// The «Лента» tab: one row per thread, newest conversation first, the parent
// named, «Семьями» grouping. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFeed,
  familySize,
  feedAge,
  groupFamilies,
  lastConversationAt,
  parentLabel,
  parentRepo,
  shortRepo,
} from "../lib/feed.ts";
import type { Classification, Kind, ThreadSnapshot } from "../lib/types.ts";

const NOW = Date.parse("2026-10-16T12:00:00+03:00");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cls(kind: Kind): Classification {
  return { kind, ask: null, options: [], multi: false, replyTemplate: null, due: null, confidence: 0.8, source: "rules", reasons: [] };
}

function snap(id: string, over: Partial<ThreadSnapshot> = {}, kind: Kind = "done"): ThreadSnapshot {
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
    // BB's updatedAt after the 2026-10-15 mass model switch: the same for everyone.
    updatedAt: NOW - HOUR,
    lastAgentAt: NOW - 5 * DAY,
    lastHumanAt: NOW - 6 * DAY,
    excerpt: null,
    classification: cls(kind),
    classifiedAt: NOW,
    ...over,
  };
}

const visible = () => false;

test("last conversation is the later of the agent's turn and the user's message, never updatedAt", () => {
  assert.equal(lastConversationAt(snap("a")), NOW - 5 * DAY);
  assert.equal(lastConversationAt(snap("a", { lastHumanAt: NOW - 2 * DAY })), NOW - 2 * DAY);
  assert.equal(lastConversationAt(snap("a", { lastAgentAt: null })), NOW - 6 * DAY);
});

test("a thread with neither time falls back to its creation time, not updatedAt", () => {
  const s = snap("a", { lastAgentAt: null, lastHumanAt: null });
  assert.equal(lastConversationAt(s), s.createdAt);
});

test("rows go newest conversation first; a bumped updatedAt moves nothing; ties go by id", () => {
  const rows = buildFeed(
    [
      snap("thr_old", { lastAgentAt: NOW - 9 * DAY, lastHumanAt: null }),
      snap("thr_new", { lastAgentAt: NOW - 3 * HOUR }),
      snap("thr_b", { lastAgentAt: NOW - 2 * DAY, lastHumanAt: null }),
      snap("thr_a", { lastAgentAt: NOW - 2 * DAY, lastHumanAt: null }),
    ],
    visible,
  );
  assert.deepEqual(
    rows.map((r) => r.threadId),
    ["thr_new", "thr_a", "thr_b", "thr_old"],
  );
});

test("subthreads are rows of their own; archived threads are not rows", () => {
  const rows = buildFeed(
    [
      snap("thr_root"),
      snap("thr_kid", { parentThreadId: "thr_root", lastAgentAt: NOW - HOUR }),
      snap("thr_gone", { archived: true }),
    ],
    visible,
  );
  assert.deepEqual(rows.map((r) => r.threadId), ["thr_kid", "thr_root"]);
  assert.equal(rows[0]?.parentThreadId, "thr_root");
});

test("the parent is named; an archived or unknown parent is said so", () => {
  const rows = buildFeed(
    [
      snap("thr_root", { title: "Главная задача" }),
      snap("thr_kid", { parentThreadId: "thr_root" }),
      snap("thr_arch", { archived: true, title: "Старый" }),
      snap("thr_orphan", { parentThreadId: "thr_arch" }),
      snap("thr_lost", { parentThreadId: "thr_deleted" }),
    ],
    visible,
  );
  const label = (id: string) => parentLabel(rows.find((r) => r.threadId === id)!);
  assert.equal(label("thr_root"), null);
  assert.equal(label("thr_kid"), "Главная задача");
  assert.equal(label("thr_orphan"), "родитель в архиве");
  assert.equal(label("thr_lost"), "родитель недоступен");
});

test("a subthread names the parent's repository too, also when the parent sits in another one", () => {
  const rows = buildFeed(
    [
      snap("thr_root", { projectName: "Shop_code" }),
      snap("thr_kid", { parentThreadId: "thr_root", projectName: "market_web_code" }),
      snap("thr_arch", { archived: true, projectName: "meeting_room_code" }),
      snap("thr_orphan", { parentThreadId: "thr_arch" }),
      snap("thr_lost", { parentThreadId: "thr_deleted" }),
    ],
    visible,
  );
  const repo = (id: string) => parentRepo(rows.find((r) => r.threadId === id)!);
  assert.equal(repo("thr_kid"), "Shop_code");
  assert.equal(repo("thr_orphan"), "meeting_room_code"); // the parent is archived, its repo is still known
  assert.equal(repo("thr_root"), null);
  assert.equal(repo("thr_lost"), null);
});

test("a repository is cut for its column: five characters, plus a second word's first letter", () => {
  assert.equal(shortRepo("fulfillments_code"), "fulfi");
  assert.equal(shortRepo("Shop_code"), "Shop", "a name that fits is left alone");
  // Two repositories of one family stay apart at a glance (the user, 30.10).
  assert.equal(shortRepo("market_web_code"), "marke_w");
  assert.equal(shortRepo("marketplace_code"), "marke", "no second word near the cut");
  assert.equal(shortRepo("meeting_room_code"), "meeti_r");
  assert.equal(shortRepo("очень-длинное-название"), "очень_д", "a hyphen within the first seven letters counts");
  assert.equal(shortRepo("fulfillments_code", 12), "fulfillments", "an explicit width still wins");
  assert.equal(shortRepo("fulfillments", 20), "fulfillments", "nothing is cut when it fits");
  assert.equal(shortRepo(""), null);
  assert.equal(shortRepo("_code"), null);
  assert.equal(shortRepo(null), null);
});

