// The guard on a fake BB host (tests/fake-bb.ts): stages switch models and
// stop threads, Codex/Pi are never touched, the hook holds and the backend
// re-queues on Sonnet, consent, the weekly reset gives models back, the test
// mode touches only its threads, the interim state.json is taken over.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DRIP_REASON } from "../lib/policy.ts";
import { KV } from "../server/guard.ts";
import { installGuards } from "../server/wire.ts";
import { createFakeBb, ctx, NEXT_RESETS, row, settle, T0, thread } from "./fake-bb.ts";
import { A, B, C, CLAUDE_AGENT, CODEX, PI, setup, standardWorld } from "./harness.ts";

test("stage 0: nothing is touched, the hook lets everything through", async () => {
  const world = standardWorld({ percent: 60 });
  const t = setup(world);
  await t.guard.tick(true);
  assert.equal(t.host.callsTo("threads.update").length, 0);
  assert.deepEqual(await t.host.dispatch(ctx(A)), { action: "proceed" });
  assert.deepEqual(t.host.agentsConfig({ thread: { id: A }, provider: CLAUDE_AGENT }), { tools: [], skills: [] });
  assert.equal(t.notes.length, 0);
});

test("stage 1: claude-code threads (and only them) go to Sonnet xhigh, previous models saved first", async () => {
  const world = standardWorld({ percent: 86 });
  const t = setup(world);
  await t.guard.tick(true);
  const updates = t.host.callsTo("threads.update") as Array<{ threadId: string; model: string; reasoningLevel: string }>;
  assert.deepEqual(updates.map((u) => u.threadId).sort(), [A, B]);
  for (const u of updates) assert.deepEqual([u.model, u.reasoningLevel], ["claude-sonnet-5-5", "xhigh"]);
  assert.equal(world.threads.get(CODEX)!.model, "gpt-6.1-sol");
  assert.equal(world.threads.get(PI)!.model, "yandex");
  const saved = t.host.kv.get(KV.saved) as Record<string, unknown>;
  assert.deepEqual(saved, {
    [A]: { model: "claude-opus-5-5", reasoningLevel: "xhigh" },
    [B]: { model: "claude-opus-5-5[1m]", reasoningLevel: "max" },
  });
  // saved before any update
  const order = t.host.calls.map((c) => c.path);
  assert.ok(order.indexOf("threads.update") > order.indexOf("threads.defaultExecutionOptions"));
  assert.equal(t.host.recheckCount > 0, true);
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1"]);
  assert.match(t.host.agentsConfig({ thread: { id: A }, provider: CLAUDE_AGENT }).instructions ?? "", /--model claude-sonnet-5-5 --reasoning-level xhigh/);
  assert.equal(t.host.agentsConfig({ thread: { id: CODEX }, provider: { id: "codex" } }).instructions, undefined, "Codex agents get no Claude hint");
  const status = await t.host.cli(["status", "--json"]);
  const snap = JSON.parse(status.stdout ?? "{}");
  assert.equal(snap.stage, 1);
  assert.equal(snap.reading.percent, 86);
  assert.equal(snap.saved, 2);
  assert.equal(snap.onSonnet, 3);
});

test("stage 1: a poll re-checks only busy and fresh threads; a thread back on Opus is switched again, its first saved model kept", async () => {
  const world = standardWorld({ percent: 86 });
  const t = setup(world);
  await t.guard.tick(true);
  world.threads.get(A)!.model = "claude-opus-5-5"; // the user picked Opus explicitly
  world.threads.get(A)!.updatedAt = t.now;
  t.host.clearCalls();
  t.advance(90_000);
  await t.guard.tick(true);
  const checked = (t.host.callsTo("threads.defaultExecutionOptions") as Array<{ threadId: string }>).map((c) => c.threadId).sort();
  assert.deepEqual(checked, [A, C], "B was not updated for days and is idle — not re-checked");
  assert.deepEqual((t.host.callsTo("threads.update") as Array<{ threadId: string }>).map((u) => u.threadId), [A]);
  assert.deepEqual((t.host.kv.get(KV.saved) as Record<string, unknown>)[A], { model: "claude-opus-5-5", reasoningLevel: "xhigh" });
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1"], "no second note for the same stage");
});

