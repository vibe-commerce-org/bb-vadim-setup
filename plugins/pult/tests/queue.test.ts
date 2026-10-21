// The «Ход за тобой» queue: visibility, order, snooze/dismiss, stale. Runs
// under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_SNOOZE_MS,
  QUEUE_EXCERPT_CHARS,
  STALE_AFTER_MS,
  ageBucket,
  buildQueue,
  flatItems,
  snoozeUntilProblem,
} from "../lib/queue.ts";
import type { Classification, Kind, Overlay, ThreadSnapshot } from "../lib/types.ts";

const NOW = Date.parse("2026-10-10T12:00:00+03:00");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cls(kind: Kind, over: Partial<Classification> = {}): Classification {
  return {
    kind,
    ask: kind === "done" ? null : `ask ${kind}`,
    options: [],
    multi: false,
    replyTemplate: null,
    due: null,
    confidence: 0.8,
    source: "rules",
    reasons: [],
    ...over,
  };
}

function snap(id: string, kind: Kind, over: Partial<ThreadSnapshot> = {}, c: Partial<Classification> = {}): ThreadSnapshot {
  return {
    threadId: id,
    projectId: "prj_a",
    projectName: "Проект А",
    title: `Тред ${id}`,
    parentThreadId: null,
    providerId: "claude-code",
    status: "idle",
    pinned: false,
    archived: false,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - HOUR,
    lastAgentAt: NOW - HOUR,
    lastHumanAt: NOW - 2 * HOUR,
    excerpt: null,
    classification: cls(kind, c),
    classifiedAt: NOW,
    ...over,
  };
}

function overlay(id: string, over: Partial<Overlay>): Overlay {
  return { threadId: id, snoozedUntil: null, snoozedAt: null, dismissedAt: null, taskKey: null, ...over };
}

const none = new Map<string, Overlay>();

test("ageBucket boundaries", () => {
  assert.equal(ageBucket(0), "fresh");
  assert.equal(ageBucket(DAY - 1), "fresh");
  assert.equal(ageBucket(DAY), "day");
  assert.equal(ageBucket(7 * DAY - 1), "day");
  assert.equal(ageBucket(7 * DAY), "week");
  assert.equal(ageBucket(14 * DAY - 1), "week");
  assert.equal(ageBucket(14 * DAY), "stale");
});

test("only waiting, not archived threads are visible", () => {
  const q = buildQueue(
    [
      snap("a", "decision"),
      snap("b", "working"),
      snap("c", "done"),
      snap("d", "unknown"),
      snap("e", "action", { archived: true }),
    ],
    none,
    NOW,
  );
  assert.deepEqual(
    q.items.map((i) => i.threadId),
    ["a"],
  );
  assert.equal(q.total, 1);
});

test("order: kind, then due (none last), then pinned, then newest turn", () => {
  const q = buildQueue(
    [
      snap("commit1", "commit"),
      snap("action-old", "action", { lastAgentAt: NOW - 5 * HOUR }),
      snap("action-new", "action", { lastAgentAt: NOW - 1 * HOUR }),
      snap("action-pinned", "action", { pinned: true, lastAgentAt: NOW - 9 * HOUR }),
      snap("action-due-late", "action", {}, { due: "2026-10-20" }),
      snap("action-due-soon", "action", {}, { due: "2026-10-12" }),
      snap("failed1", "failed"),
      snap("approval1", "approval", { lastAgentAt: NOW - 3 * DAY }),
      snap("decision1", "decision"),
      snap("review1", "review"),
    ],
    none,
    NOW,
  );
  assert.deepEqual(
    q.items.map((i) => i.threadId),
    [
      "approval1",
      "decision1",
      "action-due-soon",
      "action-due-late",
      "action-pinned",
      "action-new",
      "action-old",
      "failed1",
      "review1",
      "commit1",
    ],
  );
  assert.equal(q.counts.action, 5);
  assert.equal(q.counts.approval, 1);
  assert.equal(q.counts.commit, 1);
  // The badge leaves out a lone «закоммитить? скажи да».
  assert.equal(q.total, 9);
});

