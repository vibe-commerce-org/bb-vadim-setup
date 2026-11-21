// Gemini auto-switch on 429 — the SDK side of lib/fallback.ts (plan Ф4, the author's decisions of 21.11).
//
// What it does, in order of how soon it helps (Vertex keeps a capacity pool per model, so the breaker is per model):
//   1. REACTIVE. `turn.failed` on a Pi thread on a `google-vertex/*` model, category rate-limit → that model is shut for
//      30 minutes (60, 120 … on failed probes), the thread goes to the next model of the benchmark chain that is not
//      shut (the effort is capped to what that model takes) and the failed turn is sent again there. `threads.retry` is NOT
//      used: checked on 21.11, it re-submits the turn with its ORIGINAL model and ignores the thread's new one.
//   2. SPREAD. Every other Pi thread on a shut model — and every new or waking one — is moved the same way before it
//      fails; the previous model of each is remembered.
//   3. PROBE. When a pause is over, ONE moved thread goes back to that model. Its next turn passes → the model works
//      again and the moved threads return (those whose model the user did not change meanwhile); it fails (429) → the
//      pause grows.
// Never on 403 «billing», 400, safety (only rate-limit), never while the Gemini budget is on its stop.
// Switching a thread changes its defaults for the NEXT turn; a turn whose model was picked in the composer fails once
// and takes the reactive way. Settings: `geminiFallback` (on/off), `geminiFallbackChain` (benchmark order).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  capEffort,
  closeModel,
  dueProbes,
  parseChain,
  pickTarget,
  recordFailure,
  shutModels,
  startProbe,
  untilText,
  vertexId,
  VERTEX_PREFIX,
  type Breaker,
} from "../lib/fallback.ts";
import { errorText } from "../lib/policy.ts";
import { THREAD_ID } from "../lib/saved.ts";
import type { BudgetFactLine } from "../lib/budget.ts";
import type { NotifyRecord } from "../lib/format.ts";
import type { SettingsSource } from "./guard.ts";
import type { Notifier } from "./notify.ts";

type Sdk = BbPluginApi["sdk"];
type UpdateArgs = Parameters<Sdk["threads"]["update"]>[0];
type SendArgs = Parameters<Sdk["threads"]["send"]>[0];

const KV_KEY = "gemini:fallback";
const PI = "pi";
const MAX_MOVED = 200;
/** A turn this many times retried is left alone (the chain is finite anyway; this is the belt over the braces). */
const MAX_ATTEMPT = 6;
/** The prompt to send again must be this fresh; an older last prompt is not the failed turn's. */
const PROMPT_FRESH_MS = 6 * 3_600_000;
/** A probe thread that has not run a turn for this long is replaced by another. */
const PROBE_PATIENCE_MS = 3 * 3_600_000;
const SWITCH_PARALLEL = 6;

export interface FallbackOptions {
  settings: SettingsSource;
  notifier: Notifier;
  /** The Gemini budget is on its stop: the stop is stronger, no spare Vertex models. */
  blocked: () => boolean;
  now?: () => number;
  pollMs?: number;
  /** How long the message waits for the neighbours that shut with the first model (tests shorten it). */
  joinMs?: number;
}

interface Moved {
  /** bb model id and effort the thread had before the first switch. */
  model: string;
  effort: string | null;
  /** bb model id the guard put it on last (to tell the user's own change from ours). */
  to: string;
  at: number;
}

interface FallbackState {
  version: 1;
  breaker: Breaker;
  moved: Record<string, Moved>;
  probe: { model: string; threadId: string; at: number } | null;
  /** Last switch, for `status`: when, which thread, from → to. */
  last: { at: number; threadId: string; from: string; to: string; reactive: boolean } | null;
}

export interface FallbackSnapshot {
  enabled: boolean;
  chain: string[];
  chainProblem: string | null;
  shut: Array<{ model: string; until: number; step: number; probing: boolean }>;
  moved: number;
  last: FallbackState["last"];
  blocked: boolean;
}

