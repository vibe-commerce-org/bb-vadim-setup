// `bb limit-guard` — status, consent, the switch and the test mode of both
// guards. The verb comes first, the provider word after it: `bb limit-guard off
// codex`. Without the word a command addresses Claude, as before 0.2.0 — so the
// deny rules `Bash(bb limit-guard off*)` on the user's side cover `off codex` too
// (a `bb limit-guard codex off` form would slip past them).
//
// Any local agent can call a plugin CLI (memory bb-plugin-sdk-pitfalls), so
// `resume` and `test` are for the user only by convention plus Claude Code deny
// rules on his side (README «Ограничения»). Every such call is logged with the
// calling thread and shown in `status` (who gave the consent).
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { BUDGET_KEYS, formatBudgetStatus, type BudgetKey } from "../lib/budget.ts";
import { formatStatus } from "../lib/format.ts";
import { GUARD_KEYS, type GuardKey } from "../lib/profile.ts";
import { THREAD_ID } from "../lib/saved.ts";
import type { BudgetGuard } from "./budget.ts";
import type { Guard } from "./guard.ts";

export const USAGE = [
  "bb limit-guard — Сторож лимитов: недельные лимиты Claude Code и Codex и недельные бюджеты Gemini ($), Яндекса и Cloud.ru (₽), у каждого свой выключатель и пороги",
  "  Claude Code (включён по умолчанию): 85 % → Sonnet xhigh, 93 % → стоп до согласия",
  "  Codex (выключен по умолчанию): 85 % → effort ниже (модель — по настройке), 93 % → стоп до согласия",
  "  Gemini (включён по умолчанию): бюджет в $ за неделю (пн 00:00 МСК) для тредов Pi на google-vertex/*; 80 % → предупреждение, 100 % → стоп до согласия",
  "  Яндекс и Cloud.ru (включены по умолчанию): то же в ₽ для тредов Pi на yandex/* и cloudru/* (по умолчанию 1 000 ₽ в неделю)",
  "",
  "Команды (сторож — словом claude, codex, gemini, yandex или cloudru после команды; без него — claude):",
  "  bb limit-guard status [claude|codex|gemini|yandex|cloudru] [--json]  все сторожа или один: процент недели, сброс, стадия, согласие, треды, проверка, ошибка",
  "  bb limit-guard resume [codex|gemini|yandex|cloudru]           согласие продолжать после стопа до сброса недели; со стадии 1 — заранее (только вы)",
  "  bb limit-guard off [codex|gemini|yandex|cloudru]              выключить сторожа: не держит ходы, не останавливает и не переключает треды (только вы)",
  "  bb limit-guard on [codex|gemini|yandex|cloudru]               включить сторожа, стадия пересчитывается сразу (только вы)",
  "  bb limit-guard limit gemini|yandex|cloudru <сумма>            недельный бюджет: доллары у Gemini, рубли (₽) у Яндекса и Cloud.ru, например limit yandex 1000 (только вы)",
  "  bb limit-guard restore-models [codex]                         вернуть тредам прежние модели (сторож выключен или стадия 0)",
  "  bb limit-guard test [codex] --threads <id1,id2> --percent <N> тест-режим: стадия от N, действия только с этими тредами (только вы)",
  "  bb limit-guard test gemini|yandex|cloudru <N> [--threads <id1,id2>]  тест-режим бюджета: стадия от N % (только вы)",
  "  bb limit-guard test [codex|gemini|yandex|cloudru] --off       выключить тест-режим (Claude/Codex — и вернуть тестовым тредам их модели)",
  "",
  "status --json без провайдера — Claude, как до 0.2.0.",
  "Аварийно выключить оба сторожа: bb plugin disable limit-guard (придержанные ходы сразу уйдут).",
].join("\n");

