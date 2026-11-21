// The budget guards — pure logic, no SDK (server/budget.ts is the SDK side).
//
// The user's own weekly limits in money for the paid models of Pi in bb (plan
// backlog/plans/2026-11-21-gemini-vertex-budget.md, decisions of 21.11): one budget
// per Pi provider — Gemini on Vertex AI (dollars), Yandex AI Studio and Cloud.ru
// (Russian rubles). For each:
//   stage 0 — below the warning threshold (80 %): the guard only counts;
//   stage 1 — at or above it: a warning (card, Telegram), nothing is held;
//   stage 2 — the limit (100 %) is reached and the user has not consented: turns of
//             Pi threads on that provider's models wait, running ones stop;
//             other Pi models and other providers run.
// The week is a calendar week, Monday 00:00 Moscow time (UTC+3, no DST).
// Stages, hysteresis and consent are the ones of lib/stage.ts with thresholds
// {sonnet: warning, stop: 100}.
import { formatAgo } from "./format.ts";
import type { DispatchDecision } from "./policy.ts";
import { MARKER, MAX_REASON, STOP_MARK } from "./policy.ts";
import type { Stage, Thresholds } from "./stage.ts";

export const PI_PROVIDER = "pi";

export type BudgetKey = "gemini" | "yandex" | "cloudru";
export const BUDGET_KEYS: readonly BudgetKey[] = ["gemini", "yandex", "cloudru"];
export type Currency = "USD" | "RUB";

export interface BudgetProfile {
  key: BudgetKey;
  /** Heading of the block and of `status`: «Gemini · Vertex», «Яндекс», «Cloud.ru (GLM)». */
  title: string;
  /** In texts: «Gemini», «Яндекс», «Cloud.ru». */
  word: string;
  /** «ходы Gemini», «ходы Яндекса» — what waits on the stop. */
  turns: string;
  /** Pi's provider id; bb model ids of Pi are `<provider>/<model>`. */
  piProvider: string;
  currency: Currency;
  /** Setting keys of the limit and the warning threshold (lib/profile.ts SETTINGS). */
  settingLimit: string;
  settingWarn: string;
  defaultLimit: number;
  /** Where the prices come from, in `status`. */
  priceNote: string;
}

