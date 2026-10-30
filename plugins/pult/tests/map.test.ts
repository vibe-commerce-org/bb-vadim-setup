// The «Карта» tree: project → tasks → threads, families, «ждёт родителя».
// Runs under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMap } from "../lib/map.ts";
import type { Classification, GitState, Kind, MapNode, Overlay, TaskRecord, ThreadSnapshot } from "../lib/types.ts";

const NOW = Date.parse("2026-10-10T12:00:00+03:00");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cls(kind: Kind): Classification {
  return { kind, ask: null, options: [], multi: false, replyTemplate: null, due: null, confidence: 0.8, source: "rules", reasons: [] };
}

function snap(id: string, kind: Kind, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId: id,
    projectId: "prj_a",
    projectName: "Проект А",
    title: `Тред ${id}`,
    parentThreadId: null,
    providerId: "claude-code",
    model: null,
    modelLabel: null,
    effort: null,
    status: "idle",
    pinned: false,
    archived: false,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * HOUR,
    lastAgentAt: NOW - 2 * HOUR,
    lastHumanAt: NOW - 3 * HOUR,
    excerpt: null,
    classification: cls(kind),
    classifiedAt: NOW,
    ...over,
  };
}

function task(id: string, threadIds: string[], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    key: id.toUpperCase(),
    title: `Задача ${id}`,
    status: "in_progress",
    priority: "urgent",
    dueDate: null,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY,
    trackerProjectId: "trk_1",
    trackerProjectName: "Трекер",
    bbProjectId: "prj_a",
    threads: threadIds.map((t) => ({ threadId: t, title: t, liveStatus: "idle", queueKind: null, lastActivityAt: null })),
    ...over,
  };
}

const projects = [
  { id: "prj_a", name: "Проект А" },
  { id: "prj_b", name: "Проект Б" },
];
const noGit = new Map<string, GitState>();

const ids = (nodes: MapNode[]) => nodes.map((n) => n.id);
const find = (nodes: MapNode[], id: string): MapNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const inner = find(n.children, id);
    if (inner) return inner;
  }
  return undefined;
};

test("project → task → threads, and families without a task", () => {
  const snaps = [
    snap("t1", "decision"),
    snap("t1kid", "working", { parentThreadId: "t1" }),
    snap("root", "working"),
    snap("rootkid", "action", { parentThreadId: "root" }),
  ];
  const map = buildMap(projects, snaps, [task("ta", ["t1"])], noGit, NOW, true);
  assert.deepEqual(ids(map), ["prj_a"]); // Б has nothing open
  const proj = map[0]!;
  assert.deepEqual(ids(proj.children), ["ta", "root"]);
  const taskNode = proj.children[0]!;
  assert.equal(taskNode.type, "task");
  assert.equal(taskNode.title, "TA · Задача ta");
  assert.equal(taskNode.lane, "now");
  assert.deepEqual(ids(taskNode.children), ["t1"]);
  assert.deepEqual(ids(taskNode.children[0]!.children), ["t1kid"]);
  assert.deepEqual(ids(proj.children[1]!.children), ["rootkid"]);
});

test("every thread appears once", () => {
  const snaps = [snap("p", "working"), snap("c", "decision", { parentThreadId: "p" })];
  // The child is filed under a task; it leaves its parent's family.
  const map = buildMap(projects, snaps, [task("ta", ["c"])], noGit, NOW, true);
  const all: string[] = [];
  const walk = (n: MapNode) => {
    if (n.type === "thread") all.push(n.id);
    n.children.forEach(walk);
  };
  map.forEach(walk);
  assert.deepEqual(all.sort(), ["c", "p"]);
  assert.deepEqual(ids(find(map, "ta")!.children), ["c"]);
  assert.deepEqual(ids(find(map, "p")!.children), []);
});

test("a working child whose parent waits for the user is blocked by it", () => {
  const snaps = [
    snap("parent", "decision"),
    snap("kid-open", "working", { parentThreadId: "parent" }),
    snap("kid-done", "done", { parentThreadId: "parent" }),
    snap("kid-unknown", "unknown", { parentThreadId: "parent" }),
    snap("kid-waits", "action", { parentThreadId: "parent" }),
    snap("kid-commit", "commit", { parentThreadId: "parent" }),
    snap("p2", "working"),
    snap("kid-of-working", "working", { parentThreadId: "p2" }),
  ];
  const map = buildMap(projects, snaps, [], noGit, NOW, false);
  assert.equal(find(map, "kid-open")!.blockedByThreadId, "parent");
  assert.equal(find(map, "kid-done")!.blockedByThreadId, null);
  assert.equal(find(map, "kid-unknown")!.blockedByThreadId, null);
  // A child that itself waits for the user is his move, not «ждёт родителя».
  assert.equal(find(map, "kid-waits")!.blockedByThreadId, null);
  assert.equal(find(map, "kid-commit")!.blockedByThreadId, null);
  assert.equal(find(map, "kid-of-working")!.blockedByThreadId, null);
});

