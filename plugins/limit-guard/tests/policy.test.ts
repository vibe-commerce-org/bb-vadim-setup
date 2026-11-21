// The message.dispatch policy as a pure function, and the fail-open handler.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDispatchHook,
  decide,
  DRIP_REASON,
  DRIP_WINDOW_MS,
  MARKER,
  MAX_REASON,
  needsRunningCount,
  newThreadReason,
  rejectMessage,
  sonnetReason,
  stopReason,
  type DispatchFacts,
  type HookContextLike,
  type PolicyView,
} from "../lib/policy.ts";
import { CLAUDE_GUARD } from "../lib/profile.ts";
import { DEFAULT_THRESHOLDS, type Stage } from "../lib/stage.ts";

const NOW = Date.parse("2026-10-15T06:00:00+03:00");
const T = DEFAULT_THRESHOLDS;

function facts(over: Partial<DispatchFacts> = {}): DispatchFacts {
  return {
    threadId: "thr_aaaaaaaa",
    providerId: "claude-code",
    model: "claude-opus-5-5",
    attempt: "start-turn",
    threadStatus: "idle",
    origin: "cli",
    inline: true,
    ...over,
  };
}

function view(stage: Stage, over: Partial<PolicyView> = {}): PolicyView {
  return { stage, consent: false, dripFrom: null, scope: null, thresholds: T, guard: CLAUDE_GUARD, ...over };
}

test("proceed: other providers, a join into a running turn, stage 0, outside the test scope", () => {
  assert.deepEqual(decide(facts({ providerId: "codex" }), view(2), NOW).decision, { action: "proceed" });
  assert.deepEqual(decide(facts({ providerId: "pi" }), view(1), NOW).decision, { action: "proceed" });
  assert.deepEqual(decide(facts({ attempt: "join-turn" }), view(2), NOW).decision, { action: "proceed" });
  assert.deepEqual(decide(facts(), view(0), NOW).decision, { action: "proceed" });
  const scoped = view(2, { scope: new Set(["thr_bbbbbbbb"]) });
  assert.deepEqual(decide(facts(), scoped, NOW).decision, { action: "proceed" });
  assert.equal(decide(facts({ threadId: "thr_bbbbbbbb" }), scoped, NOW).decision.action, "wait");
});

test("stage 1: Sonnet goes, Opus is held and re-queued, unknown model goes", () => {
  assert.deepEqual(decide(facts({ model: "claude-sonnet-5-5" }), view(1), NOW).decision, { action: "proceed" });
  assert.deepEqual(decide(facts({ model: "sonnet" }), view(1), NOW).decision, { action: "proceed" });
  assert.deepEqual(decide(facts({ model: null }), view(1), NOW).decision, { action: "proceed" });
  const held = decide(facts({ inline: false }), view(1), NOW);
  assert.deepEqual(held.decision, { action: "wait", reason: sonnetReason(T, "claude-opus-5-5") });
  assert.equal(held.reseat, true);
  assert.equal(decide(facts({ threadStatus: "error" }), view(1), NOW).reseat, true);
});

test("stage ≥1: the first message of a new thread on Opus — rejected for agents, held for the app", () => {
  const spawned = decide(facts({ threadStatus: "pending", origin: "cli" }), view(1), NOW);
  assert.deepEqual(spawned.decision, { action: "reject", message: rejectMessage(T) });
  assert.match(rejectMessage(T), /--model claude-sonnet-5-5 --reasoning-level xhigh/);
  assert.equal(decide(facts({ threadStatus: "pending", origin: null }), view(1), NOW).decision.action, "reject");
  assert.equal(decide(facts({ threadStatus: "pending", origin: "plugin" }), view(2), NOW).decision.action, "reject");
  const app = decide(facts({ threadStatus: "pending", origin: "app" }), view(1), NOW);
  assert.deepEqual(app.decision, { action: "wait", reason: newThreadReason(T, "claude-opus-5-5") });
  assert.equal(app.reseat, false);
  const queuedFirst = decide(facts({ threadStatus: "pending", inline: false }), view(1), NOW);
  assert.equal(queuedFirst.decision.action, "wait");
  assert.equal(queuedFirst.reseat, false);
  assert.deepEqual(decide(facts({ threadStatus: "pending", model: "claude-sonnet-5-5" }), view(1), NOW).decision, { action: "proceed" });
});

test("stage 2 without consent: every claude-code turn waits for the user", () => {
  const sonnet = decide(facts({ model: "claude-sonnet-5-5" }), view(2), NOW);
  assert.deepEqual(sonnet.decision, { action: "wait", reason: stopReason(T) });
  assert.equal(sonnet.reseat, false);
  const opus = decide(facts(), view(2), NOW);
  assert.equal(opus.decision.action, "wait");
  assert.equal(opus.reseat, true, "held Opus rows move to Sonnet already while waiting");
  assert.match(stopReason(T), /ждёт вашего согласия \(bb limit-guard resume\)/);
});

test("after consent: 10 minutes of ≤2 running claude-code threads, then everything", () => {
  const consented = view(1, { consent: true, dripFrom: NOW - 60_000 });
  const busy = decide(facts({ model: "claude-sonnet-5-5", runningClaude: 2 }), consented, NOW);
  assert.deepEqual(busy.decision, { action: "wait", reason: DRIP_REASON });
  assert.deepEqual(decide(facts({ model: "claude-sonnet-5-5", runningClaude: 1 }), consented, NOW).decision, { action: "proceed" });
  assert.equal(decide(facts({ runningClaude: 1 }), consented, NOW).decision.action, "wait", "Opus still moves to Sonnet");
  const later = NOW + DRIP_WINDOW_MS;
  assert.deepEqual(decide(facts({ model: "claude-sonnet-5-5", runningClaude: 9 }), consented, later).decision, { action: "proceed" });
  assert.equal(needsRunningCount(facts(), consented, NOW), true);
  assert.equal(needsRunningCount(facts(), consented, later), false);
  assert.equal(needsRunningCount(facts({ providerId: "codex" }), consented, NOW), false);
  assert.equal(needsRunningCount(facts(), view(1), NOW), false);
});

