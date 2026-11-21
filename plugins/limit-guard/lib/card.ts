// What the sidebar-footer card says — pure functions over the `status` RPC
// result, so the wording is tested without React (tests/card.test.ts). The card
// has one block per guard (Claude Code, Codex) and one for the Gemini budget;
// every text names its provider and its target.
import { formatMsk, limitMoney, money, percentText } from "./budget.ts";
export interface CardStatus {
  /** Which guard: "claude" | "codex". */
  provider: "claude" | "codex";
  /** Block heading: «Claude Code», «Codex». */
  name: string;
  /** In texts: «Работа Claude остановлена». */
  title: string;
  /** Stage-1 target: «Sonnet xhigh», «effort medium». */
  target: string;
  /** The same after a count: «на Sonnet 442 треда». */
  targetShort: string;
  enabled: boolean;
  stage: 0 | 1 | 2;
  realStage: 0 | 1 | 2;
  percent: number | null;
  resetsAt: string | null;
  checkedAt: number | null;
  consent: boolean;
  /** Threads on the target (the name is from 0.1, Claude only). */
  onSonnet: number;
  saved: number;
  stopped: number;
  restoring: boolean;
  testActive: boolean;
  error: string | null;
  thresholds: { sonnet: number; stop: number };
}

export type Tone = "off" | "ok" | "warn" | "stop";

export interface Headline {
  tone: Tone;
  title: string;
  hint: string;
}

/** «23.10 08:00» in the viewer's local time; the empty string for a missing or broken date. */
export function formatReset(resetsAt: string | null): string {
  if (resetsAt === null) return "";
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** «1 тред», «2 треда», «5 тредов», «21 тред», «12 тредов». */
export function threadsWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} тредов`;
  if (mod10 === 1) return `${n} тред`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} треда`;
  return `${n} тредов`;
}

/** The provider word after a command: none for Claude (as before 0.2.0), « codex». */
export function commandWord(provider: CardStatus["provider"]): string {
  return provider === "claude" ? "" : ` ${provider}`;
}

export function headline(s: CardStatus): Headline {
  const cmd = commandWord(s.provider);
  if (s.testActive) {
    return { tone: "warn", title: "Идёт тест-режим", hint: `Сторож действует только на тестовых тредах. Выключить тест: bb limit-guard test${cmd} --off` };
  }
  if (!s.enabled) {
    return {
      tone: "off",
      title: "Выключен",
      hint:
        s.saved > 0
          ? `Ничего не держит и не переключает. ${threadsWord(s.saved)}, переведённых сторожем, остаются на ${s.targetShort} — кнопкой ниже можно вернуть прежние модели.`
          : "Ничего не держит, не останавливает и не переключает. Лимит только читается.",
    };
  }
  if (s.stage === 2 && !s.consent) {
    return { tone: "stop", title: `Стоп с ${s.thresholds.stop} %`, hint: `Работа ${s.title} остановлена до согласия: bb limit-guard resume${cmd}` };
  }
  if (s.stage === 2) {
    return { tone: "warn", title: "Согласие дано", hint: `Работа идёт на ${s.targetShort} до сброса недели.` };
  }
  if (s.stage === 1) {
    return {
      tone: "warn",
      title: `С ${s.thresholds.sonnet} %: ${s.target}`,
      hint: s.consent ? "Согласие дано заранее — стоп на пороге не включится." : `Треды ${s.title} идут на ${s.targetShort}; на ${s.thresholds.stop} % работа остановится.`,
    };
  }
  return { tone: "ok", title: "Всё в норме", hint: `Ниже ${s.thresholds.sonnet} %: сторож только следит.` };
}

/** One line under the bar: week percent and the reset. */
export function weekLine(s: CardStatus): string {
  if (s.percent === null) return "Неделя ещё не прочитана";
  const reset = formatReset(s.resetsAt);
  return `Неделя ${s.percent} %${reset === "" ? "" : ` · сброс ${reset}`}`;
}

/** The counts line; empty when there is nothing to say. */
export function countsLine(s: CardStatus): string {
  const parts: string[] = [];
  if (s.enabled && s.onSonnet > 0) parts.push(`на ${s.targetShort} ${threadsWord(s.onSonnet)}`);
  if (s.stopped > 0) parts.push(`остановлено ${threadsWord(s.stopped)}`);
  return parts.join(" · ");
}

/** Bar fill and the two ticks, in percent of the bar (clamped to 0–100). */
export function barGeometry(s: CardStatus): { fill: number; sonnet: number; stop: number } {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return { fill: clamp(s.percent ?? 0), sonnet: clamp(s.thresholds.sonnet), stop: clamp(s.thresholds.stop) };
}

/** The restore button is offered only when there is something to give back and the guard will not undo it. */
export function canRestore(s: CardStatus): boolean {
  return s.saved > 0 && !s.restoring && !s.testActive && (!s.enabled ? true : s.realStage === 0);
}

// ── the budget blocks (0.3.0: Gemini; Yandex and Cloud.ru after) ───────