const COMMANDS = [
  {
    name: "status",
    summary: "Состояние сторожей Claude Code, Codex и бюджетов Gemini, Яндекса, Cloud.ru: процент недели, стадия, согласие, треды",
    usage: "bb limit-guard status [claude|codex|gemini|yandex|cloudru] [--json]",
  },
  {
    name: "resume",
    summary: "Согласие продолжать после 93 % до сброса недели — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard resume [codex|gemini|yandex|cloudru]",
  },
  {
    name: "off",
    summary: "Выключить сторожа: он читает лимит, но ничего не держит, не останавливает и не переключает — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard off [codex|gemini|yandex|cloudru]",
  },
  {
    name: "on",
    summary: "Включить сторожа (Codex по умолчанию выключен; за порогом остановки работа встанет сразу) — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard on [codex|gemini|yandex|cloudru]",
  },
  {
    name: "limit",
    summary: "Недельный бюджет Gemini ($), Яндекса или Cloud.ru (₽) — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard limit gemini|yandex|cloudru <сумма>",
  },
  {
    name: "restore-models",
    summary: "Вернуть тредам прежние модели (сторож выключен или стадия 0) — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard restore-models [codex]",
  },
  {
    name: "test",
    summary: "Тест-режим на указанных тредах — ТОЛЬКО пользователь, агентам не вызывать",
    usage: "bb limit-guard test [codex] --threads <id1,id2> --percent <N> | bb limit-guard test gemini|yandex|cloudru <N> [--threads <id1,id2>] | bb limit-guard test [codex|gemini|yandex|cloudru] --off",
  },
];

/** Who a command addresses: a Claude/Codex guard or a budget guard. */
export type Target = GuardKey | BudgetKey;

/** `guard` is absent when no provider word was given: Claude, or all for `status`. */
type Addressed = { guard?: Target };

export type ParsedCommand =
  | { kind: "help" }
  | ({ kind: "status"; json: boolean } & Addressed)
  | ({ kind: "resume" } & Addressed)
  | ({ kind: "off" } & Addressed)
  | ({ kind: "on" } & Addressed)
  | ({ kind: "restore-models" } & Addressed)
  | ({ kind: "test-on"; threads: string[] | null; percent: number } & Addressed)
  | ({ kind: "limit"; amount: number } & Addressed)
  | ({ kind: "test-off" } & Addressed)
  | { kind: "error"; message: string };

function option(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function isBudget(target: Target | undefined): target is BudgetKey {
  return target !== undefined && (BUDGET_KEYS as readonly string[]).includes(target);
}

function isTarget(word: string): word is Target {
  return (BUDGET_KEYS as readonly string[]).includes(word) || (GUARD_KEYS as readonly string[]).includes(word);
}

const AMOUNT = /^\d{1,7}([.,]\d{1,2})?$/;

/** Options of `test` that take the next word as their value (`--threads=…` carries it inline). */
const VALUED = new Set(["--threads", "--percent"]);

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...after] = [...argv];
  const known = command !== undefined && ["status", "resume", "off", "on", "restore-models", "test", "limit"].includes(command);
  if (!known) return parseCommand(command, after);
  // The provider word may stand anywhere among the words that are not options or option values
  // (`test --off codex` is Codex, not Claude); any other loose word is a mistake, not ignored.
  const rest: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < after.length; i += 1) {
    const arg = after[i]!;
    if (arg.startsWith("-")) {
      rest.push(arg);
      if (VALUED.has(arg) && i + 1 < after.length) rest.push(after[++i]!);
      continue;
    }
    words.push(arg);
  }
  const amounts = command === "limit" || command === "test" ? words.filter((word) => AMOUNT.test(word)) : [];
  const bad = words.filter((word) => !isTarget(word) && !amounts.includes(word));
  if (bad.length > 0) return { kind: "error", message: `Неизвестный сторож или лишнее слово: ${bad.join(" ")}. Сторож — claude, codex, gemini, yandex или cloudru (без слова — claude).` };
  const guards = [...new Set(words.filter(isTarget))];
  if (guards.length > 1) return { kind: "error", message: "Одна команда — один сторож: claude, codex, gemini, yandex или cloudru." };
  const guard = guards[0];
  if (command === "limit") {
    if (!isBudget(guard) || amounts.length !== 1) return { kind: "error", message: "Использование: bb limit-guard limit gemini|yandex|cloudru <сумма>, например limit yandex 1000 (лимит есть только у бюджетов)" };
    return { kind: "limit", amount: Number(amounts[0]!.replace(",", ".")), guard };
  }
  if (command === "restore-models" && isBudget(guard)) return { kind: "error", message: "У бюджетного сторожа нечего возвращать: он не переключает модели." };
  if (command === "test" && amounts.length > 0) {
    // `test gemini 80` — the percent as a plain word, budgets only (Claude/Codex keep --percent).
    if (!isBudget(guard) || amounts.length > 1 || option(rest, "--percent") !== undefined) {
      return { kind: "error", message: `Лишнее слово: ${amounts.join(" ")}. Процент — --percent <N> (у бюджетов можно просто числом: test gemini 80).` };
    }
    rest.push("--percent", amounts[0]!);
  }
  const parsed = parseCommand(command, rest, isBudget(guard));
  if (parsed.kind === "help" || parsed.kind === "error" || guard === undefined) return parsed;
  return { ...parsed, guard };
}

