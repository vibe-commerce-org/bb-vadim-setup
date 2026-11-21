// The Gemini budget guard (0.3.0): the counter over Pi's session files, the
// calendar week in Moscow time, the stages (80 % warning, 100 % stop), the hook
// holding only Pi turns on google-vertex/*, consent, the weekly reset, the
// switch, the limit command, the test mode and the card's RPC.
// Plan: backlog/plans/2026-11-21-gemini-vertex-budget.md, contract C1–C8.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUDGET_PROFILES,
  budgetPercent,
  dayStart,
  decideBudget,
  formatMsk,
  isBudgetHoldReason,
  limitMoney,
  money,
  resolveBudget,
  weekResetsAt,
  weekStart,
} from "../lib/budget.ts";
import { parseLine, totalsFor } from "../lib/ledger.ts";
import { STOP_MARK } from "../lib/policy.ts";
import { ctx, settle, T0, thread } from "./fake-bb.ts";
import { A, PI, setup, standardWorld } from "./harness.ts";

const G = BUDGET_PROFILES.gemini;
const VTX = "thr_pivtx000";
const VTX2 = "thr_pivtx002";
const NEON = "google-vertex/gemini-4-neon";
const DAY = 24 * 3_600_000;

function answer(provider: string, model: string, cost: number, at: number): string {
  return `${JSON.stringify({
    type: "message",
    id: Math.random().toString(16).slice(2, 10),
    parentId: null,
    timestamp: new Date(at).toISOString(),
    message: { role: "assistant", provider, model, usage: { input: 1000, output: 10, cost: { total: cost } }, timestamp: at },
  })}\n`;
}

function world() {
  const w = standardWorld();
  w.threads.set(VTX, thread(VTX, { providerId: "pi", model: NEON, reasoningLevel: "high" }));
  w.threads.set(VTX2, thread(VTX2, { providerId: "pi", model: NEON, reasoningLevel: "high" }));
  return w;
}

