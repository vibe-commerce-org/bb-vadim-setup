// Thresholds, hysteresis, weekly reset, consent, test mode (lib/stage.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance,
  advanceTest,
  DEFAULT_THRESHOLDS,
  giveConsent,
  holdsForModel,
  INITIAL_PHASE,
  isSonnet,
  isTargetExecution,
  resolveThresholds,
  stageFor,
  weekRolledOver,
  type Phase,
} from "../lib/stage.ts";

const T = DEFAULT_THRESHOLDS;
const RESETS = "2026-10-20T05:00:00.000Z";
const NEXT = "2026-10-27T05:00:00.000Z";
const NOW = Date.parse("2026-10-15T06:00:00+03:00");

function phase(over: Partial<Phase> = {}): Phase {
  return { ...INITIAL_PHASE, resetsAt: RESETS, ...over };
}

test("thresholds: defaults 85/93, custom values, anything odd falls back", () => {
  assert.deepEqual(resolveThresholds(85, 93), { thresholds: { sonnet: 85, stop: 93 }, problem: null });
  assert.deepEqual(resolveThresholds(80, 90).thresholds, { sonnet: 80, stop: 90 });
  for (const [a, b] of [
    [93, 85],
    [85, 85],
    [0, 50],
    [85, 101],
    [Number.NaN, 93],
    ["85", 93],
    [undefined, undefined],
  ] as const) {
    const r = resolveThresholds(a, b);
    assert.deepEqual(r.thresholds, { sonnet: 85, stop: 93 }, `${String(a)}/${String(b)}`);
    assert.ok(r.problem !== null);
  }
});

test("stageFor: <85 → 0, ≥85 → 1, ≥93 → 2, consent keeps 1", () => {
  assert.equal(stageFor(84, T, false), 0);
  assert.equal(stageFor(84.9, T, false), 0);
  assert.equal(stageFor(85, T, false), 1);
  assert.equal(stageFor(92, T, false), 1);
  assert.equal(stageFor(93, T, false), 2);
  assert.equal(stageFor(100, T, false), 2);
  assert.equal(stageFor(99, T, true), 1);
  assert.equal(stageFor(81, { sonnet: 80, stop: 90 }, false), 1);
});

test("advance: going up enters stages, a jump enters 2 directly", () => {
  let step = advance(phase(), { percent: 84, resetsAt: RESETS }, T, NOW);
  assert.equal(step.phase.stage, 0);
  assert.equal(step.entered, null);
  step = advance(step.phase, { percent: 85, resetsAt: RESETS }, T, NOW);
  assert.equal(step.phase.stage, 1);
  assert.equal(step.entered, 1);
  step = advance(step.phase, { percent: 88, resetsAt: RESETS }, T, NOW);
  assert.equal(step.entered, null);
  step = advance(step.phase, { percent: 93, resetsAt: RESETS }, T, NOW);
  assert.equal(step.phase.stage, 2);
  assert.equal(step.entered, 2);
  const jump = advance(phase(), { percent: 96, resetsAt: RESETS }, T, NOW);
  assert.equal(jump.phase.stage, 2);
  assert.equal(jump.entered, 2);
});

test("advance: hysteresis — a dip inside the week changes nothing", () => {
  const step = advance(phase({ stage: 2 }), { percent: 70, resetsAt: RESETS }, T, NOW);
  assert.equal(step.phase.stage, 2);
  assert.equal(step.reset, false);
  const one = advance(phase({ stage: 1 }), { percent: 10, resetsAt: "2026-10-20T05:00:07.000Z" }, T, NOW);
  assert.equal(one.phase.stage, 1, "seconds of jitter in resetsAt are the same reset");
  assert.equal(one.reset, false);
});

test("advance: weekly reset — resetsAt moved and percent back under 85 → stage 0, consent dropped", () => {
  const step = advance(phase({ stage: 1, consent: true, consentAt: NOW - 1000, dripFrom: NOW - 1000 }), { percent: 2, resetsAt: NEXT }, T, NOW);
  assert.equal(step.reset, true);
  assert.deepEqual(step.phase, { stage: 0, consent: false, consentAt: null, dripFrom: null, resetsAt: NEXT });
  assert.equal(step.entered, null);
});

test("advance: weekly reset — the stored reset moment passed", () => {
  const after = Date.parse(RESETS) + 60_000;
  const step = advance(phase({ stage: 2 }), { percent: 1, resetsAt: RESETS }, T, after);
  assert.equal(step.reset, true);
  assert.equal(step.phase.stage, 0);
});

test("advance: resetsAt moved but percent still ≥85 → no reset, resetsAt follows", () => {
  const step = advance(phase({ stage: 1 }), { percent: 90, resetsAt: NEXT }, T, NOW);
  assert.equal(step.reset, false);
  assert.equal(step.phase.stage, 1);
  assert.equal(step.phase.resetsAt, NEXT);
});