test("items carry the classification and age", () => {
  const q = buildQueue(
    [snap("a", "decision", { lastAgentAt: NOW - 2 * DAY }, { multi: true, replyTemplate: "1 — А, 2 — Б", confidence: 0.9 })],
    new Map([["a", overlay("a", { taskKey: "ORC-3" })]]),
    NOW,
  );
  const it = q.items[0]!;
  assert.equal(it.ageMs, 2 * DAY);
  assert.equal(it.ageBucket, "day");
  assert.equal(it.multi, true);
  assert.equal(it.replyTemplate, "1 — А, 2 — Б");
  assert.equal(it.taskKey, "ORC-3");
  assert.equal(it.snoozedUntil, null);
});

test("age falls back to updatedAt when the agent turn time is unknown", () => {
  const q = buildQueue([snap("a", "approval", { lastAgentAt: null, updatedAt: NOW - 3 * HOUR })], none, NOW);
  assert.equal(q.items[0]!.ageMs, 3 * HOUR);
});

test("14+ days old → stale, still counted", () => {
  const q = buildQueue(
    [snap("old", "decision", { lastAgentAt: NOW - STALE_AFTER_MS }), snap("new", "decision")],
    none,
    NOW,
  );
  assert.deepEqual(
    q.items.map((i) => i.threadId),
    ["new"],
  );
  assert.deepEqual(
    q.stale.map((i) => i.threadId),
    ["old"],
  );
  assert.equal(q.stale[0]!.ageBucket, "stale");
  assert.equal(q.total, 2);
  assert.equal(q.counts.decision, 2);
});

test("dismiss hides until the agent writes again", () => {
  const s = snap("a", "decision", { lastAgentAt: NOW - 2 * HOUR });
  const dismissed = new Map([["a", overlay("a", { dismissedAt: NOW - HOUR })]]);
  assert.equal(buildQueue([s], dismissed, NOW).total, 0);
  // The agent wrote after the dismissal: the item is back.
  const again = { ...s, lastAgentAt: NOW - 10 * 60 * 1000 };
  assert.equal(buildQueue([again], dismissed, NOW).total, 1);
});

test("snooze hides until its time, goes to `snoozed`, wakes on a new agent turn", () => {
  const s = snap("a", "action", { lastAgentAt: NOW - 3 * HOUR });
  const snoozed = new Map([["a", overlay("a", { snoozedUntil: NOW + DAY, snoozedAt: NOW - 2 * HOUR })]]);
  const q = buildQueue([s], snoozed, NOW);
  assert.equal(q.total, 0);
  assert.deepEqual(
    q.snoozed.map((i) => [i.threadId, i.snoozedUntil]),
    [["a", NOW + DAY]],
  );
  // Time passed.
  assert.equal(buildQueue([s], snoozed, NOW + 2 * DAY).total, 1);
  // The agent wrote after the snooze.
  assert.equal(buildQueue([{ ...s, lastAgentAt: NOW - HOUR }], snoozed, NOW).total, 1);
});

test("overlays never hide an approval: BB waits on it mid-turn, no new turn will come", () => {
  // Dismissed / snoozed at T1, later the thread works again and asks for a
  // permission in the middle of a turn: lastAgentAt stays before T1.
  const s = snap("a", "approval", { lastAgentAt: NOW - 3 * HOUR, lastHumanAt: NOW - 4 * HOUR });
  const dismissed = new Map([["a", overlay("a", { dismissedAt: NOW - HOUR })]]);
  assert.equal(buildQueue([s], dismissed, NOW).counts.approval, 1);
  const snoozed = new Map([["a", overlay("a", { snoozedUntil: NOW + DAY, snoozedAt: NOW - HOUR })]]);
  const q = buildQueue([s], snoozed, NOW);
  assert.equal(q.counts.approval, 1);
  assert.equal(q.snoozed.length, 0);
});