test("reasons: marked, within BB's 200 characters, thresholds from settings", () => {
  const t = { sonnet: 80, stop: 90 };
  for (const text of [stopReason(t), DRIP_REASON, sonnetReason(t, "claude-opus-5-5"), newThreadReason(t, "x".repeat(300)), rejectMessage(t)]) {
    assert.ok(text.startsWith(MARKER), text);
  }
  for (const text of [stopReason(t), DRIP_REASON, sonnetReason(t, "claude-opus-5-5"), newThreadReason(t, "x".repeat(300))]) {
    assert.ok(text.length <= MAX_REASON, `${text.length}`);
  }
  assert.match(stopReason(t), /≥90 %/);
  assert.match(sonnetReason(t, "claude-opus-5-5"), /≥80 %: ход на Opus придержан и переставляется на Sonnet xhigh\. Нужен Opus — Send now/);
});

function context(over: Partial<{ model: string | null; status: string; attempt: string; provider: string; queued: number }> = {}): HookContextLike {
  return {
    thread: { id: "thr_aaaaaaaa", status: over.status ?? "idle" },
    requestedExecution: { providerId: over.provider ?? "claude-code", model: over.model === undefined ? "claude-opus-5-5" : over.model },
    attempt: over.attempt ?? "start-turn",
    origin: "cli",
    queuedMessages: Array.from({ length: over.queued ?? 0 }, () => ({})),
  };
}

function hookWith(over: Partial<Parameters<typeof createDispatchHook>[0]> = {}) {
  const seen: string[] = [];
  const reseat: string[] = [];
  const granted: string[] = [];
  const handler = createDispatchHook({
    view: () => view(1),
    ready: async () => undefined,
    countRunningClaude: async () => 0,
    onGranted: (id) => granted.push(id),
    onReseat: (id) => reseat.push(id),
    onSeen: (id) => seen.push(id),
    warn: () => undefined,
    now: () => NOW,
    readyBudgetMs: 30,
    countBudgetMs: 30,
    ...over,
  });
  return { handler, seen, reseat, granted };
}

test("hook: decides from memory and asks for the re-queue after a hold", async () => {
  const { handler, reseat, seen } = hookWith();
  assert.equal((await handler(context())).action, "wait");
  assert.deepEqual(reseat, ["thr_aaaaaaaa"]);
  assert.deepEqual(seen, ["thr_aaaaaaaa"]);
  assert.deepEqual(await handler(context({ model: "claude-sonnet-5-5" })), { action: "proceed" });
});

test("hook fail-open: a throw anywhere answers proceed", async () => {
  const broken = hookWith({
    view: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await broken.handler(context()), { action: "proceed" });
  const malformed = hookWith();
  assert.deepEqual(await malformed.handler({} as HookContextLike), { action: "proceed" });
  assert.deepEqual(await malformed.handler(null as unknown as HookContextLike), { action: "proceed" });
  const consented = view(1, { consent: true, dripFrom: NOW - 1000 });
  const failingCount = hookWith({
    view: () => consented,
    countRunningClaude: async () => {
      throw new Error("listRunning 500");
    },
  });
  assert.deepEqual(await failingCount.handler(context({ model: "claude-sonnet-5-5" })), { action: "proceed" });
  const warnThrows = hookWith({
    view: () => {
      throw new Error("boom");
    },
    warn: () => {
      throw new Error("log is gone");
    },
  });
  assert.deepEqual(await warnThrows.handler(context()), { action: "proceed" });
  const reseatThrows = hookWith({
    onReseat: () => {
      throw new Error("timer");
    },
  });
  assert.equal((await reseatThrows.handler(context())).action, "wait", "the decision stands even if the re-queue is not planned");
});

test("hook fail-open: a hanging SDK call or load never holds the send past its budget", async () => {
  const consented = view(1, { consent: true, dripFrom: NOW - 1000 });
  const hanging = hookWith({ view: () => consented, countRunningClaude: () => new Promise<number>(() => undefined) });
  const started = Date.now();
  assert.deepEqual(await hanging.handler(context({ model: "claude-sonnet-5-5" })), { action: "proceed" });
  assert.ok(Date.now() - started < 1_000);
  const notLoaded = hookWith({ ready: () => new Promise<void>(() => undefined), view: () => view(2) });
  const decision = await notLoaded.handler(context());
  assert.equal(decision.action, "wait", "after the load budget the hook still decides from memory");
});

test("hook: drip window counts running threads and records the grant", async () => {
  const consented = view(1, { consent: true, dripFrom: NOW - 1000 });
  const busy = hookWith({ view: () => consented, countRunningClaude: async () => 2 });
  assert.deepEqual(await busy.handler(context({ model: "claude-sonnet-5-5" })), { action: "wait", reason: DRIP_REASON });
  assert.deepEqual(busy.granted, []);
  const free = hookWith({ view: () => consented, countRunningClaude: async () => 1 });
  assert.deepEqual(await free.handler(context({ model: "claude-sonnet-5-5" })), { action: "proceed" });
  assert.deepEqual(free.granted, ["thr_aaaaaaaa"]);
});
