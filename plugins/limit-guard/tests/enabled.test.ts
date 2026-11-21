// The off switch (sidebar-footer card, `bb limit-guard off|on|restore-models`):
// off = the guard reads the limit and nothing else; models stay as they are;
// «return the models» is a separate, deliberate step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KV } from "../server/guard.ts";
import { registerRpc } from "../server/rpc.ts";
import { installGuards } from "../server/wire.ts";
import { createFakeBb, ctx, NEXT_RESETS, newWorld, row, settle, T0, thread } from "./fake-bb.ts";
import { A, B, C, CLAUDE_AGENT, CODEX, setup, standardWorld } from "./harness.ts";

const cliText = async (t: ReturnType<typeof setup>, argv: string[]) => {
  const r = await t.host.cli(argv);
  return { code: r.exitCode, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

test("off on stage 2: nothing is held, stopped or switched; the card still sees the week", async () => {
  const world = standardWorld({ percent: 94 });
  world.running = new Set([A]);
  const t = setup(world);
  await t.guard.tick(true);
  assert.equal(((await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" }))) as { action: string }).action, "wait", "stage 2 holds before the switch");
  t.host.clearCalls();
  const before = t.host.recheckCount;
  const notesAtOff = t.notes.length;

  const off = await cliText(t, ["off"]);
  assert.equal(off.code, 0);
  assert.match(off.text, /Сторож выключен/);
  assert.ok(t.host.recheckCount > before, "held rows are released at once");

  assert.deepEqual(await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(ctx(A, { model: "claude-opus-5-5" })), { action: "proceed" }, "no Opus re-queue either");
  assert.deepEqual(t.host.agentsConfig({ thread: { id: A }, provider: CLAUDE_AGENT }), { tools: [], skills: [] });

  world.running = new Set([B]);
  await t.host.emit("thread.active", { thread: { ...world.threads.get(B)!, status: "active" } });
  await t.host.emit("thread.created", { thread: { ...world.threads.get(B)!, status: "idle" } });
  await settle(30);
  world.percent = 95;
  await t.guard.tick(true);
  assert.deepEqual(t.host.callsTo("threads.stop"), []);
  assert.deepEqual(t.host.callsTo("threads.update"), []);
  assert.equal(t.notes.length, notesAtOff, "no further notifications while off");

  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.enabled, false);
  assert.equal(snap.reading.percent, 95, "the reading keeps coming");
  const status = (await t.host.cli(["status"])).stdout ?? "";
  assert.match(status, /ВЫКЛЮЧЕН \(не вмешивается\)/);
});

test("off on stage 1: models stay on Sonnet and are not touched; restore-models gives them back in the background", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  assert.equal(world.threads.get(B)!.model, "claude-sonnet-5-5");
  t.host.clearCalls();

  const refused = await cliText(t, ["restore-models"]);
  assert.equal(refused.code, 1, "on stage 1 the guard would switch them again");
  assert.match(refused.text, /Сначала выключи/);
  assert.deepEqual(t.host.callsTo("threads.update"), []);

  const off = await cliText(t, ["off"]);
  assert.match(off.text, /Модели не менялись: 2 тредов, переведённых сторожем, остаются на claude-sonnet-5-5/);
  assert.deepEqual(t.host.callsTo("threads.update"), [], "turning off changes no model");
  world.percent = 90;
  await t.guard.tick(true);
  assert.deepEqual(t.host.callsTo("threads.update"), [], "polls while off change no model");

  const restore = await cliText(t, ["restore-models"]);
  assert.equal(restore.code, 0);
  assert.match(restore.text, /Возвращаю прежние модели 2 тредам в фоне/);
  await settle(50);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(world.threads.get(B)!.model, "claude-opus-5-5[1m]");
  assert.equal(world.threads.get(B)!.reasoningLevel, "max");
  assert.equal(world.threads.get(CODEX)!.model, "gpt-6.1-sol", "Codex never touched");
  assert.deepEqual(t.host.kv.get(KV.saved), {});
  assert.match((await cliText(t, ["restore-models"])).text, /Возвращать нечего/);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.restoring, false);
});

test("on: a fresh reading decides — stage 2 without consent stops running work at once", async () => {
  const world = standardWorld({ percent: 88 });
  world.running = new Set([A]);
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  world.percent = 95;
  await t.guard.tick(true);
  t.host.clearCalls();

  const on = await cliText(t, ["on"]);
  assert.equal(on.code, 0);
  assert.match(on.text, /Сторож включён: неделя 95 %, стадия 2/);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [A]);
  assert.equal(((await t.host.dispatch(ctx(C, { model: "claude-sonnet-5-5" }))) as { action: string }).action, "wait");
  assert.match((await cliText(t, ["on"])).text, /и так включён/);
});

test("on after a weekly reset that happened while off: the models come back, stage 0", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  world.percent = 3;
  world.resetsAt = NEXT_RESETS;
  await t.guard.tick(true);
  assert.equal(world.threads.get(A)!.model, "claude-sonnet-5-5", "off: even a reset gives nothing back by itself");
  await t.host.cli(["on"]);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").stage, 0);
});