async function piDir(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lg-pi-"));
  const file = join(dir, "pi_test.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date(T0).toISOString(), cwd: "/tmp" })}\n`);
  return { dir, file };
}

const piTurn = (threadId: string, model: string | null) => ctx(threadId, { providerId: "pi", model });

/** One budget's card data through the `budgets` RPC, as the card reads it. */
async function budgetCard(host: ReturnType<typeof setup>["host"], key: string): Promise<unknown> {
  const all = (await host.rpc("budgets")) as Array<{ key: string }>;
  const one = all.find((b) => b.key === key);
  if (one === undefined) throw new Error(`no budget ${key} in the RPC answer`);
  return one;
}

test("week: Monday 00:00 Moscow time, reset next Monday, today from 00:00 MSK", () => {
  const sat = Date.parse("2026-11-21T12:00:00+03:00");
  assert.equal(weekStart(sat), Date.parse("2026-11-16T00:00:00+03:00"));
  assert.equal(weekResetsAt(sat), "2026-11-22T21:00:00.000Z", "Monday 23.11 00:00 MSK");
  assert.equal(dayStart(sat), Date.parse("2026-11-21T00:00:00+03:00"));
  const monday = Date.parse("2026-11-23T00:00:00+03:00");
  assert.equal(weekStart(monday), monday, "the reset moment starts the new week");
  assert.equal(weekStart(monday - 1), Date.parse("2026-11-16T00:00:00+03:00"));
  assert.equal(formatMsk(monday), "пн 23.11 00:00");
});

test("ledger: answers with a cost are counted by provider, the rest is not", () => {
  const at = Date.parse("2026-11-21T09:00:00+03:00");
  const line = answer("google-vertex", "gemini-4-neon", 0.13, at);
  assert.deepEqual(parseLine(line), { kind: "cost", entry: { at, provider: "google-vertex", model: "gemini-4-neon", cost: 0.13 } });
  assert.equal(parseLine('{"type":"message","message":{"role":"user","content":"hi"}}').kind, "other");
  assert.equal(parseLine('{"type":"message","message":{"role":"assistant","provider":"google-vertex","model":"x"}}').kind, "suspect");
  assert.equal(parseLine("{broken").kind, "other");
  const entries = [
    { at, provider: "google-vertex", model: "gemini-4-neon", cost: 2 },
    { at: at - 3 * DAY, provider: "google-vertex", model: "gemini-3.8-flash", cost: 1 },
    { at, provider: "yandex", model: "deepseek", cost: 100 },
    { at: weekStart(at) - 1, provider: "google-vertex", model: "gemini-4-neon", cost: 50 },
  ];
  const t = totalsFor(entries, { from: weekStart(at), dayFrom: dayStart(at), providers: ["google-vertex"] });
  assert.equal(t.spent, 3);
  assert.equal(t.today, 2);
  assert.deepEqual(t.byModel, { "gemini-4-neon": 2, "gemini-3.8-flash": 1 });
});

test("words: dollars with a decimal comma, settings fall back on nonsense", () => {
  assert.equal(money(31.4), "$31,40");
  assert.equal(money(1234.5), "$1\u00a0234,50");
  assert.equal(money(157.66, "RUB"), "157,66\u00a0₽");
  assert.equal(money(1002, "RUB"), "1\u00a0002,00\u00a0₽");
  assert.equal(limitMoney(1000, "RUB"), "1\u00a0000\u00a0₽");
  assert.equal(limitMoney(50), "$50");
  assert.equal(budgetPercent(43.1, 50), 86.2);
  assert.deepEqual(resolveBudget({}, G), { limit: 50, warnPercent: 80, problem: null });
  assert.deepEqual(resolveBudget({}, BUDGET_PROFILES.yandex), { limit: 1000, warnPercent: 80, problem: null });
  const odd = resolveBudget({ geminiWeeklyUsd: -5, geminiWarnPercent: 120 }, G);
  assert.equal(odd.limit, 50);
  assert.equal(odd.warnPercent, 80);
  assert.match(odd.problem ?? "", /лимит Gemini «-5» не годится/);
});

test("hook decision: only a new Pi turn on google-vertex/* waits, only on stage 2 without consent", () => {
  const stop = { enabled: true, stage: 2 as const, consent: false, scope: null, spent: 51, limit: 50 };
  const f = (model: string | null, extra: Partial<{ providerId: string; attempt: string; threadId: string }> = {}) => ({
    threadId: VTX,
    providerId: "pi",
    model,
    attempt: "start-turn",
    ...extra,
  });
  const held = decideBudget(f(NEON), stop, G);
  assert.equal(held.action, "wait");
  assert.ok(held.action === "wait" && held.reason.includes(STOP_MARK) && isBudgetHoldReason(held.reason, G) && !isBudgetHoldReason(held.reason, BUDGET_PROFILES.yandex));
  assert.match(held.action === "wait" ? held.reason : "", /^Сторож лимитов · Gemini \$51,00 из \$50 за неделю/);
  assert.equal(decideBudget(f("yandex/deepseek"), stop, G).action, "proceed", "other Pi models run");
  assert.equal(decideBudget(f(NEON, { providerId: "claude-code" }), stop, G).action, "proceed");
  assert.equal(decideBudget(f(NEON, { attempt: "join-turn" }), stop, G).action, "proceed", "a join into a running turn is not a new turn");
  assert.equal(decideBudget(f(null), stop, G, NEON).action, "wait", "a missing model falls back to the thread's known one");
  assert.equal(decideBudget(f(null), stop, G).action, "proceed", "unknown model — fail-open");
  assert.equal(decideBudget(f(NEON), { ...stop, consent: true }, G).action, "proceed");
  assert.equal(decideBudget(f(NEON), { ...stop, stage: 1 }, G).action, "proceed", "the warning stage holds nothing");
  assert.equal(decideBudget(f(NEON), { ...stop, enabled: false }, G).action, "proceed");
  assert.equal(decideBudget(f(NEON, { threadId: VTX2 }), { ...stop, scope: new Set([VTX]) }, G).action, "proceed", "test scope");
});

test("C1–C5: counts Pi's Vertex spend, warns at 80 %, stops at 100 % (Vertex only), consent, weekly reset", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 10, T0 - 3_600_000));
  await appendFile(file, answer("yandex", "gpt://f/deepseek/latest", 100, T0 - 3_600_000));
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 30, weekStart(T0) - 60_000)); // last week
  const w = world();
  const t = setup(w, { piDirs: [dir] });
  await t.gemini.tick();
  let s = t.gemini.snapshot();
  assert.equal(s.spent, 10, "this week's Vertex answers only");
  assert.equal(s.percent, 20);
  assert.equal(s.stage, 0);
  assert.equal(t.notes.length, 0);

  // C1: an appended answer is counted by the next scan (incremental read).
  await appendFile(file, answer("google-vertex", "gemini-3.8-flash", 31, T0));
  await t.gemini.tick();
  s = t.gemini.snapshot();
  assert.equal(s.spent, 41);
  assert.deepEqual(s.byModel, [
    { model: "gemini-4-neon", cost: 10 },
    { model: "gemini-3.8-flash", cost: 31 },
  ].sort((a, b) => b.cost - a.cost));
  assert.equal(s.stage, 1, "82 % — warning");
  assert.deepEqual(t.notes.map((n) => n.kind), ["gemini-warn"]);
  assert.match(t.notes[0]!.note.note, /Gemini в bb: потрачено \$41,00 из \$50 \(82 %\)/);
  assert.equal(await t.host.dispatch(piTurn(VTX, NEON)).then((d) => d.action), "proceed", "the warning holds nothing");

  // C4: 100 % — only Pi on Vertex waits and is stopped.
  w.running = new Set([VTX, PI, A]);
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 10, T0));
  await t.gemini.tick();
  s = t.gemini.snapshot();
  assert.equal(s.stage, 2);
  assert.deepEqual(t.notes.map((n) => n.kind), ["gemini-warn", "gemini-stop"]);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [VTX]);
  assert.deepEqual(s.stoppedThreads, [VTX]);
  const held = await t.host.dispatch(piTurn(VTX, NEON));
  assert.equal(held.action, "wait");
  assert.match(held.reason ?? "", /Gemini \$51,00 из \$50 за неделю: ждёт вашего согласия \(bb limit-guard resume gemini\)/);
  assert.equal((await t.host.dispatch(piTurn(PI, "yandex/deepseek"))).action, "proceed", "Pi on Yandex runs");
  assert.equal((await t.host.dispatch(ctx(A))).action, "proceed", "Claude is its own guard's business (50 %)");
  const status = (await t.host.cli(["status", "gemini"])).stdout ?? "";
  assert.match(status, /Сторож лимитов · Gemini · Vertex · стадия 2 \(стоп до согласия\)/);
  assert.match(status, /Неделя: \$51,00 из \$50 \(102 %\)/);
  assert.match(status, /resume gemini \(только вы\)/);
  const all = (await t.host.cli(["status"])).stdout ?? "";
  assert.match(all, /Claude Code[\s\S]*Codex[\s\S]*Gemini · Vertex/, "plain status shows all three guards");

  // Consent until the reset: the held turns go (recheck), no stop again this week.
  const before = t.host.recheckCount;
  const resumed = await t.host.cli(["resume", "gemini"], { threadId: "thr_owner000" });
  assert.equal(resumed.exitCode, 0);
  assert.match(resumed.stdout ?? "", /Согласие принято до сброса недели/);
  assert.match(resumed.stdout ?? "", new RegExp(`напиши в них: ${VTX}`));
  assert.ok(t.host.recheckCount > before, "held rows are re-attempted");
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "proceed");
  await settle(10);
  assert.deepEqual(t.notes.map((n) => n.kind), ["gemini-warn", "gemini-stop", "gemini-consent"]);
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 5, T0 + 60_000));
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().stage, 1, "consent keeps the stop away");

  // C5: next Monday 00:00 MSK — stage 0, consent gone.
  t.advance(weekStart(T0) + 7 * DAY - T0 + 60_000);
  await t.gemini.tick();
  s = t.gemini.snapshot();
  assert.equal(s.spent, 0);
  assert.equal(s.stage, 0);
  assert.equal(s.consent, false);
  assert.deepEqual(s.stoppedThreads, []);
});