test("stage 1 hook on a running thread: Opus held and re-queued on Sonnet in place; Codex and Sonnet pass", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.threads.get(A)!.status = "active";
  world.queue.push(
    row(A, { id: "qm_first", model: "claude-sonnet-5-5", waitingOn: { kind: "thread-busy" } }),
    row(A, { id: "qm_opus", senderThreadId: B, initiator: "agent" }),
    row(A, { id: "qm_last", model: "claude-sonnet-5-5", waitingOn: { kind: "thread-busy" } }),
  );
  const decision = (await t.host.dispatch(ctx(A, { queued: 1 }))) as { action: string; reason: string };
  assert.equal(decision.action, "wait");
  assert.match(decision.reason, /переставляется на Sonnet xhigh\. Нужен Opus — Send now/);
  assert.deepEqual(await t.host.dispatch(ctx(CODEX, { providerId: "codex", model: "gpt-6.1-sol" })), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(ctx(A, { model: "claude-sonnet-5-5" })), { action: "proceed" });
  await t.host.emit("message.queued", { entry: world.queue[1] });
  await settle(60);
  const created = t.host.callsTo("queuedMessages.create") as Array<Record<string, unknown>>;
  assert.equal(created.length, 1, "hook and message.queued schedule one re-queue");
  assert.equal(created[0]!.model, "claude-sonnet-5-5");
  assert.equal(created[0]!.reasoningLevel, "xhigh");
  assert.equal(created[0]!.senderThreadId, B);
  assert.equal(created[0]!.permissionMode, "full");
  assert.deepEqual(created[0]!.input, [{ type: "text", text: "продолжай", mentions: [] }]);
  assert.deepEqual(world.queue.map((r) => r.id), ["qm_first", "qm_new1", "qm_last"], "the copy stands where the held row stood");
  const s = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(s.reseat.copied, 1);
  assert.equal(t.host.callsTo("threads.send").length, 0);
});

test("re-queue on an idle thread: the held Opus row goes out as a new Sonnet turn (lifts a stop pause), sender kept", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.queue.push(row(A, { id: "qm_opus", senderThreadId: B, initiator: "agent" }), row(A, { id: "qm_opus2" }));
  await t.host.dispatch(ctx(A));
  await settle(60);
  const sends = t.host.callsTo("threads.send") as Array<Record<string, unknown>>;
  assert.equal(sends.length, 1);
  assert.deepEqual(
    [sends[0]!.threadId, sends[0]!.mode, sends[0]!.model, sends[0]!.reasoningLevel, sends[0]!.senderThreadId],
    [A, "queue-if-active", "claude-sonnet-5-5", "xhigh", B],
  );
  assert.deepEqual(world.queue.map((r) => [r.id, r.model]), [["qm_new1", "claude-sonnet-5-5"]], "the second held row is copied behind it");
  const order = t.host.calls.map((c) => c.path).filter((p) => p === "queuedMessages.delete" || p === "threads.send");
  assert.equal(order[0], "queuedMessages.delete", "the held row is deleted before the send — no duplicate after Send now");
});

test("re-queue: an error thread gets the held retry as a new Sonnet turn; a new thread is left held", async () => {
  const world = standardWorld({ percent: 88 });
  world.threads.get(A)!.status = "error";
  world.threads.get(B)!.status = "pending";
  const t = setup(world);
  await t.guard.tick(true);
  world.queue.push(row(A, { id: "qm_retry", payload: { kind: "retry" } }), row(B, { id: "qm_new_thread" }));
  await t.host.emit("message.queued", { entry: world.queue[0] });
  await t.host.emit("message.queued", { entry: world.queue[1] });
  await settle(60);
  const sends = t.host.callsTo("threads.send") as Array<Record<string, unknown>>;
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.threadId, A);
  assert.equal(sends[0]!.model, "claude-sonnet-5-5");
  assert.equal(sends[0]!.mode, "queue-if-active");
  assert.deepEqual(world.queue.map((r) => r.id), ["qm_new_thread"]);
  assert.equal(t.host.callsTo("queuedMessages.create").length, 0);
});

