// The Codex guard next to the Claude guard (0.2.0): off by default, its own
// switch, thresholds, target, state and consent; the two never touch each
// other's threads. Plan: backlog/plans/2026-11-20-limit-guard-per-provider.md.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KV } from "../server/guard.ts";
import { parseArgs } from "../server/cli.ts";
import { ctx, NEXT_RESETS, row, settle } from "./fake-bb.ts";
import { A, B, CLAUDE_AGENT, CODEX, setup, standardWorld } from "./harness.ts";

const CODEX_AGENT = { id: "codex" };

/** A dispatch of a Codex turn with an effort (fake-bb's ctx() has no effort). */
function codexTurn(model: string, effort: string, extra: { status?: string; queued?: number } = {}) {
  const base = ctx(CODEX, { providerId: "codex", model, ...extra });
  return { ...base, requestedExecution: { providerId: "codex", model, reasoningLevel: effort } };
}

async function run(t: ReturnType<typeof setup>, argv: string[]) {
  const result = await t.host.cli(argv);
  return { code: result.exitCode, text: result.exitCode === 0 ? (result.stdout ?? "") : (result.stderr ?? "") };
}

function updatesOf(t: ReturnType<typeof setup>, threadId: string) {
  return (t.host.callsTo("threads.update") as Array<Record<string, unknown>>).filter((u) => u.threadId === threadId);
}

test("codex is off by default: at 95 % nothing of Codex is touched, status shows both guards", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 95 });
  const t = setup(world);
  await t.guard.tick(true);
  await t.codex.tick(true);
  assert.deepEqual(updatesOf(t, CODEX), []);
  assert.deepEqual(t.host.callsTo("threads.stop"), []);
  assert.deepEqual(await t.host.dispatch(codexTurn("gpt-6.1-sol", "xhigh")), { action: "proceed" });
  assert.equal(t.host.agentsConfig({ thread: { id: CODEX }, provider: CODEX_AGENT }).instructions, undefined);
  const both = await run(t, ["status"]);
  assert.match(both.text, /Сторож лимитов · Claude Code · стадия 0/);
  assert.match(both.text, /Сторож лимитов · Codex · ВЫКЛЮЧЕН \(не вмешивается\) · неделя 95 %/, "an off guard still reads its week");
  assert.match(both.text, /Включить сторожа: bb limit-guard on codex/);
  const json = JSON.parse((await run(t, ["status", "codex", "--json"])).text);
  assert.equal(json.enabled, false);
  assert.equal(json.guard.profile.providerId, "codex");
  assert.equal(JSON.parse((await run(t, ["status", "--json"])).text).guard.profile.providerId, "claude-code", "status --json stays Claude");
  assert.equal(t.notes.length, 0);
});

test("on codex at 90 %: Codex threads keep their model, effort goes to medium; Claude untouched; own kv keys", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 90 });
  const t = setup(world);
  await t.guard.tick(true);
  const on = await run(t, ["on", "codex"]);
  assert.equal(on.code, 0, on.text);
  assert.match(on.text, /Сторож Codex включён: неделя 90 %, стадия 1/);
  assert.deepEqual(updatesOf(t, CODEX), [{ threadId: CODEX, reasoningLevel: "medium" }], "no model in the update: the thread keeps gpt-6.1-sol");
  assert.equal(world.threads.get(CODEX)!.model, "gpt-6.1-sol");
  assert.equal(world.threads.get(CODEX)!.reasoningLevel, "medium");
  assert.deepEqual(updatesOf(t, A), []);
  assert.equal(world.threads.get(A)!.model, "claude-opus-5-5");
  assert.deepEqual(t.host.kv.get(`codex:${KV.saved}`), { [CODEX]: { model: "gpt-6.1-sol", reasoningLevel: "high", effortOnly: true } });
  assert.equal(t.host.kv.get(KV.saved), undefined, "Claude's saved map is not written by the Codex guard");
  assert.equal((t.host.kv.get(`codex:${KV.state}`) as { enabled: boolean }).enabled, true);
  assert.match(t.host.agentsConfig({ thread: { id: CODEX }, provider: CODEX_AGENT }).instructions ?? "", /недельный лимит Codex ≥85 % — запускай треды Codex с --reasoning-level medium$/);
  assert.equal(t.host.agentsConfig({ thread: { id: A }, provider: CLAUDE_AGENT }).instructions, undefined, "Claude agents get no Codex hint");
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-1"]);
  assert.match(t.notes[0]!.note.md, /# Сторож лимитов: неделя ≥85 % — Codex на effort medium/);
  assert.match(t.notes[0]!.note.note, /^Недельный лимит Codex 90 %: треды codex переведены на effort medium\./);
  const status = await run(t, ["status", "codex"]);
  assert.match(status.text, /Сторож лимитов · Codex · стадия 1 \(effort medium\) · неделя 90 %/);
  assert.match(status.text, /Треды: на effort medium переведено 1, прежних моделей сохранено 1/);
});

