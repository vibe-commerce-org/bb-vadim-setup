// Now/Next/Later lanes over BB Tasks priorities. Runs under `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WIP_LIMIT,
  buildLanes,
  laneToPriority,
  priorityToLane,
  threadsToHideOnArchive,
  type LaneMemory,
} from "../lib/lanes.ts";
import type { TaskRecord, TaskThreadRef, WaitingKind } from "../lib/types.ts";

const NOW = Date.parse("2026-10-10T12:00:00+03:00");
const DAY = 24 * 60 * 60 * 1000;

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    key: id.toUpperCase(),
    title: `Задача ${id}`,
    status: "todo",
    priority: "medium",
    dueDate: null,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - DAY,
    trackerProjectId: "trk_1",
    trackerProjectName: "Оркестратор",
    bbProjectId: "prj_a",
    threads: [],
    ...over,
  };
}

function ref(threadId: string, over: Partial<TaskThreadRef> = {}): TaskThreadRef {
  return { threadId, title: threadId, liveStatus: "idle", queueKind: null, lastActivityAt: null, ...over };
}

const empty = new Map<string, LaneMemory>();

test("priorityToLane", () => {
  assert.equal(priorityToLane("urgent"), "now");
  assert.equal(priorityToLane("high"), "next");
  assert.equal(priorityToLane("medium"), "later");
  assert.equal(priorityToLane("low"), "later");
  assert.equal(priorityToLane("none"), "later");
});

test("laneToPriority keeps a later priority, else medium", () => {
  assert.equal(laneToPriority("now", "low"), "urgent");
  assert.equal(laneToPriority("next", "urgent"), "high");
  assert.equal(laneToPriority("later", "low"), "low");
  assert.equal(laneToPriority("later", "none"), "none");
  assert.equal(laneToPriority("later", "urgent"), "medium");
  assert.equal(laneToPriority("later", "high"), "medium");
});

test("closed tasks are out; lanes by priority", () => {
  const { lanes } = buildLanes(
    [
      task("a", { priority: "urgent" }),
      task("b", { priority: "high" }),
      task("c", { priority: "low" }),
      task("d", { priority: "urgent", status: "done" }),
      task("e", { priority: "high", status: "canceled" }),
    ],
    empty,
    NOW,
  );
  assert.deepEqual(lanes.now.map((t) => t.id), ["a"]);
  assert.deepEqual(lanes.next.map((t) => t.id), ["b"]);
  assert.deepEqual(lanes.later.map((t) => t.id), ["c"]);
  assert.equal(lanes.wipLimit, WIP_LIMIT);
});

test("laneSince: remembered, changed outside Pult or first seen → task.updatedAt (approx)", () => {
  const memory = new Map<string, LaneMemory>([
    ["same", { lane: "now", since: NOW - 3 * DAY, approx: false }],
    ["moved", { lane: "later", since: NOW - 9 * DAY, approx: true }],
  ]);
  const { lanes, memory: next } = buildLanes(
    [
      task("same", { priority: "urgent" }),
      task("moved", { priority: "high" }),
      task("fresh", { priority: "urgent", updatedAt: NOW - 2 * DAY }),
      task("closed", { priority: "urgent", status: "done" }),
    ],
    memory,
    NOW,
  );
  const same = lanes.now.find((t) => t.id === "same")!;
  assert.equal(same.laneSince, NOW - 3 * DAY);
  assert.equal(same.laneSinceApprox, false);
  // Moved in BB Tasks, noticed by Pult only now: the task's update time is
  // closer to the truth than the moment of noticing.
  const moved = lanes.next.find((t) => t.id === "moved")!;
  assert.equal(moved.laneSince, NOW - DAY);
  assert.equal(moved.laneSinceApprox, true);
  const fresh = lanes.now.find((t) => t.id === "fresh")!;
  assert.equal(fresh.laneSince, NOW - 2 * DAY);
  assert.equal(fresh.laneSinceApprox, true);
  assert.deepEqual([...next.keys()].sort(), ["fresh", "moved", "same"]);
  assert.deepEqual(next.get("moved"), { lane: "next", since: NOW - DAY, approx: true });
});

test("laneSince of an observed change is never before the remembered one", () => {
  const memory = new Map<string, LaneMemory>([["m", { lane: "later", since: NOW - 2 * 3_600_000, approx: false }]]);
  const { lanes } = buildLanes([task("m", { priority: "urgent", updatedAt: NOW - DAY })], memory, NOW);
  assert.equal(lanes.now[0]?.laneSince, NOW - 2 * 3_600_000);
});