test("re-queue: a failed send puts the message back on Sonnet — nothing lost", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.queue.push(row(A, { id: "qm_opus" }));
  (t.host.bb.sdk.threads as { send: unknown }).send = async () => {
    throw new Error("HTTP 502: host not connected");
  };
  await t.host.dispatch(ctx(A));
  await settle(60);
  assert.deepEqual(world.queue.map((r) => [r.id, r.model]), [["qm_new1", "claude-sonnet-5-5"]]);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.reseat.failed, 1);
  assert.match(snap.lastError.message, /новый ход на Sonnet не ушёл/);
});

test("re-queue: the original went meanwhile (Send now) — the copy is removed, no duplicate", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.threads.get(A)!.status = "active";
  world.queue.push(row(A, { id: "qm_opus" }));
  // The original disappears between list and delete.
  const original = t.host.bb.sdk.threads.queuedMessages.reorder;
  (t.host.bb.sdk.threads.queuedMessages as { reorder: unknown }).reorder = async (args: never) => {
    const result = await original(args);
    world.queue.splice(world.queue.findIndex((r) => r.id === "qm_opus"), 1);
    return result;
  };
  await t.host.dispatch(ctx(A, { queued: 1 }));
  await settle(60);
  assert.deepEqual(world.queue, []);
});

test("re-queue: on an idle thread the original went meanwhile — nothing is sent", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.queue.push(row(A, { id: "qm_opus" }));
  const list = t.host.bb.sdk.threads.queuedMessages.list;
  (t.host.bb.sdk.threads.queuedMessages as { list: unknown }).list = async (args: never) => {
    const rows = await list(args);
    world.queue.splice(0, world.queue.length);
    return rows;
  };
  await t.host.dispatch(ctx(A));
  await settle(60);
  assert.equal(t.host.callsTo("threads.send").length, 0);
});

test("stage 2: claude-code turns held, running claude-code stopped (Codex/Pi not), thread.active stops too", async () => {
  const world = standardWorld({ percent: 94 });
  world.running = new Set([A, CODEX, PI]);
  const t = setup(world);
  await t.guard.tick(true);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [A]);
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-2"]);
  const held = (await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" }))) as { action: string; reason: string };
  assert.equal(held.action, "wait");
  assert.match(held.reason, /ждёт вашего согласия \(bb limit-guard resume\)/);
  assert.deepEqual(await t.host.dispatch(ctx(CODEX, { providerId: "codex", model: "gpt-6.1-sol" })), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(ctx(A, { attempt: "join-turn" })), { action: "proceed" });
  // A turn that bypassed the hook (a notice to a parent) is caught on thread.active.
  t.host.clearCalls();
  world.running = new Set([B, CODEX]);
  await t.host.emit("thread.active", { thread: { ...world.threads.get(B)!, status: "active" } });
  await t.host.emit("thread.active", { thread: { ...world.threads.get(CODEX)!, status: "active" } });
  await settle(30);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [B]);
  // A turn that went idle within the grace is not stopped: a stop on an idle thread would pause its queue.
  t.host.clearCalls();
  await t.host.emit("thread.active", { thread: { ...world.threads.get(C)!, status: "active" } });
  await settle(30);
  assert.deepEqual(t.host.callsTo("threads.stop"), []);
  const status = (await t.host.cli(["status"])).stdout ?? "";
  assert.match(status, /стадия 2 \(стоп до согласия\)/);
  assert.match(status, new RegExp(`Остановлено тредов на стадии 2: 2 \\(остановок 2\\): ${A}, ${B}`));
});

test("stage 2: a turn past the hook right after the guard's own stop is stopped too (no time dedupe)", async () => {
  const world = standardWorld({ percent: 94 });
  world.running = new Set([A]);
  const t = setup(world);
  await t.guard.tick(true);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [A]);
  // 3 s later a «child was interrupted» notice starts the parent's turn past the hook.
  t.advance(3_000);
  world.running.add(A);
  await t.host.emit("thread.active", { thread: { ...world.threads.get(A)!, status: "active" } });
  await settle(30);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [A, A]);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.deepEqual([snap.stoppedThreads, snap.stoppedSinceStage2], [[A], 2]);
});

