// The Yandex and Cloud.ru budgets next to Gemini (0.3.0, plan Ф6): rubles with the sign,
// each budget counts and holds only its own provider, the shared counter, outside
// figures (the Yandex balance, Google's month spend) and the card words in rubles.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BUDGET_PROFILES, isBudgetHoldReason, shortModel, weekStart } from "../lib/budget.ts";
import { budgetFactRows, budgetHeadline, budgetRows, budgetWeekLine, modelName } from "../lib/card.ts";
import { ctx, settle, T0, thread } from "./fake-bb.ts";
import { setup, standardWorld } from "./harness.ts";

const YA = "thr_piyand00";
const GLM = "thr_picloud0";
const VTX = "thr_pivtx001";
const YA_MODEL = "yandex/gpt://b1gtestfolder/deepseek-v4.1-flash/latest";
const GLM_MODEL = "cloudru/zai-org/GLM-5.2";
const NEON = "google-vertex/gemini-4-neon";
const NBSP = " ";

function line(provider: string, model: string, cost: number, at: number): string {
  return `${JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", provider, model, usage: { input: 1000, cost: { total: cost } }, timestamp: at } })}\n`;
}
const modelChange = (provider: string, modelId: string, at: number) => `${JSON.stringify({ type: "model_change", timestamp: new Date(at).toISOString(), provider, modelId })}\n`;
const compaction = (cost: number, at: number) => `${JSON.stringify({ type: "compaction", timestamp: new Date(at).toISOString(), usage: { cost: { total: cost } } })}\n`;

async function piDir(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lg-bud-"));
  const file = join(dir, "pi_a.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(T0).toISOString() })}\n`);
  return { dir, file };
}

function world() {
  const w = standardWorld();
  w.threads.set(YA, thread(YA, { providerId: "pi", model: YA_MODEL, reasoningLevel: "high" }));
  w.threads.set(GLM, thread(GLM, { providerId: "pi", model: GLM_MODEL, reasoningLevel: "high" }));
  w.threads.set(VTX, thread(VTX, { providerId: "pi", model: NEON, reasoningLevel: "high" }));
  return w;
}

const piTurn = (threadId: string, model: string) => ctx(threadId, { providerId: "pi", model });

test("shortModel: no folder id and no org on screen", () => {
  assert.equal(shortModel("gpt://b1gtestfolder/deepseek-v4.1-flash/latest"), "deepseek-v4.1-flash");
  assert.equal(shortModel("zai-org/GLM-5.2"), "GLM-5.2");
  assert.equal(shortModel("gemini-4-neon"), "gemini-4-neon");
});

test("Yandex counts only its own provider, in rubles; the folder id never reaches the status", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, modelChange("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", T0 - 3_600_000));
  await appendFile(file, line("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", 157.66, T0 - 3_000_000));
  await appendFile(file, line("google-vertex", "gemini-4-neon", 2, T0 - 2_000_000));
  await appendFile(file, line("cloudru", "zai-org/GLM-5.2", 34, T0 - 1_000_000));
  const t = setup(world(), { piDirs: [dir] });
  await Promise.all([t.gemini.tick(), t.yandex.tick(), t.cloudru.tick()]);
  assert.equal(t.yandex.snapshot().spent, 157.66);
  assert.equal(t.gemini.snapshot().spent, 2);
  assert.equal(t.cloudru.snapshot().spent, 34);
  const text = (await t.host.cli(["status", "yandex"])).stdout ?? "";
  assert.match(text, /Сторож лимитов · Яндекс · стадия 0 \(считает\)/);
  assert.match(text, new RegExp(`Неделя: 157,66${NBSP}₽ из 1${NBSP}000${NBSP}₽ \\(15,8 %\\)`));
  assert.match(text, /По моделям: deepseek-v4\.1-flash 157,66/);
  assert.doesNotMatch(text, /b1gtestfolder/);
  assert.match(text, /limit yandex <рубли> \(сейчас 1.000.₽\)/);
});