test("C6: no Pi folders, or answers without a cost — an error, not $0, and nothing is held", async () => {
  const t = setup(world(), { piDirs: ["/nonexistent/lg-pi"] });
  await t.gemini.tick();
  let s = t.gemini.snapshot();
  assert.equal(s.spent, null);
  assert.match(s.lastError?.message ?? "", /счётчик не видит файлы Pi/);
  const card = await budgetCard(t.host, "gemini") as { spent: number | null; error: string | null };
  assert.equal(card.spent, null);
  assert.match(card.error ?? "", /не видит файлы Pi/);
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "proceed");

  const { dir, file } = await piDir();
  await appendFile(file, '{"type":"message","message":{"role":"assistant","provider":"google-vertex","model":"gemini-4-neon","usage":{"input":5}}}\n');
  const t2 = setup(world(), { piDirs: [dir] });
  await t2.gemini.tick();
  s = t2.gemini.snapshot();
  assert.equal(s.spent, null);
  assert.match(s.lastError?.message ?? "", /формат Pi сменился\? ответ модели без usage\.cost/);
});

test("C2: `limit gemini 30` changes the limit at once; the percent follows; bad amounts are refused", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 12, T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().percent, 24);
  const r = await t.host.cli(["limit", "gemini", "30"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.match(r.stdout ?? "", /Лимит Gemini: \$30 в неделю/);
  await settle(10);
  assert.equal(t.gemini.snapshot().limit, 30);
  assert.equal(t.gemini.snapshot().percent, 40);
  assert.equal((await t.host.cli(["limit", "gemini", "0"])).exitCode, 1);
  assert.equal((await t.host.cli(["limit", "30"])).exitCode, 1, "the limit is Gemini's only");
  assert.equal((await t.host.cli(["restore-models", "gemini"])).exitCode, 1);
});