export const BUDGET_PROFILES: Record<BudgetKey, BudgetProfile> = {
  gemini: {
    key: "gemini",
    title: "Gemini · Vertex",
    word: "Gemini",
    turns: "ходы Gemini",
    piProvider: "google-vertex",
    currency: "USD",
    settingLimit: "geminiWeeklyUsd",
    settingWarn: "geminiWarnPercent",
    defaultLimit: 50,
    priceNote: "Счёт — оценка по ценам каталога Pi (google-vertex/*), фактический счёт Google может отличаться.",
  },
  yandex: {
    key: "yandex",
    title: "Яндекс",
    word: "Яндекс",
    turns: "ходы Яндекса",
    piProvider: "yandex",
    currency: "RUB",
    settingLimit: "yandexWeeklyRub",
    settingWarn: "yandexWarnPercent",
    defaultLimit: 1000,
    priceNote: "Счёт — оценка по ценам из models.json Pi (вписаны вручную), это не счёт Яндекса; в папку Яндекса ходят и другие сервисы.",
  },
  cloudru: {
    key: "cloudru",
    title: "Cloud.ru (GLM)",
    word: "Cloud.ru",
    turns: "ходы Cloud.ru",
    piProvider: "cloudru",
    currency: "RUB",
    settingLimit: "cloudruWeeklyRub",
    settingWarn: "cloudruWarnPercent",
    defaultLimit: 1000,
    priceNote: "Счёт — оценка по ценам из models.json Pi (вписаны вручную), это не счёт Cloud.ru.",
  },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MSK = 3 * HOUR;

export const DEFAULT_WARN_PERCENT = 80;
const MAX_LIMIT: Record<Currency, number> = { USD: 10_000, RUB: 1_000_000 };

/** Monday 00:00 Moscow time of the week `now` falls in, ms. */
export function weekStart(now: number): number {
  const local = now + MSK;
  const day = Math.floor(local / DAY);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  const sinceMonday = (((day + 3) % 7) + 7) % 7;
  return (day - sinceMonday) * DAY - MSK;
}

/** 00:00 Moscow time of `now`'s day, ms. */
export function dayStart(now: number): number {
  return Math.floor((now + MSK) / DAY) * DAY - MSK;
}

/** The next weekly reset (next Monday 00:00 MSK) as ISO. */
export function weekResetsAt(now: number): string {
  return new Date(weekStart(now) + 7 * DAY).toISOString();
}

/** A bb model id of a Pi thread belongs to the profile's provider: `google-vertex/gemini-4-neon`. */
export function isModelOf(profile: BudgetProfile, model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(`${profile.piProvider}/`);
}

/** «gpt://<folder>/deepseek-v4.1-flash/latest» → «deepseek-v4.1-flash», «zai-org/GLM-5.2» → «GLM-5.2» (no folder id on screen). */
export function shortModel(id: string): string {
  let m = id.replace(/^gpt:\/\/[^/]+\//, "").replace(/\/(latest|rc|deprecated)$/, "");
  const slash = m.lastIndexOf("/");
  if (slash !== -1) m = m.slice(slash + 1);
  return m === "" ? id : m;
}

// ── settings ───────────────────────────────────────────────────────────

export interface BudgetSettings {
  limit: number;
  warnPercent: number;
  problem: string | null;
}

export function maxLimit(profile: BudgetProfile): number {
  return MAX_LIMIT[profile.currency];
}

export function validLimit(value: unknown, profile: BudgetProfile): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= MAX_LIMIT[profile.currency];
}

export function resolveBudget(values: Record<string, unknown>, profile: BudgetProfile): BudgetSettings {
  const problems: string[] = [];
  let limit = profile.defaultLimit;
  let warnPercent = DEFAULT_WARN_PERCENT;
  const max = MAX_LIMIT[profile.currency];
  const rawLimit = values[profile.settingLimit];
  if (validLimit(rawLimit, profile)) limit = rawLimit;
  else if (rawLimit !== undefined) {
    problems.push(`лимит ${profile.word} «${String(rawLimit)}» не годится (нужно от 1 до ${max} ${currencySign(profile.currency)}) — беру ${limitMoney(profile.defaultLimit, profile.currency)}`);
  }
  const rawWarn = values[profile.settingWarn];
  if (typeof rawWarn === "number" && Number.isFinite(rawWarn) && rawWarn >= 1 && rawWarn < 100) warnPercent = rawWarn;
  else if (rawWarn !== undefined) problems.push(`порог предупреждения ${profile.word} «${String(rawWarn)}» не годится (нужно 1–99 %) — беру ${DEFAULT_WARN_PERCENT} %`);
  return { limit, warnPercent, problem: problems.length === 0 ? null : problems.join("; ") };
}

export function budgetThresholds(warnPercent: number): Thresholds {
  return { sonnet: warnPercent, stop: 100 };
}

/** Week percent of the limit, one decimal. */
export function budgetPercent(spent: number, limit: number): number {
  return Math.round((spent / limit) * 1000) / 10;
}

// ── words ──────────────────────────────────────────────────────────────

export function currencySign(currency: Currency): string {
  return currency === "USD" ? "$" : "₽";
}

/** «$31,40», «157,66 ₽», «1 002,00 ₽» — decimal comma and spaced thousands, the currency always with the number. */
export function money(amount: number, currency: Currency = "USD"): string {
  const sign = amount < 0 ? "−" : "";
  const [int, frac] = Math.abs(amount).toFixed(2).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return currency === "USD" ? `${sign}$${grouped},${frac}` : `${sign}${grouped},${frac} ₽`;
}

/** «63 %», «62,8 %». */
export function percentText(p: number): string {
  return `${String(p).replace(".", ",")} %`;
}

/** «$50», «1 000 ₽» for whole limits, with kopecks/cents otherwise. */
export function limitMoney(amount: number, currency: Currency = "USD"): string {
  if (!Number.isInteger(amount)) return money(amount, currency);
  const grouped = String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return currency === "USD" ? `$${grouped}` : `${grouped} ₽`;
}

/** «пн 23.11 00:00» in Moscow time. */
export function formatMsk(ms: number, withWeekday = true): string {
  const d = new Date(ms + MSK);
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const date = `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withWeekday ? `${days[d.getUTCDay()]} ${date}` : date;
}

function cap(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
}

/** The stage-2 wait reason. Starts with MARKER (the guard's rows), carries STOP_MARK (Send now detection) and `resume <key>`. */
export function budgetStopReason(spent: number, limit: number, profile: BudgetProfile): string {
  return cap(
    `${MARKER} · ${profile.word} ${money(spent, profile.currency)} из ${limitMoney(limit, profile.currency)} за неделю: ${STOP_MARK} (bb limit-guard resume ${profile.key})`,
  );
}

/** A stage-2 hold of this budget guard (not the Claude/Codex one, not another budget's). */
export function isBudgetHoldReason(reason: string, profile: BudgetProfile): boolean {
  return reason.includes(MARKER) && reason.includes(STOP_MARK) && reason.includes(`resume ${profile.key})`);
}

// ── the hook ───────────────────────────────────────────────────────────

export interface BudgetFacts {
  threadId: string;
  providerId: string;
  /** The requested model; null when core resolves it — then the cached model of the thread. */
  model: string | null;
  attempt: string;
}

export interface BudgetView {
  enabled: boolean;
  stage: Stage;
  consent: boolean;
  /** Test mode with threads: only these are held. null = every thread. */
  scope: ReadonlySet<string> | null;
  spent: number;
  limit: number;
}

const PROCEED: DispatchDecision = { action: "proceed" };

/** Stage 2 without consent holds a new turn of a Pi thread on this provider's model; everything else goes. */
export function decideBudget(f: BudgetFacts, view: BudgetView, profile: BudgetProfile, cachedModel: string | null = null): DispatchDecision {
  if (!view.enabled || view.stage !== 2 || view.consent) return PROCEED;
  if (f.providerId !== PI_PROVIDER || f.attempt === "join-turn") return PROCEED;
  if (view.scope !== null && !view.scope.has(f.threadId)) return PROCEED;
  const model = f.model ?? cachedModel;
  if (!isModelOf(profile, model)) return PROCEED;
  return { action: "wait", reason: budgetStopReason(view.spent, view.limit, profile) };
}

// ── status and notes ───────────────────────────────────────────────────

/** A figure from outside Pi's files (the Yandex account balance, Google's month spend): label, value, how fresh. */
export interface BudgetFactLine {
  label: string;
  /** Formatted, with its age: «1 234,50 ₽ · 12 мин назад», or the reason it is unavailable. */
  value: string;
  /** off — not configured (the card hides it, `status` says how to turn it on). */
  kind: "ok" | "error" | "off";
}

export interface BudgetSnapshot {
  key: BudgetKey;
  title: string;
  word: string;
  turns: string;
  piProvider: string;
  currency: Currency;
  priceNote: string;
  now: number;
  enabled: boolean;
  enabledBy: string | null;
  /** The stage the guard enforces (0 while off). */
  stage: Stage;
  /** The stage of the real week. */
  realStage: Stage;
  consent: boolean;
  consentBy: string | null;
  limit: number;
  warnPercent: number;
  settingsProblem: string | null;
  /** null — the counter has not read Pi's files (or cannot). */
  spent: number | null;
  today: number | null;
  byModel: Array<{ model: string; cost: number }>;
  answers: number;
  percent: number | null;
  weekStart: number;
  resetsAt: string;
  lastScanAt: number | null;
  lastError: { at: number; message: string } | null;
  stoppedThreads: string[];
  test: { percent: number; threads: string[] | null; stage: Stage; consent: boolean } | null;
  lastNotify: { at: number; kind: string; ok: boolean; message: string } | null;
  telegram: boolean;
  facts: BudgetFactLine[];
}

/** «Gemini 4 Neon $27,90 · Gemini 3.8 Flash $3,50». */
export function modelsLine(byModel: BudgetSnapshot["byModel"], currency: Currency, max = 4): string {
  const shown = byModel.slice(0, max).map((m) => `${m.model} ${money(m.cost, currency)}`);
  const rest = byModel.length - shown.length;
  return [...shown, ...(rest > 0 ? [`и ещё ${rest}`] : [])].join(" · ");
}

const STAGE_WORDS: Record<Stage, string> = { 0: "считает", 1: "предупреждение", 2: "стоп до согласия" };

/** The figure's age for a fact line. */
export function factAge(at: number, now: number): string {
  return formatAgo(at, now);
}

export function formatBudgetStatus(s: BudgetSnapshot): string {
  const m = (n: number) => money(n, s.currency);
  const head = s.enabled ? `стадия ${s.stage} (${STAGE_WORDS[s.stage]})` : "ВЫКЛЮЧЕН (считает, не вмешивается)";
  const lines = [`Сторож лимитов · ${s.title} · ${head}`];
  if (s.test !== null) {
    lines.push(`ТЕСТ-РЕЖИМ: процент ${s.test.percent} → стадия ${s.test.stage}${s.test.threads === null ? "" : `, только треды ${s.test.threads.join(", ")}`}. Выключить: bb limit-guard test ${s.key} --off`);
  }
  const spent = s.spent === null ? "не прочитано" : `${m(s.spent)} из ${limitMoney(s.limit, s.currency)} (${percentText(s.percent ?? 0)})`;
  lines.push(`Неделя: ${spent} · с ${formatMsk(s.weekStart)} МСК · сброс ${formatMsk(Date.parse(s.resetsAt))} МСК`);
  lines.push(`Пороги: предупреждение ${s.warnPercent} %, стоп 100 %${s.settingsProblem === null ? "" : ` · ⚠ ${s.settingsProblem}`}`);
  if (s.today !== null) lines.push(`Сегодня: ${m(s.today)} · ответов за неделю: ${s.answers}`);
  if (s.byModel.length > 0) lines.push(`По моделям: ${modelsLine(s.byModel, s.currency, 8)}`);
  for (const fact of s.facts) lines.push(`${fact.label}: ${fact.value}`);
  lines.push(s.priceNote);
  if (s.consent) lines.push(`Согласие до сброса недели дано${s.consentBy === null ? "" : ` (${s.consentBy})`}.`);
  if (s.stoppedThreads.length > 0) lines.push(`Остановлено на стопе: ${s.stoppedThreads.length} — ${s.stoppedThreads.slice(0, 10).join(", ")}`);
  if (s.lastScanAt !== null) lines.push(`Подсчёт: ${formatMsk(s.lastScanAt, false)} МСК`);
  if (s.lastError !== null) lines.push(`Последняя ошибка (${formatMsk(s.lastError.at, false)}): ${s.lastError.message}`);
  if (s.lastNotify !== null) lines.push(`Уведомление ${s.lastNotify.kind}: ${s.lastNotify.ok ? "доставлено" : `не доставлено — ${s.lastNotify.message}`}`);
  if (!s.enabled) lines.push(`Включить: bb limit-guard on ${s.key}`);
  else if (s.stage === 2 && !s.consent) lines.push(`Продолжить до сброса недели: bb limit-guard resume ${s.key} (только вы)`);
  lines.push(`Лимит: bb limit-guard limit ${s.key} <${s.currency === "USD" ? "доллары" : "рубли"}> (сейчас ${limitMoney(s.limit, s.currency)})`);
  return lines.join("\n");
}

export type BudgetNotifyStage = "warn" | "stop" | "consent";
export type BudgetNotifyKind = `${BudgetKey}-${BudgetNotifyStage}`;

export function budgetNoteFor(kind: BudgetNotifyKind, s: BudgetSnapshot): { md: string; note: string } {
  const m = (n: number) => money(n, s.currency);
  const lim = limitMoney(s.limit, s.currency);
  const stage = kind.slice(s.key.length + 1) as BudgetNotifyStage;
  const test = s.test !== null ? "[ТЕСТ] " : "";
  const spent = s.spent ?? 0;
  const pct = s.test !== null ? s.test.percent : (s.percent ?? 0);
  const left = Math.max(0, s.limit - spent);
  const reset = `${formatMsk(Date.parse(s.resetsAt))} МСК`;
  const top = s.byModel.length > 0 ? modelsLine(s.byModel, s.currency) : "расхода по моделям нет";
  const glob = `${s.piProvider}/*`;
  const head = [`Время: ${formatMsk(s.now, false)} МСК`, `Неделя: ${m(spent)} из ${lim} (${percentText(pct)}), сброс ${reset}.`, `По моделям: ${top}.`, "Сумма — оценка по ценам каталога Pi."];
  if (stage === "warn") {
    return {
      note: `${test}${s.word} в bb: потрачено ${m(spent)} из ${lim} (${percentText(pct)}), до сброса ${reset}. На ${lim} ${s.turns} встанут до bb limit-guard resume ${s.key}.`,
      md: [`# ${test}Сторож лимитов: ${s.word} — пройдено ${s.warnPercent} %`, "", ...head, "", `Осталось ${m(left)}. На 100 % новые ходы Pi на моделях ${glob} будут ждать согласия, идущие — остановятся; другие модели Pi работают.`].join("\n"),
    };
  }
  if (stage === "stop") {
    return {
      note: `${test}${s.word} в bb: недельный лимит ${lim} исчерпан (${m(spent)}). ${s.turns[0]!.toUpperCase()}${s.turns.slice(1)} ждут согласия: bb limit-guard resume ${s.key}. Другие модели Pi работают.`,
      md: [`# ${test}Сторож лимитов: ${s.word} — стоп`, "", ...head, "", `Новые ходы Pi на моделях ${glob} ждут согласия, идущие остановлены. Треды Pi на других моделях и другие провайдеры не затронуты.`, "", `Продолжить до сброса недели: \`bb limit-guard resume ${s.key}\`.`].join("\n"),
    };
  }
  return {
    note: `${test}${s.word} в bb: согласие дано — работа идёт до сброса недели (${reset}), стоп больше не включится. Потрачено ${m(spent)} из ${lim}.`,
    md: [`# ${test}Сторож лимитов: ${s.word} — согласие до сброса недели`, "", ...head, "", `Согласие: ${s.consentBy ?? "?"}.`].join("\n"),
  };
}