test("Yandex stop at 100 %: only yandex/* waits and is stopped; Gemini, Cloud.ru and Claude run; the reason names the ruble amounts", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, modelChange("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", T0 - 3_600_000));
  await appendFile(file, line("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", 1002, T0 - 3_000_000));
  const w = world();
  w.running = new Set([YA, GLM, VTX]);
  const t = setup(w, { piDirs: [dir] });
  await t.yandex.tick();
  await t.gemini.tick();
  await t.cloudru.tick();
  assert.equal(t.yandex.snapshot().stage, 2);
  assert.deepEqual(t.notes.map((n) => n.kind), ["yandex-stop"]);
  assert.match(t.notes[0]!.note.note, new RegExp(`^Яндекс в bb: недельный лимит 1${NBSP}000${NBSP}₽ исчерпан \\(1${NBSP}002,00${NBSP}₽\\)\\. Ходы Яндекса ждут согласия: bb limit-guard resume yandex`));
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [YA]);
  const held = await t.host.dispatch(piTurn(YA, YA_MODEL));
  assert.equal(held.action, "wait");
  assert.match(held.reason ?? "", new RegExp(`Яндекс 1${NBSP}002,00${NBSP}₽ из 1${NBSP}000${NBSP}₽ за неделю: ждёт вашего согласия \\(bb limit-guard resume yandex\\)`));
  assert.ok(isBudgetHoldReason(held.reason ?? "", BUDGET_PROFILES.yandex));
  assert.ok(!isBudgetHoldReason(held.reason ?? "", BUDGET_PROFILES.cloudru), "another budget's hold is not this one's");
  assert.equal((await t.host.dispatch(piTurn(GLM, GLM_MODEL))).action, "proceed");
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "proceed");
  assert.equal((await t.host.dispatch(ctx("thr_aaaaaaaa"))).action, "proceed");
  // Consent is per budget.
  const resumed = await t.host.cli(["resume", "yandex"], { threadId: "thr_owner000" });
  assert.match(resumed.stdout ?? "", /Согласие принято до сброса недели: придержанные ходы Яндекса уходят/);
  assert.equal((await t.host.dispatch(piTurn(YA, YA_MODEL))).action, "proceed");
  assert.equal((await t.host.cli(["resume", "cloudru"])).exitCode, 1, "Cloud.ru is on stage 0: nothing to consent to");
});

test("Cloud.ru: GLM spend, its own stop word; limits are per budget and per currency", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, line("cloudru", "zai-org/GLM-5.2", 900, T0 - 1_000_000));
  const t = setup(world(), { piDirs: [dir] });
  await t.cloudru.tick();
  assert.equal(t.cloudru.snapshot().stage, 1, "90 % of 1 000 ₽ — warning");
  assert.equal(t.cloudru.snapshot().byModel[0]!.model, "GLM-5.2");
  assert.equal(t.yandex.snapshot().stage, 0);
  assert.match(t.notes[0]!.note.note, /^Cloud\.ru в bb: потрачено 900,00.₽ из 1.000.₽ \(90 %\)/);
  // Limits: rubles for Yandex/Cloud.ru, dollars for Gemini, each within its own bounds.
  assert.equal((await t.host.cli(["limit", "cloudru", "500"])).exitCode, 0);
  await settle(10);
  assert.equal(t.cloudru.snapshot().limit, 500);
  assert.equal(t.cloudru.snapshot().stage, 2, "900 ₽ of 500 ₽ — stop");
  assert.equal((await t.host.cli(["limit", "yandex", "250000"])).exitCode, 0, "250 000 ₽ is fine for rubles");
  assert.equal((await t.host.cli(["limit", "gemini", "250000"])).exitCode, 1, "250 000 $ is not");
  assert.equal((await t.host.cli(["limit", "yandex", "0"])).exitCode, 1);
  assert.equal(t.yandex.snapshot().limit, 250000);
  assert.equal(t.gemini.snapshot().limit, 50, "the Gemini limit did not move");
});

test("a Yandex compaction is billed to Yandex (the session's model), never alarms and never lands on Gemini", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, modelChange("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", T0 - 3_600_000));
  await appendFile(file, line("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", 10, T0 - 3_500_000));
  await appendFile(file, compaction(9, T0 - 3_400_000));
  const t = setup(world(), { piDirs: [dir] });
  await Promise.all([t.gemini.tick(), t.yandex.tick()]);
  assert.equal(t.yandex.snapshot().spent, 19);
  assert.equal(t.yandex.snapshot().lastError, null);
  assert.equal(t.gemini.snapshot().spent, 0, "Gemini has no answers this week: zero, not an error — the sessions are readable");
  assert.equal(t.gemini.snapshot().lastError, null);
});

