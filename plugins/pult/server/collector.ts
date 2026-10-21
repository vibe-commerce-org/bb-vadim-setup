// Collector: turns BB threads into Pult snapshots.
//
// Two levels of work per thread:
// - fetch (I/O through bb.sdk): the latest turn, the user's latest message, the
//   agent's last text, a pending interaction, the latest error → StoredInput;
// - classify (pure): classify() from lib/, then the LLM triage result and the
//   inventory seed on top → Classification → ThreadSnapshot.
// The StoredInput is kept, so a seed import, an LLM result or a reload with
// new rules re-classifies every thread without touching the SDK.
//
// Sources of change: a full reconcile at load, an incremental scan every
// 5 minutes (threads whose list fingerprint changed) and thread events with a
// 2 s debounce per thread. A scan and an event refresh of the same thread never
// run at once (one in-flight read per thread), and a read never overwrites a
// snapshot that is newer than the thread row it started from.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { classify } from "../lib/classify.ts";
import { cut, tail } from "../lib/marker.ts";
import {
  isWaitingKind,
  type Classification,
  type LastTurn,
  type PendingInteractionInfo,
  type ThreadSnapshot,
} from "../lib/types.ts";
import {
  errorText,
  mapLimit,
  timeoutSignal,
  type PultStore,
  type SeedRow,
  type StoredInput,
} from "./store.ts";

const SCAN_CONCURRENCY = 4;
const CALL_TIMEOUT_MS = 20_000;
const EVENT_DEBOUNCE_MS = 2_000;
const EXCERPT_CHARS = 2_000;
const STORED_TEXT_CHARS = 20_000;
const ERROR_CHARS = 300;
const PROMPT_CHARS = 600;
/** The LLM result replaces only weak text-rule results. */
const LLM_OVERRIDES_BELOW = 0.6;

/** The fields Pult reads from a thread, from threads.list or threads.get. */
interface ThreadLike {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  providerId: string;
  status: string;
  runtime: { displayStatus: string };
  pinnedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: string;
  originPluginId: string | null;
  createdAt: number;
  updatedAt: number;
  latestAttentionAt?: number;
  /** Only on threads.list rows; unknown (null) for a single thread DTO. */
  hasPendingInteraction?: boolean;
}

export interface ScanResult {
  /** Threads re-fetched in this scan. */
  scanned: number;
  /** False while the scan still runs (the caller stopped waiting). */
  done: boolean;
}

export interface Collector {
  /** Reconcile with threads.list: changed threads only, or all with full. */
  scan(opts?: { full?: boolean; signal?: AbortSignal }): Promise<ScanResult>;
  /** Like scan, but resolves after `waitMs` at the latest. */
  scanWithin(full: boolean, waitMs: number): Promise<ScanResult>;
  /** Debounced re-fetch of one thread (events, replies). */
  schedule(threadId: string, opts?: { delayMs?: number; hintText?: string | null }): void;
  /** Re-fetch one thread now. */
  refreshThread(threadId: string): Promise<ThreadSnapshot | null>;
  /** Re-classify stored threads from their stored inputs (no I/O). */
  reclassify(threadIds?: readonly string[]): number;
  /** Project names by id (refreshed on every scan). */
  projectNames(): Promise<Map<string, string>>;
  listen(): void;
  status(): { scannedAt: number | null; scanning: boolean; threadCount: number };
  dispose(): void;
}

function threadTitle(thread: ThreadLike): string {
  return (thread.title ?? thread.titleFallback ?? "").trim() || "Без названия";
}

/**
 * What changes in a thread row when something happened in it. A threads.get
 * DTO has no hasPendingInteraction, so the caller passes the known value to
 * keep list rows and DTOs comparable.
 */
function fingerprint(thread: ThreadLike, hasPending: boolean): string {
  return [
    thread.updatedAt,
    thread.latestAttentionAt ?? "",
    thread.status,
    hasPending,
    thread.pinnedAt ?? "",
    thread.parentThreadId ?? "",
  ].join("|");
}

function unknownClassification(reason: string): Classification {
  return {
    kind: "unknown",
    ask: null,
    options: [],
    multi: false,
    replyTemplate: null,
    due: null,
    confidence: 0,
    source: "rules",
    reasons: [reason],
  };
}