test("C3 test mode: the percent from the command, threads optional; --off goes back to the real week", async () => {
  const { dir } = await piDir();
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  const on = await t.host.cli(["test", "gemini", "--percent", "85"]);
  assert.equal(on.exitCode, 0, on.stderr);
  await settle(10);
  assert.equal(t.notes.at(-1)?.kind, "gemini-warn");
  assert.match(t.notes.at(-1)!.note.note, /^\[ТЕСТ\] Gemini в bb/);
  await t.host.cli(["test", "gemini", "--percent", "100", "--threads", VTX]);
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "wait");
  assert.equal((await t.host.dispatch(piTurn(VTX2, NEON))).action, "proceed", "outside the test scope");
  const off = await t.host.cli(["test", "gemini", "--off"]);
  assert.equal(off.exitCode, 0);
  assert.equal(t.gemini.snapshot().stage, 0);
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "proceed");
});

test("stage 2: the user's Send now is not stopped; a turn past the hook is; off releases everything", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 60, T0));
  const w = world();
  const t = setup(w, { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().stage, 2);
  t.host.clearCalls();
  // Send now: the held row goes out carrying the guard's stage-2 reason.
  const reason = (await t.host.dispatch(piTurn(VTX, NEON))).reason ?? "";
  await t.host.emit("message.dispatched", { entry: { threadId: VTX, waitingOn: { kind: "plugin", reason } } });
  w.running = new Set([VTX, VTX2]);
  await t.host.emit("thread.active", { thread: { ...w.threads.get(VTX)!, status: "active" } });
  await t.host.emit("thread.active", { thread: { ...w.threads.get(VTX2)!, status: "active" } });
  await settle(40);
  assert.deepEqual((t.host.callsTo("threads.stop") as Array<{ threadId: string }>).map((c) => c.threadId), [VTX2]);

  const off = await t.host.cli(["off", "gemini"]);
  assert.equal(off.exitCode, 0);
  assert.equal((await t.host.dispatch(piTurn(VTX2, NEON))).action, "proceed");
  const card = await budgetCard(t.host, "gemini") as { enabled: boolean; stage: number; realStage: number; spent: number };
  assert.equal(card.enabled, false);
  assert.equal(card.stage, 0, "the enforced stage is 0 while off");
  assert.equal(card.realStage, 2);
  assert.equal(card.spent, 60, "an off guard still counts");
  const back = (await t.host.rpc("budgetSetEnabled", { key: "gemini", enabled: true })) as { ok: boolean; text: string };
  assert.ok(back.ok);
  assert.match(back.text, /ходы Gemini ждут согласия/);
});