test("an overlay lapses once the user wrote into the thread after it", () => {
  // «Не нужно» at T1, the user wrote at T2 > T1, the turn failed at dispatch:
  // no new agent turn, yet the thread is back in work by his will.
  const s = snap("a", "failed", { lastAgentAt: NOW - 3 * HOUR, lastHumanAt: NOW - 30 * 60_000 });
  assert.equal(buildQueue([s], new Map([["a", overlay("a", { dismissedAt: NOW - HOUR })]]), NOW).total, 1);
  const snoozed = new Map([["a", overlay("a", { snoozedUntil: NOW + DAY, snoozedAt: NOW - HOUR })]]);
  assert.equal(buildQueue([s], snoozed, NOW).total, 1);
  // The user's message before the overlay changes nothing.
  const before = { ...s, lastHumanAt: NOW - 2 * HOUR };
  assert.equal(buildQueue([before], new Map([["a", overlay("a", { dismissedAt: NOW - HOUR })]]), NOW).total, 0);
});

test("flatItems: top level, stale and nested subthreads", () => {
  const q = buildQueue(
    [
      snap("p", "decision"),
      snap("c", "action", { parentThreadId: "p" }),
      snap("old", "review", { lastAgentAt: NOW - STALE_AFTER_MS }),
      snap("oldkid", "decision", { parentThreadId: "old" }),
    ],
    none,
    NOW,
  );
  assert.deepEqual(q.items.map((i) => i.threadId), ["p"]);
  assert.deepEqual(flatItems(q).map((i) => i.threadId).sort(), ["c", "old", "oldkid", "p"]);
});

/** No lone surrogate anywhere (String.prototype.isWellFormed is ES2024). */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test("excerpt travels only without an ask, at most 600 chars, no cut surrogate pair", () => {
  const long = "😀".repeat(400) + "конец";
  const q = buildQueue(
    [snap("asked", "decision", { excerpt: "текст" }), snap("silent", "decision", { excerpt: long }, { ask: null })],
    none,
    NOW,
  );
  const byId = new Map(flatItems(q).map((i) => [i.threadId, i]));
  assert.equal(byId.get("asked")!.excerpt, null);
  const excerpt = byId.get("silent")!.excerpt!;
  assert.ok(excerpt.length <= QUEUE_EXCERPT_CHARS);
  assert.ok(excerpt.endsWith("конец"));
  assert.doesNotMatch(excerpt, /^…[\uDC00-\uDFFF]/u);
  assert.ok(wellFormed(excerpt));
});

test("snooze bounds: in the future, at most 30 days", () => {
  assert.equal(snoozeUntilProblem(NOW + DAY, NOW), null);
  assert.equal(snoozeUntilProblem(NOW + MAX_SNOOZE_MS, NOW), null);
  assert.match(snoozeUntilProblem(NOW + MAX_SNOOZE_MS + 1, NOW) ?? "", /30 дней/);
  assert.match(snoozeUntilProblem(NOW - 1, NOW) ?? "", /прошёл/);
});

test("snoozed list: the one that wakes first on top", () => {
  const q = buildQueue(
    [snap("late", "decision"), snap("soon", "decision")],
    new Map([
      ["late", overlay("late", { snoozedUntil: NOW + 3 * DAY, snoozedAt: NOW })],
      ["soon", overlay("soon", { snoozedUntil: NOW + DAY, snoozedAt: NOW })],
    ]),
    NOW,
  );
  assert.deepEqual(
    q.snoozed.map((i) => i.threadId),
    ["soon", "late"],
  );
});

