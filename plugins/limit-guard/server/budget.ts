// The budget guard's backend — one instance per budget profile (lib/budget.ts):
// Gemini on Vertex AI (dollars), Yandex AI Studio and Cloud.ru (rubles). It counts Pi's
// spend of its provider from Pi's session files (server/ledger.ts, shared by the
// three), keeps the stage, and holds and stops Pi turns on that provider's models
// at the weekly limit until the user's `bb limit-guard resume <key>`.
//
// A sibling of the Claude/Codex guards (server/guard.ts), not one of their
// profiles: those switch thread models on stage 1, this one only warns on
// stage 1 and acts on stage 2 — and only on some models of a shared provider
// (Pi also runs the other budgets' models and LM Studio). The registrations the
// SDK allows once per plugin (hook, settings, CLI, RPC) are in server/wire.ts.
// Plan: backlog/plans/2026-11-21-gemini-vertex-budget.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  budgetNoteFor,
  budgetPercent,
  budgetThresholds,
  decideBudget,
  factAge,
  isBudgetHoldReason,
  isModelOf,
  limitMoney,
  maxLimit,
  money,
  percentText,
  PI_PROVIDER,
  resolveBudget,
  shortModel,
  validLimit,
  weekResetsAt,
  weekStart,
  type BudgetFactLine,
  type BudgetNotifyKind,
  type BudgetProfile,
  type BudgetSnapshot,
} from "../lib/budget.ts";
import type { NotifyRecord } from "../lib/format.ts";
import type { Totals } from "../lib/ledger.ts";
import { errorText, type DispatchDecision, type HookContextLike } from "../lib/policy.ts";
import { THREAD_ID } from "../lib/saved.ts";
import { advance, advanceTest, giveConsent, INITIAL_PHASE, type Phase, type Stage, type Step, type Thresholds } from "../lib/stage.ts";
import type { CommandResult, SettingsSource } from "./guard.ts";
import type { PiLedger } from "./ledger.ts";
import type { Notifier } from "./notify.ts";

const MAX_STOPPED_IDS = 200;
const SEND_NOW_GRACE_MS = 2_000;
const STOP_BUDGET_MS = 10_000;
/** A figure from outside Pi's files is read this often, and never longer than this per attempt. */
const FACT_EVERY_MS = 30 * 60_000;
const FACT_TIMEOUT_MS = 25_000;

export interface BudgetSettingsSource extends SettingsSource {
  set?(values: Record<string, unknown>): Promise<unknown>;
}

/**
 * A figure that does not come from Pi's files — the Yandex account balance, Google's month spend.
 * `read` returns it already formatted with its currency, `null` when it is not configured (no key),
 * and throws when it cannot be read: the card then says so instead of a zero.
 */
export interface BudgetFact {
  label: string;
  read(): Promise<string | null>;
  everyMs?: number;
}

export interface BudgetOptions {
  settings: BudgetSettingsSource;
  notifier: Notifier;
  ledger: PiLedger;
  facts?: BudgetFact[];
  now?: () => number;
  pollMs?: number;
  sendNowGraceMs?: number;
  stopBudgetMs?: number;
}

interface TestState {
  percent: number;
  threads: string[] | null;
  phase: Phase;
}

interface BudgetState {
  version: 1;
  enabled: boolean;
  enabledBy: string | null;
  enabledAt: number | null;
  phase: Phase;
  consentBy: string | null;
  test: TestState | null;
  stoppedThreads: string[];
}

interface StoredStatus {
  lastScanAt: number | null;
  lastError: { at: number; message: string } | null;
  lastNotify: NotifyRecord | null;
}

interface FactState {
  fact: BudgetFact;
  /** Formatted value of the last good read; null — not configured. */
  value: string | null;
  at: number | null;
  error: string | null;
  tried: boolean;
  /** The first attempt has finished (well or not): until then there is nothing to show. */
  done: boolean;
  lastTry: number;
}

