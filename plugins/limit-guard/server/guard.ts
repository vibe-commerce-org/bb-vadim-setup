// The guard's backend: reads the weekly window, keeps the stage, switches
// thread models, holds and re-queues turns, stops the provider's threads on
// stage 2, gives the previous models back after the weekly reset.
//
// One guard per provider profile (lib/profile.ts): Claude Code and Codex run
// the same code side by side, each with its own state, kv keys, settings,
// switch and service. What the SDK allows only once per plugin — the
// message.dispatch hook, agents.configure, the settings, the CLI and the RPC —
// is registered in server/wire.ts and handed to both guards.
//
// Everything that changes state runs one at a time (`exclusive`). The
// message.dispatch hook reads memory only (lib/policy.ts) — the persisted
// state is loaded once at start and kept in memory.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readFile, stat } from "node:fs/promises";
import {
  agentInstruction,
  formatDateTime,
  notificationFor,
  stoppedHint,
  type NotifyKind,
  type NotifyRecord,
  type PassStats,
  type ReseatStats,
  type StatusSnapshot,
} from "../lib/format.ts";
import {
  createDispatchHook,
  DRIP_WINDOW_MS,
  errorText,
  inDripWindow,
  inScope,
  STOP_MARK,
  type DispatchDecision,
  type HookContextLike,
  type PolicyView,
} from "../lib/policy.ts";
import {
  executionFor,
  heldTurns,
  holdsExecution,
  isOnTarget,
  resolveSettings,
  restoreAttempts,
  savedEntry,
  targetExec,
  targetLabel,
  targetShort,
  targetUpdate,
  type GuardInfo,
  type Profile,
  type Target,
} from "../lib/profile.ts";
import { mergeSaved, parseSaved, shouldImport, THREAD_ID, type SavedMap } from "../lib/saved.ts";
import {
  advance,
  advanceTest,
  DEFAULT_THRESHOLDS,
  giveConsent,
  INITIAL_PHASE,
  type Phase,
  type Stage,
  type Step,
  type Thresholds,
} from "../lib/stage.ts";
import { isHeldByGuard, isLiveClaudeThread, planReseat, restoreModels, wantsCheck } from "../lib/threads.ts";
import { pickWeekly } from "../lib/usage.ts";
import type { Notifier } from "./notify.ts";

type Sdk = BbPluginApi["sdk"];
type UpdateArgs = Parameters<Sdk["threads"]["update"]>[0];
type CreateRowArgs = Parameters<Sdk["threads"]["queuedMessages"]["create"]>[0];
type SendArgs = Parameters<Sdk["threads"]["send"]>[0];
type QueuedRow = Awaited<ReturnType<Sdk["threads"]["queuedMessages"]["list"]>>[number];

/** kv key names; a guard prefixes them with `profile.kvPrefix` (Claude: none — the 0.1.x keys). */
export const KV = {
  state: "state",
  saved: "saved",
  savedTest: "saved-test",
  reading: "reading",
  status: "status",
} as const;

export function kvKeys(profile: Profile): { [K in keyof typeof KV]: string } {
  const p = profile.kvPrefix;
  return { state: p + KV.state, saved: p + KV.saved, savedTest: p + KV.savedTest, reading: p + KV.reading, status: p + KV.status };
}

const PAGE = 200;
const PARALLEL = 6;
const GRANT_TTL_MS = 15_000;
/**
 * `threads.stop` waits for the interrupt (BB: up to 60 s a round, up to 4
 * rounds). A pass waits for the stops at most this long, the rest finish in the
 * background — the guard's queue (consent, the next reading) is not held.
 */
const STOP_BUDGET_MS = 10_000;
/**
 * BB emits `thread.active` BEFORE `message.dispatched` for the same Send now
 * (run.started is applied inside the send, the dispatched row is settled after
 * it), so the stage-2 stop on `thread.active` waits this long for the
 * dispatched event that marks the user's Send now.
 */
const SEND_NOW_GRACE_MS = 2_000;
/** Stopped thread ids kept for `status` and the consent text. */
const MAX_STOPPED_IDS = 500;

export interface TestState {
  threads: string[];
  percent: number;
  phase: Phase;
}

export interface PersistedState {
  version: 1;
  /** Off: the guard reads the limit but never interferes (button in the sidebar footer, `bb limit-guard off`). */
  enabled: boolean;
  /** Who switched it last (`shell`, a thread id, `rpc`) and when — the card and the CLI cannot tell an agent from the button. */
  enabledBy: string | null;
  enabledAt: number | null;
  phase: Phase;
  consentBy: string | null;
  test: TestState | null;
  lastResetAt: number | null;
  interimImportedMtimeMs: number | null;
  stoppedSinceStage2: number;
  /** Threads stopped on stage 2 (unique, capped): after consent they need a new message. */
  stoppedThreads: string[];
  /** A reset left models to give back (the host was offline, say). */
  pendingRestore: boolean;
}

interface StoredStatus {
  lastCheckedAt: number | null;
  lastError: { at: number; message: string } | null;
  lastPass: PassStats | null;
  lastNotify: NotifyRecord | null;
  reseat: ReseatStats;
}

/** The plugin's settings handle (defined once in server/wire.ts; its onChange is wired there too). */
export interface SettingsSource {
  get(): Promise<Record<string, unknown>>;
  /** Persist some of the plugin's own settings (the Gemini limit command); absent on hosts without it. */
  set?(values: Record<string, unknown>): Promise<unknown>;
}

export interface GuardOptions {
  settings: SettingsSource;
  notifier: Notifier;
  /** state.json of scripts/limit-guard-interim.py; null — no import. */
  interimStatePath: string | null;
  now?: () => number;
  pollMs?: number;
  minReadMs?: number;
  reseatDelayMs?: number;
  sendNowGraceMs?: number;
  stopBudgetMs?: number;
}

export interface CommandResult {
  ok: boolean;
  text: string;
}

export interface Guard {
  profile: Profile;
  ready: Promise<void>;
  /** This guard's message.dispatch decision (server/wire.ts asks both guards; fail-open). */
  dispatch(ctx: HookContextLike): Promise<DispatchDecision>;
  /** The line for an agent of this guard's provider on stage ≥ 1, null otherwise. */
  agentHint(ctx: { thread: { id: string }; provider?: { id: string } | null }): string | null;
  /** New plugin settings (server/wire.ts subscribes once for both guards). */
  onSettings(values: Record<string, unknown>): void;
  snapshot(): StatusSnapshot;
  tick(read: boolean): Promise<void>;
  resume(caller: string): Promise<CommandResult>;
  /** On/off: off = the guard stops interfering at once; models of the threads stay as they are. */
  setEnabled(enabled: boolean, caller: string): Promise<CommandResult>;
  /** Give the saved previous models back (guard off, or stage 0); runs in the background. */
  restoreModels(caller: string): Promise<CommandResult>;
  startTest(threads: string[], percent: number, caller: string): Promise<CommandResult>;
  stopTest(caller: string): Promise<CommandResult>;
}

function initialState(enabled: boolean): PersistedState {
  return {
    version: 1,
    enabled,
    enabledBy: null,
    enabledAt: null,
    phase: { ...INITIAL_PHASE },
    consentBy: null,
    test: null,
    lastResetAt: null,
    interimImportedMtimeMs: null,
    stoppedSinceStage2: 0,
    stoppedThreads: [],
    pendingRestore: false,
  };
}

