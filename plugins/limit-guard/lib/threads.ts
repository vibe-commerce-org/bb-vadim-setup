// Which threads and queued rows the guard touches — pure logic, no SDK.
import { holdsForModel } from "./stage.ts";
import { CLAUDE_PROVIDER, MARKER } from "./policy.ts";

/** Threads updated this recently are re-checked on every poll. */
export const RECENT_MS = 6 * 60 * 60_000;

const BUSY = new Set(["active", "starting", "pending"]);

export interface ThreadRowLike {
  id: string;
  providerId: string;
  status: string;
  archivedAt: number | null;
  deletedAt?: number | null;
  updatedAt: number;
}

/** A live (not archived, not deleted) thread of the provider — claude-code unless said otherwise. */
export function isLiveClaudeThread(row: ThreadRowLike, providerId = CLAUDE_PROVIDER): boolean {
  return row.providerId === providerId && row.archivedAt === null && (row.deletedAt ?? null) === null;
}

/** A full pass checks every live thread of the provider; a poll — busy or recently updated ones. */
export function wantsCheck(row: ThreadRowLike, now: number, full: boolean, providerId = CLAUDE_PROVIDER): boolean {
  if (!isLiveClaudeThread(row, providerId)) return false;
  if (full) return true;
  return BUSY.has(row.status) || now - row.updatedAt <= RECENT_MS;
}

/**
 * Models to try when giving a thread its previous model back. BB's thread
 * update checks the model against the provider catalog, which has no `[1m]`
 * variants (spawn lets them through unchecked), so the suffix-less id goes
 * second.
 */
export function restoreModels(model: string | null): Array<string | null> {
  if (model === null) return [null];
  const plain = model.replace(/\[1m\]$/i, "");
  return plain === model ? [model] : [model, plain];
}

// ── re-queueing held rows on the target (Sonnet for Claude) ────────────

export interface QueueRowLike {
  id: string;
  model: string;
  reasoningLevel?: string;
  initiator: string;
  groupWithNext: boolean;
  payload: { kind: string };
  waitingOn: { kind: string; pluginId?: string; reason?: string } | null;
}

export type ReseatStep<Row extends QueueRowLike = QueueRowLike> =
  /** Create a copy on the target, put it where the row stood, delete the row. */
  | { kind: "copy"; row: Row }
  /** Send it as a new turn on the target (threads.send, queue-if-active), delete the row. */
  | { kind: "send"; row: Row }
  /** Leave it held: Send now or the weekly reset releases it. */
  | { kind: "skip"; row: Row; why: string };

/** A row this guard held (its reason may be appended to another plugin's). */
export function isHeldByGuard(row: QueueRowLike): boolean {
  return row.waitingOn?.kind === "plugin" && (row.waitingOn.reason ?? "").includes(MARKER);
}

/**
 * What to do with each held row of one thread that is off the target (`holds`;
 * by default the Claude rule — any model but Sonnet). Ground rules from
 * BB's queue (server sources 0.46): a row a plugin creates waits as
 * `thread-busy`, and such a row drains only on an idle or pending thread
 * (createAutomaticQueuedMessageGroupEligibility) and never while a manual stop
 * pauses the thread's queue (ORDINARY_TURN_END_WAIT_KINDS) — the stop the
 * guard itself makes on stage 2. A new turn lifts that pause.
 *
 * - idle or error thread: the first held row goes out as a new turn on Sonnet
 *   (threads.send) — it starts right away, lifts a stop pause and takes an
 *   error thread out of error; later held rows are copied and drain after it;
 * - running thread (active, starting, stopping): copied in place, drained when
 *   the turn ends;
 * - pending thread: no session yet, a created row would never dispatch — held;
 * - groups (`groupWithNext`) are not split — the sender composed them as one prompt;
 * - system rows cannot be created by a plugin;
 * - a retry re-runs the failed turn: only while the thread is still in error
 *   and nothing was sent before it; otherwise the conversation moved on.
 */
export function planReseat<Row extends QueueRowLike>(
  rows: readonly Row[],
  threadStatus: string,
  holds: (row: Row) => boolean = (row) => holdsForModel(row.model),
): ReseatStep<Row>[] {
  const steps: ReseatStep<Row>[] = [];
  const startsTurn = threadStatus === "idle" || threadStatus === "error";
  let sent = false;
  rows.forEach((row, index) => {
    if (!isHeldByGuard(row) || !holds(row)) return;
    const previous = index > 0 ? rows[index - 1]! : null;
    if (row.groupWithNext || previous?.groupWithNext === true) {
      steps.push({ kind: "skip", row, why: "часть группы сообщений" });
      return;
    }
    if (row.initiator === "system") {
      steps.push({ kind: "skip", row, why: "системное сообщение" });
      return;
    }
    if (threadStatus === "pending") {
      steps.push({ kind: "skip", row, why: "тред ещё не запущен" });
      return;
    }
    if (row.payload.kind === "retry" && (threadStatus !== "error" || sent)) {
      steps.push({ kind: "skip", row, why: "повтор хода, а тред уже не в ошибке" });
      return;
    }
    if (startsTurn && !sent) {
      sent = true;
      steps.push({ kind: "send", row });
      return;
    }
    steps.push({ kind: "copy", row });
  });
  return steps;
}
