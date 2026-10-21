// `bb pult` output: the summary first (it must survive the 200-line cap),
// the commit group, waiting subthreads indented under their parent, --brief,
// --json without the agents' text, the wording shared with the page, refusals
// to hide, and explain telling whether an overlay still acts. Runs under
// plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, KIND_SHORT, MARK_LABELS } from "../lib/format.ts";
import { buildQueue } from "../lib/queue.ts";
import type { Classification, Kind, Overlay, ThreadSnapshot } from "../lib/types.ts";
import {
  MARK_LABEL,
  explainText,
  formatQueue,
  hideRefusal,
  hostCardOf,
  overlayNotes,
  queueForJson,
} from "../server/cli.ts";

const NOW = Date.parse("2026-10-10T12:00:00+03:00");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cls(kind: Kind): Classification {
  return {
    kind,
    ask: `ask ${kind}`,
    options: [],
    multi: false,
    replyTemplate: null,
    due: null,
    confidence: 0.8,
    source: "rules",
    reasons: [],
  };
}

function snap(id: string, kind: Kind, over: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    threadId: `thr_${id}`,
    projectId: "prj_a",
    projectName: "Проект А",
    title: `Тред ${id}`,
    parentThreadId: null,
    providerId: "claude-code",
    status: "idle",
    pinned: false,
    archived: false,
    createdAt: NOW - 10 * 24 * HOUR,
    updatedAt: NOW - HOUR,
    lastAgentAt: NOW - HOUR,
    lastHumanAt: NOW - 2 * HOUR,
    excerpt: null,
    classification: cls(kind),
    classifiedAt: NOW,
    ...over,
  };
}

function overlay(id: string, over: Partial<Overlay>): Overlay {
  return { threadId: id, snoozedUntil: null, snoozedAt: null, dismissedAt: null, taskKey: null, ...over };
}

const none = new Map<string, Overlay>();

test("summary first: the badge with the commit count, per-kind counts in the page's words", () => {
  const queue = buildQueue(
    [snap("parent01", "decision"), snap("action01", "action"), snap("commit01", "commit"), snap("commit02", "commit")],
    none,
    NOW,
  );
  const lines = formatQueue(queue, false).split("\n");
  assert.equal(lines[0], "Ход за тобой: 2 (+ коммит ждёт «да»: 2)");
  assert.equal(lines[1], "Нужно решение: 1 · Сделать руками: 1");
  const commitHead = lines.indexOf("Коммит ждёт «да»: 2");
  assert.ok(commitHead > lines.findIndex((l) => l.includes("thr_action01")));
  assert.ok(lines.findIndex((l) => l.includes("thr_commit01")) > commitHead);
});

test("stale and snoozed counts sit in the summary, before the list", () => {
  const queue = buildQueue(
    [snap("fresh001", "decision"), snap("old00001", "decision", { lastAgentAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY })],
    new Map([["thr_fresh001", overlay("thr_fresh001", { snoozedUntil: NOW + DAY, snoozedAt: NOW })]]),
    NOW,
  );
  const lines = formatQueue(queue, false).split("\n");
  assert.equal(lines[2], "Застряло (14+ дней): 1 · отложено: 1 — показать: bb pult queue --all");
});

test("a long queue keeps its summary under the 200-line cap", () => {
  const many = Array.from({ length: 120 }, (_, i) => snap(`many${String(i).padStart(4, "0")}`, "decision"));
  const commits = Array.from({ length: 5 }, (_, i) => snap(`comm${String(i).padStart(4, "0")}`, "commit"));
  const old = snap("old00001", "action", { lastAgentAt: NOW - 20 * DAY, updatedAt: NOW - 20 * DAY });
  const out = formatQueue(buildQueue([...many, ...commits, old], none, NOW), false);
  const lines = out.split("\n");
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "Ход за тобой: 121 (+ коммит ждёт «да»: 5)");
  assert.match(lines[2]!, /^Застряло \(14\+ дней\): 1/);
  assert.match(lines.at(-1)!, /bb pult queue --brief/);
  // --brief: one line per item, everything fits.
  const brief = formatQueue(buildQueue([...many, ...commits, old], none, NOW), false, { brief: true }).split("\n");
  assert.ok(brief.length < 200);
  assert.ok(brief.some((l) => l.includes("thr_comm0004")));
});

