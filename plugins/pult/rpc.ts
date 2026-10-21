// The RPC contract between Pult's page (app.tsx, components/pult/*) and its
// backend (server.ts, server/*). Both schemas run at the wire boundary; the
// frontend imports only the type of `rpcContract`.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadId = z.string().regex(/^thr_[a-z0-9]{6,40}$/);
const waitingKind = z.enum(["approval", "decision", "action", "failed", "review", "commit"]);
const kind = z.enum([
  "approval",
  "decision",
  "action",
  "failed",
  "review",
  "commit",
  "working",
  "done",
  "unknown",
]);
const source = z.enum(["manual", "native", "marker", "inventory", "llm", "rules"]);
const lane = z.enum(["now", "next", "later"]);

const answerOption = z.object({
  key: z.string(),
  label: z.string(),
  recommended: z.boolean(),
});

const queueItemBase = z.object({
  threadId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  parentThreadId: z.string().nullable(),
  parentTitle: z.string().nullable(),
  kind: waitingKind,
  ask: z.string().nullable(),
  options: z.array(answerOption),
  multi: z.boolean(),
  replyTemplate: z.string().nullable(),
  due: z.string().nullable(),
  ageMs: z.number(),
  ageBucket: z.enum(["fresh", "day", "week", "stale"]),
  source,
  confidence: z.number(),
  pinned: z.boolean(),
  taskKey: z.string().nullable(),
  openChildren: z.number().int(),
  excerpt: z.string().nullable(),
  lastAgentAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
});

/** A queue item; `nested` holds waiting subthreads (one level deep). */
export const queueItemSchema = queueItemBase.extend({
  nested: z.array(queueItemBase.extend({ nested: z.array(z.never()) })),
});

const counts = z.object({
  approval: z.number().int(),
  decision: z.number().int(),
  action: z.number().int(),
  failed: z.number().int(),
  review: z.number().int(),
  commit: z.number().int(),
});

export const queueSchema = z.object({
  items: z.array(queueItemSchema),
  stale: z.array(queueItemSchema),
  snoozed: z.array(queueItemSchema),
  dismissed: z.array(queueItemSchema),
  counts,
  total: z.number().int(),
});

const scanInfo = z.object({
  /** When the last scan finished (ms), null before the first one. */
  scannedAt: z.number().nullable(),
  scanning: z.boolean(),
  /** Threads known to Pult (not archived). */
  threadCount: z.number().int(),
  llmEnabled: z.boolean(),
  /** As-of time (ms) of the imported inventory, null when none was imported. */
  seedAsOf: z.number().nullable(),
});

const gitState = z.object({
  projectId: z.string(),
  branch: z.string().nullable(),
  state: z.enum([
    "clean",
    "untracked",
    "dirty_uncommitted",
    "committed_unmerged",
    "dirty_and_committed_unmerged",
    "unknown",
  ]),
  ahead: z.number().int().nullable(),
  behind: z.number().int().nullable(),
  checkedAt: z.number(),
});

const taskThreadRef = z.object({
  threadId: z.string(),
  title: z.string(),
  liveStatus: z.string(),
  queueKind: waitingKind.nullable(),
  lastActivityAt: z.number().nullable(),
});

export const laneTaskSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "canceled"]),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  dueDate: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  trackerProjectId: z.string(),
  trackerProjectName: z.string(),
  bbProjectId: z.string().nullable(),
  threads: z.array(taskThreadRef),
  lane,
  laneSince: z.number(),
  laneSinceApprox: z.boolean(),
  stale: z.boolean(),
  waitingOnYou: z.boolean(),
});

type MapNodeShape = {
  type: "project" | "task" | "thread";
  id: string;
  title: string;
  kind: z.infer<typeof kind> | null;
  lane: z.infer<typeof lane> | null;
  ageMs: number | null;
  blockedByThreadId: string | null;
  git: z.infer<typeof gitState> | null;
  waiting: number;
  working: number;
  open: number;
  children: MapNodeShape[];
};
export const mapNodeSchema: z.ZodType<MapNodeShape> = z.lazy(() =>
  z.object({
    type: z.enum(["project", "task", "thread"]),
    id: z.string(),
    title: z.string(),
    kind: kind.nullable(),
    lane: lane.nullable(),
    ageMs: z.number().nullable(),
    blockedByThreadId: z.string().nullable(),
    git: gitState.nullable(),
    waiting: z.number().int(),
    working: z.number().int(),
    open: z.number().int(),
    children: z.array(mapNodeSchema),
  }),
);

