// The weekly window, thread selection, the re-queue plan, saved models, texts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInstruction, formatStatus, notificationFor, type StatusSnapshot } from "../lib/format.ts";
import { CLAUDE_GUARD } from "../lib/profile.ts";
import { mergeSaved, parseSaved, shouldImport } from "../lib/saved.ts";
import { DEFAULT_THRESHOLDS } from "../lib/stage.ts";
import { isHeldByGuard, planReseat, restoreModels, wantsCheck, type QueueRowLike } from "../lib/threads.ts";
import { pickWeekly } from "../lib/usage.ts";

const NOW = Date.parse("2026-10-15T06:00:00+03:00");
const OUR = "Сторож лимитов · неделя ≥85 %: ход на Opus придержан";

test("weekly window: kind=weekly without model, never by label", () => {
  const response = {
    "claude-code": {
      status: "ok",
      windows: [
        { label: "Current session", kind: "five-hour", model: null, usedPercent: 99, resetsAt: "a" },
        { label: "Fable", kind: "weekly", model: "claude-fable-5-1", usedPercent: 3, resetsAt: "b" },
        { label: "Что угодно", kind: "weekly", model: null, usedPercent: 86, resetsAt: "2026-10-20T05:00:00Z" },
      ],
    },
  };
  assert.deepEqual(pickWeekly(response), { ok: true, reading: { percent: 86, resetsAt: "2026-10-20T05:00:00Z" } });
  const noReset = { "claude-code": { status: "ok", windows: [{ kind: "weekly", usedPercent: 10, resetsAt: null }] } };
  assert.deepEqual(pickWeekly(noReset), { ok: true, reading: { percent: 10, resetsAt: null } });
  const labelOnly = { "claude-code": { status: "ok", windows: [{ label: "Weekly limit", usedPercent: 90 }] } };
  assert.equal(pickWeekly(labelOnly).ok, false);
  assert.equal(pickWeekly({ "claude-code": { status: "error", message: "429" } }).ok, false);
  assert.match((pickWeekly({ "claude-code": { status: "error", message: "429" } }) as { error: string }).error, /429/);
  assert.equal(pickWeekly({}).ok, false);
  assert.equal(pickWeekly(null).ok, false);
  assert.equal(pickWeekly({ "claude-code": { status: "ok", windows: [{ kind: "weekly", model: null, usedPercent: "86" }] } }).ok, false);
});

test("thread selection: a full pass takes every live claude-code thread, a poll — busy or fresh ones", () => {
  const base = { providerId: "claude-code", archivedAt: null, deletedAt: null };
  const old = NOW - 7 * 60 * 60_000;
  assert.equal(wantsCheck({ ...base, id: "a", status: "idle", updatedAt: old }, NOW, true), true);
  assert.equal(wantsCheck({ ...base, id: "a", status: "idle", updatedAt: old }, NOW, false), false);
  assert.equal(wantsCheck({ ...base, id: "a", status: "idle", updatedAt: NOW - 60_000 }, NOW, false), true);
  for (const status of ["active", "starting", "pending"]) {
    assert.equal(wantsCheck({ ...base, id: "a", status, updatedAt: old }, NOW, false), true, status);
  }
  assert.equal(wantsCheck({ ...base, id: "a", providerId: "codex", status: "active", updatedAt: NOW }, NOW, true), false);
  assert.equal(wantsCheck({ ...base, id: "a", archivedAt: NOW, status: "idle", updatedAt: NOW }, NOW, true), false);
  assert.equal(wantsCheck({ ...base, id: "a", deletedAt: NOW, status: "idle", updatedAt: NOW }, NOW, true), false);
});

test("restore: a [1m] model falls back to the catalog id", () => {
  assert.deepEqual(restoreModels("claude-opus-5-5"), ["claude-opus-5-5"]);
  assert.deepEqual(restoreModels("claude-opus-5-5[1m]"), ["claude-opus-5-5[1m]", "claude-opus-5-5"]);
  assert.deepEqual(restoreModels(null), [null]);
});

function qrow(id: string, over: Partial<QueueRowLike> = {}): QueueRowLike {
  return {
    id,
    model: "claude-opus-5-5",
    initiator: "user",
    groupWithNext: false,
    payload: { kind: "inline" },
    waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: OUR },
    ...over,
  };
}