/** A pending interaction row (provider or plugin), reduced for the queue. */
export function toPendingInfo(row: unknown): PendingInteractionInfo | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as { id?: unknown; status?: unknown; payload?: unknown };
  if (r.status !== "pending" || typeof r.id !== "string") return null;
  const payload = (r.payload ?? {}) as Record<string, unknown>;
  if (payload.kind === "user_question") {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const first = (questions[0] ?? {}) as { prompt?: unknown; options?: unknown };
    const options = Array.isArray(first.options)
      ? first.options
          .map((o) => o as { label?: unknown; value?: unknown })
          .filter((o) => typeof o.label === "string")
          .map((o) => ({ label: String(o.label), value: typeof o.value === "string" ? o.value : String(o.label) }))
      : [];
    let prompt = typeof first.prompt === "string" ? first.prompt : null;
    if (prompt !== null && questions.length > 1) prompt += ` (+ ещё вопросов: ${questions.length - 1})`;
    return {
      interactionId: r.id,
      kind: "user_question",
      subjectKind: null,
      prompt: prompt === null ? null : cut(prompt, PROMPT_CHARS),
      options,
    };
  }
  if (payload.kind === "approval") {
    const subject = (payload.subject ?? {}) as Record<string, unknown>;
    const subjectKind = typeof subject.kind === "string" ? subject.kind : null;
    let prompt: string | null = null;
    if (subjectKind === "command" && typeof subject.command === "string") prompt = subject.command;
    else if (subjectKind === "plan" && typeof subject.plan === "string") prompt = subject.plan;
    else if (subjectKind === "file_change") {
      prompt = typeof subject.writeScope === "string" ? `Изменение файлов: ${subject.writeScope}` : "Изменение файлов";
    } else if (subjectKind === "permission_grant") {
      const tool = typeof subject.toolName === "string" ? subject.toolName : null;
      prompt = tool === null ? "Запрос дополнительных прав" : `Запрос прав для ${tool}`;
    } else if (subjectKind === "tool_use") {
      const presentation = (subject.presentation ?? {}) as { title?: unknown };
      prompt =
        typeof presentation.title === "string"
          ? presentation.title
          : typeof subject.tool === "string"
            ? subject.tool
            : null;
    }
    if (prompt === null && typeof payload.reason === "string") prompt = payload.reason;
    return {
      interactionId: r.id,
      kind: "approval",
      subjectKind,
      prompt: prompt === null ? null : cut(prompt, PROMPT_CHARS),
      options: [],
    };
  }
  // A plugin-rendered form: show its title as a question.
  const title = typeof payload.title === "string" ? payload.title : null;
  return { interactionId: r.id, kind: "user_question", subjectKind: null, prompt: title, options: [] };
}

/** The fields of a client/turn/requested event Pult reads. */
export interface TurnRequest {
  createdAt: number;
  initiator?: string | null;
  senderThreadId?: string | null;
  systemMessageKind?: string | null;
  source?: string | null;
}

/**
 * When the user himself last wrote into a thread, from its turn requests (newest
 * first): a user-initiated message, not from another thread, not a system
 * notice. The first prompt of a subthread (source "spawn") is written by the
 * parent agent even though BB records it as the user's, so it never counts.
 */
export function vadimLastMessageAt(requests: readonly TurnRequest[], isChild: boolean): number | null {
  for (const r of requests) {
    if (isChild && r.source === "spawn") continue;
    const kind = r.systemMessageKind;
    if (
      r.initiator === "user" &&
      r.senderThreadId == null &&
      (kind === undefined || kind === null || kind === "unlabeled")
    ) {
      return r.createdAt;
    }
  }
  return null;
}

/** A snapshot as the queue sees it, for «did anything change» checks. */
function snapshotKey(s: ThreadSnapshot | null): string {
  return s === null ? "" : JSON.stringify({ ...s, classifiedAt: 0 });
}

/** max(lastAgentAt, lastHumanAt), or updatedAt when both are unknown. */
export function lastActivity(input: Pick<StoredInput, "lastAgentAt" | "lastHumanAt">, updatedAt: number): number {
  if (input.lastAgentAt === null && input.lastHumanAt === null) return updatedAt;
  return Math.max(input.lastAgentAt ?? 0, input.lastHumanAt ?? 0);
}

/**
 * The 2026-10-10 inventory on top of the rules, while the thread has not
 * moved since. Native approval / working / failed always win.
 */