test("openOnly hides done/unknown threads without open descendants and closed tasks", () => {
  const snaps = [
    snap("done-alone", "done"),
    snap("done-parent", "done"),
    snap("open-kid", "review", { parentThreadId: "done-parent" }),
    snap("unknown-alone", "unknown"),
    snap("in-closed-task", "working"),
  ];
  const tasks = [task("closed", ["in-closed-task"], { status: "done" }), task("empty-open", [])];
  const open = buildMap(projects, snaps, tasks, noGit, NOW, true);
  const proj = open[0]!;
  assert.equal(find(open, "done-alone"), undefined);
  assert.equal(find(open, "unknown-alone"), undefined);
  assert.ok(find(open, "done-parent"));
  assert.equal(find(open, "closed"), undefined);
  assert.ok(find(open, "empty-open"), "an open task stays even without threads");
  // The thread of the closed task falls back to its family place.
  assert.ok(proj.children.some((n) => n.id === "in-closed-task"));
  // Everything when not openOnly, including the empty project.
  const all = buildMap(projects, snaps, tasks, noGit, NOW, false);
  assert.deepEqual(ids(all).sort(), ["prj_a", "prj_b"]);
  assert.ok(find(all, "done-alone"));
  assert.ok(find(all, "closed"));
});

test("counts, most urgent kind inside, git, project order", () => {
  const snaps = [
    snap("a1", "working"),
    snap("a2", "review", { parentThreadId: "a1" }),
    snap("b1", "decision", { projectId: "prj_b", projectName: "Проект Б" }),
    snap("b2", "action", { projectId: "prj_b", projectName: "Проект Б" }),
    snap("b3", "approval", { projectId: "prj_b", projectName: "Проект Б", parentThreadId: "b2" }),
  ];
  const git = new Map<string, GitState>([
    ["prj_b", { projectId: "prj_b", branch: "local", state: "dirty_uncommitted", ahead: 2, behind: 0, checkedAt: NOW }],
  ]);
  const map = buildMap(projects, snaps, [task("tb", ["b1"], { bbProjectId: "prj_b" })], git, NOW, true);
  assert.deepEqual(ids(map), ["prj_b", "prj_a"]); // more waiting first
  const b = map[0]!;
  assert.equal(b.waiting, 3);
  assert.equal(b.working, 0);
  assert.equal(b.open, 4); // 3 open threads + 1 open task
  assert.equal(b.kind, "approval");
  assert.equal(b.git?.state, "dirty_uncommitted");
  assert.equal(find(map, "b2")!.kind, "action");
  assert.equal(find(map, "b2")!.waiting, 2);
  const a = map[1]!;
  assert.equal(a.waiting, 1);
  assert.equal(a.working, 1);
  assert.equal(a.kind, "review");
  assert.equal(a.git, null);
});

test("ageMs: newest activity of a thread; project = its freshest child", () => {
  const snaps = [
    snap("x", "working", { updatedAt: NOW - 5 * HOUR, lastAgentAt: NOW - 6 * HOUR, lastHumanAt: NOW - HOUR }),
    snap("y", "working", { updatedAt: NOW - 3 * DAY, lastAgentAt: NOW - 3 * DAY, lastHumanAt: null }),
  ];
  const map = buildMap(projects, snaps, [], noGit, NOW, true);
  assert.equal(find(map, "x")!.ageMs, HOUR);
  assert.equal(map[0]!.ageMs, HOUR);
  assert.deepEqual(ids(map[0]!.children), ["x", "y"]);
});

test("ageMs ignores a bumped updatedAt (the 2026-10-15 mass model switch)", () => {
  const snaps = [snap("w", "working", { updatedAt: NOW - HOUR, lastAgentAt: NOW - 5 * DAY, lastHumanAt: null })];
  assert.equal(find(buildMap(projects, snaps, [], noGit, NOW, true), "w")!.ageMs, 5 * DAY);
});

test("archived threads never show", () => {
  const map = buildMap(projects, [snap("gone", "decision", { archived: true })], [], noGit, NOW, false);
  assert.equal(find(map, "gone"), undefined);
});

test("«не нужно», «отложить» and commits do not count as waiting; hidden parents block nobody", () => {
  const snaps = [
    snap("shown", "decision"),
    snap("dismissed", "decision", { lastAgentAt: NOW - 2 * HOUR }),
    snap("snoozed", "action", { lastAgentAt: NOW - 2 * HOUR }),
    snap("kid", "working", { parentThreadId: "dismissed" }),
    snap("commit", "commit"),
    snap("other", "working", { projectId: "prj_b", projectName: "Проект Б" }),
  ];
  const overlays = new Map<string, Overlay>([
    ["dismissed", { threadId: "dismissed", snoozedUntil: null, snoozedAt: null, dismissedAt: NOW - HOUR, taskKey: null }],
    ["snoozed", { threadId: "snoozed", snoozedUntil: NOW + DAY, snoozedAt: NOW - HOUR, dismissedAt: null, taskKey: null }],
  ]);
  const map = buildMap(projects, snaps, [task("ta", ["snoozed"])], noGit, NOW, true, overlays);
  const a = find(map, "prj_a")!;
  assert.equal(a.waiting, 1); // only «shown»
  assert.equal(find(map, "kid")!.blockedByThreadId, null);
  assert.equal(find(map, "dismissed")!.kind, "decision"); // the node keeps its own kind
  assert.equal(find(map, "ta")!.kind, null); // its only thread is snoozed
  assert.equal(find(map, "ta")!.waiting, 0);
  // Without overlays the same threads count (and «kid» waits behind its parent).
  const plain = buildMap(projects, snaps, [task("ta", ["snoozed"])], noGit, NOW, true);
  assert.equal(find(plain, "prj_a")!.waiting, 3);
  assert.equal(find(plain, "kid")!.blockedByThreadId, "dismissed");
  // A project whose only waiting thread was dismissed sorts like a quiet one.
  const quiet = buildMap(projects, [snaps[1]!, snaps[5]!], [], noGit, NOW, true, overlays);
  assert.equal(find(quiet, "prj_a")!.waiting, 0);
});