const STOP_HELD = { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя ≥93 %: ждёт вашего согласия (bb limit-guard resume)" };

test("stage 2: the user's Send now on a held row runs — its thread is not stopped until it goes idle", async () => {
  const world = standardWorld({ percent: 94 });
  const t = setup(world);
  await t.guard.tick(true);
  const held = row(B, { id: "qm_held", model: "claude-sonnet-5-5", waitingOn: STOP_HELD });
  await t.host.emit("message.queued", { entry: held });
  t.host.clearCalls();
  world.running = new Set([B]);
  // BB's real order: run.started (thread.active) inside the send, message.dispatched after it.
  await t.host.emit("thread.active", { thread: { ...world.threads.get(B)!, status: "active" } });
  await t.host.emit("message.dispatched", { entry: held });
  await settle(30);
  await t.guard.tick(true);
  await settle(10);
  assert.deepEqual(t.host.callsTo("threads.stop"), []);
  await t.host.emit("thread.idle", { thread: { ...world.threads.get(B)!, status: "idle" }, lastAssistantText: null });
  await t.host.emit("thread.active", { thread: { ...world.threads.get(B)!, status: "active" } });
  await settle(30);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [B]);
});

test("stage 2: Send now is recognised after a reload too — from the row's own wait, not from memory", async () => {
  const world = standardWorld({ percent: 94 });
  const first = setup(world);
  await first.guard.tick(true);
  await first.host.dispose();
  const host2 = createFakeBb(world);
  for (const [key, value] of first.host.kv) host2.kv.set(key, value);
  const guard2 = installGuards(host2.bb, {
    notifier: async (kind) => ({ at: T0, kind, ok: true, message: "" }),
    interimStatePath: null,
    now: () => T0,
    minReadMs: 0,
    sendNowGraceMs: 5,
  }).claude;
  await guard2.ready;
  world.running = new Set([B]);
  await host2.emit("thread.active", { thread: { ...world.threads.get(B)!, status: "active" } });
  await host2.emit("message.dispatched", { entry: row(B, { id: "qm_before_reload", waitingOn: STOP_HELD }) });
  await settle(30);
  assert.deepEqual(host2.callsTo("threads.stop"), []);
});

test("consent in advance on stage 1: no stage 2 this week, no drip window; refused on stage 0", async () => {
  const world = standardWorld({ percent: 60 });
  world.running = new Set([A, B]);
  const t = setup(world);
  await t.guard.tick(true);
  const none = await t.host.cli(["resume"]);
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr ?? "", /стадия 0/);
  world.percent = 88;
  await t.guard.tick(true);
  const early = await t.host.cli(["resume"]);
  assert.equal(early.exitCode, 0, early.stderr);
  assert.match(early.stdout ?? "", /заранее/);
  assert.deepEqual(await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "proceed" }, "no «one by one» window");
  world.percent = 96;
  await t.guard.tick(true);
  assert.equal(t.host.callsTo("threads.stop").length, 0);
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1", "consent"]);
  const again = await t.host.cli(["resume"]);
  assert.match(again.stdout ?? "", /уже дано/);
  world.percent = 2;
  world.resetsAt = NEXT_RESETS;
  await t.guard.tick(true);
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").consent, false, "ends at the weekly reset");
});

