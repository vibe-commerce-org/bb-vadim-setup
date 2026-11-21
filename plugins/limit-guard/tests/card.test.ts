// The words of the sidebar-footer card (lib/card.ts): pure, no React.
import assert from "node:assert/strict";
import { test } from "node:test";
import { barGeometry, canRestore, countsLine, formatReset, headline, threadsWord, weekLine, type CardStatus } from "../lib/card.ts";

function card(over: Partial<CardStatus> = {}): CardStatus {
  return {
    provider: "claude",
    name: "Claude Code",
    title: "Claude",
    target: "Sonnet xhigh",
    targetShort: "Sonnet",
    enabled: true,
    stage: 1,
    realStage: 1,
    percent: 91,
    resetsAt: "2026-10-27T05:00:00.000Z",
    checkedAt: 1,
    consent: false,
    onSonnet: 442,
    saved: 414,
    stopped: 0,
    restoring: false,
    testActive: false,
    error: null,
    thresholds: { sonnet: 85, stop: 93 },
    ...over,
  };
}

test("threadsWord: Russian plural forms", () => {
  assert.equal(threadsWord(1), "1 тред");
  assert.equal(threadsWord(2), "2 треда");
  assert.equal(threadsWord(5), "5 тредов");
  assert.equal(threadsWord(11), "11 тредов");
  assert.equal(threadsWord(21), "21 тред");
  assert.equal(threadsWord(112), "112 тредов");
  assert.equal(threadsWord(414), "414 тредов");
});

test("headline: every state says what the guard does now", () => {
  assert.deepEqual(headline(card({ stage: 0, realStage: 0, percent: 40, onSonnet: 0 })).tone, "ok");
  const stage1 = headline(card());
  assert.equal(stage1.tone, "warn");
  assert.ok(stage1.title.includes("85 %") && stage1.hint.includes("93 %"), JSON.stringify(stage1));
  assert.ok(headline(card({ consent: true })).hint.includes("Согласие дано заранее"));
  const stop = headline(card({ stage: 2, realStage: 2, percent: 94 }));
  assert.equal(stop.tone, "stop");
  assert.ok(stop.hint.includes("bb limit-guard resume"));
  assert.equal(headline(card({ stage: 2, realStage: 2, consent: true })).title, "Согласие дано");
  const off = headline(card({ enabled: false, stage: 0 }));
  assert.equal(off.tone, "off");
  assert.equal(off.title, "Выключен");
  assert.ok(off.hint.includes("414 тредов, переведённых сторожем, остаются на Sonnet"), off.hint);
  assert.ok(!headline(card({ enabled: false, stage: 0, saved: 0 })).hint.includes("Sonnet"));
  assert.equal(headline(card({ testActive: true })).title, "Идёт тест-режим");
});

test("weekLine, countsLine, formatReset", () => {
  assert.equal(weekLine(card({ percent: null, resetsAt: null })), "Неделя ещё не прочитана");
  assert.match(weekLine(card()), /^Неделя 91 % · сброс \d\d\.\d\d \d\d:\d\d$/);
  assert.equal(weekLine(card({ resetsAt: null })), "Неделя 91 %");
  assert.equal(formatReset("не дата"), "");
  assert.equal(countsLine(card()), "на Sonnet 442 треда");
  assert.equal(countsLine(card({ stopped: 3 })), "на Sonnet 442 треда · остановлено 3 треда");
  assert.equal(countsLine(card({ enabled: false, stage: 0 })), "", "off: nothing is «on Sonnet» by the guard's doing");
  assert.equal(countsLine(card({ onSonnet: 0 })), "");
});

test("barGeometry: fill and ticks are clamped to the bar", () => {
  assert.deepEqual(barGeometry(card()), { fill: 91, sonnet: 85, stop: 93 });
  assert.deepEqual(barGeometry(card({ percent: 140, thresholds: { sonnet: 85, stop: 120 } })), { fill: 100, sonnet: 85, stop: 100 });
  assert.equal(barGeometry(card({ percent: null })).fill, 0);
});

test("canRestore: only with something to give back, and only when the guard will not undo it", () => {
  assert.equal(canRestore(card()), false, "on, stage 1: the guard would switch them again");
  assert.equal(canRestore(card({ enabled: false, stage: 0 })), true);
  assert.equal(canRestore(card({ enabled: true, stage: 0, realStage: 0 })), true);
  assert.equal(canRestore(card({ enabled: false, stage: 0, saved: 0 })), false);
  assert.equal(canRestore(card({ enabled: false, stage: 0, restoring: true })), false);
  assert.equal(canRestore(card({ enabled: false, stage: 0, testActive: true })), false);
});
