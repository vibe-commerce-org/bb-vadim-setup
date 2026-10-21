// Pure: Now/Next/Later lanes over BB Tasks priorities.
import type { Lane, LaneTask, Lanes, TaskPriority, TaskRecord, WaitingKind } from "./types.ts";

export const WIP_LIMIT = 5;
export const LANE_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** urgent → now, high → next, medium | low | none → later. */
export function priorityToLane(priority: TaskPriority): Lane {
  if (priority === "urgent") return "now";
  if (priority === "high") return "next";
  return "later";
}

/** now → urgent, next → high, later → keep medium/low/none if already there, else medium. */
export function laneToPriority(lane: Lane, current: TaskPriority): TaskPriority {
  if (lane === "now") return "urgent";
  if (lane === "next") return "high";
  return current === "medium" || current === "low" || current === "none" ? current : "medium";
}

/** What Pult remembers about a task's lane (from its own store). */
export interface LaneMemory {
  lane: Lane;
  since: number;
  approx: boolean;
}

const CLOSED = new Set(["done", "canceled"]);

/** The newest movement of a task: its own update or activity in its threads. */
function lastMovement(task: TaskRecord): number {
  let newest = task.updatedAt;
  for (const t of task.threads) {
    if (t.lastActivityAt !== null && t.lastActivityAt > newest) newest = t.lastActivityAt;
  }
  return newest;
}

function compareLaneTasks(a: LaneTask, b: LaneTask): number {
  if (a.waitingOnYou !== b.waitingOnYou) return a.waitingOnYou ? -1 : 1;
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.laneSince !== b.laneSince) return a.laneSince - b.laneSince;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Lanes from open tasks (status not done/canceled). laneSince comes from
 * `memory` when the lane matches (a move made through Pult is stored there
 * exact, approx=false). Otherwise the lane changed outside Pult or Pult never
 * saw the task: laneSince is then task.updatedAt (not before the remembered
 * since) with approx=true — the moment Pult noticed it would be later than
 * the real change. Returns the lanes plus the memory to store back: open
 * tasks only, so memory of closed tasks can be dropped.
 * Sort inside a lane: waitingOnYou first, then due ascending (none last),
 * then laneSince oldest first. stale = lane now|next and the newest of
 * task.updatedAt and its threads' lastActivityAt is older than 7 days.
 */
export function buildLanes(
  tasks: readonly TaskRecord[],
  memory: ReadonlyMap<string, LaneMemory>,
  now: number,
): { lanes: Lanes; memory: Map<string, LaneMemory> } {
  const lanes: Lanes = { now: [], next: [], later: [], wipLimit: WIP_LIMIT, wipExceeded: false };
  const nextMemory = new Map<string, LaneMemory>();
  for (const task of tasks) {
    if (CLOSED.has(task.status)) continue;
    const lane = priorityToLane(task.priority);
    const known = memory.get(task.id);
    const mem: LaneMemory =
      known && known.lane === lane
        ? known
        : { lane, since: Math.max(task.updatedAt, known?.since ?? -Infinity), approx: true };
    nextMemory.set(task.id, mem);
    lanes[lane].push({
      ...task,
      lane,
      laneSince: mem.since,
      laneSinceApprox: mem.approx,
      stale: lane !== "later" && now - lastMovement(task) >= LANE_STALE_AFTER_MS,
      waitingOnYou: task.threads.some((t) => t.queueKind !== null),
    });
  }
  lanes.now.sort(compareLaneTasks);
  lanes.next.sort(compareLaneTasks);
  lanes.later.sort(compareLaneTasks);
  lanes.wipExceeded = lanes.now.length > WIP_LIMIT;
  return { lanes, memory: nextMemory };
}

/**
 * «В архив» drops a task the user no longer wants, so the questions in its
 * threads are moot too. Which waiting threads leave «Ход за тобой»: those
 * whose nearest match walking up from the thread itself (parentOf) is one of
 * the task's threads — subthreads ride in the same card. The nearest match
 * decides, and at one thread «held by another open task» beats «the task's
 * own»: that task still wants it and everything under it. Never an approval:
 * its agent is blocked mid-turn.
 */
export function threadsToHideOnArchive(
  taskThreadIds: readonly string[],
  waiting: ReadonlyMap<string, WaitingKind>,
  parentOf: ReadonlyMap<string, string | null>,
  heldElsewhere: ReadonlySet<string>,
): string[] {
  const own = new Set(taskThreadIds);
  const hide: string[] = [];
  for (const [threadId, kind] of waiting) {
    if (kind === "approval") continue;
    const seen = new Set<string>();
    for (let cur: string | null = threadId; cur !== null && !seen.has(cur); cur = parentOf.get(cur) ?? null) {
      seen.add(cur);
      if (heldElsewhere.has(cur)) break;
      if (own.has(cur)) {
        hide.push(threadId);
        break;
      }
    }
  }
  return hide;
}

export type { LaneTask };