test("waiting subthreads are printed indented under their parent", () => {
  const queue = buildQueue(
    [
      snap("parent01", "decision", { title: "Родитель" }),
      snap("child001", "action", { parentThreadId: "thr_parent01", title: "Сабтред" }),
      snap("other001", "review"),
    ],
    none,
    NOW,
  );
  const out = formatQueue(queue, false);
  const lines = out.split("\n");
  assert.equal(lines[0], "Ход за тобой: 2 (+ коммит ждёт «да»: 0)");
  const parent = lines.findIndex((l) => l.startsWith(`• ${KIND_SHORT.decision}`) && l.includes("«Родитель»"));
  const child = lines.findIndex((l) => l.includes("«Сабтред»"));
  const other = lines.findIndex((l) => l.startsWith(`• ${KIND_SHORT.review}`));
  assert.ok(parent >= 0 && parent < child && child < other, out);
  assert.match(lines[child]!, new RegExp(`^ {4}↳ ${KIND_SHORT.action} · `, "u"));
  assert.match(lines[child + 1]!, /^ {6}Что нужно: ask action$/u);
  assert.match(lines[parent + 2]!, /ждут сабтреды: 1/u);
  assert.equal(hostCardOf(queue, "thr_child001"), "thr_parent01");
  assert.equal(hostCardOf(queue, "thr_other001"), null);
});

test("ages and labels are the page's: formatAge, KIND_SHORT, MARK_LABELS", () => {
  const age = 13.6 * DAY;
  const queue = buildQueue([snap("aged0001", "decision", { lastAgentAt: NOW - age })], none, NOW);
  const out = formatQueue(queue, false);
  assert.ok(out.includes(`· ${formatAge(age)}`), out);
  assert.ok(!out.includes("2 нед"), out);
  assert.deepEqual(MARK_LABEL, MARK_LABELS);
});

test("an empty queue says so", () => {
  const out = formatQueue(buildQueue([], none, NOW), false);
  assert.equal(out, "Ход за тобой: 0 (+ коммит ждёт «да»: 0)\n\nСвежих тредов, которые ждут Вадима, нет.");
});

test("--json carries no agent text", () => {
  const queue = buildQueue(
    [
      snap("parent01", "decision", { excerpt: "секретный хвост" }),
      snap("child001", "action", { parentThreadId: "thr_parent01", excerpt: "ещё текст" }),
    ],
    none,
    NOW,
  );
  const json = JSON.stringify(queueForJson(queue));
  assert.ok(!json.includes("excerpt"), json);
  assert.ok(json.includes("thr_child001"));
});

test("hiding is refused for an approval and for the caller's own thread", () => {
  assert.match(hideRefusal("thr_a", "decision", "thr_a") ?? "", /сам себя/);
  assert.match(hideRefusal("thr_a", "approval", undefined) ?? "", /одобрения/);
  assert.equal(hideRefusal("thr_a", "decision", "thr_b"), null);
  assert.equal(hideRefusal("thr_a", "decision", undefined), null);
});

test("explain says «скрыт» only while the overlay acts", () => {
  const s = snap("aaaa0001", "decision", { lastAgentAt: NOW - HOUR });
  const held = overlayNotes(s, overlay(s.threadId, { dismissedAt: NOW - 30 * 60_000 }), NOW);
  assert.match(held[0]!, /^скрыт/);
  // The agent wrote after «не нужно»: the thread is back.
  const back = overlayNotes(s, overlay(s.threadId, { dismissedAt: NOW - 2 * HOUR }), NOW);
  assert.match(back[0]!, /^было скрыто .*вернулось после ответа агента/);
  // The user wrote after it.
  const human = snap("aaaa0002", "decision", { lastAgentAt: NOW - 3 * HOUR, lastHumanAt: NOW - 10 * 60_000 });
  assert.match(overlayNotes(human, overlay(human.threadId, { dismissedAt: NOW - HOUR }), NOW)[0]!, /Вадим написал/);
  // An approval is never hidden.
  const approval = snap("aaaa0003", "approval");
  assert.match(overlayNotes(approval, overlay(approval.threadId, { dismissedAt: NOW }), NOW)[0]!, /одобрения/);
  // A snooze that ran out.
  const expired = overlayNotes(s, overlay(s.threadId, { snoozedUntil: NOW - 1, snoozedAt: NOW - DAY }), NOW);
  assert.match(expired[0]!, /^был отложен .*срок вышел/);

  const text = explainText(
    { snapshot: s, input: null, seed: null, llm: null, overlay: overlay(s.threadId, { dismissedAt: NOW - 2 * HOUR }) },
    s.threadId,
    NOW,
    "thr_parent01",
  );
  assert.match(text, /Пульт: было скрыто/);
  assert.match(text, /В очереди: в карточке родителя thr_parent01/);
});