export function applySeed(
  c: Classification,
  seed: SeedRow | null,
  input: StoredInput,
  updatedAt: number,
): Classification {
  if (seed === null) return c;
  if (lastActivity(input, updatedAt) > seed.asOf) return c;
  if (c.source === "native" && (c.kind === "approval" || c.kind === "working" || c.kind === "failed")) {
    return c;
  }
  const reasons = [...c.reasons, `seed:${seed.status}`];
  switch (seed.status) {
    case "WAITING_VADIM":
    case "BLOCKED":
    case "ABANDONED":
      return {
        ...c,
        kind: isWaitingKind(c.kind) ? c.kind : "decision",
        ask: seed.ask ?? c.ask,
        source: "inventory",
        confidence: 0.9,
        reasons,
      };
    case "IN_PROGRESS": {
      const stopped = input.lastTurn === "failed" || input.lastTurn === "interrupted";
      return {
        ...c,
        kind: isWaitingKind(c.kind) ? c.kind : stopped ? "failed" : "decision",
        ask: seed.ask ?? c.ask,
        source: "inventory",
        confidence: 0.7,
        reasons,
      };
    }
    case "DONE":
    case "CHILD_DONE":
      return {
        kind: "done",
        ask: null,
        options: [],
        multi: false,
        replyTemplate: null,
        due: null,
        confidence: 0.9,
        source: "inventory",
        reasons,
      };
  }
}