test("consent on stage 2: then stage 1 to the reset, ≤2 running claude-code for 10 minutes, stopped threads listed", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.running = new Set([B]);
  world.percent = 95;
  await t.guard.tick(true);
  const recheckBefore = t.host.recheckCount;
  const given = await t.host.cli(["resume"], { threadId: undefined });
  assert.equal(given.exitCode, 0, given.stderr);
  assert.match(given.stdout ?? "", new RegExp(`нужно новое сообщение или Send now: ${B}`));
  assert.ok(t.host.recheckCount > recheckBefore);
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1", "enter-2", "consent"]);
  world.running = new Set([A, B]);
  assert.deepEqual(await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "wait", reason: DRIP_REASON });
  world.running = new Set([A, CODEX]);
  assert.deepEqual(await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "proceed" });
  // C was just granted: until it shows as running it still counts.
  assert.deepEqual(await t.host.dispatch(ctx(B, { model: "claude-sonnet-5-5" })), { action: "wait", reason: DRIP_REASON });
  t.advance(11 * 60_000);
  world.running = new Set([A, B, C]);
  assert.deepEqual(await t.host.dispatch(ctx(B, { model: "claude-sonnet-5-5" })), { action: "proceed" });
  world.percent = 99;
  await t.guard.tick(true);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.stage, 1, "no stage 2 again until the reset");
  assert.equal(snap.consent, true);
  assert.equal(snap.consentBy, "shell");
});

test("weekly reset: previous models come back ([1m] falls back), stage 0, consent dropped", async () => {
  const world = standardWorld({ percent: 95 });
  world.rejectModel.set("claude-opus-5-5[1m]", 400);
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["resume"]);
  world.percent = 2;
  world.resetsAt = NEXT_RESETS;
  t.host.clearCalls();
  await t.guard.tick(true);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(world.threads.get(A)!.reasoningLevel, "xhigh");
  assert.equal(world.threads.get(B)!.model, "claude-opus-5-5");
  assert.equal(world.threads.get(B)!.reasoningLevel, "max");
  assert.equal(world.threads.get(C)!.model, "claude-sonnet-5-5", "a thread that was on Sonnet before stays");
  assert.deepEqual(t.host.kv.get(KV.saved), {});
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.stage, 0);
  assert.equal(snap.consent, false);
  assert.deepEqual(await t.host.dispatch(ctx(A)), { action: "proceed" });
});

test("weekly reset with the host offline: models kept and given back on a later poll", async () => {
  const world = standardWorld({ percent: 87 });
  const t = setup(world);
  await t.guard.tick(true);
  world.percent = 1;
  world.resetsAt = NEXT_RESETS;
  world.rejectModel.set("claude-opus-5-5", 503);
  await t.guard.tick(true);
  assert.equal(world.threads.get(A)!.model, "claude-sonnet-5-5");
  assert.ok(Object.keys(t.host.kv.get(KV.saved) as object).includes(A));
  world.rejectModel.clear();
  await t.guard.tick(true);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.deepEqual(t.host.kv.get(KV.saved), {});
});

test("a failed reading changes nothing and lands in status", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.usageError = "Anthropic temporarily throttled this usage check";
  world.percent = 99;
  await t.guard.tick(true);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.stage, 1);
  assert.match(snap.lastError.message, /throttled/);
});

test("test mode: only the listed threads are switched, held, stopped; --off gives their models back", async () => {
  const world = standardWorld({ percent: 40 });
  world.running = new Set([A, B]);
  const t = setup(world);
  await t.guard.tick(true);
  const on = await t.host.cli(["test", "--threads", A, "--percent", "90"]);
  assert.equal(on.exitCode, 0, on.stderr);
  assert.deepEqual((t.host.callsTo("threads.update") as Array<{ threadId: string }>).map((u) => u.threadId), [A]);
  assert.equal(world.threads.get(B)!.model, "claude-opus-5-5[1m]");
  assert.equal((await t.host.dispatch(ctx(A, { queued: 1 }))).action !== "proceed", true);
  assert.deepEqual(await t.host.dispatch(ctx(B)), { action: "proceed" });
  assert.deepEqual(t.host.agentsConfig({ thread: { id: B }, provider: CLAUDE_AGENT }), { tools: [], skills: [] });
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1"]);
  assert.ok(t.notes[0]!.note.note.startsWith("[ТЕСТ]"));
  await t.host.cli(["test", "--threads", A, "--percent", "95"]);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [A]);
  assert.deepEqual(await t.host.dispatch(ctx(B, { model: "claude-sonnet-5-5" })), { action: "proceed" });
  const status = (await t.host.cli(["status"])).stdout ?? "";
  assert.match(status, /ТЕСТ-РЕЖИМ/);
  const off = await t.host.cli(["test", "--off"]);
  assert.equal(off.exitCode, 0, off.stderr);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.deepEqual(t.host.kv.get(KV.savedTest), {});
  assert.deepEqual(await t.host.dispatch(ctx(A)), { action: "proceed" }, "real stage 0 again");
});