test("card words: the week in dollars, the headline per stage, rows per model", async () => {
  const { budgetHeadline, budgetRows, budgetWeekLine, modelName } = await import("../lib/card.ts");
  const base = {
    key: "gemini" as const,
    title: "Gemini · Vertex",
    word: "Gemini",
    turns: "ходы Gemini",
    currency: "USD" as const,
    facts: [],
    enabled: true,
    stage: 0 as const,
    realStage: 0 as const,
    consent: false,
    limit: 50,
    warnPercent: 80,
    spent: 31.4,
    today: 6.2,
    percent: 62.8,
    byModel: [
      { model: "gemini-4-neon", cost: 27.9 },
      { model: "gemini-3.8-flash", cost: 3.5 },
    ],
    resetsAt: "2026-11-22T21:00:00.000Z",
    lastScanAt: T0,
    stopped: 0,
    testActive: false,
    error: null,
  };
  assert.equal(budgetWeekLine(base), "Неделя $31,40 из $50 · 62,8 % · сброс пн 23.11 00:00");
  assert.deepEqual(budgetHeadline(base), { tone: "ok", title: "Всё в норме · осталось $18,60", hint: "Ниже 80 %: сторож только считает. Сумма — оценка по ценам Pi." });
  assert.equal(budgetHeadline({ ...base, stage: 1 }).title, "Осталось $18,60");
  assert.equal(budgetHeadline({ ...base, stage: 2, spent: 50.4 }).tone, "stop");
  assert.equal(budgetHeadline({ ...base, stage: 2, consent: true }).title, "Согласие дано");
  assert.equal(budgetHeadline({ ...base, enabled: false }).tone, "off");
  assert.equal(budgetHeadline({ ...base, spent: null }).title, "Расход не прочитан");
  assert.deepEqual(budgetRows(base), [
    { label: "Сегодня", value: "$6,20" },
    { label: "Gemini 4 Neon", value: "$27,90" },
    { label: "Gemini 3.8 Flash", value: "$3,50" },
  ]);
  assert.equal(modelName("gemini-3.1-pro-preview"), "Gemini 3.1 Pro Preview");
});

const noCost = (provider: string | null, at: number) =>
  `${JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role: "assistant", ...(provider === null ? {} : { provider }), model: "gemini-4-neon", usage: { input: 5 }, timestamp: at } })}\n`;

test("C6 (fix): a format change is kept from scan to scan until a later priced answer clears it", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 5, T0 - 60_000));
  await appendFile(file, noCost("google-vertex", T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().spent, null);
  t.advance(60_000);
  await t.gemini.tick();
  let s = t.gemini.snapshot();
  assert.equal(s.spent, null, "the second scan (nothing new) does not forget the problem");
  const card = await budgetCard(t.host, "gemini") as { spent: number | null; error: string | null };
  assert.match(card.error ?? "", /формат Pi сменился/, "the card keeps showing it");
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 1, T0 + 60_000));
  await t.gemini.tick();
  s = t.gemini.snapshot();
  assert.equal(s.spent, 6, "a later priced answer clears it; the old spend is still counted");
});

test("C6 (fix): Vertex answers without a cost raise the error even when Yandex answers are priced", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, noCost("google-vertex", T0 - 60_000));
  await appendFile(file, answer("yandex", "gpt://f/deepseek/latest", 3, T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.match(t.gemini.snapshot().lastError?.message ?? "", /формат Pi сменился/);
  // A line with usage.cost that is not a recognisable answer (type renamed) counts as suspect too.
  const { dir: dir2, file: file2 } = await piDir();
  await appendFile(file2, `${JSON.stringify({ type: "reply", message: { role: "assistant", provider: "google-vertex", model: "x", usage: { cost: { total: 1 } } } })}\n`);
  const t2 = setup(world(), { piDirs: [dir2] });
  await t2.gemini.tick();
  assert.match(t2.gemini.snapshot().lastError?.message ?? "", /не похожа на ответ модели/);
});

test("C6 (fix): a user message quoting JSON with usage/cost is not a format change", async () => {
  const { dir, file } = await piDir();
  const quoted = JSON.stringify({ usage: { cost: { total: 1 } }, role: "assistant" });
  await appendFile(file, `${JSON.stringify({ type: "message", message: { role: "user", content: quoted, timestamp: T0 } })}\n`);
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 2, T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().spent, 2);
  assert.equal(t.gemini.snapshot().lastError, null);
});