export function createCollector(
  bb: BbPluginApi,
  store: PultStore,
  opts: { onChange: () => void },
): Collector {
  const disposed = new AbortController();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const hints = new Map<string, string | null>();
  /** One read per thread at a time: an event refresh or a scan step. */
  const inflight = new Map<string, Promise<unknown>>();
  const dirty = new Set<string>();
  /** When a thread was archived or deleted (events), to drop reads started before. */
  const goneAt = new Map<string, number>();
  let names = new Map<string, string>();
  let namesAt = 0;
  let running: Promise<ScanResult> | null = null;
  let runningFull = false;
  let progress = 0;

  async function loadProjectNames(force = false): Promise<Map<string, string>> {
    if (!force && names.size > 0 && Date.now() - namesAt < 10 * 60_000) return names;
    try {
      const projects = await bb.sdk.projects.list({
        includePersonal: true,
        signal: timeoutSignal(CALL_TIMEOUT_MS, disposed.signal),
      });
      names = new Map(projects.map((p) => [p.id, p.name]));
      namesAt = Date.now();
    } catch (error) {
      bb.log.warn(`projects.list failed: ${errorText(error)}`);
    }
    return names;
  }

  function finalClassification(input: StoredInput, updatedAt: number, now: number): Classification {
    let c: Classification;
    try {
      c = classify({ ...input, now });
    } catch (error) {
      bb.log.warn(`classify failed for ${input.threadId}: ${errorText(error)}`);
      c = unknownClassification("classify-error");
    }
    const llm = store.getLlm(input.threadId);
    if (
      llm !== null &&
      llm.classification !== null &&
      llm.lastAgentAt === input.lastAgentAt &&
      c.source === "rules" &&
      c.confidence < LLM_OVERRIDES_BELOW
    ) {
      c = { ...llm.classification, reasons: [...llm.classification.reasons, ...c.reasons] };
    }
    return applySeed(c, store.getSeed(input.threadId), input, updatedAt);
  }

  function buildSnapshot(
    thread: ThreadLike,
    input: StoredInput,
    projectName: string,
    now: number,
  ): ThreadSnapshot {
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      projectName,
      title: threadTitle(thread),
      parentThreadId: thread.parentThreadId,
      providerId: thread.providerId,
      status: thread.status,
      pinned: thread.pinnedAt !== null,
      archived: false,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      lastAgentAt: input.lastAgentAt,
      lastHumanAt: input.lastHumanAt,
      excerpt: input.lastAgentText === null ? null : tail(input.lastAgentText, EXCERPT_CHARS),
      classification: finalClassification(input, thread.updatedAt, now),
      classifiedAt: now,
    };
  }

  /** All the I/O for one thread → its StoredInput. */
  async function fetchInput(thread: ThreadLike, hintText: string | null | undefined): Promise<StoredInput> {
    const threadId = thread.id;
    const signal = () => timeoutSignal(CALL_TIMEOUT_MS, disposed.signal);
    const sdk = bb.sdk;

    const turns = await sdk.threads.events.list({
      threadId,
      order: "desc",
      types: ["turn/completed"],
      limit: "1",
      signal: signal(),
    });
    const requests = await sdk.threads.events.list({
      threadId,
      order: "desc",
      types: ["client/turn/requested"],
      limit: "20",
      signal: signal(),
    });

    let turnSeq: number | null = null;
    let turnAt: number | null = null;
    let lastTurn: LastTurn = "none";
    let turnError: string | null = null;
    for (const event of turns) {
      if (event.type !== "turn/completed") continue;
      turnSeq = event.seq;
      turnAt = event.createdAt;
      lastTurn = event.data.status;
      turnError = event.data.error?.message ?? null;
      break;
    }

    let latestRequestSeq: number | null = null;
    const turnRequests: TurnRequest[] = [];
    for (const event of requests) {
      if (event.type !== "client/turn/requested") continue;
      if (latestRequestSeq === null) latestRequestSeq = event.seq;
      turnRequests.push({ ...event.data, createdAt: event.createdAt });
    }
    const lastHumanAt = vadimLastMessageAt(turnRequests, thread.parentThreadId !== null);

    const runningNow = thread.status === "active" || thread.status === "starting";
    if (runningNow && (turnSeq === null || (latestRequestSeq !== null && latestRequestSeq > turnSeq))) {
      lastTurn = "running";
    }

    // The agent's last text: from the idle event when we have it, from the
    // stored input when the latest turn did not change, else threads.output.
    const stored = store.getStoredInput(threadId);
    let lastAgentText: string | null;
    if (hintText !== undefined && hintText !== null) {
      lastAgentText = hintText;
    } else if (stored !== null && stored.turnSeq === turnSeq && turnSeq !== null && lastTurn !== "running") {
      lastAgentText = stored.lastAgentText;
    } else {
      const { output } = await sdk.threads.output({ threadId, signal: signal() });
      lastAgentText = output;
    }
    if (lastAgentText !== null) lastAgentText = tail(lastAgentText, STORED_TEXT_CHARS);

    let pending: PendingInteractionInfo | null = null;
    if (thread.hasPendingInteraction !== false) {
      const rows = await sdk.threads.interactions.list({ threadId, signal: signal() });
      for (const row of rows) {
        pending = toPendingInfo(row);
        if (pending !== null) break;
      }
    }

    let lastErrorText: string | null = null;
    if (lastTurn === "failed" || thread.status === "error") {
      lastErrorText = turnError;
      if (lastErrorText === null) {
        const errors = await sdk.threads.events.list({
          threadId,
          order: "desc",
          types: ["provider/error", "system/error"],
          limit: "1",
          signal: signal(),
        });
        const latest = errors[0];
        if (latest !== undefined && (latest.type === "provider/error" || latest.type === "system/error")) {
          lastErrorText = latest.data.message;
        }
      }
      if (lastErrorText !== null) lastErrorText = cut(lastErrorText.trim(), ERROR_CHARS);
    }

    return {
      threadId,
      status: thread.status,
      runtimeStatus: thread.runtime.displayStatus ?? null,
      hasPendingInteraction: pending !== null,
      pending,
      lastTurn,
      lastAgentText,
      lastAgentAt: turnAt,
      lastHumanAt,
      lastErrorText,
      isChild: thread.parentThreadId !== null,
      turnSeq,
    };
  }

  function skip(thread: ThreadLike): boolean {
    return thread.visibility === "hidden" || thread.originPluginId === bb.pluginId;
  }

  /**
   * Reads one thread and stores its snapshot. Writes nothing when the stored
   * snapshot is newer than `thread` (another read got there first) or when
   * the thread was archived or deleted while this read ran.
   */
  async function computeThread(
    thread: ThreadLike,
    hintText?: string | null,
  ): Promise<{ snapshot: ThreadSnapshot | null; changed: boolean }> {
    const startedAt = Date.now();
    const input = await fetchInput(thread, hintText);
    let projectName = names.get(thread.projectId);
    if (projectName === undefined) projectName = (await loadProjectNames(true)).get(thread.projectId);
    const prev = store.getSnapshot(thread.id);
    if (prev !== null && prev.updatedAt > thread.updatedAt) return { snapshot: prev, changed: false };
    if ((goneAt.get(thread.id) ?? -Infinity) >= startedAt) return { snapshot: prev, changed: false };
    const snapshot = buildSnapshot(thread, input, projectName ?? thread.projectId, Date.now());
    store.putSnapshot(snapshot, input, fingerprint(thread, thread.hasPendingInteraction ?? input.hasPendingInteraction));
    return { snapshot, changed: snapshotKey(prev) !== snapshotKey(snapshot) };
  }

  /** Runs `work` as the one in-flight read of `threadId`; re-schedules a read asked meanwhile. */
  function track<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const run = (async () => {
      try {
        return await work();
      } finally {
        inflight.delete(threadId);
        if (dirty.delete(threadId) && !disposed.signal.aborted) schedule(threadId);
      }
    })();
    inflight.set(threadId, run);
    return run;
  }

  async function refreshOne(threadId: string): Promise<ThreadSnapshot | null> {
    const hint = hints.get(threadId);
    hints.delete(threadId);
    let thread: ThreadLike;
    try {
      thread = await bb.sdk.threads.get({ threadId, signal: timeoutSignal(CALL_TIMEOUT_MS, disposed.signal) });
    } catch (error) {
      bb.log.warn(`threads.get ${threadId} failed: ${errorText(error)}`);
      return null;
    }
    if (skip(thread)) {
      store.deleteSnapshot(threadId);
      return null;
    }
    if (thread.deletedAt !== null) {
      if (store.deleteThreadData(threadId)) opts.onChange();
      return null;
    }
    if (thread.archivedAt !== null) {
      if (store.setArchived([threadId], true) > 0) opts.onChange();
      return store.getSnapshot(threadId);
    }
    const { snapshot, changed } = await computeThread(thread, hint);
    if (changed) opts.onChange();
    return snapshot;
  }

  function refreshThread(threadId: string): Promise<ThreadSnapshot | null> {
    const current = inflight.get(threadId);
    if (current !== undefined) {
      dirty.add(threadId);
      return current.then(
        () => store.getSnapshot(threadId),
        () => store.getSnapshot(threadId),
      );
    }
    return track(threadId, async () => {
      try {
        return await refreshOne(threadId);
      } catch (error) {
        bb.log.warn(`refresh ${threadId} failed: ${errorText(error)}`);
        return store.getSnapshot(threadId);
      }
    });
  }

  function schedule(threadId: string, o: { delayMs?: number; hintText?: string | null } = {}): void {
    if (disposed.signal.aborted) return;
    if (o.hintText !== undefined) hints.set(threadId, o.hintText);
    const existing = timers.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      threadId,
      setTimeout(() => {
        timers.delete(threadId);
        void refreshThread(threadId);
      }, o.delayMs ?? EVENT_DEBOUNCE_MS),
    );
  }

  async function runScan(full: boolean, signal?: AbortSignal): Promise<ScanResult> {
    const scanSignal = signal === undefined ? disposed.signal : AbortSignal.any([signal, disposed.signal]);
    progress = 0;
    await loadProjectNames(true);
    const rows = await bb.sdk.threads.list({ archived: false, signal: timeoutSignal(60_000, scanSignal) });
    const visible = rows.filter((row) => !skip(row));
    const known = store.knownThreads();
    const live = new Set(visible.map((row) => row.id));

    const gone = [...known].filter(([id, k]) => !k.archived && !live.has(id)).map(([id]) => id);
    let changed = store.setArchived(gone, true);
    if (changed > 0) opts.onChange();

    const todo = visible.filter((row) => {
      const k = known.get(row.id);
      return full || k === undefined || k.archived || k.fingerprint !== fingerprint(row, row.hasPendingInteraction);
    });
    let failed = 0;
    let unpublished = 0;
    await mapLimit(todo, SCAN_CONCURRENCY, async (row) => {
      if (scanSignal.aborted) return;
      // An event refresh is reading this thread right now, from a fresher
      // threads.get than this list row: leave it to that read.
      if (inflight.has(row.id)) return;
      try {
        const result = await track(row.id, () => computeThread(row, hints.get(row.id)));
        hints.delete(row.id);
        progress += 1;
        if (result.changed) {
          changed += 1;
          unpublished += 1;
          if (unpublished >= 10) {
            unpublished = 0;
            opts.onChange();
          }
        }
      } catch (error) {
        failed += 1;
        if (!scanSignal.aborted) bb.log.warn(`scan: skipped ${row.id}: ${errorText(error)}`);
      }
    });
    if (!scanSignal.aborted) store.setMeta("scannedAt", String(Date.now()));
    if (todo.length > 0 || failed > 0) {
      bb.log.info(
        `scan${full ? " (full)" : ""}: ${progress}/${todo.length} threads re-read, ${changed} changed, ${failed} skipped`,
      );
    }
    // Nothing changed → no signal: every signal makes open pages refetch.
    if (unpublished > 0) opts.onChange();
    return { scanned: progress, done: true };
  }

  function scan(o: { full?: boolean; signal?: AbortSignal } = {}): Promise<ScanResult> {
    const full = o.full === true;
    if (running !== null) {
      // A full scan asked during an incremental one runs right after it.
      if (full && !runningFull) return running.then(() => scan(o));
      return running;
    }
    runningFull = full;
    running = runScan(full, o.signal).finally(() => {
      running = null;
      runningFull = false;
    });
    return running;
  }

  async function scanWithin(full: boolean, waitMs: number): Promise<ScanResult> {
    const work = scan({ full });
    work.catch((error) => bb.log.warn(`scan failed: ${errorText(error)}`));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ScanResult>((resolve) => {
      timer = setTimeout(() => resolve({ scanned: progress, done: false }), waitMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function reclassify(threadIds?: readonly string[]): number {
    const wanted = threadIds === undefined ? null : new Set(threadIds);
    const now = Date.now();
    let changed = 0;
    for (const { snapshot, input } of store.listStored()) {
      if (wanted !== null && !wanted.has(snapshot.threadId)) continue;
      const classification = finalClassification(input, snapshot.updatedAt, now);
      if (JSON.stringify(classification) === JSON.stringify(snapshot.classification)) continue;
      store.putSnapshot({ ...snapshot, classification, classifiedAt: now }, null, null);
      changed += 1;
    }
    if (changed > 0) opts.onChange();
    return changed;
  }

  function cancelTimer(threadId: string): void {
    const timer = timers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(threadId);
  }

  function listen(): void {
    bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
      if (!skip(thread)) schedule(thread.id, { hintText: lastAssistantText });
    });
    for (const event of ["thread.active", "thread.failed", "interaction.pending"] as const) {
      bb.events.on(event, ({ thread }) => {
        if (!skip(thread)) schedule(thread.id);
      });
    }
    bb.events.on("thread.unarchived", ({ thread }) => {
      goneAt.delete(thread.id);
      if (!skip(thread)) schedule(thread.id);
    });
    bb.events.on("turn.failed", ({ threadId }) => schedule(threadId));
    // An approval resolved in BB does not change the thread's status (it
    // stays active), so no lifecycle event comes: watch the event stream of
    // threads Pult shows as «ждёт одобрения» and re-read them.
    bb.events.on("experimental_thread.events", ({ thread }) => {
      if (skip(thread)) return;
      if (store.getSnapshot(thread.id)?.classification.kind !== "approval") return;
      if (inflight.has(thread.id)) dirty.add(thread.id);
      // A read already scheduled stays as it is: postponing it on every event
      // would delay it until the agent goes quiet.
      else if (!timers.has(thread.id)) schedule(thread.id);
    });
    bb.events.on("thread.archived", ({ thread }) => {
      cancelTimer(thread.id);
      goneAt.set(thread.id, Date.now());
      if (store.setArchived([thread.id], true) > 0) opts.onChange();
    });
    // A deleted thread leaves nothing behind in Pult's database: no agent
    // text, no overlay, no LLM triage.
    bb.events.on("thread.deleted", ({ thread }) => {
      cancelTimer(thread.id);
      hints.delete(thread.id);
      goneAt.set(thread.id, Date.now());
      if (store.deleteThreadData(thread.id)) opts.onChange();
    });
  }

  return {
    scan,
    scanWithin,
    schedule,
    refreshThread,
    reclassify,
    projectNames: () => loadProjectNames(false),
    listen,
    status() {
      const scannedAt = store.getMeta("scannedAt");
      return {
        scannedAt: scannedAt === null ? null : Number(scannedAt),
        scanning: running !== null,
        threadCount: store.countLive(),
      };
    },
    dispose() {
      disposed.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