function emptyReseat(): ReseatStats {
  return { copied: 0, sent: 0, skipped: 0, failed: 0, lastSkip: null };
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
    dripFrom: typeof value.dripFrom === "number" ? value.dripFrom : null,
    resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : null,
  };
}

/** The persisted state as stored, anything malformed reset to defaults (`enabledByDefault` — no state stored yet). */
export function parseState(value: unknown, enabledByDefault = true): PersistedState {
  const base = initialState(enabledByDefault);
  if (!isRecord(value)) return base;
  let test: TestState | null = null;
  if (isRecord(value.test) && Array.isArray(value.test.threads) && typeof value.test.percent === "number") {
    const threads = value.test.threads.filter((id): id is string => typeof id === "string" && THREAD_ID.test(id));
    if (threads.length > 0) test = { threads, percent: value.test.percent, phase: parsePhase(value.test.phase) };
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    version: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : enabledByDefault,
    enabledBy: typeof value.enabledBy === "string" ? value.enabledBy : null,
    enabledAt: num(value.enabledAt),
    phase: parsePhase(value.phase),
    consentBy: typeof value.consentBy === "string" ? value.consentBy : null,
    test,
    lastResetAt: num(value.lastResetAt),
    interimImportedMtimeMs: num(value.interimImportedMtimeMs),
    stoppedSinceStage2: num(value.stoppedSinceStage2) ?? 0,
    stoppedThreads: Array.isArray(value.stoppedThreads)
      ? value.stoppedThreads.filter((id): id is string => typeof id === "string" && THREAD_ID.test(id)).slice(0, MAX_STOPPED_IDS)
      : [],
    pendingRestore: value.pendingRestore === true,
  };
}

