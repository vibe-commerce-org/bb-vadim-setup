// Provider profiles (lib/profile.ts): settings, what a guard holds, the words.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_GUARD,
  CLAUDE_PROFILE,
  CODEX_PROFILE,
  effortAbove,
  executionFor,
  holdsExecution,
  isOnTarget,
  resolveSettings,
  restoreAttempts,
  savedEntry,
  targetExec,
  targetFlags,
  targetLabel,
  targetShort,
  targetUpdate,
  type GuardInfo,
} from "../lib/profile.ts";
import { pickWeekly } from "../lib/usage.ts";

const KEEP: GuardInfo = { profile: CODEX_PROFILE, target: { model: null, effort: "medium" } };
const SOL: GuardInfo = { profile: CODEX_PROFILE, target: { model: "gpt-6.2-sol", effort: "medium" } };

test("profiles: Claude keeps its 0.1 keys and is on by default; Codex is off by default with its own keys", () => {
  assert.deepEqual([CLAUDE_PROFILE.kvPrefix, CLAUDE_PROFILE.service, CLAUDE_PROFILE.cmd, CLAUDE_PROFILE.enabledByDefault], ["", "poll", "", true]);
  assert.deepEqual([CODEX_PROFILE.kvPrefix, CODEX_PROFILE.service, CODEX_PROFILE.cmd, CODEX_PROFILE.enabledByDefault], ["codex:", "poll-codex", " codex", false]);
});

test("settings: Claude — 85/93 and Sonnet xhigh; Codex — own thresholds, keep-the-model + medium by default", () => {
  assert.deepEqual(resolveSettings(CLAUDE_PROFILE, { sonnetPercent: 80, stopPercent: 90, codexCheapPercent: 10 }), {
    thresholds: { sonnet: 80, stop: 90 },
    target: { model: "claude-sonnet-5-5", effort: "xhigh" },
    problem: null,
  });
  assert.deepEqual(resolveSettings(CODEX_PROFILE, { codexCheapPercent: 70, codexStopPercent: 95, codexModel: "", codexEffort: "medium", sonnetPercent: 10 }), {
    thresholds: { sonnet: 70, stop: 95 },
    target: { model: null, effort: "medium" },
    problem: null,
  });
  assert.deepEqual(resolveSettings(CODEX_PROFILE, { codexModel: " gpt-6.2-sol ", codexEffort: "low" }).target, { model: "gpt-6.2-sol", effort: "low" });
  const odd = resolveSettings(CODEX_PROFILE, { codexCheapPercent: 99, codexStopPercent: 90, codexModel: "a b", codexEffort: "max" });
  assert.deepEqual(odd.thresholds, { sonnet: 85, stop: 93 });
  assert.deepEqual(odd.target, { model: null, effort: "medium" });
  assert.match(odd.problem ?? "", /1 ≤ экономия < стоп/);
  assert.match(odd.problem ?? "", /effort Codex «max» не годится/);
  assert.match(odd.problem ?? "", /модель Codex «a b»/);
});

test("effortAbove: ranks known efforts, never calls an unknown one higher", () => {
  assert.equal(effortAbove("xhigh", "medium"), true);
  assert.equal(effortAbove("medium", "medium"), false);
  assert.equal(effortAbove("low", "medium"), false);
  assert.equal(effortAbove("ultra", "xhigh"), true);
  assert.equal(effortAbove(null, "medium"), false);
  assert.equal(effortAbove("turbo", "low"), false);
});

test("holds and on-target: Claude by model only; Codex by effort, and by model when one is set", () => {
  assert.equal(holdsExecution(CLAUDE_GUARD, "claude-opus-5-5", "low"), true);
  assert.equal(holdsExecution(CLAUDE_GUARD, "claude-sonnet-5-5", "max"), false, "Claude ignores the effort, as in 0.1");
  assert.equal(holdsExecution(KEEP, "gpt-6.1-terra", "xhigh"), true);
  assert.equal(holdsExecution(KEEP, "gpt-6.1-terra", "medium"), false);
  assert.equal(holdsExecution(KEEP, "gpt-6.1-terra", null), false, "an effort core resolves is the thread's default — already lowered");
  assert.equal(holdsExecution(KEEP, null, "xhigh"), false, "unknown model — left alone");
  assert.equal(holdsExecution(SOL, "gpt-6.1-terra", "low"), true);
  assert.equal(holdsExecution(SOL, "gpt-6.2-sol", "high"), true);
  assert.equal(holdsExecution(SOL, "gpt-6.2-sol", "low"), false);
  assert.equal(isOnTarget(KEEP, { model: "gpt-6.1-terra", reasoningLevel: "low" }), true, "a lower effort is never raised");
  assert.equal(isOnTarget(KEEP, { model: "gpt-6.1-terra", reasoningLevel: "high" }), false);
  assert.equal(isOnTarget(SOL, { model: "gpt-6.1-terra", reasoningLevel: "low" }), false);
  assert.equal(isOnTarget(SOL, null), false);
  assert.equal(isOnTarget(CLAUDE_GUARD, { model: "claude-sonnet-5-5", reasoningLevel: "xhigh" }), true);
  assert.deepEqual(targetUpdate(KEEP, { model: "gpt-6.1-terra", reasoningLevel: "xhigh" }), { reasoningLevel: "medium" });
  assert.deepEqual(targetUpdate(SOL, { model: "gpt-6.1-terra", reasoningLevel: "xhigh" }), { model: "gpt-6.2-sol", reasoningLevel: "medium" });
  assert.deepEqual(targetUpdate(SOL, { model: "gpt-6.1-terra", reasoningLevel: "low" }), { model: "gpt-6.2-sol", reasoningLevel: "low" }, "a lower effort is not raised in model mode either");
  assert.deepEqual(targetUpdate(CLAUDE_GUARD, { model: "claude-opus-5-5", reasoningLevel: "low" }), { model: "claude-sonnet-5-5", reasoningLevel: "xhigh" }, "Claude: Sonnet xhigh, as in 0.1");
  assert.deepEqual(executionFor(SOL, "gpt-6.1-terra", "low"), { model: "gpt-6.2-sol", reasoningLevel: "low" });
  assert.deepEqual(executionFor(KEEP, "gpt-6.1-terra", "ultra"), { model: "gpt-6.1-terra", reasoningLevel: "medium" });
  assert.deepEqual(executionFor(KEEP, "gpt-6.1-terra", null), { model: "gpt-6.1-terra", reasoningLevel: "medium" });
});