test("sort: waiting on you, then due (none last), then the oldest in lane", () => {
  const memory = new Map<string, LaneMemory>([
    ["old", { lane: "now", since: NOW - 10 * DAY, approx: false }],
    ["young", { lane: "now", since: NOW - 1 * DAY, approx: false }],
    ["due-late", { lane: "now", since: NOW, approx: false }],
    ["due-soon", { lane: "now", since: NOW, approx: false }],
    ["waits", { lane: "now", since: NOW, approx: false }],
  ]);
  const { lanes } = buildLanes(
    [
      task("young", { priority: "urgent" }),
      task("old", { priority: "urgent" }),
      task("due-late", { priority: "urgent", dueDate: "2026-10-30" }),
      task("due-soon", { priority: "urgent", dueDate: "2026-10-12" }),
      task("waits", { priority: "urgent", threads: [ref("thr_x", { queueKind: "decision" })] }),
    ],
    memory,
    NOW,
  );
  assert.deepEqual(lanes.now.map((t) => t.id), ["waits", "due-soon", "due-late", "old", "young"]);
  assert.equal(lanes.now[0]!.waitingOnYou, true);
  assert.equal(lanes.now[1]!.waitingOnYou, false);
});

test("stale: Now/Next without movement for 7+ days; thread activity counts", () => {
  const { lanes } = buildLanes(
    [
      task("quiet", { priority: "urgent", updatedAt: NOW - 8 * DAY }),
      task("busy-thread", {
        priority: "high",
        updatedAt: NOW - 20 * DAY,
        threads: [ref("thr_y", { lastActivityAt: NOW - DAY })],
      }),
      task("later-quiet", { priority: "low", updatedAt: NOW - 30 * DAY }),
    ],
    empty,
    NOW,
  );
  assert.equal(lanes.now[0]!.stale, true);
  assert.equal(lanes.next[0]!.stale, false);
  assert.equal(lanes.later[0]!.stale, false);
});

test("WIP: more than 5 in Now exceeds the limit", () => {
  const five = Array.from({ length: 5 }, (_, i) => task(`t${i}`, { priority: "urgent" }));
  assert.equal(buildLanes(five, empty, NOW).lanes.wipExceeded, false);
  const six = [...five, task("t5", { priority: "urgent" })];
  assert.equal(buildLanes(six, empty, NOW).lanes.wipExceeded, true);
});

test("archive hides the task's waiting threads and their subthreads, not approvals", () => {
  const waiting = new Map<string, WaitingKind>([
    ["thr_task", "decision"],
    ["thr_child", "action"],
    ["thr_grandchild", "review"],
    ["thr_approval", "approval"],
    ["thr_other", "decision"],
  ]);
  const parentOf = new Map<string, string | null>([
    ["thr_task", null],
    ["thr_child", "thr_task"],
    ["thr_grandchild", "thr_child"],
    ["thr_approval", "thr_task"],
    ["thr_other", null],
  ]);
  const hide = threadsToHideOnArchive(["thr_task", "thr_quiet"], waiting, parentOf, new Set());
  assert.deepEqual([...hide].sort(), ["thr_child", "thr_grandchild", "thr_task"]);
});

test("archive keeps what another open task holds, and everything under it", () => {
  const waiting = new Map<string, WaitingKind>([
    ["thr_shared", "decision"],
    ["thr_under_held", "action"],
    ["thr_mine", "review"],
  ]);
  const parentOf = new Map<string, string | null>([
    ["thr_shared", null],
    ["thr_held", "thr_shared"],
    ["thr_under_held", "thr_held"],
    ["thr_mine", "thr_held"],
  ]);
  // thr_shared is attached to both tasks; thr_held belongs to another open task,
  // thr_mine sits under it but is attached to the archived task itself.
  const hide = threadsToHideOnArchive(
    ["thr_shared", "thr_mine"],
    waiting,
    parentOf,
    new Set(["thr_shared", "thr_held"]),
  );
  assert.deepEqual(hide, ["thr_mine"]);
});

test("archive survives a parent cycle", () => {
  const waiting = new Map<string, WaitingKind>([["thr_a", "decision"]]);
  const parentOf = new Map<string, string | null>([
    ["thr_a", "thr_b"],
    ["thr_b", "thr_a"],
  ]);
  assert.deepEqual(threadsToHideOnArchive(["thr_c"], waiting, parentOf, new Set()), []);
});
