// Framework-free state behind Pult's queue views, shared by everything in one
// window:
// - one queue.list cache: the page, the title-bar badge and the row-mark
//   bridge all read it, so a PULT_CHANGED signal costs one request, not two
//   or three;
// - the local record of replies sent from this window, so a card whose answer
//   already went (or may have gone) out cannot send it again before the agent
//   moves.
// No React and no SDK here: hooks/usePult.ts wires the store to useRpc and
// useRealtime, and tests run this file under plain `node --test`.
import { MARK_LABELS } from "../lib/format.ts";
import type { WaitingKind } from "../lib/types.ts";

/** The fields of a queue item this module looks at. */
export interface ItemShape {
  threadId: string;
  kind: WaitingKind;
  lastAgentAt: number | null;
  nested: readonly ItemShape[];
}

export interface QueueShape {
  items: readonly ItemShape[];
  stale: readonly ItemShape[];
  total: number;
}

export interface QueueListShape {
  queue: QueueShape;
}

// ------------------------------------------------------------ move versions

/** The agent turn a card shows; a reply is meant for exactly this turn. */
export interface MoveVersion {
  lastAgentAt: number | null;
  kind: WaitingKind;
}

export function versionOf(item: MoveVersion): MoveVersion {
  return { lastAgentAt: item.lastAgentAt, kind: item.kind };
}

export function sameVersion(a: MoveVersion, b: MoveVersion): boolean {
  return a.lastAgentAt === b.lastAgentAt && a.kind === b.kind;
}

/** Every waiting item: top level and stale, each followed by its nested ones. */
export function waitingItems(queue: Pick<QueueShape, "items" | "stale">): ItemShape[] {
  return [...queue.items, ...queue.stale].flatMap((item) => [item, ...item.nested]);
}

export function findWaitingItem(
  queue: Pick<QueueShape, "items" | "stale">,
  threadId: string,
): ItemShape | null {
  return waitingItems(queue).find((item) => item.threadId === threadId) ?? null;
}

/**
 * Is a reply prepared for `version` still an answer to what the thread waits
 * for? "gone" — the thread left the queue; "changed" — the agent moved (a new
 * turn or a new kind) since the confirmation opened.
 */
export function replyTarget(current: MoveVersion | null, version: MoveVersion): "ok" | "gone" | "changed" {
  if (current === null) return "gone";
  return sameVersion(current, version) ? "ok" : "changed";
}

// ---------------------------------------------------------------- row marks

export interface Mark {
  threadId: string;
  kind: WaitingKind;
  label: string;
}

/** Row marks for BB's thread list, from queue.list (same set as marks.list). */
export function deriveMarks(queue: Pick<QueueShape, "items" | "stale">): Mark[] {
  const seen = new Set<string>();
  const marks: Mark[] = [];
  for (const item of waitingItems(queue)) {
    if (seen.has(item.threadId)) continue;
    seen.add(item.threadId);
    marks.push({ threadId: item.threadId, kind: item.kind, label: MARK_LABELS[item.kind] });
  }
  return marks;
}

// ------------------------------------------------------------- sent replies

/**
 * "sent" — threads.send answered ok; "unknown" — the request failed in a way
 * that does not tell whether BB took the message (network drop, timeout).
 */
export type SentOutcome = "sent" | "unknown";

export interface SentReply extends MoveVersion {
  threadId: string;
  text: string;
  outcome: SentOutcome;
  at: number;
  /** Why the outcome is unknown, for the card. */
  error: string | null;
}

/** A record older than this is dropped even if the agent never moved. */
export const SENT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Keeps a record while its thread is absent from the queue (it went to work)
 * or still waits on the very turn the reply answered; drops it once the
 * thread waits on another turn or kind — then the card is live again.
 * Returns `sent` itself when nothing changed.
 */
export function pruneSent(
  sent: ReadonlyMap<string, SentReply>,
  queue: Pick<QueueShape, "items" | "stale">,
  now: number,
): ReadonlyMap<string, SentReply> {
  if (sent.size === 0) return sent;
  const byId = new Map(waitingItems(queue).map((item) => [item.threadId, item] as const));
  let changed = false;
  const next = new Map<string, SentReply>();
  for (const [threadId, record] of sent) {
    const current = byId.get(threadId);
    const moved = current !== undefined && !sameVersion(current, record);
    if (moved || now - record.at > SENT_TTL_MS) changed = true;
    else next.set(threadId, record);
  }
  return changed ? next : sent;
}

/**
 * After threads.send threw: "refused" when the server surely rejected the
 * request (a 4xx answer other than 408 — nothing was queued, a retry is
 * safe); "unknown" for everything else (no answer, timeout, 5xx), where the
 * message may already sit in the thread.
 */
export function sendFailureKind(cause: unknown): "refused" | "unknown" {
  const status = statusOf(cause);
  if (status !== null && status >= 400 && status < 500 && status !== 408) return "refused";
  return "unknown";
}