test("codex stage 1 hook: a higher effort is held and re-queued with the thread's model at medium; lower efforts and Claude pass", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 88 });
  const t = setup(world);
  await run(t, ["on", "codex"]);
  world.threads.get(CODEX)!.status = "active";
  world.queue.push(
    row(CODEX, {
      id: "qm_codex",
      model: "gpt-6.1-terra",
      reasoningLevel: "xhigh",
      waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя Codex ≥85 %: ход придержан" },
    }),
  );
  const held = (await t.host.dispatch(codexTurn("gpt-6.1-terra", "xhigh", { status: "active", queued: 1 }))) as { action: string; reason: string };
  assert.equal(held.action, "wait");
  assert.match(held.reason, /неделя Codex ≥85 %: ход на gpt-6\.1-terra \/ xhigh придержан и переставляется на effort medium\. Нужно как было — Send now/);
  assert.deepEqual(await t.host.dispatch(codexTurn("gpt-6.1-terra", "low")), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(codexTurn("gpt-6.1-terra", "medium")), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(ctx(A)), { action: "proceed" }, "Claude is on stage 0");
  await settle(60);
  const created = t.host.callsTo("queuedMessages.create") as Array<Record<string, unknown>>;
  assert.equal(created.length, 1);
  assert.deepEqual([created[0]!.model, created[0]!.reasoningLevel], ["gpt-6.1-terra", "medium"]);
  assert.deepEqual(world.queue.map((r) => [r.id, r.model, r.reasoningLevel]), [["qm_new1", "gpt-6.1-terra", "medium"]]);
});

test("codex model from the settings: threads move to it; another model is held; a bad id falls back to «keep the model»", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 90 });
  const t = setup(world, { settings: { codexModel: "gpt-6.2-sol", codexEffort: "high", codexCheapPercent: 80, codexStopPercent: 96 } });
  await run(t, ["on", "codex"]);
  assert.deepEqual(updatesOf(t, CODEX), [{ threadId: CODEX, model: "gpt-6.2-sol", reasoningLevel: "high" }]);
  const held = (await t.host.dispatch(codexTurn("gpt-6.1-sol", "low"))) as { action: string; reason: string };
  assert.equal(held.action, "wait", "another model is held even at a low effort");
  assert.match(held.reason, /неделя Codex ≥80 %.*переставляется на gpt-6\.2-sol high/);
  assert.deepEqual(await t.host.dispatch(codexTurn("gpt-6.2-sol", "medium")), { action: "proceed" });
  assert.deepEqual(await t.host.dispatch(codexTurn("gpt-6.2-sol", "xhigh")).then((d) => d.action), "wait");

  const odd = setup(standardWorld({ codexPercent: 90 }), { settings: { codexModel: "rm -rf /", codexEffort: "ultra" } });
  await run(odd, ["on", "codex"]);
  assert.deepEqual(updatesOf(odd, CODEX), [{ threadId: CODEX, reasoningLevel: "medium" }]);
  const status = await run(odd, ["status", "codex"]);
  assert.match(status.text, /Настройки: .*effort Codex «ultra» не годится.*модель Codex «rm -rf \/» не похожа на id модели/);
});