test("parentTitle and openChildren", () => {
  const q = buildQueue(
    [
      snap("parent", "decision", { title: "Родитель" }),
      snap("kid1", "working", { parentThreadId: "parent" }),
      snap("kid2", "review", { parentThreadId: "parent" }),
      snap("kid3", "done", { parentThreadId: "parent" }),
      snap("kid4", "working", { parentThreadId: "parent", archived: true }),
    ],
    none,
    NOW,
  );
  const parent = q.items.find((i) => i.threadId === "parent")!;
  assert.equal(parent.openChildren, 2);
  const kid = parent.nested.find((i) => i.threadId === "kid2")!;
  assert.equal(kid.parentTitle, "Родитель");
  assert.equal(kid.parentThreadId, "parent");
});

const ids = (items: { threadId: string }[]) => items.map((i) => i.threadId);

test("a waiting subthread sits inside its waiting parent's card", () => {
  const q = buildQueue(
    [
      snap("parent", "decision"),
      snap("kid", "review", { parentThreadId: "parent" }),
      snap("other", "action"),
    ],
    none,
    NOW,
  );
  assert.deepEqual(ids(q.items), ["parent", "other"]);
  const parent = q.items[0]!;
  assert.deepEqual(ids(parent.nested), ["kid"]);
  assert.deepEqual(parent.nested[0]!.nested, []);
  assert.deepEqual(q.items[1]!.nested, []);
  // Counts and the badge: the top level only.
  assert.equal(q.counts.decision, 1);
  assert.equal(q.counts.review, 0);
  assert.equal(q.total, 2);
});

test("nesting walks through non-waiting and archived ancestors, one level deep", () => {
  const q = buildQueue(
    [
      snap("root", "decision"),
      snap("mid-working", "working", { parentThreadId: "root" }),
      snap("grandkid", "action", { parentThreadId: "mid-working" }),
      snap("mid-waiting", "approval", { parentThreadId: "root" }),
      snap("great-grandkid", "failed", { parentThreadId: "mid-waiting" }),
      snap("mid-archived", "decision", { parentThreadId: "root", archived: true }),
      snap("under-archived", "review", { parentThreadId: "mid-archived" }),
    ],
    none,
    NOW,
  );
  // An approval never nests (it blocks its agent mid-turn), so "mid-waiting"
  // stays top-level and hosts its own descendant.
  assert.deepEqual(ids(q.items), ["mid-waiting", "root"]);
  const root = q.items.find((i) => i.threadId === "root")!;
  assert.deepEqual(ids(root.nested).sort(), ["grandkid", "under-archived"]);
  const approval = q.items.find((i) => i.threadId === "mid-waiting")!;
  assert.deepEqual(ids(approval.nested), ["great-grandkid"]);
  for (const n of [...root.nested, ...approval.nested]) assert.deepEqual(n.nested, []);
  assert.equal(q.total, 2);
});

test("nested order: kind first, then the freshest", () => {
  const q = buildQueue(
    [
      snap("parent", "decision"),
      snap("review-new", "review", { parentThreadId: "parent", lastAgentAt: NOW - HOUR }),
      snap("action-old", "action", { parentThreadId: "parent", lastAgentAt: NOW - 5 * HOUR }),
      snap("action-new", "action", { parentThreadId: "parent", lastAgentAt: NOW - 2 * HOUR }),
      snap("approval-old", "approval", { parentThreadId: "parent", lastAgentAt: NOW - 3 * DAY, pinned: true }),
    ],
    none,
    NOW,
  );
  // The approval stays on top as its own card; the rest nest by kind, then freshness.
  assert.deepEqual(ids(q.items), ["approval-old", "parent"]);
  assert.deepEqual(ids(q.items.find((i) => i.threadId === "parent")!.nested), ["action-new", "action-old", "review-new"]);
});