function statusOf(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const record = cause as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const value of [record.status, record.statusCode, record.response?.status]) {
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------- card memo

/** What a queue card draws. ageMs is left out: the card's age chip ticks on its own. */
export interface CardItemShape {
  threadId: string;
  projectId: string;
  projectName: string;
  title: string;
  parentThreadId: string | null;
  parentTitle: string | null;
  kind: string;
  ask: string | null;
  options: readonly { key: string; label: string; recommended: boolean }[];
  multi: boolean;
  replyTemplate: string | null;
  due: string | null;
  ageBucket: string;
  source: string;
  confidence: number;
  pinned: boolean;
  taskKey: string | null;
  openChildren: number;
  excerpt: string | null;
  lastAgentAt: number | null;
  snoozedUntil: number | null;
  nested: readonly CardItemShape[];
}

const CARD_FIELDS = [
  "threadId",
  "lastAgentAt",
  "kind",
  "projectId",
  "projectName",
  "title",
  "parentThreadId",
  "parentTitle",
  "ask",
  "multi",
  "replyTemplate",
  "due",
  "ageBucket",
  "source",
  "confidence",
  "pinned",
  "taskKey",
  "openChildren",
  "excerpt",
  "snoozedUntil",
] as const satisfies readonly (keyof CardItemShape)[];

/**
 * True when two snapshots of an item draw the same card: every refetch brings
 * fresh objects, and a memoized card skips its render when this holds.
 */
export function sameCardItem(a: CardItemShape, b: CardItemShape): boolean {
  if (a === b) return true;
  for (const field of CARD_FIELDS) if (a[field] !== b[field]) return false;
  if (a.options.length !== b.options.length || a.nested.length !== b.nested.length) return false;
  for (let index = 0; index < a.options.length; index += 1) {
    const x = a.options[index]!;
    const y = b.options[index]!;
    if (x.key !== y.key || x.label !== y.label || x.recommended !== y.recommended) return false;
  }
  for (let index = 0; index < a.nested.length; index += 1) {
    if (!sameCardItem(a.nested[index]!, b.nested[index]!)) return false;
  }
  return true;
}

// -------------------------------------------------------------------- store

export interface QueueStoreState<D> {
  data: D | null;
  error: string | null;
  /** True while a request runs (first load or refresh). */
  busy: boolean;
  /** Client time (ms) the current data arrived; ages are counted from it. */
  receivedAt: number | null;
  /** The badge number: from the latest data or the latest PULT_CHANGED payload. */
  total: number | null;
  /** Views that keep the data fresh right now (the page, the badge). */
  retainers: number;
  sent: ReadonlyMap<string, SentReply>;
}

export interface QueueStore<D> {
  getState(): QueueStoreState<D>;
  subscribe(listener: () => void): () => void;
  /**
   * A view that shows the queue mounts: fetch while at least one is retained.
   * The first retainer refetches (signals are ignored while nobody listens,
   * so cached data may be old). Returns the release function.
   */
  retain(load: () => Promise<D>): () => void;
  /** Refetch; every call in one tick, and every call during a request, folds into one. */
  refetch(): void;
  /** A PULT_CHANGED signal: the badge total from its payload, then one refetch. */
  signal(payload: unknown): void;
  markSent(record: SentReply): void;
}

export interface QueueStoreOptions {
  now?: () => number;
  /** Runs the coalesced refetch; a microtask by default. */
  defer?: (run: () => void) => void;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return String(cause);
}

function totalOf(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const total = (payload as { total?: unknown }).total;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
}

export function createQueueStore<D extends QueueListShape>(options: QueueStoreOptions = {}): QueueStore<D> {
  const now = options.now ?? Date.now;
  const defer = options.defer ?? ((run: () => void) => queueMicrotask(run));
  const listeners = new Set<() => void>();
  const loaders: (() => Promise<D>)[] = [];
  let state: QueueStoreState<D> = {
    data: null,
    error: null,
    busy: false,
    receivedAt: null,
    total: null,
    retainers: 0,
    sent: new Map(),
  };
  let inflight = false;
  let again = false;
  let scheduled = false;

  function set(patch: Partial<QueueStoreState<D>>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  function run(): void {
    scheduled = false;
    const load = loaders[loaders.length - 1];
    if (load === undefined) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    if (!state.busy) set({ busy: true });
    let request: Promise<D>;
    try {
      request = load();
    } catch (cause) {
      request = Promise.reject(cause);
    }
    request
      .then(
        (data) => {
          const at = now();
          set({
            data,
            error: null,
            receivedAt: at,
            total: data.queue.total,
            sent: pruneSent(state.sent, data.queue, at),
          });
        },
        (cause: unknown) => set({ error: errorText(cause) }),
      )
      .finally(() => {
        inflight = false;
        if (again) {
          again = false;
          run();
          return;
        }
        set({ busy: false });
      });
  }

  function refetch(): void {
    if (scheduled) return;
    scheduled = true;
    defer(run);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain(load) {
      loaders.push(load);
      set({ retainers: state.retainers + 1 });
      if (state.retainers === 1) refetch();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const index = loaders.lastIndexOf(load);
        if (index >= 0) loaders.splice(index, 1);
        set({ retainers: state.retainers - 1 });
      };
    },
    refetch,
    signal(payload) {
      const total = totalOf(payload);
      if (total !== null && total !== state.total) set({ total });
      refetch();
    },
    markSent(record) {
      const sent = new Map(state.sent);
      sent.set(record.threadId, record);
      set({ sent });
    },
  };
}