function parseCommand(command: string | undefined, rest: string[], budget = false): ParsedCommand {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "status":
      return { kind: "status", json: rest.includes("--json") };
    case "resume":
      return { kind: "resume" };
    case "off":
      return { kind: "off" };
    case "on":
      return { kind: "on" };
    case "restore-models":
      return { kind: "restore-models" };
    case "test": {
      if (rest.includes("--off")) return { kind: "test-off" };
      const threadsRaw = option(rest, "--threads");
      const percentRaw = option(rest, "--percent");
      const usage = budget
        ? "Использование: bb limit-guard test gemini|yandex|cloudru <N> [--threads <id1,id2>] или bb limit-guard test gemini|yandex|cloudru --off"
        : "Использование: bb limit-guard test [codex] --threads <id1,id2> --percent <N> или bb limit-guard test [codex] --off";
      if (percentRaw === undefined || (threadsRaw === undefined && !budget)) return { kind: "error", message: usage };
      if (threadsRaw === undefined) {
        if (!/^\d{1,3}$/.test(percentRaw) || Number(percentRaw) > 200) return { kind: "error", message: `--percent — целое от 0 до 200, получено «${percentRaw}»` };
        return { kind: "test-on", threads: null, percent: Number(percentRaw) };
      }
      const threads = [...new Set(threadsRaw.split(",").map((id) => id.trim()).filter(Boolean))];
      const bad = threads.filter((id) => !THREAD_ID.test(id));
      if (threads.length === 0 || bad.length > 0) {
        return { kind: "error", message: `Не похоже на id тредов: ${bad.join(", ") || "(пусто)"}. ${usage}` };
      }
      if (threads.length > 20) return { kind: "error", message: "Тест-режим — не больше 20 тредов" };
      if (!/^\d{1,3}$/.test(percentRaw) || Number(percentRaw) > 100) {
        return { kind: "error", message: `--percent — целое от 0 до 100, получено «${percentRaw}»` };
      }
      return { kind: "test-on", threads, percent: Number(percentRaw) };
    }
    default:
      return { kind: "error", message: `Неизвестная команда: ${command}\n\n${USAGE}` };
  }
}

function ok(stdout: string): PluginCliResult {
  return { exitCode: 0, stdout };
}

function fail(stderr: string): PluginCliResult {
  return { exitCode: 1, stderr };
}