test("test mode: a percent under 85 simulates the weekly reset", async () => {
  const world = standardWorld({ percent: 40 });
  world.rejectModel.set("claude-opus-5-5[1m]", 400);
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["test", "--threads", `${A},${B}`, "--percent", "88"]);
  assert.equal(world.threads.get(B)!.model, "claude-sonnet-5-5");
  await t.host.cli(["test", "--threads", `${A},${B}`, "--percent", "10"]);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(world.threads.get(B)!.model, "claude-opus-5-5", "[1m] rejected by the catalog → plain id");
});

test("the interim state.json is taken over: the plugin keeps the script's previous models, not Sonnet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "limit-guard-"));
  const file = join(dir, "state.json");
  await writeFile(file, JSON.stringify({ stage: 1, saved: { [A]: { model: "claude-opus-5-5", reasoningLevel: "ultracode" }, bad: {} } }));
  const world = standardWorld({ percent: 87 });
  world.threads.get(A)!.model = "claude-sonnet-5-5"; // the script already switched it
  const t = setup(world, { interim: file });
  await t.guard.ready;
  assert.deepEqual(t.host.kv.get(KV.saved), { [A]: { model: "claude-opus-5-5", reasoningLevel: "ultracode" } });
  await t.guard.tick(true);
  assert.deepEqual((t.host.kv.get(KV.saved) as Record<string, unknown>)[A], { model: "claude-opus-5-5", reasoningLevel: "ultracode" });
  world.percent = 3;
  world.resetsAt = NEXT_RESETS;
  await t.guard.tick(true);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(world.threads.get(A)!.reasoningLevel, "ultracode");
});