test("the age column is short: «<1м» under a minute, then минуты м, часы ч, дни д", () => {
  assert.equal(feedAge(0), "<1м");
  assert.equal(feedAge(59_000), "<1м");
  assert.equal(feedAge(-5), "<1м");
  assert.equal(feedAge(5 * 60_000 + 59_000), "5м");
  assert.equal(feedAge(3 * HOUR), "3ч");
  assert.equal(feedAge(23.9 * HOUR), "23ч");
  assert.equal(feedAge(2 * DAY), "2д");
  assert.equal(feedAge(45 * DAY), "45д", "days go on: no weeks, no months in this column");
});

test("kind: a waiting kind and «работает» show; hidden or quiet threads show none", () => {
  const rows = buildFeed(
    [
      snap("thr_wait", {}, "decision"),
      snap("thr_run", { status: "active" }, "working"),
      snap("thr_done", {}, "done"),
      snap("thr_unk", {}, "unknown"),
      snap("thr_snoozed", {}, "action"),
    ],
    (s) => s.threadId === "thr_snoozed",
  );
  const kind = (id: string) => rows.find((r) => r.threadId === id)?.kind;
  assert.equal(kind("thr_wait"), "decision");
  assert.equal(kind("thr_run"), "working");
  assert.equal(kind("thr_done"), null);
  assert.equal(kind("thr_unk"), null);
  assert.equal(kind("thr_snoozed"), null);
});

test("the agent provider comes through for the logo column", () => {
  const rows = buildFeed(
    [snap("thr_cc"), snap("thr_cx", { providerId: "codex", lastAgentAt: NOW - 6 * DAY, lastHumanAt: null })],
    visible,
  );
  assert.deepEqual(
    rows.map((r) => [r.threadId, r.providerId]),
    [
      ["thr_cc", "claude-code"],
      ["thr_cx", "codex"],
    ],
  );
});

test("pin and project come through", () => {
  const [row] = buildFeed([snap("thr_p", { pinned: true, projectName: "fulfillments_code" })], visible);
  assert.equal(row?.pinned, true);
  assert.equal(row?.projectName, "fulfillments_code");
});

test("families: subthreads sit under their parent; roots go by the newest conversation inside", () => {
  const rows = buildFeed(
    [
      snap("thr_a", { lastAgentAt: NOW - 4 * DAY }),
      snap("thr_a1", { parentThreadId: "thr_a", lastAgentAt: NOW - 1 * HOUR }),
      snap("thr_a1x", { parentThreadId: "thr_a1", lastAgentAt: NOW - 3 * DAY }),
      snap("thr_a2", { parentThreadId: "thr_a", lastAgentAt: NOW - 2 * DAY }),
      snap("thr_b", { lastAgentAt: NOW - 2 * HOUR }),
    ],
    visible,
  );
  const families = groupFamilies(rows);
  assert.deepEqual(families.map((f) => f.row.threadId), ["thr_a", "thr_b"]);
  const a = families[0]!;
  assert.equal(a.newestAt, NOW - HOUR);
  assert.deepEqual(a.children.map((c) => c.row.threadId), ["thr_a1", "thr_a2"]);
  assert.equal(a.children[0]?.children[0]?.row.threadId, "thr_a1x");
  assert.equal(familySize(a), 4);
});

test("families: a subthread whose parent is archived or gone becomes a root", () => {
  const rows = buildFeed(
    [snap("thr_arch", { archived: true }), snap("thr_kid", { parentThreadId: "thr_arch" })],
    visible,
  );
  assert.deepEqual(groupFamilies(rows).map((f) => f.row.threadId), ["thr_kid"]);
});

test("families: a parent cycle cannot hide a thread", () => {
  const rows = buildFeed(
    [
      snap("thr_x", { parentThreadId: "thr_y" }),
      snap("thr_y", { parentThreadId: "thr_x" }),
      snap("thr_z"),
    ],
    visible,
  );
  const families = groupFamilies(rows);
  const all = families.flatMap(function walk(f): string[] {
    return [f.row.threadId, ...f.children.flatMap(walk)];
  });
  assert.deepEqual(all.sort(), ["thr_x", "thr_y", "thr_z"]);
});

test("the model and the effort of the latest turn come through for the row", () => {
  const rows = buildFeed(
    [
      snap("thr_gem", {
        providerId: "acp-antigravity",
        model: "gemini-4-argon",
        modelLabel: "Gemini 4 Argon",
        effort: "xhigh",
      }),
      snap("thr_old", { model: null, modelLabel: null, effort: null }),
    ],
    visible,
  );
  const row = (id: string) => rows.find((r) => r.threadId === id);
  assert.equal(row("thr_gem")?.model, "gemini-4-argon");
  assert.equal(row("thr_gem")?.modelLabel, "Gemini 4 Argon");
  assert.equal(row("thr_gem")?.effort, "xhigh");
  assert.equal(row("thr_old")?.modelLabel, null);
  assert.equal(row("thr_old")?.effort, null);
});