test("off survives a reload of the plugin; a second off and the test mode while off are handled", async () => {
  const world = standardWorld({ percent: 94 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  assert.match((await cliText(t, ["off"])).text, /и так выключен/);
  const refusedTest = await cliText(t, ["test", "--threads", A, "--percent", "90"]);
  assert.equal(refusedTest.code, 1);
  assert.match(refusedTest.text, /Сторож выключен/);

  const host2 = createFakeBb(world);
  for (const [key, value] of t.host.kv) host2.kv.set(key, structuredClone(value));
  const guard2 = installGuards(host2.bb, {
    notifier: async (kind) => ({ at: T0, kind, ok: true, message: "ok" }),
    interimStatePath: null,
    now: () => T0,
    minReadMs: 0,
  }).claude;
  await guard2.ready;
  assert.deepEqual(await host2.dispatch(ctx(C, { model: "claude-sonnet-5-5" })), { action: "proceed" }, "still off after the reload");
  assert.equal(JSON.parse((await host2.cli(["status", "--json"])).stdout ?? "{}").enabled, false);
});

test("off ends a running test mode and gives the test threads their models back", async () => {
  const world = standardWorld({ percent: 50 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["test", "--threads", A, "--percent", "90"]);
  assert.equal(world.threads.get(A)!.model, "claude-sonnet-5-5");
  const off = await cliText(t, ["off"]);
  assert.equal(off.code, 0);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5", "test models returned");
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").test, null);
});

test("rpc: status for the card, the switch, restore — the same answers as the commands", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);

  const s1 = (await t.host.rpc("status")) as Record<string, unknown>;
  assert.equal(s1.enabled, true);
  assert.equal(s1.stage, 1);
  assert.equal(s1.percent, 88);
  assert.equal(s1.resetsAt, world.resetsAt);
  assert.equal(s1.onSonnet, 3, "A and B switched, C was already there");
  assert.equal(s1.saved, 2, "only A and B have a previous model to give back");
  assert.deepEqual(s1.thresholds, { sonnet: 85, stop: 93 });

  const refused = (await t.host.rpc("restoreModels")) as { ok: boolean; text: string };
  assert.equal(refused.ok, false);

  const off = (await t.host.rpc("setEnabled", { enabled: false })) as { ok: boolean; text: string };
  assert.equal(off.ok, true);
  const s2 = (await t.host.rpc("status")) as Record<string, unknown>;
  assert.equal(s2.enabled, false);
  assert.equal(s2.stage, 0, "the card sees stage 0 while off");
  assert.equal(s2.realStage, 1);

  const restore = (await t.host.rpc("restoreModels")) as { ok: boolean };
  assert.equal(restore.ok, true);
  await settle(50);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.equal(((await t.host.rpc("status")) as { saved: number }).saved, 0);

  const on = (await t.host.rpc("setEnabled", { enabled: true })) as { ok: boolean; text: string };
  assert.match(on.text, /Сторож включён/);
  assert.equal(((await t.host.rpc("status")) as { enabled: boolean }).enabled, true);
});

test("the contract's schemas accept what the handlers return", async () => {
  const { rpcContract } = await import("../rpc.ts");
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  const status = await t.host.rpc("status");
  const parsed = rpcContract.status.output["~standard"].validate(status) as { issues?: unknown };
  assert.equal(parsed.issues, undefined, JSON.stringify(parsed));
  assert.equal((rpcContract.setEnabled.input["~standard"].validate({ enabled: true }) as { issues?: unknown }).issues, undefined);
  assert.notEqual((rpcContract.setEnabled.input["~standard"].validate({ enabled: "yes" }) as { issues?: unknown }).issues, undefined);
});

test("registerRpc is registered next to the CLI by the plugin entry", async () => {
  const world = standardWorld({ percent: 50 });
  const host = createFakeBb(world);
  const { createPlugin } = await import("../server.ts");
  createPlugin({ notifier: async (kind) => ({ at: T0, kind, ok: true, message: "ok" }), interimStatePath: null })(host.bb);
  const status = (await host.rpc("status")) as { enabled: boolean };
  assert.equal(status.enabled, true);
  void registerRpc;
});

// ── regressions from the review of the off switch (23.10) ──────────────────────

type Gate = { open(): void; wait: Promise<void> };
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

test("off in the middle of a re-queue: the rows not yet moved stay as they are", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  world.threads.get(A)!.status = "active";
  world.queue.push(
    row(A, { id: "qm_opus1", waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя ≥85 %: ход на Opus придержан" } }),
    row(A, { id: "qm_opus2", waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя ≥85 %: ход на Opus придержан" } }),
  );
  const queued = (t.host.bb as unknown as { sdk: { threads: { queuedMessages: { create: (a: unknown) => Promise<unknown> } } } }).sdk.threads.queuedMessages;
  const original = queued.create.bind(queued);
  const slow = gate();
  queued.create = async (args) => {
    await slow.wait;
    return original(args);
  };
  await t.host.emit("message.queued", { entry: world.queue[0] });
  await settle(30); // the re-queue started and waits inside the first create
  await t.host.cli(["off"]);
  slow.open();
  await settle(60);
  // The step in flight (copy → delete of the first row) finishes as a unit; the second row is not started.
  assert.equal(t.host.callsTo("queuedMessages.create").length, 1, "only the create that was already in flight");
  assert.equal(world.queue.length, 2, "no duplicate: the first row was replaced by its copy, not doubled");
  assert.ok(world.queue.some((r) => r.id === "qm_opus2"), "the second row is untouched");
  assert.ok(!world.queue.some((r) => r.id === "qm_opus1"), "the first row went with its copy");
});

test("resume while off is refused: no consent kept, no Telegram, no false hint in status", async () => {
  const world = standardWorld({ percent: 94 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  const notesBefore = t.notes.length;
  const refused = await cliText(t, ["resume"]);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /Сторож выключен — согласие не нужно/);
  assert.equal(t.notes.length, notesBefore, "no notification while off");
  const status = (await t.host.cli(["status"])).stdout ?? "";
  assert.ok(!status.includes("Продолжить до сброса недели"), status);
  await t.host.cli(["on"]);
  assert.equal(JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}").consent, false, "no consent slipped in while off");
});

test("off in the middle of a pass: the skipped threads are not counted as failures", async () => {
  const many = Array.from({ length: 12 }, (_, i) => thread(`thr_many${String(i).padStart(4, "0")}`));
  const world = newWorld(many, { percent: 50 });
  const t = setup(world);
  await t.guard.tick(true);
  const sdk = (t.host.bb as unknown as { sdk: { threads: { update: (a: { threadId: string }) => Promise<unknown> } } }).sdk.threads;
  const original = sdk.update.bind(sdk);
  let updates = 0;
  sdk.update = async (args) => {
    updates += 1;
    if (updates === 3) {
      // From outside, like the button: the flag flips at once, the rest queues behind the running pass.
      void t.host.cli(["off"]);
      await settle(5);
    }
    return original(args);
  };
  world.percent = 90;
  await t.guard.tick(true);
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.ok(updates < 12, `the pass stopped early (${updates} updates)`);
  assert.equal(snap.lastPass.failed, 0, "skipped because of off ≠ failed");
  assert.ok(!snap.lastError || !String(snap.lastError.message).includes("не удалось"), JSON.stringify(snap.lastError));
});

test("restore-models accepted while off and run behind a slow tick still restores (the rule is re-checked inside the queue)", async () => {
  const world = standardWorld({ percent: 50 });
  const t = setup(world);
  world.percent = 88;
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  // The restore request is accepted while off, but waits behind a slow tick…
  const slow = gate();
  const usage = (t.host.bb as unknown as { sdk: { system: { usageLimits: (a: unknown) => Promise<unknown> } } }).sdk.system;
  const originalUsage = usage.usageLimits.bind(usage);
  usage.usageLimits = async (args) => {
    await slow.wait;
    return originalUsage(args);
  };
  const slowTick = t.guard.tick(true);
  await settle(10);
  const accepted = await cliText(t, ["restore-models"]);
  assert.equal(accepted.code, 0);
  // …and the guard is switched on meanwhile (it queues after the restore) — the rule is re-checked inside the queue.
  slow.open();
  await slowTick;
  await settle(60);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5", "restore ran while still off");
});

test("on with a failed reading says so and does not trust the stale number", async () => {
  const world = standardWorld({ percent: 96 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  world.percent = 70;
  world.usageError = "429";
  const on = await cliText(t, ["on"]);
  assert.equal(on.code, 0);
  assert.match(on.text, /Чтение лимита не удалось — данные от/);
  assert.match(on.text, /неделя 96 %/, "the last good reading, labelled as old");
});

test("status --json shows the enforced stage: 0 while off, the real one next to it; who switched is kept", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"], { threadId: "thr_agent0001" });
  const snap = JSON.parse((await t.host.cli(["status", "--json"])).stdout ?? "{}");
  assert.equal(snap.stage, 0);
  assert.equal(snap.realStage, 1);
  assert.equal(snap.enabledBy, "thr_agent0001");
  assert.match((await t.host.cli(["status"])).stdout ?? "", /Выключил: thr_agent0001, \d\d\.\d\d \d\d:\d\d/);
});

test("rpc: setEnabled and restoreModels answers pass the contract's output schema (the fake host validates both ways)", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.rpc("setEnabled", { enabled: false });
  await t.host.rpc("restoreModels");
  await t.host.rpc("setEnabled", { enabled: true });
  await assert.rejects(() => t.host.rpc("setEnabled", { enabled: "yes" }), /invalid_input/);
  await settle(50);
});

test("off while a second off arrives: no extra notification, state stays off", async () => {
  const world = standardWorld({ percent: 94 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.host.cli(["off"]);
  const before = t.notes.length;
  await t.host.cli(["off"]);
  await t.guard.tick(true);
  assert.equal(t.notes.length, before);
});

test("rpc: the card's error is shown only while no later reading succeeded", async () => {
  const world = standardWorld({ percent: 88 });
  const t = setup(world);
  world.usageError = "status=expired";
  await t.guard.tick(true);
  assert.match(String(((await t.host.rpc("status")) as { error: string | null }).error), /status=expired/, "reading fails → the card says so");
  world.usageError = null;
  t.advance(1000);
  await t.guard.tick(true);
  assert.equal(((await t.host.rpc("status")) as { error: string | null }).error, null, "a good reading came after it → no red line");
  assert.match((await t.host.cli(["status"])).stdout ?? "", /Последняя ошибка: \d\d\.\d\d \d\d:\d\d — .*status=expired/, "the CLI keeps the dated line");
});