test("words: Claude reads as before; Codex names its effort or model", () => {
  assert.deepEqual([targetLabel(CLAUDE_GUARD.target), targetShort(CLAUDE_GUARD.target), targetExec(CLAUDE_GUARD.target)], ["Sonnet xhigh", "Sonnet", "claude-sonnet-5-5 / xhigh"]);
  assert.equal(targetFlags(CLAUDE_GUARD.target), "--model claude-sonnet-5-5 --reasoning-level xhigh");
  assert.deepEqual([targetLabel(KEEP.target), targetShort(KEEP.target), targetExec(KEEP.target), targetFlags(KEEP.target)], [
    "effort medium",
    "effort medium",
    "effort medium",
    "--reasoning-level medium",
  ]);
  assert.deepEqual([targetLabel(SOL.target), targetShort(SOL.target), targetExec(SOL.target)], ["gpt-6.2-sol medium", "gpt-6.2-sol", "gpt-6.2-sol / medium"]);
});

test("pickWeekly: the Codex weekly window from a real-shaped answer; not connected — in words", () => {
  const answer = {
    codex: {
      status: "ok",
      planLabel: "Plus",
      windows: [
        { label: "Current session", usedPercent: 2, resetsAt: "2026-11-21T00:03:43.000Z", kind: "five-hour" },
        { label: "Weekly limit", usedPercent: 35, resetsAt: "2026-11-26T08:05:10.000Z", kind: "weekly" },
      ],
    },
  };
  assert.deepEqual(pickWeekly(answer, "codex"), { ok: true, reading: { percent: 35, resetsAt: "2026-11-26T08:05:10.000Z" } });
  const missing = pickWeekly({ codex: { status: "unauthenticated" } }, "codex");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error, /нет входа в аккаунт провайдера · status=unauthenticated/);
});

test("saved and restore: Codex keep-model saves «effort only» and gives back only the effort; Claude as in 0.1", () => {
  const opts = { model: "gpt-6.1-terra", reasoningLevel: "xhigh" };
  assert.deepEqual(savedEntry(KEEP, opts), { model: "gpt-6.1-terra", reasoningLevel: "xhigh", effortOnly: true });
  assert.deepEqual(savedEntry(SOL, opts), { model: "gpt-6.1-terra", reasoningLevel: "xhigh" });
  assert.deepEqual(savedEntry(CLAUDE_GUARD, { model: "claude-opus-5-5", reasoningLevel: "max" }), { model: "claude-opus-5-5", reasoningLevel: "max" });
  const models = (m: string | null) => (m === null ? [null] : [m, m.replace(/\[1m\]$/, "")].filter((x, i, a) => a.indexOf(x) === i));
  assert.deepEqual(restoreAttempts(KEEP, { model: "gpt-6.1-terra", reasoningLevel: "xhigh", effortOnly: true }, models), [{ reasoningLevel: "xhigh" }]);
  assert.deepEqual(restoreAttempts(SOL, { model: "gpt-6.1-terra", reasoningLevel: "xhigh" }, models), [
    { model: "gpt-6.1-terra", reasoningLevel: "xhigh" },
    { reasoningLevel: "xhigh" },
  ]);
  assert.deepEqual(restoreAttempts(CLAUDE_GUARD, { model: "claude-opus-5-5[1m]", reasoningLevel: "max" }, models), [
    { model: "claude-opus-5-5[1m]", reasoningLevel: "max" },
    { model: "claude-opus-5-5", reasoningLevel: "max" },
  ]);
});