function httpStatus(error: unknown): number | null {
  if (isRecord(error) && typeof error.status === "number") return error.status;
  const match = /\bHTTP (\d{3})\b/.exec(errorText(error));
  return match === null ? null : Number(match[1]);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createGuard(bb: BbPluginApi, profile: Profile, opts: GuardOptions): Guard {
  const provider = profile.providerId;
  /** « Codex» after «Сторож» in texts; nothing for Claude — its texts read as before 0.2.0. */
  const who = profile.key === "claude" ? "" : ` ${profile.title}`;
  const K = kvKeys(profile);
  const clock = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 90_000;
  const minReadMs = opts.minReadMs ?? 60_000;
  const reseatDelayMs = opts.reseatDelayMs ?? 1_000;
  const sendNowGraceMs = opts.sendNowGraceMs ?? SEND_NOW_GRACE_MS;
  const stopBudgetMs = opts.stopBudgetMs ?? STOP_BUDGET_MS;

  // ── memory ───────────────────────────────────────────────────────────
  let state = initialState(profile.enabledByDefault);
  let saved: SavedMap = {};
  let savedTest: SavedMap = {};
  let reading: { percent: number; resetsAt: string | null; at: number } | null = null;
  let status: StoredStatus = { lastCheckedAt: null, lastError: null, lastPass: null, lastNotify: null, reseat: emptyReseat() };
  let thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  let target: Target = resolveSettings(profile, {}).target;
  let thresholdsProblem: string | null = null;
  let telegram = true;
  let scope: Set<string> | null = null;
  let needFullPass = false;
  let lastReadAttemptAt = 0;
  let disposed = false;
  /** A background «give the models back» is running. */
  let restoring = false;

  const providers = new Map<string, string>();
  const onTarget = new Set<string>();
  const failedSwitch = new Set<string>();
  /** Stops in flight: a second stop of the same thread joins the first instead of being dropped. */
  const stopping = new Map<string, Promise<void>>();
  let grants: Array<{ threadId: string; at: number }> = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const reseatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const reseatChains = new Map<string, Promise<void>>();
  /** Threads running a Send-now turn on stage 2 — not stopped until they go idle. */
  const sendNowThreads = new Set<string>();
  /** Held rows the re-queue leaves for Send now (counted once). */
  const skippedRows = new Set<string>();

  // ── helpers ──────────────────────────────────────────────────────────
  function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
    return timer;
  }

  /** Fire and forget without ever crashing the plugin (a detached rejection counts as a crash). */
  function safe(label: string, fn: () => Promise<unknown>): void {
    void fn().catch((error) => {
      try {
        bb.log.warn(`${label}: ${errorText(error)}`);
      } catch {
        // the plugin may be disposed
      }
    });
  }

  /** `quiet` — kept for `status` only: a switched-off guard (a Codex nobody uses) must not fill the log every 90 s. */
  function recordError(where: string, error: unknown, quiet = false): void {
    const message = `${where}: ${errorText(error)}`.slice(0, 500);
    status.lastError = { at: clock(), message };
    if (quiet) bb.log.debug(message);
    else bb.log.warn(message);
  }

  function guardInfo(): GuardInfo {
    return { profile, target };
  }

  /** «[тест] » in log lines of the test mode. */
  function testMark(): string {
    return state.test !== null ? "[тест] " : "";
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

  function view(): PolicyView {
    // Off: stage 0 for the hook, the events, the stops, the re-queue and the agent hint —
    // one place, so nothing can act on a stage the guard no longer enforces.
    const guard = guardInfo();
    if (!state.enabled) return { stage: 0, consent: false, dripFrom: null, scope, thresholds, guard };
    const phase = phaseNow();
    return { stage: phase.stage, consent: phase.consent, dripFrom: phase.dripFrom, scope, thresholds, guard };
  }

  function savedMap(): SavedMap {
    return state.test !== null ? savedTest : saved;
  }

  function recheck(): void {
    safe("recheck", () => bb.experimental_hooks.recheck("message.dispatch"));
  }

  // ── persistence ──────────────────────────────────────────────────────
  async function persistState(): Promise<void> {
    await bb.storage.kv.set(K.state, state);
  }
  async function persistSaved(): Promise<void> {
    if (state.test !== null) await bb.storage.kv.set(K.savedTest, savedTest);
    else await bb.storage.kv.set(K.saved, saved);
  }
  async function persistStatus(): Promise<void> {
    await bb.storage.kv.set(K.status, status);
  }

  async function load(): Promise<void> {
    const [rawState, rawSaved, rawSavedTest, rawReading, rawStatus] = await Promise.all([
      bb.storage.kv.get<unknown>(K.state),
      bb.storage.kv.get<unknown>(K.saved),
      bb.storage.kv.get<unknown>(K.savedTest),
      bb.storage.kv.get<unknown>(K.reading),
      bb.storage.kv.get<unknown>(K.status),
    ]);
    state = parseState(rawState, profile.enabledByDefault);
    saved = parseSaved(rawSaved);
    savedTest = parseSaved(rawSavedTest);
    if (isRecord(rawReading) && typeof rawReading.percent === "number" && typeof rawReading.at === "number") {
      reading = {
        percent: rawReading.percent,
        resetsAt: typeof rawReading.resetsAt === "string" ? rawReading.resetsAt : null,
        at: rawReading.at,
      };
    }
    if (isRecord(rawStatus)) {
      status = {
        lastCheckedAt: typeof rawStatus.lastCheckedAt === "number" ? rawStatus.lastCheckedAt : null,
        lastError: isRecord(rawStatus.lastError) ? (rawStatus.lastError as StoredStatus["lastError"]) : null,
        lastPass: isRecord(rawStatus.lastPass) ? (rawStatus.lastPass as unknown as PassStats) : null,
        lastNotify: isRecord(rawStatus.lastNotify) ? (rawStatus.lastNotify as unknown as NotifyRecord) : null,
        reseat: isRecord(rawStatus.reseat) ? { ...emptyReseat(), ...(rawStatus.reseat as Partial<ReseatStats>) } : emptyReseat(),
      };
    }
    scope = state.test !== null ? new Set(state.test.threads) : null;
    needFullPass = phaseNow().stage >= 1;
  }

  // ── settings ─────────────────────────────────────────────────────────
  /** True when the target changed: threads marked «on target» under the old one must be checked again. */
  function applySettings(values: Record<string, unknown>): boolean {
    const resolved = resolveSettings(profile, values);
    const changed = resolved.target.model !== target.model || resolved.target.effort !== target.effort;
    thresholds = resolved.thresholds;
    target = resolved.target;
    thresholdsProblem = resolved.problem;
    if (resolved.problem !== null) bb.log.warn(`${profile.title}: ${resolved.problem}`);
    telegram = values.telegram !== false;
    if (changed) {
      onTarget.clear();
      failedSwitch.clear();
      needFullPass = true;
    }
    return changed;
  }

  /**
   * A model set in the settings must be in the provider's catalog: a mistyped id would make every
   * `threads.update` fail and hold every turn from the first threshold on. Not in the catalog — the
   * threads keep their models (the effort still goes down), the reason is in `status`. Claude's target
   * is a constant and is not checked. A catalog that cannot be read leaves the target as set.
   */
  async function verifyTarget(): Promise<void> {
    if (profile.key === "claude" || target.model === null) return;
    const wanted = target.model;
    let ids: string[];
    try {
      const options = await bb.sdk.system.executionOptions({ providerId: provider, signal: AbortSignal.timeout(20_000) });
      if (options.modelLoadError !== null || options.models.length === 0) return;
      ids = options.models.flatMap((m) => [m.id, m.model]);
    } catch (error) {
      bb.log.warn(`каталог моделей ${profile.title} не прочитан (модель из настроек не проверена): ${errorText(error)}`);
      return;
    }
    if (ids.includes(wanted) || target.model !== wanted) return;
    target = { ...target, model: null };
    onTarget.clear();
    needFullPass = true;
    const problem = `модели «${wanted}» нет в каталоге ${profile.title} — треды остаются на своих моделях`;
    thresholdsProblem = thresholdsProblem === null ? problem : `${thresholdsProblem}; ${problem}`;
    bb.log.warn(`${profile.title}: ${problem}`);
  }

  function onSettings(values: Record<string, unknown>): void {
    const changed = applySettings(values);
    safe("пересчёт после настроек", async () => {
      await verifyTarget();
      await tick(false);
      if (changed) recheck();
    });
  }

  const ready: Promise<void> = (async () => {
    try {
      await load();
    } catch (error) {
      recordError("загрузка состояния", error);
    }
    try {
      applySettings(await opts.settings.get());
      await verifyTarget();
    } catch (error) {
      recordError("настройки", error);
    }
    try {
      await importInterim();
    } catch (error) {
      recordError("импорт state.json", error);
    }
  })();

  // ── import from the interim script ───────────────────────────────────
  async function importInterim(): Promise<void> {
    const path = opts.interimStatePath;
    if (path === null) return;
    let mtimeMs: number;
    let size: number;
    try {
      const info = await stat(path);
      mtimeMs = info.mtimeMs;
      size = info.size;
    } catch {
      return; // no file — nothing to import
    }
    if (!shouldImport({ mtimeMs, importedMtimeMs: state.interimImportedMtimeMs, lastResetAt: state.lastResetAt })) return;
    if (size > 2 * 1024 * 1024) throw new Error(`${path} больше 2 МБ — не читаю`);
    const json: unknown = JSON.parse(await readFile(path, "utf8"));
    const from = parseSaved(isRecord(json) ? json.saved : undefined);
    const { merged, added } = mergeSaved(saved, from);
    saved = merged;
    state.interimImportedMtimeMs = mtimeMs;
    await bb.storage.kv.set(K.saved, saved);
    await persistState();
    bb.log.info(`импорт из ${path}: добавлено прежних моделей ${added} (в файле ${Object.keys(from).length})`);
  }

  // ── reading ──────────────────────────────────────────────────────────
  /** "skipped" — read less than minReadMs ago (Anthropic answers 429 to frequent checks). */
  async function readUsage(): Promise<"fresh" | "skipped" | "failed"> {
    const now = clock();
    if (now - lastReadAttemptAt < minReadMs) return "skipped";
    lastReadAttemptAt = now;
    try {
      const response = await bb.sdk.system.usageLimits({ providerId: provider, signal: AbortSignal.timeout(30_000) });
      const pick = pickWeekly(response, provider);
      if (!pick.ok) throw new Error(pick.error);
      reading = { ...pick.reading, at: clock() };
      status.lastCheckedAt = reading.at;
      await bb.storage.kv.set(K.reading, reading);
      return "fresh";
    } catch (error) {
      recordError("чтение лимита (стадия не меняется)", error, !state.enabled);
      return "failed";
    }
  }

  // ── threads ──────────────────────────────────────────────────────────
  async function listThreads() {
    const rows: Awaited<ReturnType<Sdk["threads"]["list"]>> = [];
    for (let offset = 0; offset < 50_000; offset += PAGE) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: PAGE, offset });
      for (const row of page) {
        providers.set(row.id, row.providerId);
        rows.push(row);
      }
      if (page.length < PAGE) break;
    }
    return rows;
  }

  async function providerOf(threadId: string): Promise<string | null> {
    const known = providers.get(threadId);
    if (known !== undefined) return known;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      providers.set(threadId, thread.providerId);
      return thread.providerId;
    } catch (error) {
      bb.log.warn(`threads.get ${threadId}: ${errorText(error)}`);
      return null;
    }
  }

  /** Save the previous model (once) and put each thread on the target (Sonnet xhigh for Claude). */
  async function switchThreads(ids: readonly string[], full: boolean): Promise<PassStats> {
    const map = savedMap();
    let failed = 0;
    const options = await mapLimit(ids, PARALLEL, async (threadId) => {
      if (disposed || !state.enabled) return null; // unloaded or switched off mid-pass: nothing more is touched
      try {
        return { threadId, opts: await bb.sdk.threads.defaultExecutionOptions({ threadId }) };
      } catch (error) {
        // Gone meanwhile (a spawn the hook rejected is deleted by core) — not a failure.
        if (httpStatus(error) === 404) return null;
        failed += 1;
        failedSwitch.add(threadId);
        bb.log.warn(`defaultExecutionOptions ${threadId}: ${errorText(error)}`);
        return null;
      }
    });
    const toSwitch: string[] = [];
    const current = new Map<string, { model: string | null; reasoningLevel: string | null }>();
    let savedChanged = false;
    for (const item of options) {
      if (item === null || item.opts === null) continue;
      if (isOnTarget(guardInfo(), item.opts)) {
        onTarget.add(item.threadId);
        failedSwitch.delete(item.threadId);
        continue;
      }
      if (!(item.threadId in map)) {
        map[item.threadId] = savedEntry(guardInfo(), item.opts);
        savedChanged = true;
      }
      toSwitch.push(item.threadId);
      current.set(item.threadId, item.opts);
    }
    // The previous models are stored before any thread is touched.
    if (savedChanged) await persistSaved();
    const g = guardInfo();
    const results = await mapLimit(toSwitch, PARALLEL, async (threadId) => {
      if (disposed || !state.enabled) return null; // skipped, not failed
      try {
        await bb.sdk.threads.update({ threadId, ...targetUpdate(g, current.get(threadId) ?? null) } as UpdateArgs);
        onTarget.add(threadId);
        failedSwitch.delete(threadId);
        return true;
      } catch (error) {
        failedSwitch.add(threadId);
        bb.log.warn(`threads.update ${threadId} → ${targetExec(target)}: ${errorText(error)}`);
        return false;
      }
    });
    const switched = results.filter((r) => r === true).length;
    const failures = failed + results.filter((r) => r === false).length;
    if (switched > 0 || failures > 0) {
      bb.log.info(`${testMark()}на ${targetLabel(target)} переведено ${switched}, не удалось ${failures} (проверено ${ids.length})`);
    }
    if (failures > 0) status.lastError = { at: clock(), message: `перевод на ${targetShort(target)}: не удалось ${failures} тредам (повторю на следующей проверке)` };
    return { at: clock(), full, checked: ids.length, switched, failed: failures };
  }

  async function switchPass(full: boolean): Promise<PassStats> {
    const now = clock();
    const rows = await listThreads();
    const ids = rows
      .filter((row) => scope === null || scope.has(row.id))
      .filter((row) => wantsCheck(row, now, full, provider) || (isLiveClaudeThread(row, provider) && failedSwitch.has(row.id)))
      .map((row) => row.id);
    return await switchThreads(ids, full);
  }

  /** Give every saved thread its previous model back; keeps entries that failed for a passing reason. */
  async function restoreAll(): Promise<{ restored: number; kept: number }> {
    const map = savedMap();
    let restored = 0;
    for (const [threadId, previous] of Object.entries(map)) {
      if (disposed) break; // unloaded mid-way: what is left stays saved for the next instance
      let outcome: "done" | "drop" | "keep" = "drop";
      for (const attempt of restoreAttempts(guardInfo(), previous, restoreModels)) {
        try {
          await bb.sdk.threads.update({ threadId, ...attempt } as UpdateArgs);
          outcome = "done";
          break;
        } catch (error) {
          const code = httpStatus(error);
          if (code === 404 || code === 410) break; // the thread is gone
          if (code === 400 || code === 409 || code === 422) {
            bb.log.warn(`возврат ${threadId} → ${"model" in attempt ? String(attempt.model) : `effort ${String(attempt.reasoningLevel)}`}: ${errorText(error)}`);
            continue;
          }
          outcome = "keep";
          bb.log.warn(`возврат ${threadId}: ${errorText(error)} — повторю позже`);
          break;
        }
      }
      if (outcome === "done") restored += 1;
      if (outcome !== "keep") delete map[threadId];
      onTarget.delete(threadId);
    }
    await persistSaved();
    const kept = Object.keys(map).length;
    bb.log.info(`${testMark()}вернул прежние модели: ${restored}, отложено: ${kept}`);
    return { restored, kept };
  }

  /** Models a reset could not give back yet (real mode: flagged at the reset; test mode: whatever is left). */
  function restoreLeft(): boolean {
    if (state.test !== null) return Object.keys(savedTest).length > 0;
    return state.pendingRestore && Object.keys(saved).length > 0;
  }

  /** Stage 2 without consent, the thread guarded and not running the user's Send now. */
  function stopWanted(threadId: string): boolean {
    const v = view();
    return v.stage === 2 && !v.consent && inScope(v, threadId) && !sendNowThreads.has(threadId);
  }

  function noteStopped(threadId: string): void {
    state.stoppedSinceStage2 += 1;
    if (!state.stoppedThreads.includes(threadId) && state.stoppedThreads.length < MAX_STOPPED_IDS) {
      state.stoppedThreads.push(threadId);
    }
  }

  /**
   * Stop one thread. Concurrent stops of the same thread share one call; a later
   * stop (a new turn after the previous stop) is a new call — nothing is dropped.
   * The stage is re-checked right before the call: consent may have come while
   * a pass was on its way here.
   */
  function stopThread(threadId: string): Promise<void> {
    const inFlight = stopping.get(threadId);
    if (inFlight !== undefined) return inFlight;
    if (!stopWanted(threadId)) return Promise.resolve();
    const run = (async () => {
      await bb.sdk.threads.stop({ threadId });
      noteStopped(threadId);
      bb.log.info(`${testMark()}стадия 2: остановил ${threadId}`);
    })().finally(() => {
      if (stopping.get(threadId) === run) stopping.delete(threadId);
    });
    stopping.set(threadId, run);
    return run;
  }

  /** Waits for `promise` at most `ms`; what is left keeps running. */
  function atMost(promise: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
    return Promise.race([promise.then(() => undefined), budget]).finally(() => clearTimeout(timer));
  }

  async function stopRunning(): Promise<void> {
    const running = await bb.sdk.threads.listRunning();
    const ids = running.map((row) => row.id).filter((id) => stopWanted(id));
    const all = mapLimit(ids, 4, async (threadId) => {
      if (disposed || (await providerOf(threadId)) !== provider) return;
      try {
        await stopThread(threadId);
      } catch (error) {
        recordError(`остановка ${threadId}`, error);
      }
    })
      .then(() => (disposed ? undefined : persistState()))
      .catch((error: unknown) => recordError("остановка тредов", error));
    await atMost(all, stopBudgetMs);
  }

  /**
   * A turn of the provider started on stage 2 (`thread.active`): a turn past the hook
   * (a notice to a parent, compaction) — or the user's Send now, whose
   * `message.dispatched` comes a moment AFTER `thread.active`. So decide after
   * a short grace; a stop still in flight is waited for, then the thread is
   * stopped again if it runs.
   */
  function stopLater(threadId: string): void {
    later(sendNowGraceMs, () => {
      safe(`остановка ${threadId}`, async () => {
        const inFlight = stopping.get(threadId);
        if (inFlight !== undefined) await inFlight.catch(() => undefined);
        if (disposed || !stopWanted(threadId)) return;
        // Never stop an idle thread: a manual stop pauses its queue.
        const running = await bb.sdk.threads.listRunning();
        if (!running.some((row) => row.id === threadId)) return;
        await stopThread(threadId);
        if (!disposed) await persistState();
      });
    });
  }

  // ── notifications ────────────────────────────────────────────────────
  function notify(kind: NotifyKind): void {
    const at = clock();
    if (!telegram) {
      status.lastNotify = { at, kind, ok: false, message: "Telegram выключен в настройках плагина" };
      return;
    }
    const note = notificationFor(kind, snapshot());
    bb.log.info(`уведомление ${kind}: ${note.note}`);
    safe("уведомление", async () => {
      let record: NotifyRecord;
      try {
        record = await opts.notifier(kind, note);
      } catch (error) {
        record = { at, kind, ok: false, message: errorText(error) };
      }
      status.lastNotify = record;
      if (!record.ok) bb.log.warn(`уведомление ${kind} не доставлено: ${record.message}`);
      if (!disposed) await persistStatus();
    });
  }

  // ── one step of the guard ────────────────────────────────────────────
  /** `advanceReal: false` — this tick's reading failed: the real stage stays as it is. */
  async function apply(advanceReal = true): Promise<void> {
    if (!state.enabled) {
      // Off: the reading above keeps the card fresh; the stage is not advanced and nothing is touched.
      await persistStatus();
      return;
    }
    const now = clock();
    const test = state.test;
    const before = phaseNow();
    let step: Step;
    if (test !== null) step = advanceTest(test.phase, test.percent, thresholds);
    else if (reading !== null && advanceReal) step = advance(state.phase, reading, thresholds, now);
    else step = { phase: state.phase, reset: false, entered: null };
    // The hook sees the new stage right away; the passes below catch up.
    if (test !== null) test.phase = step.phase;
    else state.phase = step.phase;
    const after = step.phase;
    const changed = step.reset || after.stage !== before.stage || after.consent !== before.consent;
    if (changed) sendNowThreads.clear();

    if (step.reset) {
      bb.log.info(`${testMark()}сброс недели: стадия 0, согласие снято, возвращаю модели`);
      if (test === null) state.lastResetAt = now;
      state.stoppedSinceStage2 = 0;
      state.stoppedThreads = [];
      failedSwitch.clear();
      try {
        const { kept } = await restoreAll();
        if (test === null) state.pendingRestore = kept > 0;
      } catch (error) {
        if (test === null) state.pendingRestore = true;
        recordError("возврат моделей", error);
      }
      onTarget.clear();
    } else if (after.stage === 0 && restoreLeft()) {
      try {
        const { kept } = await restoreAll();
        if (test === null) state.pendingRestore = kept > 0;
      } catch (error) {
        recordError("повторный возврат моделей", error);
      }
    }

    if (after.stage === 2 && !after.consent) {
      if (step.entered === 2) {
        state.stoppedSinceStage2 = 0;
        state.stoppedThreads = [];
      }
      try {
        await stopRunning();
      } catch (error) {
        recordError("остановка тредов", error);
      }
    }

    if (after.stage >= 1) {
      const full = step.entered !== null || needFullPass;
      try {
        if (full && test === null) await importInterim();
        status.lastPass = await switchPass(full);
        if (full) needFullPass = false;
      } catch (error) {
        if (full) needFullPass = true;
        recordError(`перевод тредов на ${targetShort(target)}`, error);
      }
    }

    await persistState();
    await persistStatus();
    if (changed || inDripWindow(after, now)) recheck();
    if (step.entered === 2) notify("enter-2");
    else if (step.entered === 1) notify("enter-1");
  }

  function tick(read: boolean): Promise<void> {
    return exclusive(async () => {
      if (disposed) return;
      await ready;
      try {
        const result = read ? await readUsage() : "skipped";
        await apply(result !== "failed");
      } catch (error) {
        recordError("проход сторожа", error);
      }
    });
  }

  let readTimer: ReturnType<typeof setTimeout> | null = null;
  /** Out-of-turn reading on thread.idle / turn.failed — not more often than minReadMs. */
  function requestRead(): void {
    if (readTimer !== null) return;
    const wait = Math.max(0, lastReadAttemptAt + minReadMs - clock());
    readTimer = later(wait, () => {
      readTimer = null;
      safe("внеочередная проверка", () => tick(true));
    });
  }

  function scheduleDripEnd(dripFrom: number | null): void {
    if (dripFrom === null) return;
    const left = dripFrom + DRIP_WINDOW_MS - clock();
    if (left > 0) later(left + 1_000, recheck);
  }

  // ── re-queueing held rows on the target ──────────────────────────────
  function scheduleReseat(threadId: string): void {
    if (reseatTimers.has(threadId) || disposed) return;
    const timer = setTimeout(() => {
      reseatTimers.delete(threadId);
      if (disposed) return;
      const previous = reseatChains.get(threadId) ?? Promise.resolve();
      const next = previous
        .then(() => reseatThread(threadId))
        .catch((error) => {
          status.reseat.failed += 1;
          recordError(`перестановка очереди ${threadId}`, error);
        })
        .finally(() => {
          if (reseatChains.get(threadId) === next) reseatChains.delete(threadId);
        });
      reseatChains.set(threadId, next);
    }, reseatDelayMs);
    timer.unref?.();
    reseatTimers.set(threadId, timer);
  }

  function rowInput(row: QueuedRow): CreateRowArgs["input"] {
    return row.content as unknown as CreateRowArgs["input"];
  }

  /**
   * The thread's previous model, saved before its first turn on the target. The
   * pass over all threads may not have reached this one yet (the hook sees the
   * new stage at once, the re-queue fires a second later): once a turn on the
   * target ran, `defaultExecutionOptions` would answer the target and the
   * previous model would be lost. A thread already on the target has nothing to save.
   */
  async function rememberPrevious(threadId: string): Promise<void> {
    const map = savedMap();
    if (threadId in map || onTarget.has(threadId)) return;
    try {
      const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId });
      if (opts === null || isOnTarget(guardInfo(), opts) || threadId in map) return;
      map[threadId] = savedEntry(guardInfo(), opts);
      await persistSaved();
    } catch (error) {
      bb.log.warn(`очередь ${threadId}: прежнюю модель не сохранить: ${errorText(error)}`);
    }
  }

  /** Stage ≥ 1, the thread in scope, the guard on and loaded — re-asked between the steps of a re-queue. */
  function guarding(threadId: string): boolean {
    if (disposed) return false;
    const v = view();
    return v.stage >= 1 && inScope(v, threadId);
  }

  async function reseatThread(threadId: string): Promise<void> {
    if (!guarding(threadId)) return;
    const thread = await bb.sdk.threads.get({ threadId });
    providers.set(threadId, thread.providerId);
    if (thread.providerId !== provider || thread.archivedAt !== null) return;
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
    if (!guarding(threadId)) return;
    const g = guardInfo();
    const steps = planReseat(rows, thread.status, (row) => holdsExecution(g, row.model, row.reasoningLevel));
    if (steps.length === 0) return;
    if (steps.some((step) => step.kind !== "skip")) await rememberPrevious(threadId);
    // The queue as our own steps change it: a copy goes right after the row now before the original.
    const order = rows.map((r) => r.id);
    let changed = false;
    for (const step of steps) {
      // Switched off (or unloaded) mid-way: the rows not yet moved stay as they are.
      if (!guarding(threadId)) break;
      const row = step.row;
      if (step.kind === "skip") {
        // A held row is re-attempted again and again; count and log it once.
        if (!skippedRows.has(row.id)) {
          if (skippedRows.size > 5_000) skippedRows.clear();
          skippedRows.add(row.id);
          status.reseat.skipped += 1;
          status.reseat.lastSkip = `${threadId}: ${step.why}`;
          bb.log.info(`очередь ${threadId}: строка ${row.id} остаётся придержанной (${step.why}) — Send now или сброс недели`);
        }
        continue;
      }
      const next = executionFor(g, row.model, row.reasoningLevel);
      const execution: Pick<CreateRowArgs, "model" | "reasoningLevel" | "permissionMode" | "serviceTier" | "senderThreadId"> = {
        model: next.model ?? row.model,
        reasoningLevel: next.reasoningLevel as CreateRowArgs["reasoningLevel"],
        permissionMode: row.permissionMode,
        serviceTier: row.serviceTier,
        ...(row.senderThreadId !== null ? { senderThreadId: row.senderThreadId } : {}),
      };
      if (step.kind === "copy") {
        // Copy first, then delete: nothing is lost if a call fails.
        const copy = await bb.sdk.threads.queuedMessages.create({ threadId, input: rowInput(row), ...execution });
        const at = order.indexOf(row.id);
        const previousId = at > 0 ? order[at - 1]! : null;
        try {
          await bb.sdk.threads.queuedMessages.reorder({
            threadId,
            queuedMessageId: copy.id,
            previousQueuedMessageId: previousId,
            nextQueuedMessageId: row.id,
          });
          order.splice(at, 0, copy.id);
        } catch (error) {
          order.push(copy.id);
          bb.log.warn(`очередь ${threadId}: копия ${copy.id} осталась в конце очереди: ${errorText(error)}`);
        }
        try {
          await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
        } catch (error) {
          // The original already went (Send now) or was deleted: drop the copy, no duplicate.
          await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: copy.id }).catch(() => undefined);
          order.splice(order.indexOf(copy.id), 1);
          bb.log.warn(`очередь ${threadId}: строку ${row.id} не удалить (${errorText(error)}) — копию убрал`);
          continue;
        }
        order.splice(order.indexOf(row.id), 1);
        status.reseat.copied += 1;
        changed = true;
        bb.log.info(`очередь ${threadId}: строка ${row.id} (${row.model}) → ${copy.id} на ${targetExec(g.target)}`);
      } else {
        // The held row goes first: if it is already gone (Send now, deleted), nothing is sent — no
        // duplicate. Then a new turn on the target (queue-if-active: never steers into a turn that
        // started meanwhile). If the send fails, the message is queued back on the target — not lost.
        try {
          await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id });
        } catch (error) {
          bb.log.warn(`очередь ${threadId}: строки ${row.id} уже нет (${errorText(error)}) — не отправляю`);
          continue;
        }
        const at = order.indexOf(row.id);
        if (at !== -1) order.splice(at, 1);
        changed = true;
        const send: SendArgs = { threadId, mode: "queue-if-active", input: rowInput(row) as SendArgs["input"], ...execution };
        let sent: Awaited<ReturnType<Sdk["threads"]["send"]>>;
        try {
          sent = await bb.sdk.threads.send(send);
        } catch (error) {
          status.reseat.failed += 1;
          recordError(`очередь ${threadId}: новый ход на ${targetShort(g.target)} не ушёл`, error);
          // Back on the target; if the target itself is refused (a model gone from the catalog), back as it was —
          // held again rather than lost.
          const asItWas = { ...execution, model: row.model, reasoningLevel: row.reasoningLevel as CreateRowArgs["reasoningLevel"] };
          const back = await bb.sdk.threads.queuedMessages
            .create({ threadId, input: rowInput(row), ...execution })
            .catch(() => bb.sdk.threads.queuedMessages.create({ threadId, input: rowInput(row), ...asItWas }))
            .catch((createError: unknown) => {
              recordError(`очередь ${threadId}: строку ${row.id} не вернуть — текст: «${JSON.stringify(row.content).slice(0, 160)}»`, createError);
              return null;
            });
          if (back !== null) order.push(back.id);
          continue;
        }
        status.reseat.sent += 1;
        if (sent.delivery === "queued") {
          // Held (stage 2, the drip window, another plugin): BB put the new row at the END of the
          // queue. Move it where the original stood, so the copies below stay behind it.
          const id = sent.queuedMessage.id;
          const nextId = at === -1 ? undefined : order[at];
          if (nextId === undefined) {
            order.push(id); // it stood last anyway
          } else {
            try {
              await bb.sdk.threads.queuedMessages.reorder({
                threadId,
                queuedMessageId: id,
                previousQueuedMessageId: at > 0 ? order[at - 1]! : null,
                nextQueuedMessageId: nextId,
              });
              order.splice(at, 0, id);
            } catch (error) {
              order.push(id);
              bb.log.warn(`очередь ${threadId}: строка ${id} на ${targetShort(g.target)} осталась в конце очереди: ${errorText(error)}`);
            }
          }
          bb.log.info(`очередь ${threadId}: строка ${row.id} (${row.model}) → ${id} на ${targetExec(g.target)}, ждёт на своём месте в очереди`);
          continue;
        }
        bb.log.info(`очередь ${threadId}: ${row.payload.kind === "retry" ? "повтор" : "строка"} ${row.id} (${row.model}) ушла новым ходом на ${targetExec(g.target)}`);
      }
    }
    if (changed) recheck();
  }

  // ── hook (registered once for both guards in server/wire.ts) ─────────
  async function countRunningClaude(): Promise<number> {
    const running = await bb.sdk.threads.listRunning();
    const now = clock();
    grants = grants.filter((grant) => now - grant.at < GRANT_TTL_MS);
    const ids = new Set<string>();
    for (const row of running) {
      if (scope !== null && !scope.has(row.id)) continue;
      const known = providers.get(row.id);
      if (known === undefined || known === provider) ids.add(row.id);
    }
    for (const grant of grants) ids.add(grant.threadId);
    return ids.size;
  }

  const hook = createDispatchHook({
    view,
    ready: () => ready,
    countRunningClaude,
    onGranted: (threadId) => grants.push({ threadId, at: clock() }),
    onReseat: scheduleReseat,
    onSeen: (threadId, providerId) => providers.set(threadId, providerId),
    warn: (message) => bb.log.warn(message),
    now: clock,
  });

  // ── agents (one agents.configure for both guards in server/wire.ts) ──
  /** Agents of this guard's provider only: the others are never pushed onto this provider's target. */
  function agentHint(ctx: { thread: { id: string }; provider?: { id: string } | null }): string | null {
    try {
      const v = view();
      if (v.stage >= 1 && ctx.provider?.id === provider && inScope(v, ctx.thread.id)) return agentInstruction(v.thresholds, v.guard);
    } catch {
      // never fail the thread's configuration over a hint
    }
    return null;
  }

  // ── events (additive in the SDK: each guard listens on its own) ──────
  function guards(threadId: string, providerId: string): boolean {
    const v = view();
    return providerId === provider && inScope(v, threadId) && v.stage >= 1;
  }

  bb.events.on("thread.created", ({ thread }) => {
    providers.set(thread.id, thread.providerId);
    if (!guards(thread.id, thread.providerId)) return;
    safe(`новый тред ${thread.id}`, () => exclusive(() => switchThreads([thread.id], false)));
  });

  bb.events.on("thread.active", ({ thread }) => {
    providers.set(thread.id, thread.providerId);
    if (!guards(thread.id, thread.providerId)) return;
    const v = view();
    if (v.stage === 2 && !v.consent) {
      // Turns that bypass the hook (notices to a parent, compaction) are caught here;
      // the user's own Send now is his per-message override and runs (stopLater waits for
      // its message.dispatched, which BB emits after thread.active).
      if (!sendNowThreads.has(thread.id)) stopLater(thread.id);
      return;
    }
    if (!onTarget.has(thread.id)) safe(`тред ${thread.id}`, () => exclusive(() => switchThreads([thread.id], false)));
  });

  bb.events.on("thread.idle", ({ thread }) => {
    providers.set(thread.id, thread.providerId);
    sendNowThreads.delete(thread.id);
    requestRead();
    if (inDripWindow(phaseNow(), clock())) recheck();
  });

  bb.events.on("thread.failed", ({ thread }) => {
    providers.set(thread.id, thread.providerId);
    sendNowThreads.delete(thread.id);
    if (inDripWindow(phaseNow(), clock())) recheck();
  });

  bb.events.on("turn.failed", () => {
    requestRead();
  });

  bb.events.on("message.queued", ({ entry }) => {
    const v = view();
    if (v.stage < 1 || !inScope(v, entry.threadId)) return;
    if (!isHeldByGuard(entry) || !holdsExecution(v.guard, entry.model, entry.reasoningLevel)) return;
    const known = providers.get(entry.threadId);
    if (known !== undefined && known !== provider) return;
    scheduleReseat(entry.threadId);
  });

  bb.events.on("message.dispatched", ({ entry }) => {
    // A claimed row keeps its wait in the event (BB: claiming sets claimedAt only), so a row
    // that still carries the guard's stage-2 hold went out past the hook — only Send now does
    // that on stage 2. Read from the row itself, this survives a reload of the plugin.
    const reason = entry.waitingOn?.kind === "plugin" ? (entry.waitingOn.reason ?? "") : "";
    if (!isHeldByGuard(entry) || !reason.includes(STOP_MARK)) return;
    const known = providers.get(entry.threadId);
    if (known !== undefined && known !== provider) return; // the other guard's hold
    const v = view();
    if (v.stage === 2 && !v.consent && inScope(v, entry.threadId)) {
      sendNowThreads.add(entry.threadId);
      bb.log.info(`стадия 2: Send now в ${entry.threadId} — этот ход не останавливаю`);
    }
  });

  // ── background ───────────────────────────────────────────────────────
  /** Resolves after `ms` or at once when `signal` aborts. */
  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  bb.background.service(profile.service, {
    // BB gives a service 5 s to resolve after abort, or marks the plugin degraded and
    // drops a reloaded instance (d.ts: «start … should resolve when `signal` aborts»).
    // A pass can run much longer (326 threads, stops), so `start` stops waiting for it
    // on abort; the pass itself winds down on `disposed`.
    async start(signal) {
      const aborted = pause(2 ** 31 - 1, signal);
      await Promise.race([ready, aborted]);
      if (signal.aborted) return;
      scheduleDripEnd(phaseNow().dripFrom);
      while (!signal.aborted) {
        await Promise.race([tick(true).catch(() => undefined), aborted]);
        if (signal.aborted) break;
        await pause(pollMs, signal);
      }
    },
  });

  bb.onDispose(() => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    for (const timer of reseatTimers.values()) clearTimeout(timer);
    timers.clear();
    reseatTimers.clear();
  });

  // ── commands ─────────────────────────────────────────────────────────
  function snapshot(): StatusSnapshot {
    const phase = phaseNow();
    return {
      guard: guardInfo(),
      now: clock(),
      thresholds,
      thresholdsProblem,
      reading,
      lastCheckedAt: status.lastCheckedAt,
      lastError: status.lastError,
      stage: state.enabled ? phase.stage : 0,
      consent: state.enabled && phase.consent,
      consentAt: phase.consentAt,
      dripFrom: phase.dripFrom,
      consentBy: state.consentBy,
      saved: Object.keys(saved).length,
      onSonnet: onTarget.size,
      lastPass: status.lastPass,
      stoppedSinceStage2: state.stoppedSinceStage2,
      stoppedThreads: [...state.stoppedThreads],
      reseat: { ...status.reseat },
      lastNotify: status.lastNotify,
      telegram,
      test:
        state.test === null
          ? null
          : {
              threads: [...state.test.threads],
              percent: state.test.percent,
              stage: state.test.phase.stage,
              consent: state.test.phase.consent,
              saved: Object.keys(savedTest).length,
            },
      realStage: state.phase.stage,
      enabled: state.enabled,
      enabledBy: state.enabledBy,
      enabledAt: state.enabledAt,
      restoring,
    };
  }

  /**
   * the user's consent. Not queued behind `exclusive`: a pass may be waiting on
   * `threads.stop` for minutes, and the hook keeps holding the provider's turns
   * all that time. The phase changes in memory at once (the hook and `stopThread` read it),
   * a pass already running sees it before each stop and persists it with its state.
   */
  async function resume(caller: string): Promise<CommandResult> {
    await ready;
    const cmd = profile.cmd;
    if (!state.enabled) return { ok: false, text: `Сторож${who} выключен — согласие не нужно, ничего не держится. Включить: bb limit-guard on${cmd}` };
    const test = state.test;
    const phase = phaseNow();
    const mark = test !== null ? "[ТЕСТ] " : "";
    if (phase.consent) {
      return { ok: true, text: `${mark}Согласие уже дано${state.consentBy === null ? "" : ` (${state.consentBy})`} и действует до сброса недели.` };
    }
    const result = giveConsent(phase, clock());
    if (!result.ok) {
      return {
        ok: false,
        text: `Сейчас стадия 0 (${profile.weekWord} ниже ${thresholds.sonnet} %) — согласие не нужно, ничего не меняю. Дать его заранее можно со стадии 1.`,
      };
    }
    if (test !== null) test.phase = result.phase;
    else state.phase = result.phase;
    state.consentBy = caller;
    sendNowThreads.clear();
    try {
      await persistState();
    } catch (error) {
      recordError("сохранение согласия (в памяти оно уже действует)", error);
    }
    bb.log.info(`${testMark()}согласие до сброса недели${phase.stage === 1 ? " (заранее, на стадии 1)" : ""} — ${caller}`);
    recheck();
    scheduleDripEnd(result.phase.dripFrom);
    notify("consent");
    if (phase.stage === 1) {
      return {
        ok: true,
        text: [
          `${mark}Согласие дано заранее и действует до сброса недели.`,
          `На ${thresholds.stop} % работа ${provider} не встанет: идёт на ${targetExec(target)}. ${heldTurns(guardInfo())} по-прежнему переставляются на ${targetShort(target)}.`,
        ].join("\n"),
      };
    }
    const stopped = [...state.stoppedThreads];
    return {
      ok: true,
      text: [
        `${mark}Согласие принято до сброса недели.`,
        `Придержанные ходы ${provider} запускаются по очереди: первые 10 минут — не больше двух тредов одновременно, дальше — все.`,
        `Работа идёт на ${targetExec(target)}; стадию остановки сторож до сброса больше не ставит.`,
        ...(stopped.length > 0 ? [stoppedHint(stopped)] : []),
      ].join("\n"),
    };
  }

  async function endTestLocked(): Promise<{ restored: number; kept: number }> {
    let result = { restored: 0, kept: 0 };
    try {
      result = await restoreAll();
    } catch (error) {
      recordError("[тест] возврат моделей", error);
    }
    // What could not go back now waits in the real map: retried right away on a real stage 0,
    // given back at the real weekly reset otherwise.
    const leftovers = savedTest;
    state.test = null;
    scope = null;
    savedTest = {};
    if (Object.keys(leftovers).length > 0) {
      saved = mergeSaved(saved, leftovers).merged;
      if (state.phase.stage === 0) state.pendingRestore = true;
      await bb.storage.kv.set(K.saved, saved);
    }
    await bb.storage.kv.set(K.savedTest, savedTest);
    onTarget.clear();
    failedSwitch.clear();
    needFullPass = state.phase.stage >= 1;
    await persistState();
    recheck();
    return result;
  }

  async function startTest(threads: string[], percent: number, caller: string): Promise<CommandResult> {
    return exclusive(async () => {
      await ready;
      if (!state.enabled) return { ok: false, text: `Сторож${who} выключен — тест-режим не запускаю. Включить: bb limit-guard on${profile.cmd}` };
      const same = state.test !== null && state.test.threads.length === threads.length && threads.every((id) => scope?.has(id));
      if (state.test !== null && !same) await endTestLocked();
      if (state.test === null) {
        state.test = { threads, percent, phase: { ...INITIAL_PHASE } };
        savedTest = {};
        onTarget.clear();
        failedSwitch.clear();
      } else {
        state.test.percent = percent;
      }
      scope = new Set(threads);
      needFullPass = true;
      bb.log.info(`тест-режим${who}: ${threads.join(",")} · ${percent} % — ${caller}`);
      try {
        await apply();
      } catch (error) {
        recordError("[тест] проход", error);
      }
      const s = snapshot();
      const warnReal =
        reading !== null && reading.percent >= thresholds.sonnet
          ? `\nВнимание: реальная ${profile.weekWord} ${reading.percent} % — пока идёт тест, остальные треды${who} не охраняются.`
          : "";
      return {
        ok: true,
        text: `Тест-режим${who}: процент ${percent} → стадия ${s.test?.stage ?? "?"}. Действия только с тредами ${threads.join(", ")}; остальные — без изменений.\nВыключить и вернуть модели: bb limit-guard test${profile.cmd} --off${warnReal}`,
      };
    });
  }

  async function stopTest(caller: string): Promise<CommandResult> {
    return exclusive(async () => {
      await ready;
      if (state.test === null) return { ok: true, text: "Тест-режим и так выключен." };
      const result = await endTestLocked();
      bb.log.info(`тест-режим выключен — ${caller}`);
      try {
        await apply();
      } catch (error) {
        recordError("проход после теста", error);
      }
      return {
        ok: true,
        text: `Тест-режим${who} выключен. Прежние модели вернул: ${result.restored}${result.kept > 0 ? `, отложено (повторю): ${result.kept}` : ""}. Сторож снова охраняет все треды${who} (стадия ${state.phase.stage}).`,
      };
    });
  }

  /**
   * Off: the in-memory flag flips at once (the hook, the stops and the passes read it), the rest
   * waits for the guard's queue. Models of the threads are NOT touched — one click must not send
   * hundreds of threads back to Opus; `restoreModels` does that on purpose.
   * On: a fresh reading, then the stage is recomputed (stage 2 without consent stops work right away).
   */
  async function setEnabled(next: boolean, caller: string): Promise<CommandResult> {
    await ready;
    if (!next) {
      const already = !state.enabled;
      state.enabled = false;
      state.enabledBy = caller;
      state.enabledAt = clock();
      sendNowThreads.clear();
      grants = [];
      // Not behind the queue: a pass may sit minutes on `threads.stop`; the held rows go and the flag is stored now.
      recheck();
      safe("сохранение «выключен»", () => persistState());
      return await exclusive(async () => {
        if (state.test !== null) await endTestLocked();
        state.enabled = false;
        try {
          await persistState();
        } catch (error) {
          recordError("сохранение «выключен» (в памяти уже действует)", error);
        }
        recheck();
        if (!already) bb.log.info(`сторож${who} выключен — ${caller}`);
        const onSonnet = Object.keys(saved).length;
        const stopped = [...state.stoppedThreads];
        return {
          ok: true,
          text: [
            already
              ? `Сторож${who} и так выключен.`
              : `Сторож${who} выключен: ходы не удерживаются, треды не останавливаются и не переключаются, придержанные ходы уходят.`,
            onSonnet > 0
              ? `Модели не менялись: ${onSonnet} тредов, переведённых сторожем, остаются на ${targetExec(target)}. Вернуть прежние: bb limit-guard restore-models${profile.cmd}`
              : "Все треды на своих моделях.",
            ...(stopped.length > 0 ? [stoppedHint(stopped)] : []),
            `Включить: bb limit-guard on${profile.cmd}`,
          ].join("\n"),
        };
      });
    }
    return await exclusive(async () => {
      if (state.enabled) return { ok: true, text: `Сторож${who} и так включён.` };
      const read = await readUsage();
      state.enabled = true;
      state.enabledBy = caller;
      state.enabledAt = clock();
      needFullPass = true;
      sendNowThreads.clear();
      bb.log.info(`сторож${who} включён — ${caller}`);
      try {
        await apply(read !== "failed");
      } catch (error) {
        recordError("проход после включения", error);
      }
      recheck();
      const s = snapshot();
      const stale = read === "failed" && s.reading !== null ? ` Чтение лимита не удалось — данные от ${formatDateTime(s.reading.at)}.` : "";
      return {
        ok: true,
        text: `Сторож${who} включён: ${s.reading === null ? "неделя ещё не прочитана" : `неделя ${s.reading.percent} %`}, стадия ${s.stage}${
          s.stage === 2 && !s.consent ? ` — работа ${provider} остановлена до согласия (bb limit-guard resume${profile.cmd})` : ""
        }.${stale}`,
      };
    });
  }

  /** The saved previous models go back in the background; only with the guard off (or on stage 0). */
  async function restoreOnRequest(caller: string): Promise<CommandResult> {
    await ready;
    if (state.test !== null) return { ok: false, text: `Идёт тест-режим — сначала bb limit-guard test${profile.cmd} --off` };
    if (state.enabled && state.phase.stage >= 1) {
      return {
        ok: false,
        text: `Сторож${who} включён и на стадии ${state.phase.stage}: он сразу переключил бы треды обратно на ${targetShort(target)}. Сначала выключи его (bb limit-guard off${profile.cmd}); сам он вернёт модели при сбросе недели.`,
      };
    }
    const count = Object.keys(saved).length;
    if (restoring) return { ok: true, text: `Уже возвращаю прежние модели (осталось ${count}).` };
    if (count === 0) return { ok: true, text: "Возвращать нечего: прежних моделей не сохранено." };
    restoring = true;
    bb.log.info(`возврат прежних моделей${who} по просьбе (${count} тредов) — ${caller}`);
    safe("возврат моделей", () =>
      exclusive(async () => {
        try {
          // The queue may have moved on since the request (a tick put the stage up, a test started).
          if (state.test !== null || (state.enabled && state.phase.stage >= 1)) {
            bb.log.warn("возврат моделей отменён: за время ожидания в очереди сторож снова охраняет треды или идёт тест");
            return;
          }
          const { kept } = await restoreAll();
          state.pendingRestore = kept > 0;
          await persistState();
          onTarget.clear();
        } catch (error) {
          recordError("возврат моделей", error);
        } finally {
          restoring = false;
          recheck();
        }
      }),
    );
    return { ok: true, text: `Возвращаю прежние модели ${count} тредам в фоне; ход виден в bb limit-guard status${profile.cmd} (сохранено моделей).` };
  }

  return {
    profile,
    ready,
    dispatch: (ctx) => hook(ctx),
    agentHint,
    onSettings,
    snapshot,
    tick,
    resume,
    setEnabled,
    restoreModels: restoreOnRequest,
    startTest,
    stopTest,
  };
}