test("re-queue plan on a running thread: only the guard's non-Sonnet rows, copied; groups and system rows held", () => {
  const rows = [
    qrow("q1", { waitingOn: { kind: "thread-busy" } }),
    qrow("q2"),
    qrow("q3", { model: "claude-sonnet-5-5" }),
    qrow("q4", { waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: "1 of 1 running on all hosts" } }),
    qrow("q5", { waitingOn: { kind: "plugin", pluginId: "concurrency-limit", reason: `0 of 0 running; ${OUR}` } }),
    qrow("q6", { groupWithNext: true }),
    qrow("q7"),
    qrow("q8", { initiator: "system" }),
    qrow("q9", { initiator: "agent" }),
  ];
  for (const status of ["active", "starting", "stopping"]) {
    assert.deepEqual(
      planReseat(rows, status).map((s) => [s.kind, s.row.id, s.kind === "skip" ? s.why : null]),
      [
        ["copy", "q2", null],
        ["copy", "q5", null],
        ["skip", "q6", "часть группы сообщений"],
        ["skip", "q7", "часть группы сообщений"],
        ["skip", "q8", "системное сообщение"],
        ["copy", "q9", null],
      ],
      status,
    );
  }
  assert.equal(isHeldByGuard(rows[0]!), false);
  assert.equal(isHeldByGuard(rows[3]!), false);
  assert.equal(isHeldByGuard(rows[4]!), true);
});

test("re-queue plan on an idle or error thread: the first held row is a new turn, the rest are copied", () => {
  assert.deepEqual(planReseat([qrow("q1"), qrow("q2")], "idle").map((s) => s.kind), ["send", "copy"]);
  assert.deepEqual(
    planReseat([qrow("q1", { payload: { kind: "retry" } }), qrow("q2")], "error").map((s) => s.kind),
    ["send", "copy"],
  );
  assert.deepEqual(
    planReseat([qrow("q1"), qrow("q2", { payload: { kind: "retry" } })], "error").map((s) => s.kind),
    ["send", "skip"],
    "a retry after a new turn would redo work the conversation moved past",
  );
  assert.deepEqual(planReseat([qrow("q1", { payload: { kind: "retry" } })], "idle").map((s) => s.kind), ["skip"]);
  assert.deepEqual(planReseat([qrow("q1"), qrow("q2")], "pending").map((s) => s.kind), ["skip", "skip"]);
});

test("saved models: parse drops garbage, merge never overwrites, import only a newer file", () => {
  const parsed = parseSaved({
    thr_aaaaaaaa: { model: "claude-opus-5-5[1m]", reasoningLevel: "xhigh" },
    thr_bbbbbbbb: { model: null, reasoningLevel: null },
    thr_cccccccc: { model: 5, reasoningLevel: "high" },
    "not-a-thread": { model: "x", reasoningLevel: "y" },
    thr_dddddddd: "opus",
  });
  assert.deepEqual(Object.keys(parsed).sort(), ["thr_aaaaaaaa", "thr_bbbbbbbb"]);
  assert.deepEqual(parseSaved(null), {});
  const { merged, added } = mergeSaved(
    { thr_aaaaaaaa: { model: "claude-opus-5-5", reasoningLevel: "max" } },
    { thr_aaaaaaaa: { model: "claude-sonnet-5-5", reasoningLevel: "xhigh" }, thr_eeeeeeee: { model: "claude-opus-5-5", reasoningLevel: "high" } },
  );
  assert.equal(added, 1);
  assert.deepEqual(merged.thr_aaaaaaaa, { model: "claude-opus-5-5", reasoningLevel: "max" });
  assert.equal(shouldImport({ mtimeMs: 10, importedMtimeMs: null, lastResetAt: null }), true);
  assert.equal(shouldImport({ mtimeMs: 10, importedMtimeMs: 10, lastResetAt: null }), false);
  assert.equal(shouldImport({ mtimeMs: 11, importedMtimeMs: 10, lastResetAt: null }), true);
  assert.equal(shouldImport({ mtimeMs: 11, importedMtimeMs: null, lastResetAt: 20 }), false);
});

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    guard: CLAUDE_GUARD,
    now: NOW,
    thresholds: DEFAULT_THRESHOLDS,
    thresholdsProblem: null,
    reading: { percent: 87, resetsAt: "2026-10-20T05:00:00.000Z", at: NOW - 30_000 },
    lastCheckedAt: NOW - 30_000,
    lastError: null,
    stage: 1,
    consent: false,
    consentAt: null,
    dripFrom: null,
    consentBy: null,
    saved: 325,
    onSonnet: 320,
    lastPass: { at: NOW - 30_000, full: true, checked: 326, switched: 320, failed: 1 },
    stoppedSinceStage2: 0,
    stoppedThreads: [],
    reseat: { copied: 2, sent: 1, skipped: 1, failed: 0, lastSkip: "thr_x: часть группы сообщений" },
    lastNotify: { at: NOW - 30_000, kind: "enter-1", ok: false, message: "защита скрипта уведомлений требует подтверждения — не отправлено" },
    telegram: true,
    test: null,
    realStage: 1,
    enabled: true,
    enabledBy: null,
    enabledAt: null,
    restoring: false,
    ...over,
  };
}