export interface GeminiFallback {
  ready: Promise<void>;
  onSettings(values: Record<string, unknown>): void;
  /** One maintenance pass: start the probe of a model whose pause is over. */
  tick(): Promise<void>;
  /** The card/status line while something is shut or moved; null when all is quiet. */
  line(): BudgetFactLine | null;
  snapshot(): FallbackSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(value: unknown): FallbackState {
  const base: FallbackState = { version: 1, breaker: { open: {} }, moved: {}, probe: null, last: null };
  if (!isRecord(value)) return base;
  const breaker: Breaker = { open: {} };
  if (isRecord(value.breaker) && isRecord(value.breaker.open)) {
    for (const [model, f] of Object.entries(value.breaker.open)) {
      if (isRecord(f) && typeof f.until === "number" && typeof f.step === "number") breaker.open[model] = { until: f.until, step: f.step, probing: f.probing === true };
    }
  }
  const moved: Record<string, Moved> = {};
  if (isRecord(value.moved)) {
    for (const [id, m] of Object.entries(value.moved)) {
      if (!THREAD_ID.test(id) || !isRecord(m) || typeof m.model !== "string" || typeof m.to !== "string" || typeof m.at !== "number") continue;
      moved[id] = { model: m.model, effort: typeof m.effort === "string" ? m.effort : null, to: m.to, at: m.at };
    }
  }
  const probe = isRecord(value.probe) && typeof value.probe.model === "string" && typeof value.probe.threadId === "string" && typeof value.probe.at === "number" ? { model: value.probe.model, threadId: value.probe.threadId, at: value.probe.at } : null;
  const last = isRecord(value.last) && typeof value.last.at === "number" && typeof value.last.threadId === "string" && typeof value.last.from === "string" && typeof value.last.to === "string" ? { at: value.last.at, threadId: value.last.threadId, from: value.last.from, to: value.last.to, reactive: value.last.reactive === true } : null;
  return { version: 1, breaker, moved, probe, last };
}

/** «Gemini 3.1 Pro», «Gemini 4 Neon» from a Vertex model id. */
function modelTitle(id: string): string {
  return id
    .replace(/-preview$/, "")
    .split("-")
    .map((p) => (p === "gemini" ? "Gemini" : /^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

export function createFallback(bb: BbPluginApi, opts: FallbackOptions): GeminiFallback {
  const clock = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 60_000;
  let state = parseState(undefined);
  let enabled = true;
  let chain = parseChain(undefined);
  let disposed = false;
  const providers = new Map<string, string>();
  const handled = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function safe(label: string, fn: () => Promise<unknown>): void {
    void fn().catch((error) => {
      try {
        bb.log.warn(`Gemini · автопереключение · ${label}: ${errorText(error)}`);
      } catch {
        // disposed
      }
    });
  }

  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function persist(): Promise<void> {
    await bb.storage.kv.set(KV_KEY, state);
  }

  function applySettings(values: Record<string, unknown>): void {
    enabled = values.geminiFallback !== false;
    chain = parseChain(values.geminiFallbackChain);
    if (chain.problem !== null) bb.log.warn(`Gemini · автопереключение: ${chain.problem}`);
  }

  const ready = (async () => {
    state = parseState(await bb.storage.kv.get<unknown>(KV_KEY));
    try {
      applySettings(await opts.settings.get());
    } catch (error) {
      bb.log.warn(`Gemini · автопереключение · настройки: ${errorText(error)}`);
    }
  })();

  // ── helpers over the SDK ─────────────────────────────────────────────
  async function providerOf(threadId: string): Promise<string | null> {
    const known = providers.get(threadId);
    if (known !== undefined) return known;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      providers.set(threadId, thread.providerId);
      return thread.providerId;
    } catch {
      return null;
    }
  }

  /** The thread's model and effort for its next turn. */
  async function executionOf(threadId: string): Promise<{ model: string | null; effort: string | null }> {
    try {
      const o = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      return { model: o !== null && typeof o.model === "string" ? o.model : null, effort: o !== null && typeof o.reasoningLevel === "string" ? o.reasoningLevel : null };
    } catch {
      return { model: null, effort: null };
    }
  }

  async function setExecution(threadId: string, model: string, effort: string | null): Promise<void> {
    await bb.sdk.threads.update({ threadId, model, ...(effort !== null ? { reasoningLevel: effort } : {}) } as UpdateArgs);
  }

  function notify(text: string, md: string[]): void {
    const at = clock();
    safe("уведомление", async () => {
      let record: NotifyRecord;
      try {
        record = await opts.notifier("fallback-open", { note: text, md: md.join("\n") });
      } catch (error) {
        record = { at, kind: "fallback-open", ok: false, message: errorText(error) };
      }
      if (!record.ok) bb.log.warn(`Gemini · автопереключение: уведомление не доставлено: ${record.message}`);
    });
  }

  // ── switching ────────────────────────────────────────────────────────
  /** Put one thread on the target, remembering where it came from (once). */
  async function moveThread(threadId: string, fromModel: string, effort: string | null, targetId: string, reactive: boolean): Promise<void> {
    const to = `${VERTEX_PREFIX}${targetId}`;
    const known = state.moved[threadId];
    // Capped from the effort the thread ORIGINALLY had: xhigh comes back when the next model takes it.
    const original = known?.effort ?? effort;
    const cap = capEffort(original, targetId);
    await setExecution(threadId, to, cap);
    if (known === undefined) {
      if (Object.keys(state.moved).length >= MAX_MOVED) delete state.moved[Object.keys(state.moved)[0]!];
      state.moved[threadId] = { model: fromModel, effort, to, at: clock() };
    } else {
      state.moved[threadId] = { ...known, to, at: clock() };
    }
    state.last = { at: clock(), threadId, from: fromModel, to, reactive };
    bb.log.info(`Gemini · автопереключение: ${threadId} ${fromModel} → ${to}${cap !== effort ? ` (effort ${effort ?? "?"} → ${cap ?? "?"})` : ""}`);
  }

  /** The first model of the chain after `current` that is not shut, or null. */
  function targetFor(currentId: string): string | null {
    return pickTarget(chain.chain, currentId, shutModels(state.breaker, clock()));
  }

  /** A turn failed with 429: record, switch the thread, retry the turn. */
  function onTurnFailed(event: { threadId: string; requestId: string; errorInfo: { category?: string } | null; attemptNumber: number; inputAccepted?: boolean }): Promise<void> {
    return exclusive(async () => {
      await ready;
      if (disposed || !enabled || opts.blocked()) return;
      if (event.errorInfo?.category !== "rate-limit" || event.attemptNumber >= MAX_ATTEMPT) return;
      if (handled.has(event.requestId)) return;
      if ((await providerOf(event.threadId)) !== PI) return;
      const exec = await executionOf(event.threadId);
      const id = vertexId(exec.model);
      if (id === null) return;
      handled.add(event.requestId);
      if (handled.size > 500) handled.clear();
      const recorded = recordFailure(state.breaker, id, clock());
      state.breaker = recorded.breaker;
      if (state.probe !== null && id === state.probe.model) state.probe = null;
      const target = targetFor(id);
      if (recorded.opened !== null) announceShut(recorded.opened, target);
      if (target === null) {
        bb.log.warn(`Gemini · автопереключение: ${event.threadId} на ${id} упал с 429, а запасных в цепочке не осталось — ход остаётся упавшим`);
        await persist();
        return;
      }
      try {
        await moveThread(event.threadId, exec.model!, exec.effort, target, true);
        await sendAgain(event.threadId, target, event.inputAccepted === true, `${modelTitle(id)} перегружена у Google (429)`);
      } catch (error) {
        bb.log.warn(`Gemini · автопереключение: ${event.threadId} → ${target}: ${errorText(error)}`);
      }
      await persist();
      if (recorded.opened !== null) await switchAllOffShut();
    });
  }

  /** One message per 10 minutes: when several models shut in a row the text lists all that are shut now. */
  let lastNotifyAt = 0;
  /**
   * The failed turn again, on the thread's new model. A turn the provider never took is sent verbatim (its text is the
   * thread's latest prompt); a turn that failed after the provider took it gets a nudge instead of a second copy.
   */
  async function sendAgain(threadId: string, targetId: string, accepted: boolean, why: string): Promise<void> {
    let input: unknown[] | null = null;
    if (accepted) {
      input = [{ type: "text", text: "Продолжай с того места, где остановился: модель сменили из-за перегрузки Google." }];
    } else {
      const history = await bb.sdk.threads.promptHistory({ threadId });
      const last = [...history].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (last === undefined || clock() - last.createdAt > PROMPT_FRESH_MS) {
        bb.log.warn(`Gemini · автопереключение: ${threadId}: не нашёл свежий запрос для повтора — модель сменена, ход не повторён`);
        return;
      }
      input = last.input as unknown[];
    }
    const exec = await executionOf(threadId);
    const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input, ...(exec.model !== null ? { model: exec.model } : {}), ...(exec.effort !== null ? { reasoningLevel: exec.effort } : {}) } as SendArgs);
    bb.log.info(`Gemini · автопереключение: ${threadId} — ${why}, ход отправлен заново на ${modelTitle(targetId)} (${sent.delivery})`);
  }

  function announceShut(model: string, target: string | null): void {
    const now = clock();
    const until = state.breaker.open[model]?.until ?? now;
    bb.log.info(`Gemini · автопереключение: ${modelTitle(model)} перегружена у Google (429), пауза до ${untilText(until)} МСК, дальше ${target === null ? "нет запасных" : modelTitle(target)}`);
    if (now - lastNotifyAt < 10 * 60_000) return;
    lastNotifyAt = now;
    safe("сообщение", async () => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.joinMs ?? 2_000); // let the neighbours that shut with it join the text
        timer.unref?.();
        timers.add(timer);
      });
      const shut = Object.entries(state.breaker.open).filter(([, f]) => f.until > clock());
      const list = shut.map(([m, f]) => `${modelTitle(m)} (до ${untilText(f.until)} МСК)`).join(", ");
      const text = `Google отвечает 429 (перегрузка) на: ${list}. Ходы Pi идут на следующую модель цепочки по вашему бенчу, потом проба.`;
      notify(text, ["# Сторож лимитов: Gemini перегружен у Google", "", text, "", `Цепочка: ${chain.chain.map(modelTitle).join(" → ")}.`, "Причина — 429 RESOURCE_EXHAUSTED: очередь Google на модель, не ваш лимит. Возврат — пробным ходом, сам."]);
    });
  }

  /** Every Pi thread on a shut model goes to the next model of the chain that is not shut; the previous one is remembered. */
  async function switchAllOffShut(): Promise<void> {
    const shut = shutModels(state.breaker, clock());
    if (shut.size === 0) return;
    const ids: string[] = [];
    for (let offset = 0; offset < 50_000; offset += 200) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 200, offset });
      for (const row of page) {
        providers.set(row.id, row.providerId);
        if (row.providerId === PI) ids.push(row.id);
      }
      if (page.length < 200) break;
    }
    let next = 0;
    const worker = async () => {
      while (next < ids.length && !disposed) {
        const threadId = ids[next++]!;
        const exec = await executionOf(threadId);
        const id = vertexId(exec.model);
        if (id === null || !shut.has(id)) continue;
        const target = pickTarget(chain.chain, id, shut);
        if (target === null) continue;
        try {
          await moveThread(threadId, exec.model!, exec.effort, target, false);
        } catch (error) {
          bb.log.warn(`Gemini · автопереключение: ${threadId}: ${errorText(error)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SWITCH_PARALLEL, ids.length) }, worker));
    await persist();
  }

  /** A new or waking Pi thread on a shut model does not wait for its first failure. */
  function onThreadWakes(thread: { id: string; providerId: string }): Promise<void> {
    providers.set(thread.id, thread.providerId);
    if (thread.providerId !== PI) return Promise.resolve();
    return exclusive(async () => {
      await ready;
      if (disposed || !enabled || opts.blocked()) return;
      const shut = shutModels(state.breaker, clock());
      if (shut.size === 0) return;
      const exec = await executionOf(thread.id);
      const id = vertexId(exec.model);
      if (id === null || !shut.has(id)) return;
      const target = pickTarget(chain.chain, id, shut);
      if (target === null) return;
      try {
        await moveThread(thread.id, exec.model!, exec.effort, target, false);
        await persist();
      } catch (error) {
        bb.log.warn(`Gemini · автопереключение: ${thread.id}: ${errorText(error)}`);
      }
    });
  }

  // ── probe and return ─────────────────────────────────────────────────
  /** Give the moved threads that came from `model` their own model back (only where the user has not changed it). */
  async function returnModel(model: string): Promise<number> {
    let back = 0;
    for (const [threadId, m] of Object.entries(state.moved)) {
      if (vertexId(m.model) !== model) continue;
      const exec = await executionOf(threadId);
      if (exec.model === m.to) {
        try {
          await setExecution(threadId, m.model, m.effort);
          back += 1;
        } catch (error) {
          bb.log.warn(`Gemini · автопереключение: возврат ${threadId}: ${errorText(error)}`);
          continue; // stays remembered: the next pass tries again
        }
      }
      delete state.moved[threadId];
    }
    return back;
  }

  function maintenance(): Promise<void> {
    return exclusive(async () => {
      await ready;
      if (disposed || !enabled) return;
      const now = clock();
      // A probe thread that never ran a turn gives way to another.
      if (state.probe !== null && now - state.probe.at > PROBE_PATIENCE_MS) {
        const f = state.breaker.open[state.probe.model];
        if (f !== undefined) state.breaker = { open: { ...state.breaker.open, [state.probe.model]: { ...f, probing: false, until: now } } };
        state.probe = null;
      }
      if (state.probe !== null) return; // one probe at a time
      for (const model of dueProbes(state.breaker, now)) {
        // The thread that moved last and came from this model is the probe.
        const candidates = Object.entries(state.moved)
          .filter(([, m]) => vertexId(m.model) === model)
          .sort((a, b) => b[1].at - a[1].at);
        if (candidates.length === 0) {
          state.breaker = closeModel(state.breaker, model); // nobody to try: the model is simply open again
          bb.log.info(`Gemini · автопереключение: ${modelTitle(model)} — пауза кончилась, пробовать некому, модель открыта`);
          continue;
        }
        const [threadId, m] = candidates[0]!;
        try {
          await setExecution(threadId, m.model, m.effort);
        } catch (error) {
          bb.log.warn(`Gemini · автопереключение: проба ${threadId}: ${errorText(error)}`);
          continue;
        }
        state.moved[threadId] = { ...m, to: m.model, at: now };
        state.breaker = startProbe(state.breaker, model);
        state.probe = { model, threadId, at: now };
        bb.log.info(`Gemini · автопереключение: проба ${modelTitle(model)} — ${threadId} вернулся на ${m.model}`);
        break;
      }
      await persist();
    });
  }

  /** The probe thread finished a turn without a 429: the model works again and its threads go home. */
  function onThreadIdle(thread: { id: string }): Promise<void> {
    return exclusive(async () => {
      await ready;
      const probe = state.probe;
      if (disposed || probe === null || probe.threadId !== thread.id) return;
      // A turn the thread ran after the probe started is the proof; its failure would have come through onTurnFailed.
      const exec = await executionOf(thread.id);
      const m = state.moved[thread.id];
      if (m === undefined || exec.model !== m.model) return; // the user moved it: not a proof
      state.breaker = closeModel(state.breaker, probe.model);
      state.probe = null;
      const back = await returnModel(probe.model);
      const text = `${modelTitle(probe.model)} снова отвечает: ${back} ${back === 1 ? "тред вернулся" : "тредов вернулось"} на свои модели.`;
      bb.log.info(`Gemini · автопереключение: ${text}`);
      notify(text, [`# Сторож лимитов: ${modelTitle(probe.model)} снова отвечает`, "", text]);
      await persist();
    });
  }

  // ── events and service ───────────────────────────────────────────────
  bb.events.on("turn.failed", (event) => {
    safe("turn.failed", () => onTurnFailed(event as Parameters<typeof onTurnFailed>[0]));
  });
  bb.events.on("thread.created", ({ thread }) => {
    safe("thread.created", () => onThreadWakes(thread));
  });
  bb.events.on("thread.active", ({ thread }) => {
    safe("thread.active", () => onThreadWakes(thread));
  });
  bb.events.on("thread.idle", ({ thread }) => {
    providers.set(thread.id, thread.providerId);
    safe("thread.idle", () => onThreadIdle(thread));
  });

  bb.background.service("poll-fallback", {
    async start(signal) {
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([ready, aborted]);
      while (!signal.aborted) {
        await Promise.race([maintenance().catch(() => undefined), aborted]);
        if (signal.aborted) break;
        await Promise.race([
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            timer.unref?.();
            timers.add(timer);
          }),
          aborted,
        ]);
      }
    },
  });

  bb.onDispose(() => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });

  function snapshot(): FallbackSnapshot {
    return {
      enabled,
      chain: [...chain.chain],
      chainProblem: chain.problem,
      shut: Object.entries(state.breaker.open).map(([model, f]) => ({ model, until: f.until, step: f.step, probing: f.probing })),
      moved: Object.keys(state.moved).length,
      last: state.last,
      blocked: opts.blocked(),
    };
  }

  function line(): BudgetFactLine | null {
    if (!enabled) return null;
    const open = Object.entries(state.breaker.open);
    if (open.length === 0 && Object.keys(state.moved).length === 0) return null;
    const moved = Object.keys(state.moved).length;
    const movedText = moved === 0 ? "" : `${moved} ${moved === 1 ? "тред" : moved < 5 ? "треда" : "тредов"} на запасной модели`;
    if (open.length === 0) return { label: "Автопереключение", value: movedText, kind: "ok" };
    const parts = open.map(([model, f]) => (f.probing ? `${modelTitle(model)} — идёт проба` : `${modelTitle(model)} перегружена у Google до ${untilText(f.until)} МСК`));
    return { label: "Автопереключение", value: [...parts, ...(movedText === "" ? [] : [movedText])].join(" · "), kind: "ok" };
  }

  return {
    ready,
    onSettings: applySettings,
    tick: maintenance,
    line,
    snapshot,
  };
}
