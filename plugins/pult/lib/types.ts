// Shared domain types of the Pult plugin. Pure TypeScript: imported by the
// backend (server/*), the frontend (components/pult/*) and the pure logic in
// lib/* that tests run under plain `node --test`. Keep this file free of
// runtime imports so both bundles and Node can load it.

/**
 * Whose move it is in a thread, from the user's point of view.
 *
 * Waiting kinds (the thread waits for the user), in queue order:
 * - approval — BB itself blocks the agent on a pending interaction
 *   (a native question, a permission request or a plan approval);
 * - decision — the agent finished its turn with a question, a choice
 *   (А/Б/В), or a plan that waits for «делай» / «go»;
 * - action — a manual step only the user can take: run a command outside the
 *   sandbox, push, deploy, pay, send a letter, type a PIN, log in;
 * - failed — the turn failed (provider error, limit) or was stopped
 *   manually and nobody answered since;
 * - review — the work is done but the agent asks the user to check it
 *   (open the app, listen, look);
 * - commit — the only thing left is «закоммитить / бэкап? скажи да».
 *
 * Non-waiting kinds: working (the agent runs), done, unknown.
 */
export type Kind =
  | "approval"
  | "decision"
  | "action"
  | "failed"
  | "review"
  | "commit"
  | "working"
  | "done"
  | "unknown";

/** Waiting kinds in queue order — the order the queue is sorted in. */
export const WAITING_KINDS = [
  "approval",
  "decision",
  "action",
  "failed",
  "review",
  "commit",
] as const satisfies readonly Kind[];

export type WaitingKind = (typeof WAITING_KINDS)[number];

export function isWaitingKind(kind: Kind): kind is WaitingKind {
  return (WAITING_KINDS as readonly string[]).includes(kind);
}

/** Where a classification came from, from most to least trusted. */
export type ClassificationSource =
  | "manual" // The user corrected it by hand
  | "native" // BB's own signals: pending interaction, error, interrupt, running
  | "marker" // the agent's «⏸ Ход за Вадимом» line
  | "inventory" // the 2026-10-10 inventory of all threads (seed import)
  | "llm" // the optional LLM triage
  | "rules"; // text rules over the agent's last message

/** One answer option the agent offered, e.g. key "А", label "раскатить всем". */
export interface AnswerOption {
  /** The letter or digit the user answers with: "А", "Б", "В", "Г", "Д", "1"… */
  key: string;
  /** Short label (≤ 140 chars), plain text. */
  label: string;
  /** True when the agent marked this option as its recommendation. */
  recommended: boolean;
}

export interface Classification {
  kind: Kind;
  /**
   * What is needed from the user, in the agent's words where possible: the
   * question, the requested command or decision. Plain text, ≤ 600 chars,
   * null when nothing is needed.
   */
  ask: string | null;
  /** Options of a single question (А/Б/В…), empty when none were parsed. */
  options: AnswerOption[];
  /** True when the message asks several numbered questions at once. */
  multi: boolean;
  /**
   * A ready reply the user can send or edit, e.g. "1 — А, 2 — Б" built from the
   * agent's recommendations, or null.
   */
  replyTemplate: string | null;
  /** A deadline mentioned for the move, ISO date YYYY-MM-DD, or null. */
  due: string | null;
  /** 0..1 — how sure the classifier is. */
  confidence: number;
  source: ClassificationSource;
  /** Short machine-readable reasons (matched rules), for debugging. */
  reasons: string[];
}

/** A BB-native pending interaction, reduced to what the queue shows. */
export interface PendingInteractionInfo {
  interactionId: string;
  /** "user_question" — a native question; "approval" — a permission/plan request. */
  kind: "user_question" | "approval";
  /** For approvals: command | file_change | permission_grant | plan | tool_use. */
  subjectKind: string | null;
  /** The question prompt, the command, or the first lines of the plan. */
  prompt: string | null;
  options: { label: string; value: string }[];
}

/** How the thread's latest turn ended, from its event log. */
export type LastTurn = "completed" | "failed" | "interrupted" | "running" | "none";

/** Everything the classifier looks at for one thread. */
export interface ClassifyInput {
  threadId: string;
  /** BB thread status: pending | starting | active | idle | stopping | error. */
  status: string;
  /** BB runtime.displayStatus when known (e.g. "waiting-for-host"). */
  runtimeStatus: string | null;
  hasPendingInteraction: boolean;
  pending: PendingInteractionInfo | null;
  lastTurn: LastTurn;
  /** The agent's last message, full text (markdown), or null. */
  lastAgentText: string | null;
  /** When the latest turn ended (ms since epoch), or null. */
  lastAgentAt: number | null;
  /**
   * When the user himself last wrote into the thread (ms): a user-initiated
   * message, not a message from another thread and not a system notice.
   */
  lastHumanAt: number | null;
  /** The text of the latest error, when the turn failed. */
  lastErrorText: string | null;
  /** True when the thread has a parent thread (a subthread). */
  isChild: boolean;
  /** Current time (ms) — passed in so the classifier stays pure. */
  now: number;
}

/** One thread as the plugin stores it after a scan. */
export interface ThreadSnapshot {
  threadId: string;
  projectId: string;
  projectName: string;
  title: string;
  parentThreadId: string | null;
  providerId: string;
  status: string;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastAgentAt: number | null;
  lastHumanAt: number | null;
  /** Tail of the agent's last message (≤ 2000 chars) for the card. */
  excerpt: string | null;
  classification: Classification;
  classifiedAt: number;
}