test("codex stage 2: only Codex threads stop and wait; consent is per guard", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 95 });
  world.running = new Set([CODEX, A]);
  world.threads.get(CODEX)!.status = "active";
  world.threads.get(A)!.status = "active";
  const t = setup(world);
  await t.guard.tick(true);
  await run(t, ["on", "codex"]);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [CODEX]);
  const waiting = (await t.host.dispatch(codexTurn("gpt-6.1-sol", "medium"))) as { action: string; reason: string };
  assert.equal(waiting.action, "wait");
  assert.match(waiting.reason, /неделя Codex ≥93 %: ждёт вашего согласия \(bb limit-guard resume codex\)/);
  assert.deepEqual(await t.host.dispatch(ctx(B)), { action: "proceed" }, "Claude turns go");
  const claudeResume = await run(t, ["resume"]);
  assert.equal(claudeResume.code, 1, "Claude is on stage 0 — nothing to consent to");
  const resume = await run(t, ["resume", "codex"]);
  assert.equal(resume.code, 0, resume.text);
  assert.match(resume.text, /Придержанные ходы codex запускаются по очереди/);
  assert.equal(JSON.parse((await run(t, ["status", "codex", "--json"])).text).consent, true);
  assert.equal(JSON.parse((await run(t, ["status", "--json"])).text).consent, false);
  assert.deepEqual(t.notes.map((n) => n.kind), ["enter-2", "consent"]);
  assert.match(t.notes[0]!.note.md, /Codex остановлен[\s\S]*Claude Code и Pi не затронуты/);
});

test("codex weekly reset gives Codex models back; off codex leaves Claude on", async () => {
  const world = standardWorld({ percent: 86, codexPercent: 90 });
  const t = setup(world);
  await t.guard.tick(true);
  await run(t, ["on", "codex"]);
  assert.equal(world.threads.get(CODEX)!.reasoningLevel, "medium");
  world.threads.get(CODEX)!.model = "gpt-6.2-sol"; // the user picks another model mid-week
  world.codexPercent = 4;
  world.codexResetsAt = NEXT_RESETS;
  t.advance(90_000);
  await t.codex.tick(true);
  assert.equal(world.threads.get(CODEX)!.reasoningLevel, "high");
  assert.equal(world.threads.get(CODEX)!.model, "gpt-6.2-sol", "keep-model mode gives back the effort only — the user's model choice stays");
  assert.deepEqual(t.host.kv.get(`codex:${KV.saved}`), {});
  assert.equal(world.threads.get(A)!.model, "claude-sonnet-5-5", "Claude stays on its stage 1");

  const off = await run(t, ["off", "codex"]);
  assert.match(off.text, /^Сторож Codex выключен/);
  assert.equal(JSON.parse((await run(t, ["status", "--json"])).text).enabled, true);
  assert.equal(JSON.parse((await run(t, ["status", "codex", "--json"])).text).enabled, false);
});

test("rpc: status and switch per provider; without provider — Claude", async () => {
  const world = standardWorld({ percent: 50, codexPercent: 30 });
  const t = setup(world);
  await t.guard.tick(true);
  const claude = (await t.host.rpc("status")) as Record<string, unknown>;
  assert.deepEqual([claude.provider, claude.name, claude.target, claude.targetShort, claude.enabled], ["claude", "Claude Code", "Sonnet xhigh", "Sonnet", true]);
  const codex = (await t.host.rpc("status", { provider: "codex" })) as Record<string, unknown>;
  assert.deepEqual([codex.provider, codex.name, codex.title, codex.target, codex.enabled], ["codex", "Codex", "Codex", "effort medium", false]);
  const switched = (await t.host.rpc("setEnabled", { enabled: true, provider: "codex" })) as { ok: boolean; text: string };
  assert.equal(switched.ok, true);
  assert.equal(((await t.host.rpc("status", { provider: "codex" })) as { enabled: boolean }).enabled, true);
  assert.equal(((await t.host.rpc("status", { provider: "codex" })) as { percent: number }).percent, 30);
  assert.equal(((await t.host.rpc("restoreModels", { provider: "codex" })) as { text: string }).text, "Возвращать нечего: прежних моделей не сохранено.");
});

test("codex not installed: the off guard says so in words, without warnings in the log", async () => {
  const world = standardWorld({ codexStatus: "not_installed" });
  const t = setup(world);
  await t.codex.tick(true);
  const codex = (await t.host.rpc("status", { provider: "codex" })) as { error: string | null };
  assert.match(String(codex.error), /usageLimits codex: провайдер не установлен в bb · status=not_installed/);
  assert.equal(t.host.logs.filter((l) => l.level === "warn" && l.message.includes("codex")).length, 0);
});