test("advance: stage 0 never «resets»", () => {
  const step = advance(phase(), { percent: 3, resetsAt: NEXT }, T, NOW);
  assert.equal(step.reset, false);
  assert.equal(step.phase.resetsAt, NEXT);
});

test("consent: on stage 2 (drip window) or in advance on stage 1; holds stage 1 until the reset, then 93 % stops again", () => {
  assert.equal(giveConsent(phase({ stage: 0 }), NOW).ok, false, "stage 0: nothing to consent to");
  const early = giveConsent(phase({ stage: 1 }), NOW);
  assert.deepEqual([early.ok, early.phase], [true, { stage: 1, consent: true, consentAt: NOW, dripFrom: null, resetsAt: RESETS }]);
  const atNinetyNine = advance(early.phase, { percent: 99, resetsAt: RESETS }, T, NOW + 1000);
  assert.deepEqual([atNinetyNine.phase.stage, atNinetyNine.entered], [1, null], "an advance consent keeps stage 2 away");
  assert.equal(advance(early.phase, { percent: 2, resetsAt: NEXT }, T, NOW + 2000).reset, true, "and ends at the reset");
  const given = giveConsent(phase({ stage: 2 }), NOW);
  assert.equal(given.ok, true);
  assert.deepEqual(given.phase, { stage: 1, consent: true, consentAt: NOW, dripFrom: NOW, resetsAt: RESETS });
  assert.deepEqual(giveConsent(given.phase, NOW + 5000).phase, given.phase, "a repeated consent changes nothing");
  const higher = advance(given.phase, { percent: 99, resetsAt: RESETS }, T, NOW + 1000);
  assert.equal(higher.phase.stage, 1);
  assert.equal(higher.entered, null);
  const reset = advance(higher.phase, { percent: 1, resetsAt: NEXT }, T, NOW + 2000);
  assert.equal(reset.reset, true);
  const again = advance(reset.phase, { percent: 94, resetsAt: NEXT }, T, NOW + 3000);
  assert.equal(again.phase.stage, 2);
  assert.equal(again.entered, 2);
});

test("weekRolledOver: passed moment, moved by more than an hour, null handling", () => {
  assert.equal(weekRolledOver(RESETS, RESETS, NOW), false);
  assert.equal(weekRolledOver(RESETS, NEXT, NOW), true);
  assert.equal(weekRolledOver(RESETS, "2026-10-20T05:30:00.000Z", NOW), false);
  assert.equal(weekRolledOver(RESETS, null, NOW), false);
  assert.equal(weekRolledOver(RESETS, null, Date.parse(RESETS)), true);
  assert.equal(weekRolledOver(null, RESETS, NOW), true);
  assert.equal(weekRolledOver(null, null, NOW), false);
  assert.equal(weekRolledOver("garbage", "other", NOW), true);
});

test("test mode: stage from the given percent, under 85 is a simulated reset", () => {
  let step = advanceTest(INITIAL_PHASE, 50, T);
  assert.equal(step.phase.stage, 0);
  assert.equal(step.reset, false);
  step = advanceTest(step.phase, 90, T);
  assert.equal(step.phase.stage, 1);
  assert.equal(step.entered, 1);
  step = advanceTest(step.phase, 95, T);
  assert.equal(step.phase.stage, 2);
  assert.equal(step.entered, 2);
  const consented = giveConsent(step.phase, NOW).phase;
  step = advanceTest(consented, 97, T);
  assert.equal(step.phase.stage, 1);
  step = advanceTest(step.phase, 10, T);
  assert.equal(step.reset, true);
  assert.equal(step.phase.stage, 0);
  assert.equal(step.phase.consent, false);
  step = advanceTest(step.phase, 95, T);
  assert.equal(step.phase.stage, 2, "after the simulated reset consent is gone");
});

test("models: Sonnet spellings, holding, target execution", () => {
  for (const m of ["claude-sonnet-5-5", "claude-sonnet-4-5", "sonnet", "sonnet[1m]"]) assert.equal(isSonnet(m), true, m);
  for (const m of ["claude-opus-5-5", "claude-opus-5-5[1m]", "opus", "claude-fable-5-1", "claude-haiku-5-5"]) {
    assert.equal(isSonnet(m), false, m);
    assert.equal(holdsForModel(m), true, m);
  }
  assert.equal(holdsForModel(null), false);
  assert.equal(holdsForModel(""), false);
  assert.equal(holdsForModel("claude-sonnet-5-5"), false);
  assert.equal(isTargetExecution({ model: "claude-sonnet-5-5", reasoningLevel: "xhigh" }), true);
  assert.equal(isTargetExecution({ model: "claude-sonnet-5-5", reasoningLevel: "high" }), false);
  assert.equal(isTargetExecution({ model: "claude-opus-5-5", reasoningLevel: "xhigh" }), false);
  assert.equal(isTargetExecution(null), false);
});