export interface BudgetGuard {
  profile: BudgetProfile;
  ready: Promise<void>;
  dispatch(ctx: HookContextLike): Promise<DispatchDecision>;
  onSettings(values: Record<string, unknown>): void;
  snapshot(): BudgetSnapshot;
  /** Count the spend (`scan`) and apply the stage. */
  tick(scan?: boolean): Promise<void>;
  resume(caller: string): Promise<CommandResult>;
  setEnabled(enabled: boolean, caller: string): Promise<CommandResult>;
  setLimit(amount: number, caller: string): Promise<CommandResult>;
  startTest(percent: number, threads: string[] | null, caller: string): Promise<CommandResult>;
  stopTest(caller: string): Promise<CommandResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStage(value: unknown): value is Stage {
  return value === 0 || value === 1 || value === 2;
}

function parsePhase(value: unknown): Phase {
  if (!isRecord(value) || !isStage(value.stage)) return { ...INITIAL_PHASE };
  return {
    stage: value.stage,
    consent: value.consent === true,
    consentAt: typeof value.consentAt === "number" ? value.consentAt : null,
    dripFrom: null,
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null,
  };
}

function initialState(): BudgetState {
  return { version: 1, enabled: true, enabledBy: null, enabledAt: null, phase: { ...INITIAL_PHASE }, consentBy: null, test: null, stoppedThreads: [] };
}

export function parseBudgetState(value: unknown): BudgetState {
  const base = initialState();
  if (!isRecord(value)) return base;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === "string" && THREAD_ID.test(id)) : []);
  let test: TestState | null = null;
  if (isRecord(value.test) && typeof value.test.percent === "number") {
    const threads = value.test.threads === null ? null : ids(value.test.threads);
    test = { percent: value.test.percent, threads: threads !== null && threads.length === 0 ? null : threads, phase: parsePhase(value.test.phase) };
  }
  return {
    version: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    enabledBy: typeof value.enabledBy === "string" ? value.enabledBy : null,
    enabledAt: typeof value.enabledAt === "number" ? value.enabledAt : null,
    phase: parsePhase(value.phase),
    consentBy: typeof value.consentBy === "string" ? value.consentBy : null,
    test,
    stoppedThreads: ids(value.stoppedThreads).slice(0, MAX_STOPPED_IDS),
  };
}