test("status text: guard off says so, offers the models back and the way on", () => {
  const off = formatStatus(snapshot({ enabled: false }));
  assert.ok(off.includes("ВЫКЛЮЧЕН (не вмешивается)"), off);
  assert.ok(off.includes("bb limit-guard restore-models") && off.includes("bb limit-guard on"), off);
  assert.ok(!off.includes("стадия 1 (Sonnet xhigh)"), "no stage claim while off");
  assert.ok(formatStatus(snapshot({ enabled: false, saved: 0 })).includes("Включить сторожа: bb limit-guard on"));
  assert.ok(formatStatus(snapshot({ restoring: true, saved: 40 })).includes("Возвращаю прежние модели в фоне, осталось 40"));
});

test("status text: percent, reset, stage, consent, threads, check time, last error, test mode", () => {
  const text = formatStatus(snapshot());
  for (const part of ["стадия 1 (Sonnet xhigh)", "неделя 87 %", "пороги 85 / 93 %", "Согласие: нет", "Последняя проверка:", "30 с назад", "Последняя ошибка: нет", "переведено 320", "сохранено 325", "проверено 326", "не удалось 1", "переставлено 2", "не доставлено"]) {
    assert.ok(text.includes(part), `${part}\n${text}`);
  }
  const stopped = formatStatus(
    snapshot({ stage: 2, stoppedSinceStage2: 3, stoppedThreads: ["thr_stop0001", "thr_stop0002"], lastError: { at: NOW, message: "чтение лимита: 429" } }),
  );
  assert.ok(stopped.includes("bb limit-guard resume"));
  assert.ok(stopped.includes("Остановлено тредов на стадии 2: 2 (остановок 3): thr_stop0001, thr_stop0002"), stopped);
  assert.ok(!stopped.includes("новое сообщение"), "the hint comes with consent");
  const afterConsent = formatStatus(snapshot({ consent: true, consentAt: NOW - 1000, dripFrom: NOW - 1000, stoppedThreads: ["thr_stop0001"] }));
  assert.ok(afterConsent.includes("первые 10 мин треды запускаются по очереди"));
  assert.ok(afterConsent.includes("им нужно новое сообщение или Send now: thr_stop0001"), afterConsent);
  const early = formatStatus(snapshot({ consent: true, consentAt: NOW - 1000, dripFrom: null }));
  assert.ok(early.includes("дано заранее, на стадии 1") && !early.includes("по очереди"), early);
  assert.ok(stopped.includes("чтение лимита: 429"));
  const test = formatStatus(snapshot({ test: { threads: ["thr_aaaaaaaa"], percent: 95, stage: 2, consent: false, saved: 1 } }));
  assert.ok(test.includes("ТЕСТ-РЕЖИМ"));
  assert.ok(test.includes("thr_aaaaaaaa"));
  assert.ok(formatStatus(snapshot({ reading: null, lastCheckedAt: null })).includes("ещё не прочитана"));
});

test("notes: three kinds, 2–3 sentences, the test mode is marked", () => {
  for (const kind of ["enter-1", "enter-2", "consent"] as const) {
    const note = notificationFor(kind, snapshot());
    assert.ok(note.md.startsWith("# Сторож лимитов"), kind);
    const sentences = note.note.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 1).length;
    assert.ok(sentences >= 2 && sentences <= 3, `${kind}: ${note.note}`);
  }
  assert.ok(notificationFor("enter-2", snapshot()).md.includes("bb limit-guard resume"));
  const released = notificationFor("consent", snapshot({ consent: true, consentAt: NOW, dripFrom: NOW, stoppedThreads: ["thr_stop0001"] }));
  assert.ok(released.md.includes("thr_stop0001") && released.md.includes("по очереди"), released.md);
  const releasedSentences = released.note.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 1).length;
  assert.ok(releasedSentences >= 2 && releasedSentences <= 3, released.note);
  const test = notificationFor("enter-1", snapshot({ test: { threads: ["thr_aaaaaaaa"], percent: 90, stage: 1, consent: false, saved: 1 } }));
  assert.ok(test.md.includes("[ТЕСТ]"));
  assert.ok(test.note.startsWith("[ТЕСТ]"));
  assert.equal(
    agentInstruction(DEFAULT_THRESHOLDS),
    "Сторож лимитов: недельный лимит Claude ≥85 % — запускай треды с --model claude-sonnet-5-5 --reasoning-level xhigh",
  );
});