test("plain status shows all five guards in order; the RPC gives the three budgets with their currencies", async () => {
  const { dir } = await piDir();
  const t = setup(world(), { piDirs: [dir] });
  await Promise.all([t.gemini.tick(), t.yandex.tick(), t.cloudru.tick()]);
  const all = (await t.host.cli(["status"])).stdout ?? "";
  const order = ["Claude Code", "Codex", "Gemini · Vertex", "Яндекс", "Cloud.ru (GLM)"].map((n) => all.indexOf(`Сторож лимитов · ${n}`));
  assert.ok(order.every((i) => i >= 0), `all five blocks: ${order.join(",")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the documented order");
  const cards = (await t.host.rpc("budgets")) as Array<{ key: string; currency: string; limit: number; title: string }>;
  assert.deepEqual(cards.map((c) => [c.key, c.currency, c.limit]), [["gemini", "USD", 50], ["yandex", "RUB", 1000], ["cloudru", "RUB", 1000]]);
  const off = (await t.host.rpc("budgetSetEnabled", { key: "yandex", enabled: false })) as { ok: boolean };
  assert.ok(off.ok);
  assert.equal(t.yandex.snapshot().enabled, false);
  assert.equal(t.gemini.snapshot().enabled, true);
  assert.equal((await t.host.cli(["off", "grok"])).exitCode, 1);
});

test("outside figures: a good read shows with its age, a failure says so (never a zero), an unconfigured one hides on the card", async () => {
  const { dir } = await piDir();
  let balance: string | null = "1 234,50 ₽";
  let fail = false;
  const t = setup(world(), {
    piDirs: [dir],
    facts: {
      yandex: [
        {
          label: "Баланс счёта Яндекса",
          read: async () => {
            if (fail) throw new Error("401 ключ сервисного аккаунта отклонён");
            return balance;
          },
        },
      ],
    },
  });
  await t.yandex.tick();
  await settle(20);
  let facts = t.yandex.snapshot().facts;
  assert.deepEqual(facts, [{ label: "Баланс счёта Яндекса", value: "1 234,50 ₽ · 0 с назад", kind: "ok" }]);
  assert.match((await t.host.cli(["status", "yandex"])).stdout ?? "", /Баланс счёта Яндекса: 1 234,50 ₽ · 0 с назад/);
  // 31 minutes later it is read again — and fails: the card says «недоступно», not the old number as if it were fresh.
  t.advance(31 * 60_000);
  fail = true;
  await t.yandex.tick();
  await settle(20);
  facts = t.yandex.snapshot().facts;
  assert.equal(facts[0]!.kind, "error");
  assert.match(facts[0]!.value, /^недоступно: 401 ключ сервисного аккаунта отклонён/);
  // Not configured: null — hidden on the card, spoken in `status`.
  t.advance(31 * 60_000);
  fail = false;
  balance = null;
  await t.yandex.tick();
  await settle(20);
  facts = t.yandex.snapshot().facts;
  assert.deepEqual(facts, [{ label: "Баланс счёта Яндекса", value: "не настроено", kind: "off" }]);
  const card = ((await t.host.rpc("budgets")) as Array<Parameters<typeof budgetFactRows>[0]>).find((c) => c.key === "yandex")!;
  assert.deepEqual(budgetFactRows(card), []);
  // Facts are per budget: Gemini has none.
  assert.deepEqual(t.gemini.snapshot().facts, []);
});

test("card words in rubles: the week with the sign, rows with brand names, headline per stage", () => {
  const card = {
    key: "yandex" as const,
    title: "Яндекс",
    word: "Яндекс",
    turns: "ходы Яндекса",
    currency: "RUB" as const,
    enabled: true,
    stage: 0 as const,
    realStage: 0 as const,
    consent: false,
    limit: 1000,
    warnPercent: 80,
    spent: 157.66,
    today: 12.5,
    percent: 15.8,
    byModel: [{ model: "deepseek-v4.1-flash", cost: 157.66 }],
    resetsAt: "2026-11-22T21:00:00.000Z",
    lastScanAt: T0,
    stopped: 0,
    testActive: false,
    error: null,
    facts: [
      { label: "Баланс счёта Яндекса", value: "1 234,50 ₽ · 3 мин назад", kind: "ok" as const },
      { label: "Другое", value: "не настроено", kind: "off" as const },
    ],
  };
  assert.equal(budgetWeekLine(card), `Неделя 157,66${NBSP}₽ из 1${NBSP}000${NBSP}₽ · 15,8 % · сброс пн 23.11 00:00`);
  assert.equal(budgetHeadline(card).title, `Всё в норме · осталось 842,34${NBSP}₽`);
  assert.equal(budgetHeadline({ ...card, stage: 2, spent: 1002 }).tone, "stop");
  assert.match(budgetHeadline({ ...card, stage: 2, spent: 1002 }).hint, /^Новые ходы Яндекса ждут, идущие остановлены\..*resume yandex/);
  assert.match(budgetHeadline({ ...card, stage: 1 }).hint, new RegExp(`^Пройдено 80 %\\. На 1${NBSP}000${NBSP}₽ ходы Яндекса встанут до вашего «да»\\.$`));
  assert.match(budgetHeadline({ ...card, testActive: true, stage: 2, spent: 1002 }).hint, /^Ходы Яндекса в тестовом охвате ждут согласия\./);
  assert.deepEqual(budgetRows({ ...card, spent: 0, today: 0, byModel: [] }), [], "nothing to list before the first answer");
  assert.deepEqual(budgetRows(card), [
    { label: "Сегодня", value: `12,50${NBSP}₽` },
    { label: "DeepSeek V4.1 Flash", value: `157,66${NBSP}₽` },
  ]);
  assert.deepEqual(budgetFactRows(card), [{ label: "Баланс счёта Яндекса", value: "1 234,50 ₽ · 3 мин назад", error: false }]);
  assert.equal(modelName("zai-org-glm"), "Zai Org GLM");
  assert.equal(modelName("GLM-5.2"), "GLM-5.2");
  assert.equal(modelName("gemini-4-neon"), "Gemini 4 Neon");
});

test("week start is shared by all budgets: Monday 00:00 MSK", () => {
  assert.equal(weekStart(Date.parse("2026-11-21T12:00:00+03:00")), Date.parse("2026-11-16T00:00:00+03:00"));
});

test("a compaction adds money but is not an answer; the first read of an outside figure shows nothing yet; a vanished file does not break the scan", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, modelChange("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", T0 - 3_600_000));
  await appendFile(file, line("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", 10, T0 - 3_500_000));
  await appendFile(file, compaction(9, T0 - 3_400_000));
  let release: (value: string | null) => void = () => undefined;
  const t = setup(world(), {
    piDirs: [dir],
    facts: { yandex: [{ label: "Баланс счёта Яндекса", read: () => new Promise<string | null>((resolve) => (release = resolve)) }] },
  });
  await t.yandex.tick();
  await settle(20);
  const s = t.yandex.snapshot();
  assert.equal(s.spent, 19);
  assert.equal(s.answers, 1, "one answer and one compaction: one answer");
  assert.deepEqual(s.facts, [], "the first read is still running — no «не настроено» yet");
  release("1 234,50 ₽");
  await settle(20);
  assert.equal(t.yandex.snapshot().facts[0]?.kind, "ok");
  // A second file listed but gone before it is opened: the other file is still counted.
  await writeFile(join(dir, "pi_ghost.jsonl"), "");
  const { symlink } = await import("node:fs/promises");
  await symlink(join(dir, "nowhere.jsonl"), join(dir, "pi_dangling.jsonl")).catch(() => undefined);
  await appendFile(file, line("yandex", "gpt://b1gtestfolder/deepseek-v4.1-flash/latest", 1, T0 - 3_300_000));
  await t.yandex.tick();
  assert.equal(t.yandex.snapshot().spent, 20);
  assert.equal(t.yandex.snapshot().lastError, null);
});