const ok = z.object({ ok: z.literal(true) });

export const rpcContract = defineRpcContract({
  /** The «Ход за тобой» queue plus scan status. */
  "queue.list": {
    input: z.null(),
    output: z.object({ queue: queueSchema, scan: scanInfo }),
  },
  // There is deliberately NO reply method. Plugin RPC is callable by any
  // agent (`bb plugin rpc call pult …`), and a backend threads.send without
  // senderThreadId is recorded as the user's own message. Answers are sent by
  // the page itself through the browser session's useSdk().threads.send,
  // only from an explicit click + confirmation (security review 12.10).
  /** Hide until `until` (ms, at most 30 days ahead) or until the agent writes again. */
  "queue.snooze": {
    input: z.object({ threadId, until: z.number().int().positive() }).strict(),
    output: ok,
  },
  /** «Не нужно»: hide until the agent writes again. */
  "queue.dismiss": { input: z.object({ threadId }).strict(), output: ok },
  /** Undo snooze/dismiss. */
  "queue.restore": { input: z.object({ threadId }).strict(), output: ok },
  /**
   * File the thread as a BB Tasks task in a lane: creates the tracker
   * project for the thread's BB project if there is none, creates the task,
   * attaches the thread.
   */
  "queue.toTask": {
    input: z
      .object({ threadId, lane, title: z.string().trim().min(1).max(200).optional() })
      .strict(),
    output: z.object({ taskKey: z.string() }),
  },
  /** Re-scan now: changed threads only, or all with full=true. */
  "scan.run": {
    input: z.object({ full: z.boolean().optional() }).strict(),
    output: z.object({ scanned: z.number().int() }),
  },
  /** Lanes Now/Next/Later from BB Tasks. */
  "lanes.list": {
    input: z.null(),
    output: z.object({
      tasksAvailable: z.boolean(),
      lanes: z.object({
        now: z.array(laneTaskSchema),
        next: z.array(laneTaskSchema),
        later: z.array(laneTaskSchema),
        wipLimit: z.number().int(),
        wipExceeded: z.boolean(),
      }),
    }),
  },
  /** Move a task to another lane (changes its BB Tasks priority). */
  "lanes.move": {
    input: z.object({ taskId: z.string().min(1), lane }).strict(),
    output: ok,
  },
  /** Mark a task done in BB Tasks. */
  "lanes.done": { input: z.object({ taskId: z.string().min(1) }).strict(), output: ok },
  /**
   * «В архив»: the task is no longer wanted — canceled in BB Tasks, not done.
   * Its waiting threads leave «Ход за тобой» as «не нужно»; `hidden` counts them.
   */
  "lanes.archive": {
    input: z.object({ taskId: z.string().min(1) }).strict(),
    output: z.object({ hidden: z.number().int() }),
  },
  /** The «Карта» tree. */
  "map.get": {
    input: z.object({ openOnly: z.boolean() }).strict(),
    output: z.object({ projects: z.array(mapNodeSchema), gitCheckedAt: z.number().nullable() }),
  },
  /** Thread-row marks for BB's own thread list (content script). */
  "marks.list": {
    input: z.null(),
    output: z.object({
      marks: z.array(z.object({ threadId: z.string(), kind: waitingKind, label: z.string() })),
    }),
  },
  /** The right-panel view inside a thread. */
  "panel.forThread": {
    input: z.object({ threadId }).strict(),
    output: z.object({
      projectId: z.string().nullable(),
      projectName: z.string().nullable(),
      thisThread: z
        .object({ kind, ask: z.string().nullable(), source, confidence: z.number() })
        .nullable(),
      items: z.array(queueItemSchema),
      git: gitState.nullable(),
    }),
  },
});

/** Realtime channel: published after every change of the queue or lanes. */
export const PULT_CHANGED = "pult:changed";