test("a hidden parent leaves its subthread on top; snoozed items stay flat", () => {
  const snaps = [snap("parent", "decision"), snap("kid", "action", { parentThreadId: "parent" })];
  // The parent is snoozed: the kid stands alone, the parent is in `snoozed`.
  const parentSnoozed = new Map([["parent", overlay("parent", { snoozedUntil: NOW + DAY, snoozedAt: NOW })]]);
  let q = buildQueue(snaps, parentSnoozed, NOW);
  assert.deepEqual(ids(q.items), ["kid"]);
  assert.deepEqual(ids(q.snoozed), ["parent"]);
  assert.deepEqual(q.snoozed[0]!.nested, []);
  // The parent is dismissed: the kid stands alone.
  q = buildQueue(snaps, new Map([["parent", overlay("parent", { dismissedAt: NOW })]]), NOW);
  assert.deepEqual(ids(q.items), ["kid"]);
  // The kid is snoozed: flat in `snoozed`, not inside the parent.
  q = buildQueue(snaps, new Map([["kid", overlay("kid", { snoozedUntil: NOW + DAY, snoozedAt: NOW })]]), NOW);
  assert.deepEqual(ids(q.items), ["parent"]);
  assert.deepEqual(q.items[0]!.nested, []);
  assert.deepEqual(ids(q.snoozed), ["kid"]);
});

test("a fresh subthread of a stale parent sits in the stale card", () => {
  const q = buildQueue(
    [
      snap("old-parent", "decision", { lastAgentAt: NOW - STALE_AFTER_MS - DAY }),
      snap("fresh-kid", "action", { parentThreadId: "old-parent" }),
    ],
    none,
    NOW,
  );
  assert.deepEqual(ids(q.items), []);
  assert.deepEqual(ids(q.stale), ["old-parent"]);
  assert.deepEqual(ids(q.stale[0]!.nested), ["fresh-kid"]);
  assert.equal(q.total, 1);
});

test("a commit card takes no children; a commit subthread nests and never counts", () => {
  const q = buildQueue(
    [
      snap("commit-parent", "commit"),
      snap("ask-kid", "decision", { parentThreadId: "commit-parent" }),
      snap("ask-parent", "action"),
      snap("commit-kid", "commit", { parentThreadId: "ask-parent" }),
    ],
    none,
    NOW,
  );
  assert.deepEqual(ids(q.items), ["ask-kid", "ask-parent", "commit-parent"]);
  assert.deepEqual(q.items[2]!.nested, []);
  assert.deepEqual(ids(q.items[1]!.nested), ["commit-kid"]);
  assert.equal(q.counts.commit, 1);
  assert.equal(q.total, 2);
});

test("a parent cycle does not hang and keeps every item once", () => {
  const q = buildQueue(
    [snap("a", "decision", { parentThreadId: "b" }), snap("b", "decision", { parentThreadId: "a" })],
    none,
    NOW,
  );
  const all = [...q.items, ...q.items.flatMap((i) => i.nested)];
  assert.deepEqual(ids(all).sort(), ["a", "b"]);
  assert.equal(q.items.length, 1);
});

test("a dismissed item leaves the queue but stays listed in `dismissed`", () => {
  const q = buildQueue([snap("t1", "decision")], new Map([["t1", overlay("t1", { dismissedAt: NOW - 30 * 60 * 1000 })]]), NOW);
  assert.equal(q.total, 0);
  assert.deepEqual(q.items, []);
  assert.deepEqual(q.dismissed.map((i) => i.threadId), ["t1"]);
  assert.deepEqual(flatItems(q), []); // hidden: no row mark, not waiting on a task
});

test("an approval subthread never nests in its parent's card", () => {
  const parent = snap("p", "decision");
  const child = snap("c", "approval", { parentThreadId: "p" }, { source: "native" });
  const q = buildQueue([parent, child], new Map(), NOW);
  assert.deepEqual(q.items.map((i) => i.threadId).sort(), ["c", "p"]);
  assert.deepEqual(q.items.find((i) => i.threadId === "p")!.nested, []);
  assert.equal(q.counts.approval, 1);
  assert.equal(q.total, 2);
});