/** the user's own state on top of a thread: snooze, dismiss, link to a task. */
export interface Overlay {
  threadId: string;
  /** Hidden until this time (ms)… */
  snoozedUntil: number | null;
  /** …or until the agent writes again after this time (ms). */
  snoozedAt: number | null;
  /** «Не нужно»: hidden until the agent writes again after this time (ms). */
  dismissedAt: number | null;
  /** BB Tasks key the thread was filed under from the queue, e.g. "ORC-3". */
  taskKey: string | null;
}

/** Age buckets of a waiting item, by the time since the agent's last turn. */
export type AgeBucket = "fresh" | "day" | "week" | "stale";
// fresh < 24 h ≤ day < 7 d ≤ week < 14 d ≤ stale

export interface QueueItem {
  threadId: string;
  projectId: string;
  projectName: string;
  title: string;
  parentThreadId: string | null;
  parentTitle: string | null;
  kind: WaitingKind;
  ask: string | null;
  options: AnswerOption[];
  multi: boolean;
  replyTemplate: string | null;
  due: string | null;
  /** ms since the agent's last turn (or since the last update when unknown). */
  ageMs: number;
  ageBucket: AgeBucket;
  source: ClassificationSource;
  confidence: number;
  pinned: boolean;
  taskKey: string | null;
  /** Child threads that are not done yet (waiting on this one, usually). */
  openChildren: number;
  excerpt: string | null;
  lastAgentAt: number | null;
  /** Set for items in the snoozed list: until when (ms). */
  snoozedUntil: number | null;
  /**
   * Waiting descendants (subthreads at any depth) whose nearest waiting
   * ancestor is this item: shown inside this card instead of as separate
   * queue items. Empty for nested items themselves (one level of nesting).
   */
  nested: NestedQueueItem[];
}

/** A queue item shown inside its waiting ancestor's card (no deeper nesting). */
export type NestedQueueItem = Omit<QueueItem, "nested"> & { nested: never[] };

export interface Queue {
  /**
   * Top-level waiting items younger than 14 days, sorted (see lib/queue.ts).
   * A waiting thread whose waiting ancestor is visible sits in that
   * ancestor's `nested`, not here.
   */
  items: QueueItem[];
  /** Top-level waiting items 14 days and older («Застряло»), same order. */
  stale: QueueItem[];
  /** Items hidden by a snooze that has not expired yet. */
  snoozed: QueueItem[];
  /**
   * Items hidden with «Не нужно» that the agent has not answered since. Shown
   * in a collapsed group with «Вернуть»: plugin RPC is open to any local
   * agent, so a hidden item must stay visible somewhere.
   */
  dismissed: QueueItem[];
  /** Count of top-level visible items (items + stale) per waiting kind. */
  counts: Record<WaitingKind, number>;
  /**
   * The number on the badge: top-level items + stale, EXCLUDING kind
   * "commit" (a lone «закоммитить? скажи да» is shown in its own collapsed
   * group and does not count as a move waiting for the user).
   */
  total: number;
}

/** Priority lanes on top of BB Tasks priorities. */
export type Lane = "now" | "next" | "later";

export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";
export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "canceled";

/** A BB Tasks task as Pult receives it from the tasks plugin's RPC. */
export interface TaskRecord {
  id: string;
  key: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
  createdAt: number;
  updatedAt: number;
  /** Tracker project of the task. */
  trackerProjectId: string;
  trackerProjectName: string;
  /** The BB project the tracker project is linked to, when it is. */
  bbProjectId: string | null;
  threads: TaskThreadRef[];
}

export interface TaskThreadRef {
  threadId: string;
  title: string;
  /** tasks plugin liveStatus: starting | working | idle | completed | failed. */
  liveStatus: string;
  /** The thread's waiting kind in Pult's queue, when it waits for the user. */
  queueKind: WaitingKind | null;
  /** Last activity of the thread (ms), when known. */
  lastActivityAt: number | null;
}

export interface LaneTask extends TaskRecord {
  lane: Lane;
  /** Since when the task sits in this lane (ms). */
  laneSince: number;
  /** True when laneSince is a guess (first time Pult saw the task). */
  laneSinceApprox: boolean;
  /** Now/Next task without movement for 7+ days. */
  stale: boolean;
  /** At least one attached thread waits for the user. */
  waitingOnYou: boolean;
}

export interface Lanes {
  now: LaneTask[];
  next: LaneTask[];
  later: LaneTask[];
  wipLimit: number;
  wipExceeded: boolean;
}

/** Git state of a project's main checkout. */
export interface GitState {
  projectId: string;
  branch: string | null;
  /** BB's working-tree state; "unknown" when BB could not tell. */
  state:
    | "clean"
    | "untracked"
    | "dirty_uncommitted"
    | "committed_unmerged"
    | "dirty_and_committed_unmerged"
    | "unknown";
  ahead: number | null;
  behind: number | null;
  checkedAt: number;
}

/** A node of the «Карта» tree. */
export interface MapNode {
  type: "project" | "task" | "thread";
  id: string;
  title: string;
  /** For threads: their kind; for tasks/projects: the most urgent kind inside, or null. */
  kind: Kind | null;
  /** For tasks: the lane. */
  lane: Lane | null;
  /** ms since last activity, when known. */
  ageMs: number | null;
  /** For threads: the parent whose «ход за тобой» this thread waits behind. */
  blockedByThreadId: string | null;
  /** For projects: git state of the main checkout. */
  git: GitState | null;
  /** Counts inside the node: waiting on the user / working / open total. */
  waiting: number;
  working: number;
  open: number;
  children: MapNode[];
}