test("persisted state survives a reload: stage 2 is re-applied and running threads stopped at once", async () => {
  const world = standardWorld({ percent: 94 });
  const first = setup(world);
  await first.guard.tick(true);
  await first.host.dispose();
  const host2 = createFakeBb(world);
  for (const [key, value] of first.host.kv) host2.kv.set(key, value);
  world.usageError = "offline";
  world.running = new Set([B]);
  const guard2 = installGuards(host2.bb, { notifier: async (kind) => ({ at: T0, kind, ok: true, message: "" }), interimStatePath: null, now: () => T0, minReadMs: 0 }).claude;
  await guard2.ready;
  assert.equal((await host2.dispatch(ctx(C, { model: "claude-sonnet-5-5" }))).action, "wait", "the hook holds from the loaded state");
  await guard2.tick(true);
  assert.deepEqual((host2.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [B]);
});

test("settings: thresholds from the plugin settings, odd values fall back to 85/93", async () => {
  const world = standardWorld({ percent: 81 });
  const t = setup(world, { settings: { sonnetPercent: 80, stopPercent: 90 } });
  await t.guard.tick(true);
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").stage, 1);
  const odd = setup(standardWorld({ percent: 81 }), { settings: { sonnetPercent: 95, stopPercent: 90 } });
  await odd.guard.tick(true);
  const snap = JSON.parse((await odd.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.stage, 0);
  assert.match(snap.thresholdsProblem, /беру 85 \/ 93/);
});

test("the registered hook is fail-open on garbage", async () => {
  const t = setup(standardWorld({ percent: 99 }));
  await t.guard.tick(true);
  assert.deepEqual(await t.host.dispatch({}), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch({ thread: null }), { action: "proceed" });
});

test("resume is not queued behind a pass waiting on threads.stop; the pass then stops nothing more", async () => {
  const world = standardWorld({ percent: 88 });
  world.running = new Set([A, B]);
  const t = setup(world, { stopBudgetMs: 60_000 });
  await t.guard.tick(true);
  let release: () => void = () => undefined;
  const hung = new Promise<void>((resolve) => (release = resolve));
  const stopped: string[] = [];
  (t.host.bb.sdk.threads as { stop: unknown }).stop = async ({ threadId }: { threadId: string }) => {
    stopped.push(threadId);
    if (threadId === A) await hung; // the interrupt of A is not confirmed
    world.running.delete(threadId);
    return { ok: true };
  };
  world.percent = 95;
  let tickDone = false;
  const pass = t.guard.tick(true).then(() => (tickDone = true));
  await settle(20);
  const given = await Promise.race([t.host.cli(["resume"]), settle(500).then(() => null)]);
  assert.notEqual(given, null, "resume answered while the pass still waits on threads.stop");
  assert.equal(given!.exitCode, 0, given!.stderr);
  assert.equal(tickDone, false);
  assert.deepEqual(await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "proceed" }, "the hook sees the consent at once");
  release();
  await pass;
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").consent, true);
  assert.equal((t.host.kv.get(KV.state) as { phase: { consent: boolean } }).phase.consent, true, "the pass persisted the consent, not its stale phase");
  assert.deepEqual([...stopped].sort(), [A, B], "stops already under way finish; nothing new is stopped");
});

test("a stage-2 pass waits for slow stops at most its budget", async () => {
  const world = standardWorld({ percent: 95 });
  world.running = new Set([A]);
  const t = setup(world, { stopBudgetMs: 30 });
  (t.host.bb.sdk.threads as { stop: unknown }).stop = () => new Promise(() => undefined); // never confirmed
  const started = Date.now();
  await t.guard.tick(true);
  assert.ok(Date.now() - started < 1_000, "the tick returned after the budget");
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").stage, 2);
});

test("the poll service resolves at once on abort, even with a pass in flight", async () => {
  const world = standardWorld({ percent: 50 });
  const t = setup(world);
  await t.guard.ready;
  (t.host.bb.sdk.system as { usageLimits: unknown }).usageLimits = () => new Promise(() => undefined); // a stuck reading
  const controller = new AbortController();
  const service = t.host.services.get("poll")!;
  let resolved = false;
  const run = Promise.resolve(service.start(controller.signal)).then(() => (resolved = true));
  await settle(20);
  assert.equal(resolved, false);
  controller.abort();
  await Promise.race([run, settle(200)]);
  assert.equal(resolved, true, "start() resolved after abort");
});

test("re-queue on stage 2: a held Sonnet send keeps its place ahead of the copies", async () => {
  const world = standardWorld({ percent: 95, sendQueued: true });
  const t = setup(world);
  await t.guard.tick(true);
  world.queue.push(row(A, { id: "qm_one", waitingOn: STOP_HELD }), row(A, { id: "qm_two", waitingOn: STOP_HELD }));
  await t.host.emit("message.queued", { entry: world.queue[0] });
  await settle(60);
  assert.equal(t.host.callsTo("threads.send").length, 1);
  assert.deepEqual(
    world.queue.map((r) => [r.id, r.model]),
    [
      ["qm_new1", "claude-sonnet-5-5"],
      ["qm_new2", "claude-sonnet-5-5"],
    ],
    "the first message stays first",
  );
});

test("re-queue saves the previous model of a thread the pass has not reached yet", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  const D = "thr_dddddddd";
  world.threads.set(D, thread(D, { model: "claude-opus-5-5", reasoningLevel: "max" })); // unarchived after the pass, say
  world.queue.push(row(D, { id: "qm_opus" }));
  await t.host.dispatch(ctx(D));
  await settle(60);
  assert.equal(t.host.callsTo("threads.send").length, 1);
  assert.deepEqual((t.host.kv.get(KV.saved) as Record<string, unknown>)[D], { model: "claude-opus-5-5", reasoningLevel: "max" });
  const order = t.host.calls.map((c) => c.path);
  assert.ok(order.lastIndexOf("threads.defaultExecutionOptions") < order.indexOf("threads.send"), "saved before the Sonnet turn");
});