async function runBudget(guard: BudgetGuard, parsed: Exclude<ParsedCommand, { kind: "help" } | { kind: "error" }>, caller: string): Promise<PluginCliResult> {
  const done = (result: { ok: boolean; text: string }) => (result.ok ? ok(result.text) : fail(result.text));
  switch (parsed.kind) {
    case "status": {
      await guard.ready;
      const snapshot = guard.snapshot();
      return ok(parsed.json ? JSON.stringify(snapshot) : formatBudgetStatus(snapshot));
    }
    case "resume":
      return done(await guard.resume(caller));
    case "off":
    case "on":
      return done(await guard.setEnabled(parsed.kind === "on", caller));
    case "limit":
      return done(await guard.setLimit(parsed.amount, caller));
    case "test-on":
      return done(await guard.startTest(parsed.percent, parsed.threads, caller));
    case "test-off":
      return done(await guard.stopTest(caller));
    case "restore-models":
      return fail("У бюджетного сторожа нечего возвращать: он не переключает модели.");
  }
}

export async function runCommand(guards: Record<GuardKey, Guard>, argv: readonly string[], ctx: PluginCliContext, budgets?: Partial<Record<BudgetKey, BudgetGuard>>): Promise<PluginCliResult> {
  const caller = ctx.threadId ?? "shell";
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") return ok(USAGE);
  if (parsed.kind === "error") return fail(parsed.message);
  if (isBudget(parsed.guard)) {
    const budget = budgets?.[parsed.guard];
    if (budget === undefined) return fail(`Сторож ${parsed.guard} не подключён`);
    return await runBudget(budget, parsed, caller);
  }
  if (parsed.kind === "limit") return fail("Лимит есть только у бюджетов: bb limit-guard limit gemini|yandex|cloudru <сумма>");
  const guard = guards[parsed.guard ?? "claude"];
  switch (parsed.kind) {
    case "status": {
      if (parsed.guard === undefined && !parsed.json) {
        // All guards, Claude first, the budgets last.
        const all = [guards.claude, guards.codex];
        await Promise.all(all.map((g) => g.ready));
        const blocks = all.map((g) => formatStatus(g.snapshot()));
        for (const key of BUDGET_KEYS) {
          const budget = budgets?.[key];
          if (budget === undefined) continue;
          await budget.ready;
          blocks.push(formatBudgetStatus(budget.snapshot()));
        }
        return ok(blocks.join("\n\n"));
      }
      await guard.ready;
      const snapshot = guard.snapshot();
      return ok(parsed.json ? JSON.stringify(snapshot) : formatStatus(snapshot));
    }
    case "resume": {
      const result = await guard.resume(caller);
      return result.ok ? ok(result.text) : fail(result.text);
    }
    case "off":
    case "on": {
      const result = await guard.setEnabled(parsed.kind === "on", caller);
      return result.ok ? ok(result.text) : fail(result.text);
    }
    case "restore-models": {
      const result = await guard.restoreModels(caller);
      return result.ok ? ok(result.text) : fail(result.text);
    }
    case "test-on": {
      if (parsed.threads === null) return fail("Использование: bb limit-guard test [codex] --threads <id1,id2> --percent <N>");
      const result = await guard.startTest(parsed.threads, parsed.percent, caller);
      return result.ok ? ok(result.text) : fail(result.text);
    }
    case "test-off": {
      const result = await guard.stopTest(caller);
      return result.ok ? ok(result.text) : fail(result.text);
    }
  }
}

export function registerCli(bb: BbPluginApi, guards: Record<GuardKey, Guard>, budgets?: Partial<Record<BudgetKey, BudgetGuard>>): void {
  bb.cli.register({
    name: "limit-guard",
    summary: "Сторож лимитов: недельные лимиты Claude Code и Codex (экономный режим на 85 %, стоп на 93 %) и бюджеты Gemini ($), Яндекса и Cloud.ru (₽) (стоп на 100 %) до вашего согласия",
    commands: COMMANDS,
    async run(argv, ctx) {
      try {
        return await runCommand(guards, argv, ctx, budgets);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