test("parseArgs: the provider word after the verb", () => {
  assert.deepEqual(parseArgs(["on", "codex"]), { kind: "on", guard: "codex" });
  assert.deepEqual(parseArgs(["off", "claude"]), { kind: "off", guard: "claude" });
  assert.deepEqual(parseArgs(["status", "codex", "--json"]), { kind: "status", json: true, guard: "codex" });
  assert.deepEqual(parseArgs(["resume", "codex"]), { kind: "resume", guard: "codex" });
  assert.deepEqual(parseArgs(["restore-models", "codex"]), { kind: "restore-models", guard: "codex" });
  assert.deepEqual(parseArgs(["test", "codex", "--off"]), { kind: "test-off", guard: "codex" });
  assert.deepEqual(parseArgs(["test", "codex", "--threads", "thr_codex000", "--percent", "90"]), {
    kind: "test-on",
    threads: ["thr_codex000"],
    percent: 90,
    guard: "codex",
  });
  assert.deepEqual(parseArgs(["test", "--off", "codex"]), { kind: "test-off", guard: "codex" }, "the word after an option counts too");
  assert.deepEqual(parseArgs(["status", "--json", "codex"]), { kind: "status", json: true, guard: "codex" });
  assert.deepEqual(parseArgs(["test", "--threads", "thr_codex000", "codex", "--percent", "90"]).kind, "test-on");
  assert.equal(parseArgs(["off", "codex", "claude"]).kind, "error", "one provider per command");
  assert.equal(parseArgs(["off", "now"]).kind, "error", "a loose word is not ignored");
  assert.equal(parseArgs(["off", "grok"]).kind, "error");
  assert.deepEqual(parseArgs(["off", "gemini"]), { kind: "off", guard: "gemini" }, "gemini is the budget guard since 0.3.0");
  assert.equal(parseArgs(["codex", "off"]).kind, "error", "the verb comes first — deny rules match `bb limit-guard off*`");
});

test("codex model not in the catalog: threads keep their models, the reason is in status", async () => {
  const world = standardWorld({ codexPercent: 90 });
  const t = setup(world, { settings: { codexModel: "gpt-typo" } });
  await run(t, ["on", "codex"]);
  assert.deepEqual(updatesOf(t, CODEX), [{ threadId: CODEX, reasoningLevel: "medium" }], "no update to a model the catalog does not have");
  assert.match((await run(t, ["status", "codex"])).text, /модели «gpt-typo» нет в каталоге Codex — треды остаются на своих моделях/);
  assert.equal((await t.host.dispatch(codexTurn("gpt-6.1-sol", "low"))).action, "proceed", "turns on other models are not held");
});

test("codex target changed mid-stage: threads are checked again under the new target", async () => {
  const world = standardWorld({ codexPercent: 90 });
  const t = setup(world);
  await run(t, ["on", "codex"]);
  assert.equal(world.threads.get(CODEX)!.reasoningLevel, "medium");
  await t.host.changeSettings({ codexEffort: "low" });
  await settle(30);
  assert.equal(world.threads.get(CODEX)!.reasoningLevel, "low");
});

test("re-queue: a send that fails on the target puts the message back as it was, not lost", async () => {
  const world = standardWorld({ codexPercent: 90 });
  const t = setup(world);
  await run(t, ["on", "codex"]);
  world.queue.push(
    row(CODEX, {
      id: "qm_x1",
      model: "gpt-6.1-terra",
      reasoningLevel: "xhigh",
      waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя Codex ≥85 %: ход придержан" },
    }),
  );
  const sdk = t.host.bb.sdk as unknown as { threads: { send: () => Promise<never>; queuedMessages: { create: (a: Record<string, unknown>) => Promise<unknown> } } };
  sdk.threads.send = async () => {
    throw new Error("HTTP 400: model rejected");
  };
  const create = sdk.threads.queuedMessages.create.bind(sdk.threads.queuedMessages);
  sdk.threads.queuedMessages.create = async (a) => {
    if (a.reasoningLevel === "medium") throw new Error("HTTP 400: model rejected");
    return create(a);
  };
  await t.host.dispatch(codexTurn("gpt-6.1-terra", "xhigh", { queued: 1 }));
  await settle(60);
  assert.deepEqual(world.queue.map((r) => [r.model, r.reasoningLevel, r.content]), [["gpt-6.1-terra", "xhigh", [{ type: "text", text: "продолжай", mentions: [] }]]]);
});