/** One entry of the `budgets` RPC result (rpc.ts budgetStatusSchema). Money in the budget's own currency. */
export interface BudgetCardStatus {
  key: "gemini" | "yandex" | "cloudru";
  /** Block heading: «Gemini · Vertex», «Яндекс», «Cloud.ru (GLM)». */
  title: string;
  /** In texts: «Gemini», «Яндекс», «Cloud.ru». */
  word: string;
  /** What waits on the stop, in the genitive: «ходы Яндекса». */
  turns: string;
  currency: "USD" | "RUB";
  enabled: boolean;
  stage: 0 | 1 | 2;
  realStage: 0 | 1 | 2;
  consent: boolean;
  limit: number;
  warnPercent: number;
  spent: number | null;
  today: number | null;
  percent: number | null;
  byModel: Array<{ model: string; cost: number }>;
  resetsAt: string;
  lastScanAt: number | null;
  stopped: number;
  testActive: boolean;
  error: string | null;
  facts: Array<{ label: string; value: string; kind: "ok" | "error" | "off" }>;
}

const BRANDS: Record<string, string> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  gpt: "GPT",
  oss: "OSS",
  qwen: "Qwen",
  kimi: "Kimi",
  yandexgpt: "YandexGPT",
  aliceai: "Alice AI",
  llm: "LLM",
  moe: "MoE",
};

/** «gemini-4-neon» → «Gemini 4 Neon», «deepseek-v4.1-flash» → «DeepSeek V4.1 Flash»; ids that already have capitals («GLM-5.2») stay as they are. */
export function modelName(id: string): string {
  if (/[A-Z]/.test(id)) return id;
  return id
    .split("-")
    .map((part) => BRANDS[part] ?? (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

function upperFirst(text: string): string {
  return text === "" ? text : text[0]!.toUpperCase() + text.slice(1);
}

export function budgetHeadline(s: BudgetCardStatus): Headline {
  const m = (n: number) => money(n, s.currency);
  const left = s.spent === null ? null : Math.max(0, s.limit - s.spent);
  if (s.testActive) {
    const off = `Выключить тест: bb limit-guard test ${s.key} --off`;
    if (s.enabled && s.stage === 2 && !s.consent) return { tone: "stop", title: "Тест: стоп", hint: `${upperFirst(s.turns)} в тестовом охвате ждут согласия. ${off}` };
    if (s.enabled && s.stage >= 1) return { tone: "warn", title: "Тест: предупреждение", hint: off };
    return { tone: "warn", title: "Идёт тест-режим", hint: `Процент задан командой. ${off}` };
  }
  if (!s.enabled) return { tone: "off", title: "Выключен", hint: "Расход считается, но ходы не держатся и треды не останавливаются." };
  if (s.spent === null) return { tone: "warn", title: "Расход не прочитан", hint: "Сторож не видит, сколько потрачено, — стадия не меняется. Причина ниже." };
  if (s.stage === 2 && !s.consent) {
    return { tone: "stop", title: "Стоп до вашего «да»", hint: `Новые ${s.turns} ждут, идущие остановлены. Треды Pi на других моделях работают. Продолжить: bb limit-guard resume ${s.key}` };
  }
  if (s.consent) return { tone: "warn", title: "Согласие дано", hint: "До сброса недели стоп не включится." };
  if (s.stage === 1) {
    return { tone: "warn", title: `Осталось ${m(left ?? 0)}`, hint: `Пройдено ${s.warnPercent} %. На ${limitMoney(s.limit, s.currency)} ${s.turns} встанут до вашего «да».` };
  }
  return { tone: "ok", title: `Всё в норме · осталось ${m(left ?? 0)}`, hint: `Ниже ${s.warnPercent} %: сторож только считает. Сумма — оценка по ценам Pi.` };
}

/** «Неделя $31,40 из $50 · 63 % · сброс пн 23.11 00:00» (Moscow time — the week is Moscow's). */
export function budgetWeekLine(s: BudgetCardStatus): string {
  const reset = Number.isFinite(Date.parse(s.resetsAt)) ? ` · сброс ${formatMsk(Date.parse(s.resetsAt))}` : "";
  if (s.testActive) {
    const real = s.spent === null ? "не прочитана" : `${money(s.spent, s.currency)} из ${limitMoney(s.limit, s.currency)}`;
    return `Тест: ${percentText(s.percent ?? 0)} · настоящая неделя ${real}`;
  }
  if (s.spent === null) return `Неделя: лимит ${limitMoney(s.limit, s.currency)}${reset}`;
  return `Неделя ${money(s.spent, s.currency)} из ${limitMoney(s.limit, s.currency)} · ${percentText(s.percent ?? 0)}${reset}`;
}

/** Rows under the headline: today and the week per model. */
export function budgetRows(s: BudgetCardStatus): Array<{ label: string; value: string }> {
  if (s.spent === null || (s.spent === 0 && s.byModel.length === 0)) return [];
  const rows = [{ label: "Сегодня", value: money(s.today ?? 0, s.currency) }];
  for (const m of s.byModel.slice(0, 4)) rows.push({ label: modelName(m.model), value: money(m.cost, s.currency) });
  return rows;
}

/** Figures from outside Pi's files (balance, Google's month spend); the unconfigured ones stay hidden on the card. */
export function budgetFactRows(s: BudgetCardStatus): Array<{ label: string; value: string; error: boolean }> {
  return s.facts.filter((f) => f.kind !== "off").map((f) => ({ label: f.label, value: f.value, error: f.kind === "error" }));
}

/** Bar fill and the ticks (warning, 100 %), in percent of the bar. */
export function budgetBar(s: BudgetCardStatus): { fill: number; warn: number; stop: number } {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return { fill: clamp(s.percent ?? 0), warn: clamp(s.warnPercent), stop: 99.5 };
}