test("C6 (fix): the main Pi folder is gone but the old one is there — an error, not $0", async () => {
  const { dir } = await piDir();
  const t = setup(world(), { piDirs: ["/nonexistent/lg-pi-main", dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().spent, null);
  assert.match(t.gemini.snapshot().lastError?.message ?? "", /нет основной папки сессий Pi/);
});

test("`test gemini 80` takes the percent as a plain word; Claude keeps --percent", async () => {
  const { dir } = await piDir();
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  const r = await t.host.cli(["test", "gemini", "80"]);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(t.gemini.snapshot().test?.stage, 1);
  assert.equal((await t.host.cli(["test", "80", "--threads", A])).exitCode, 1, "Claude: a loose number is a mistake");
  const card = await budgetCard(t.host, "gemini") as Parameters<typeof import("../lib/card.ts").budgetHeadline>[0];
  const { budgetHeadline, budgetWeekLine } = await import("../lib/card.ts");
  assert.equal(budgetHeadline(card).title, "Тест: предупреждение");
  assert.equal(budgetWeekLine(card), "Тест: 80 % · настоящая неделя $0,00 из $50");
  await t.host.cli(["test", "gemini", "100"]);
  const stopCard = await budgetCard(t.host, "gemini") as Parameters<typeof budgetHeadline>[0];
  assert.equal(budgetHeadline(stopCard).tone, "stop");
});

test("weekly reset happens on Monday even when Pi's files cannot be read then", async () => {
  const base = await mkdtemp(join(tmpdir(), "lg-pi-reset-"));
  const dir = join(base, "sessions");
  await mkdir(dir);
  await appendFile(join(dir, "pi_x.jsonl"), answer("google-vertex", "gemini-4-neon", 60, T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().stage, 2);
  await rename(dir, join(base, "gone"));
  t.advance(weekStart(T0) + 7 * DAY - T0 + 60_000);
  await t.gemini.tick();
  const s = t.gemini.snapshot();
  assert.equal(s.spent, null, "the counter cannot read");
  assert.equal(s.realStage, 0, "but the old week's stop is gone");
  assert.equal((await t.host.dispatch(piTurn(VTX, NEON))).action, "proceed");
});

const modelChange = (provider: string, modelId: string, at: number) =>
  `${JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: new Date(at).toISOString(), provider, modelId })}\n`;
// The shape of Pi's compaction record (pi_06445ada…, 25.10): priced at the top level, no provider.
const compaction = (cost: number, at: number) =>
  `${JSON.stringify({ type: "compaction", id: "c1", parentId: "p", timestamp: new Date(at).toISOString(), firstKeptEntryId: "k", tokensBefore: 114762, usage: { input: 27748, output: 1721, cacheRead: 0, cacheWrite: 0, totalTokens: 29469, cost: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0, total: cost } }, fromHook: false })}\n`;

test("compaction (round 3): a normal Pi record — billed to the session's model, never a format alarm", async () => {
  const { dir, file } = await piDir();
  // A Yandex session compacts: not counted, no error.
  await appendFile(file, modelChange("yandex", "gpt://f/deepseek-v4.1-flash/latest", T0 - 3_600_000));
  await appendFile(file, answer("yandex", "gpt://f/deepseek-v4.1-flash/latest", 8, T0 - 3_500_000));
  await appendFile(file, compaction(9, T0 - 3_400_000));
  // A Neon session in another file compacts: counted on Neon.
  const neon = join(dir, "pi_neon.jsonl");
  await appendFile(neon, modelChange("google-vertex", "gemini-4-neon", T0 - 3_000_000));
  await appendFile(neon, answer("google-vertex", "gemini-4-neon", 1, T0 - 2_900_000));
  await appendFile(neon, compaction(4.67, T0 - 2_800_000));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  const s = t.gemini.snapshot();
  assert.equal(s.lastError, null);
  assert.equal(Math.round((s.spent ?? 0) * 100) / 100, 5.67);
  assert.deepEqual(s.byModel.map((m) => m.model), ["gemini-4-neon"]);
  // After a reload the files are read again from the start — still no alarm.
  const again = setup(world(), { piDirs: [dir] });
  await again.gemini.tick();
  assert.equal(again.gemini.snapshot().lastError, null);
  assert.equal(Math.round((again.gemini.snapshot().spent ?? 0) * 100) / 100, 5.67);
});

test("a suspect line takes its own timestamp: a later priced Vertex answer in the same scan clears it", async () => {
  const { dir, file } = await piDir();
  await appendFile(file, `${JSON.stringify({ type: "reply", timestamp: new Date(T0 - 60_000).toISOString(), message: { role: "assistant", provider: "google-vertex", model: "x", usage: { cost: { total: 1 } } } })}\n`);
  await appendFile(file, answer("google-vertex", "gemini-4-neon", 2, T0));
  const t = setup(world(), { piDirs: [dir] });
  await t.gemini.tick();
  assert.equal(t.gemini.snapshot().lastError, null);
  assert.equal(t.gemini.snapshot().spent, 2);
});