export function createBudgetGuard(bb: BbPluginApi, profile: BudgetProfile, opts: BudgetOptions): BudgetGuard {
  const clock = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 60_000;
  const graceMs = opts.sendNowGraceMs ?? SEND_NOW_GRACE_MS;
  const stopBudgetMs = opts.stopBudgetMs ?? STOP_BUDGET_MS;
  const cur = profile.currency;
  const tag = profile.word;
  /** kv keys: Gemini keeps `gemini:state` / `gemini:status` from 0.3.0. */
  const KV = { state: `${profile.key}:state`, status: `${profile.key}:status` } as const;

  let state = initialState();
  let status: StoredStatus = { lastScanAt: null, lastError: null, lastNotify: null };
  let limit = resolveBudget({}, profile).limit;
  let warnPercent = resolveBudget({}, profile).warnPercent;
  let settingsProblem: string | null = null;
  let thresholds: Thresholds = budgetThresholds(warnPercent);
  let telegram = true;
  let disposed = false;
  /** null — never counted (or the files cannot be read). */
  let totals: Totals | null = null;
  /** Last model seen per Pi thread (hook facts, defaults lookups). */
  const models = new Map<string, string>();
  const threadProviders = new Map<string, string>();
  const sendNowThreads = new Set<string>();
  const stopping = new Map<string, Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const factStates: FactState[] = (opts.facts ?? []).map((fact) => ({ fact, value: null, at: null, error: null, tried: false, done: false, lastTry: 0 }));
  let factsBusy = false;

  function later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  }

  function safe(label: string, fn: () => Promise<unknown>): void {
    void fn().catch((error) => {
      try {
        bb.log.warn(`${tag} · ${label}: ${errorText(error)}`);
      } catch {
        // disposed
      }
    });
  }

  function recordError(where: string, error: unknown): void {
    const message = `${where}: ${errorText(error)}`.slice(0, 500);
    status.lastError = { at: clock(), message };
    bb.log.warn(`${tag} · ${message}`);
  }

  let chain: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  function phaseNow(): Phase {
    return state.test !== null ? state.test.phase : state.phase;
  }

  function scope(): ReadonlySet<string> | null {
    return state.test?.threads ? new Set(state.test.threads) : null;
  }

  function recheck(): void {
    safe("recheck", () => bb.experimental_hooks.recheck("message.dispatch"));
  }

  async function persistState(): Promise<void> {
    await bb.storage.kv.set(KV.state, state);
  }
  async function persistStatus(): Promise<void> {
    await bb.storage.kv.set(KV.status, status);
  }

  function applySettings(values: Record<string, unknown>): void {
    const resolved = resolveBudget(values, profile);
    limit = resolved.limit;
    warnPercent = resolved.warnPercent;
    settingsProblem = resolved.problem;
    thresholds = budgetThresholds(warnPercent);
    telegram = values.telegram !== false;
    if (resolved.problem !== null) bb.log.warn(`${tag}: ${resolved.problem}`);
  }

  const ready = (async () => {
    const [rawState, rawStatus] = await Promise.all([bb.storage.kv.get<unknown>(KV.state), bb.storage.kv.get<unknown>(KV.status)]);
    state = parseBudgetState(rawState);
    if (isRecord(rawStatus)) {
      status = {
        lastScanAt: typeof rawStatus.lastScanAt === "number" ? rawStatus.lastScanAt : null,
        lastError: isRecord(rawStatus.lastError) ? (rawStatus.lastError as StoredStatus["lastError"]) : null,
        lastNotify: isRecord(rawStatus.lastNotify) ? (rawStatus.lastNotify as unknown as NotifyRecord) : null,
      };
    }
    try {
      applySettings(await opts.settings.get());
    } catch (error) {
      recordError("настройки", error);
    }
  })();

  // ── the counter ──────────────────────────────────────────────────────
  /** Count the week from the shared ledger. Throws when the files cannot be trusted (the stage does not change). */
  async function scan(): Promise<void> {
    const now = clock();
    await opts.ledger.scan(now);
    const problem = opts.ledger.problem(profile.piProvider);
    if (problem !== null) throw new Error(problem);
    totals = opts.ledger.totals(profile.piProvider, now);
    status.lastScanAt = now;
  }

  function spent(): number {
    return totals?.spent ?? 0;
  }

  // ── figures from outside Pi's files ──────────────────────────────────
  /** Outside the guard's queue: a slow network read must not hold consent or the stops. */
  async function refreshFacts(): Promise<void> {
    if (factsBusy || factStates.length === 0) return;
    factsBusy = true;
    try {
      for (const f of factStates) {
        const now = clock();
        if (f.tried && now - f.lastTry < (f.fact.everyMs ?? FACT_EVERY_MS)) continue;
        f.tried = true;
        f.lastTry = now;
        try {
          f.value = await Promise.race([
            f.fact.read(),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() => reject(new Error(`нет ответа за ${FACT_TIMEOUT_MS / 1000} с`)), FACT_TIMEOUT_MS);
              timer.unref?.();
              timers.add(timer);
            }),
          ]);
          f.at = clock();
          f.error = null;
        } catch (error) {
          f.error = errorText(error).slice(0, 200);
          bb.log.warn(`${tag} · ${f.fact.label}: ${f.error}`);
        }
        f.done = true;
      }
    } finally {
      factsBusy = false;
    }
  }

  function factLines(now: number): BudgetFactLine[] {
    const lines: BudgetFactLine[] = [];
    for (const f of factStates) {
      if (!f.done) continue;
      if (f.error !== null) lines.push({ label: f.fact.label, value: `недоступно: ${f.error}`, kind: "error" });
      else if (f.value === null) lines.push({ label: f.fact.label, value: "не настроено", kind: "off" });
      else lines.push({ label: f.fact.label, value: `${f.value} · ${factAge(f.at ?? now, now)}`, kind: "ok" });
    }
    return lines;
  }

  // ── stops ────────────────────────────────────────────────────────────
  function stopWanted(threadId: string): boolean {
    const phase = phaseNow();
    const sc = scope();
    return state.enabled && phase.stage === 2 && !phase.consent && (sc === null || sc.has(threadId)) && !sendNowThreads.has(threadId);
  }

  async function providerOf(threadId: string): Promise<string | null> {
    const known = threadProviders.get(threadId);
    if (known !== undefined) return known;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      threadProviders.set(threadId, thread.providerId);
      return thread.providerId;
    } catch {
      return null;
    }
  }

  async function modelOf(threadId: string): Promise<string | null> {
    try {
      const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (opts !== null && typeof opts.model === "string") {
        models.set(threadId, opts.model);
        return opts.model;
      }
    } catch {
      // fall back to the last model seen
    }
    return models.get(threadId) ?? null;
  }

  /** A running Pi thread on this provider's model, wanted stopped. */
  async function stopIfHeld(threadId: string): Promise<void> {
    if (!stopWanted(threadId) || (await providerOf(threadId)) !== PI_PROVIDER) return;
    if (!isModelOf(profile, await modelOf(threadId))) return;
    const inFlight = stopping.get(threadId);
    if (inFlight !== undefined) return inFlight;
    if (!stopWanted(threadId)) return;
    const run = (async () => {
      await bb.sdk.threads.stop({ threadId });
      if (!state.stoppedThreads.includes(threadId) && state.stoppedThreads.length < MAX_STOPPED_IDS) state.stoppedThreads.push(threadId);
      bb.log.info(`${state.test !== null ? "[тест] " : ""}${tag} · стоп: остановил ${threadId}`);
    })().finally(() => {
      if (stopping.get(threadId) === run) stopping.delete(threadId);
    });
    stopping.set(threadId, run);
    return run;
  }

  async function stopRunning(): Promise<void> {
    const running = await bb.sdk.threads.listRunning();
    const all = Promise.all(running.map((row) => stopIfHeld(row.id).catch((error: unknown) => recordError(`остановка ${row.id}`, error)))).then(() =>
      disposed ? undefined : persistState(),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, stopBudgetMs)))]).finally(() => clearTimeout(timer));
  }

  // ── notes ────────────────────────────────────────────────────────────
  function notify(kind: BudgetNotifyKind): void {
    const at = clock();
    if (!telegram) {
      status.lastNotify = { at, kind: kind as NotifyRecord["kind"], ok: false, message: "Telegram выключен в настройках плагина" };
      return;
    }
    const note = budgetNoteFor(kind, snapshot());
    bb.log.info(`${tag} · уведомление ${kind}: ${note.note}`);
    safe("уведомление", async () => {
      let record: NotifyRecord;
      try {
        record = await opts.notifier(kind as NotifyRecord["kind"], note);
      } catch (error) {
        record = { at, kind: kind as NotifyRecord["kind"], ok: false, message: errorText(error) };
      }
      status.lastNotify = record;
      if (!disposed) await persistStatus();
    });
  }

  // ── one step ─────────────────────────────────────────────────────────
  async function apply(counted: boolean): Promise<void> {
    if (!state.enabled) {
      await persistStatus();
      return;
    }
    const now = clock();
    const test = state.test;
    const before = phaseNow();
    let step: Step;
    if (test !== null) step = advanceTest(test.phase, test.percent, thresholds);
    else if (counted && totals !== null) step = advance(state.phase, { percent: budgetPercent(spent(), limit), resetsAt: weekResetsAt(now) }, thresholds, now);
    else if (state.phase.stage > 0 && state.phase.resetsAt !== null && now >= Date.parse(state.phase.resetsAt)) {
      // The week rolled over while the counter cannot read: a stop of the old week must not carry into the new one.
      step = { phase: { ...INITIAL_PHASE, resetsAt: weekResetsAt(now) }, reset: true, entered: null };
    } else step = { phase: state.phase, reset: false, entered: null };
    if (test !== null) test.phase = step.phase;
    else state.phase = step.phase;
    const after = step.phase;
    const changed = step.reset || after.stage !== before.stage || after.consent !== before.consent;
    if (changed) sendNowThreads.clear();
    if (step.reset || step.entered === 2) state.stoppedThreads = [];
    if (step.reset) bb.log.info(`${test !== null ? "[тест] " : ""}${tag} · сброс недели: стадия 0, согласие снято`);
    if (after.stage === 2 && !after.consent) {
      try {
        await stopRunning();
      } catch (error) {
        recordError("остановка тредов", error);
      }
    }
    await persistState();
    await persistStatus();
    if (changed) recheck();
    if (step.entered === 2) notify(`${profile.key}-stop`);
    else if (step.entered === 1) notify(`${profile.key}-warn`);
  }

  function tick(doScan = true): Promise<void> {
    if (doScan) safe("внешние цифры", refreshFacts);
    return exclusive(async () => {
      if (disposed) return;
      await ready;
      let counted = !doScan && totals !== null;
      if (doScan) {
        try {
          await scan();
          counted = true;
        } catch (error) {
          totals = null;
          recordError("подсчёт расхода (стадия не меняется)", error);
        }
      }
      try {
        await apply(counted);
      } catch (error) {
        recordError("проход сторожа", error);
      }
    });
  }

  let scanTimer = false;
  function requestScan(): void {
    if (scanTimer) return;
    scanTimer = true;
    later(3_000, () => {
      scanTimer = false;
      safe("подсчёт после хода", () => tick(true));
    });
  }

  // ── hook (registered once in server/wire.ts) ─────────────────────────
  async function dispatch(ctx: HookContextLike): Promise<DispatchDecision> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([ready, new Promise<void>((resolve) => (timer = setTimeout(resolve, 1_500)))]).finally(() => clearTimeout(timer));
      const threadId = ctx.thread.id;
      const providerId = ctx.requestedExecution.providerId;
      const model = ctx.requestedExecution.model ?? null;
      threadProviders.set(threadId, providerId);
      if (providerId === PI_PROVIDER && model !== null) models.set(threadId, model);
      const phase = phaseNow();
      return decideBudget(
        { threadId, providerId, model, attempt: ctx.attempt },
        { enabled: state.enabled, stage: phase.stage, consent: phase.consent, scope: scope(), spent: spent(), limit },
        profile,
        models.get(threadId) ?? null,
      );
    } catch (error) {
      try {
        bb.log.warn(`${tag} · hook: ошибка, пропускаю ход (fail-open): ${errorText(error)}`);
      } catch {
        // never fail-closed over logging
      }
      return { action: "proceed" };
    }
  }

  // ── events ───────────────────────────────────────────────────────────
  bb.events.on("thread.active", ({ thread }) => {
    threadProviders.set(thread.id, thread.providerId);
    if (thread.providerId !== PI_PROVIDER || !stopWanted(thread.id)) return;
    // Turns past the hook (notices to a parent) are stopped here; the user's Send now is his override
    // and its message.dispatched comes right after thread.active — hence the grace.
    later(graceMs, () => {
      safe(`остановка ${thread.id}`, async () => {
        if (!stopWanted(thread.id)) return;
        const running = await bb.sdk.threads.listRunning();
        if (!running.some((row) => row.id === thread.id)) return; // a stop on an idle thread pauses its queue
        await stopIfHeld(thread.id);
        if (!disposed) await persistState();
      });
    });
  });

  bb.events.on("thread.idle", ({ thread }) => {
    sendNowThreads.delete(thread.id);
    if (thread.providerId === PI_PROVIDER) requestScan();
  });

  bb.events.on("thread.failed", ({ thread }) => {
    sendNowThreads.delete(thread.id);
  });

  bb.events.on("message.dispatched", ({ entry }) => {
    const reason = entry.waitingOn?.kind === "plugin" ? (entry.waitingOn.reason ?? "") : "";
    if (!isBudgetHoldReason(reason, profile)) return;
    const phase = phaseNow();
    if (state.enabled && phase.stage === 2 && !phase.consent) {
      sendNowThreads.add(entry.threadId);
      bb.log.info(`${tag} · стоп: Send now в ${entry.threadId} — этот ход не останавливаю`);
    }
  });

  bb.background.service(`poll-${profile.key}`, {
    async start(signal) {
      const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await Promise.race([ready, aborted]);
      while (!signal.aborted) {
        await Promise.race([tick(true).catch(() => undefined), aborted]);
        if (signal.aborted) break;
        await Promise.race([
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollMs);
            timer.unref?.();
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

  // ── commands ─────────────────────────────────────────────────────────
  function snapshot(): BudgetSnapshot {
    const now = clock();
    const phase = phaseNow();
    // The same short name (a model reached under two ids) is one row; no folder ids on screen.
    const merged = new Map<string, number>();
    for (const [id, cost] of Object.entries(totals?.byModel ?? {})) merged.set(shortModel(id), (merged.get(shortModel(id)) ?? 0) + cost);
    const byModel = [...merged.entries()].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost);
    return {
      key: profile.key,
      title: profile.title,
      word: profile.word,
      turns: profile.turns,
      piProvider: profile.piProvider,
      currency: cur,
      priceNote: profile.priceNote,
      now,
      enabled: state.enabled,
      enabledBy: state.enabledBy,
      stage: state.enabled ? phase.stage : 0,
      realStage: state.phase.stage,
      consent: state.enabled && phase.consent,
      consentBy: state.consentBy,
      limit,
      warnPercent,
      settingsProblem,
      spent: totals === null ? null : totals.spent,
      today: totals === null ? null : totals.today,
      byModel,
      answers: totals?.answers ?? 0,
      percent: totals === null ? null : budgetPercent(totals.spent, limit),
      weekStart: weekStart(now),
      resetsAt: weekResetsAt(now),
      lastScanAt: status.lastScanAt,
      lastError: status.lastError,
      stoppedThreads: [...state.stoppedThreads],
      test: state.test === null ? null : { percent: state.test.percent, threads: state.test.threads, stage: state.test.phase.stage, consent: state.test.phase.consent },
      lastNotify: status.lastNotify,
      telegram,
      facts: factLines(now),
    };
  }

  async function resume(caller: string): Promise<CommandResult> {
    await ready;
    if (!state.enabled) return { ok: false, text: `Сторож ${tag} выключен — согласие не нужно, ничего не держится. Включить: bb limit-guard on ${profile.key}` };
    const phase = phaseNow();
    const mark = state.test !== null ? "[ТЕСТ] " : "";
    if (phase.consent) return { ok: true, text: `${mark}Согласие уже дано${state.consentBy === null ? "" : ` (${state.consentBy})`} и действует до сброса недели.` };
    const result = giveConsent(phase, clock());
    if (!result.ok) {
      return { ok: false, text: `Сейчас стадия 0 (ниже ${warnPercent} % лимита ${limitMoney(limit, cur)}) — согласие не нужно. Дать его заранее можно со стадии 1.` };
    }
    const next = { ...result.phase, dripFrom: null };
    if (state.test !== null) state.test.phase = next;
    else state.phase = next;
    state.consentBy = caller;
    sendNowThreads.clear();
    try {
      await persistState();
    } catch (error) {
      recordError("сохранение согласия (в памяти оно уже действует)", error);
    }
    bb.log.info(`${state.test !== null ? "[тест] " : ""}${tag} · согласие до сброса недели — ${caller}`);
    recheck();
    notify(`${profile.key}-consent`);
    if (phase.stage === 1) return { ok: true, text: `${mark}Согласие дано заранее: на ${limitMoney(limit, cur)} ${profile.turns} не встанут до сброса недели.` };
    const stopped = state.stoppedThreads;
    return {
      ok: true,
      text: [
        `${mark}Согласие принято до сброса недели: придержанные ${profile.turns} уходят, стоп больше не включится.`,
        ...(stopped.length > 0 ? [`Остановленные треды сами не продолжат — напиши в них: ${stopped.slice(0, 10).join(", ")}`] : []),
      ].join("\n"),
    };
  }

  async function setEnabled(next: boolean, caller: string): Promise<CommandResult> {
    await ready;
    return exclusive(async () => {
      if (state.enabled === next) return { ok: true, text: `Сторож ${tag} и так ${next ? "включён" : "выключен"}.` };
      state.enabled = next;
      state.enabledBy = caller;
      state.enabledAt = clock();
      sendNowThreads.clear();
      if (!next && state.test !== null) state.test = null;
      bb.log.info(`${tag} · сторож ${next ? "включён" : "выключен"} — ${caller}`);
      if (next) {
        try {
          await scan();
          await apply(true);
        } catch (error) {
          recordError("проход после включения", error);
        }
      }
      await persistState();
      recheck();
      const s = snapshot();
      if (!next) return { ok: true, text: `Сторож ${tag} выключен: расход считается, но ходы не держатся и треды не останавливаются. Включить: bb limit-guard on ${profile.key}` };
      return {
        ok: true,
        text: `Сторож ${tag} включён: ${s.spent === null ? "расход не прочитан" : `${money(s.spent, cur)} из ${limitMoney(limit, cur)} (${percentText(s.percent ?? 0)})`}, стадия ${s.stage}${s.stage === 2 && !s.consent ? ` — ${profile.turns} ждут согласия (bb limit-guard resume ${profile.key})` : ""}.`,
      };
    });
  }

  async function setLimit(amount: number, caller: string): Promise<CommandResult> {
    await ready;
    if (!validLimit(amount, profile)) {
      return { ok: false, text: `Лимит — число ${cur === "USD" ? "долларов" : "рублей (₽)"} от 1 до ${limitMoney(maxLimit(profile), cur)}, например: bb limit-guard limit ${profile.key} ${profile.defaultLimit}` };
    }
    if (opts.settings.set === undefined) return { ok: false, text: `Эта версия bb не даёт плагину менять свои настройки — поменяй лимит ${tag} в настройках плагина.` };
    await opts.settings.set({ [profile.settingLimit]: amount });
    applySettings({ ...(await opts.settings.get()), [profile.settingLimit]: amount });
    bb.log.info(`${tag} · лимит ${limitMoney(amount, cur)} в неделю — ${caller}`);
    await tick(false);
    const s = snapshot();
    return { ok: true, text: `Лимит ${tag}: ${limitMoney(amount, cur)} в неделю. Сейчас ${s.spent === null ? "расход не прочитан" : `${money(s.spent, cur)} (${percentText(s.percent ?? 0)})`}, стадия ${s.stage}.` };
  }

  async function startTest(percent: number, threads: string[] | null, caller: string): Promise<CommandResult> {
    return exclusive(async () => {
      await ready;
      if (!state.enabled) return { ok: false, text: `Сторож ${tag} выключен — тест не запускаю. Включить: bb limit-guard on ${profile.key}` };
      if (state.test === null) state.test = { percent, threads, phase: { ...INITIAL_PHASE } };
      else state.test = { ...state.test, percent, threads };
      bb.log.info(`${tag} · тест-режим: ${percent} %${threads === null ? "" : ` · ${threads.join(",")}`} — ${caller}`);
      await apply(false);
      const s = snapshot();
      return {
        ok: true,
        text: `Тест-режим ${tag}: процент ${percent} → стадия ${s.test?.stage ?? "?"}${threads === null ? ` (все треды Pi на ${profile.piProvider}/*)` : `, только треды ${threads.join(", ")}`}.\nВыключить: bb limit-guard test ${profile.key} --off`,
      };
    });
  }

  async function stopTest(caller: string): Promise<CommandResult> {
    return exclusive(async () => {
      await ready;
      if (state.test === null) return { ok: true, text: `Тест-режим ${tag} и так выключен.` };
      state.test = null;
      sendNowThreads.clear();
      bb.log.info(`${tag} · тест-режим выключен — ${caller}`);
      await apply(totals !== null);
      recheck();
      return { ok: true, text: `Тест-режим ${tag} выключен. Сторож снова считает настоящую неделю (стадия ${state.phase.stage}).` };
    });
  }

  return {
    profile,
    ready,
    dispatch,
    onSettings: (values) => {
      applySettings(values);
      safe("пересчёт после настроек", () => tick(false));
    },
    snapshot,
    tick,
    resume,
    setEnabled,
    setLimit,
    startTest,
    stopTest,
  };
}
