// What differs between the Claude Code guard and the Codex guard — plain data
// and pure functions, no SDK. One guard per profile (server/guard.ts), both on
// the same code: stages, the hook, stops, consent and the weekly reset do not
// depend on the provider; the target of stage 1, the thresholds, the kv keys and
// the words in texts do.
//
// Claude keeps everything it had before 0.2.0: kv keys without a prefix, the
// service name `poll`, the setting keys `sonnetPercent`/`stopPercent`, commands
// without a provider word, Sonnet xhigh as the target. Codex is off by default
// and takes its thresholds and target from its own settings.
import type { SavedExecution } from "./saved.ts";
import { holdsForModel, isTargetExecution, resolveThresholds, SONNET_EFFORT, SONNET_MODEL, type Thresholds } from "./stage.ts";

export type GuardKey = "claude" | "codex";
export const GUARD_KEYS: readonly GuardKey[] = ["claude", "codex"];

/** Where stage 1 puts a thread. `model: null` — the thread keeps its own model, only the effort goes down. */
export interface Target {
  model: string | null;
  effort: string;
}

export interface Profile {
  key: GuardKey;
  providerId: string;
  /** In texts: «недельный лимит Claude». */
  title: string;
  /** Heading of the guard's block in the card and in `status`. */
  cardTitle: string;
  /** «неделя ≥85 %» in hold reasons; Codex says whose week it is. */
  weekWord: string;
  /** Appended to commands addressing this guard: "" for Claude (as before 0.2.0), " codex". */
  cmd: string;
  /** Prefix of this guard's kv keys: "" for Claude (the 0.1.x keys), "codex:". */
  kvPrefix: string;
  /** Name of the background service. */
  service: string;
  enabledByDefault: boolean;
  /** «запускай треды с …» — what the agent hint asks to spawn. */
  agentThreads: string;
  /** The tail of a hold reason: how to keep the held execution for one message. */
  overrideTail: string;
  /** The same in a Telegram note, one sentence. */
  overrideNote: string;
  /** Who this guard never touches — for the stage-2 note. */
  others: string;
  /** The stage-1 threshold in the «thresholds do not fit» message. */
  stage1Word: string;
}

export interface GuardInfo {
  profile: Profile;
  target: Target;
}

export const CLAUDE_PROFILE: Profile = {
  key: "claude",
  providerId: "claude-code",
  title: "Claude",
  cardTitle: "Claude Code",
  weekWord: "неделя",
  cmd: "",
  kvPrefix: "",
  service: "poll",
  enabledByDefault: true,
  agentThreads: "треды",
  overrideTail: "Нужен Opus — Send now",
  overrideNote: "Opus — только через Send now",
  others: "Codex и Pi не затронуты.",
  stage1Word: "Sonnet",
};

export const CODEX_PROFILE: Profile = {
  key: "codex",
  providerId: "codex",
  title: "Codex",
  cardTitle: "Codex",
  weekWord: "неделя Codex",
  cmd: " codex",
  kvPrefix: "codex:",
  service: "poll-codex",
  enabledByDefault: false,
  agentThreads: "треды Codex",
  overrideTail: "Нужно как было — Send now",
  overrideNote: "Прежняя модель и effort — только через Send now",
  others: "Claude Code и Pi не затронуты.",
  stage1Word: "экономия",
};

export const PROFILES: Record<GuardKey, Profile> = { claude: CLAUDE_PROFILE, codex: CODEX_PROFILE };

export const CLAUDE_TARGET: Target = { model: SONNET_MODEL, effort: SONNET_EFFORT };
export const CODEX_DEFAULT_TARGET: Target = { model: null, effort: "medium" };

/** The guard Claude has always been — the default of the pure text helpers. */
export const CLAUDE_GUARD: GuardInfo = { profile: CLAUDE_PROFILE, target: CLAUDE_TARGET };

// ── settings ───────────────────────────────────────────────────────────

export const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

export const SETTINGS = {
  sonnetPercent: {
    type: "number",
    label: "Claude: порог Sonnet, %",
    description: "С этого процента недельного лимита Claude треды claude-code переходят на claude-sonnet-5-5 / xhigh. По умолчанию 85.",
    default: 85,
  },
  stopPercent: {
    type: "number",
    label: "Claude: порог остановки, %",
    description: "С этого процента работа claude-code останавливается до согласия (bb limit-guard resume). По умолчанию 93.",
    default: 93,
  },
  codexCheapPercent: {
    type: "number",
    label: "Codex: порог экономии, %",
    description: "С этого процента недельного лимита Codex треды codex переходят на экономный режим (модель и effort ниже). По умолчанию 85. Сам сторож Codex включается переключателем или bb limit-guard on codex.",
    default: 85,
  },
  codexStopPercent: {
    type: "number",
    label: "Codex: порог остановки, %",
    description: "С этого процента работа codex останавливается до согласия (bb limit-guard resume codex). По умолчанию 93.",
    default: 93,
  },
  codexModel: {
    type: "string",
    label: "Codex: модель в экономном режиме",
    description: "Пусто — каждый тред остаётся на своей модели, снижается только effort. Иначе — id модели Codex (bb provider models codex), на которую переходят все треды.",
    default: "",
  },
  codexEffort: {
    type: "select",
    label: "Codex: effort в экономном режиме",
    description: "Ходы с effort выше этого переставляются на него. По умолчанию medium.",
    options: [...CODEX_EFFORTS] as string[],
    default: "medium",
  },
  geminiWeeklyUsd: {
    type: "number",
    label: "Gemini: лимит в неделю, $",
    description: "Недельный бюджет Gemini на Vertex (треды Pi на моделях google-vertex/*), в долларах США по ценам каталога Pi. Неделя — с понедельника 00:00 МСК. На 100 % ходы Gemini ждут согласия (bb limit-guard resume gemini). По умолчанию 50. Поменять: bb limit-guard limit gemini <доллары>.",
    default: 50,
  },
  geminiWarnPercent: {
    type: "number",
    label: "Gemini: порог предупреждения, %",
    description: "С этого процента недельного бюджета — предупреждение в карточке и в Telegram; ходы не держатся. По умолчанию 80.",
    default: 80,
  },
  yandexWeeklyRub: {
    type: "number",
    label: "Яндекс: лимит в неделю, ₽",
    description: "Недельный бюджет тредов Pi на моделях Яндекса (yandex/*: DeepSeek, Qwen, YandexGPT, Alice) в российских рублях (₽) по ценам models.json Pi. Неделя — с понедельника 00:00 МСК. На 100 % ходы Яндекса ждут согласия (bb limit-guard resume yandex). По умолчанию 1000. Поменять: bb limit-guard limit yandex <рубли>.",
    default: 1000,
  },
  yandexWarnPercent: {
    type: "number",
    label: "Яндекс: порог предупреждения, %",
    description: "С этого процента недельного бюджета Яндекса — предупреждение в карточке и в Telegram; ходы не держатся. По умолчанию 80.",
    default: 80,
  },
  cloudruWeeklyRub: {
    type: "number",
    label: "Cloud.ru: лимит в неделю, ₽",
    description: "Недельный бюджет тредов Pi на моделях Cloud.ru (cloudru/*: GLM, Kimi, DeepSeek V4 Pro, Qwen3 Coder) в российских рублях (₽) по ценам models.json Pi. На 100 % ходы Cloud.ru ждут согласия (bb limit-guard resume cloudru). По умолчанию 1000. Поменять: bb limit-guard limit cloudru <рубли>.",
    default: 1000,
  },
  cloudruWarnPercent: {
    type: "number",
    label: "Cloud.ru: порог предупреждения, %",
    description: "С этого процента недельного бюджета Cloud.ru — предупреждение в карточке и в Telegram; ходы не держатся. По умолчанию 80.",
    default: 80,
  },
  telegram: {
    type: "boolean",
    label: "Уведомлять в Telegram",
    description: "При входе в стадии 1 и 2 и при согласии — сводка в Telegram через необязательный скрипт уведомлений.",
    default: true,
  },
} as const;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,79}$/;

export interface Resolved {
  thresholds: Thresholds;
  target: Target;
  /** What in the settings did not fit (shown in `status`), null when all is well. */
  problem: string | null;
}

/** Thresholds and target of one guard from the plugin settings; anything odd falls back to the defaults. */
export function resolveSettings(profile: Profile, values: Record<string, unknown>): Resolved {
  if (profile.key === "claude") {
    const { thresholds, problem } = resolveThresholds(values.sonnetPercent, values.stopPercent);
    return { thresholds, target: { ...CLAUDE_TARGET }, problem };
  }
  const problems: string[] = [];
  const { thresholds, problem } = resolveThresholds(values.codexCheapPercent, values.codexStopPercent, profile.stage1Word);
  if (problem !== null) problems.push(problem);
  const target: Target = { ...CODEX_DEFAULT_TARGET };
  const effort = values.codexEffort;
  if (typeof effort === "string" && (CODEX_EFFORTS as readonly string[]).includes(effort)) target.effort = effort;
  else if (effort !== undefined) problems.push(`effort Codex «${String(effort)}» не годится — беру ${CODEX_DEFAULT_TARGET.effort}`);
  const model = typeof values.codexModel === "string" ? values.codexModel.trim() : "";
  if (MODEL_ID.test(model)) target.model = model;
  else if (model !== "") problems.push(`модель Codex «${model.slice(0, 80)}» не похожа на id модели — треды остаются на своих моделях`);
  return { thresholds, target, problem: problems.length === 0 ? null : problems.join("; ") };
}

// ── what a guard moves ─────────────────────────────────────────────────

const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6, ultracode: 7 };

/** The effort is known and higher than the target's. Unknown values are never «higher». */
export function effortAbove(effort: string | null | undefined, target: string): boolean {
  if (typeof effort !== "string") return false;
  const rank = EFFORT_RANK[effort];
  const limit = EFFORT_RANK[target];
  return rank !== undefined && limit !== undefined && rank > limit;
}

/** A turn on this execution is moved to the target on stage ≥ 1 (null model — unknown, left alone). */
export function holdsExecution(g: GuardInfo, model: string | null | undefined, effort: string | null | undefined): boolean {
  if (g.profile.key === "claude") return holdsForModel(model);
  if (typeof model !== "string" || model === "") return false;
  if (g.target.model !== null && model !== g.target.model) return true;
  return effortAbove(effort, g.target.effort);
}

/** The thread's defaults are already where stage 1 wants them (Codex: never raised to the target). */
export function isOnTarget(g: GuardInfo, opts: { model: string | null; reasoningLevel: string | null } | null): boolean {
  if (g.profile.key === "claude") return isTargetExecution(opts);
  if (opts === null) return false;
  if (g.target.model !== null && opts.model !== g.target.model) return false;
  return !effortAbove(opts.reasoningLevel, g.target.effort);
}

/** Codex never raises an effort: a known effort at or below the target stays, anything else becomes the target. */
function lowered(effort: string | null | undefined, target: string): string {
  if (typeof effort !== "string" || EFFORT_RANK[effort] === undefined || effortAbove(effort, target)) return target;
  return effort;
}

/** The execution a held row or a thread gets on the target. Claude: Sonnet xhigh, as in 0.1. */
export function executionFor(g: GuardInfo, model: string | null, effort: string | null | undefined): { model: string | null; reasoningLevel: string } {
  if (g.profile.key === "claude") return { model: g.target.model, reasoningLevel: g.target.effort };
  return { model: g.target.model ?? model, reasoningLevel: lowered(effort, g.target.effort) };
}

/** `threads.update` arguments that put a thread on the target (keep-model mode: the effort only). */
export function targetUpdate(g: GuardInfo, opts: { model: string | null; reasoningLevel: string | null } | null): { model?: string; reasoningLevel: string } {
  const next = executionFor(g, opts?.model ?? null, opts?.reasoningLevel ?? null);
  return g.target.model === null ? { reasoningLevel: next.reasoningLevel } : { model: g.target.model, reasoningLevel: next.reasoningLevel };
}

/** What is saved before the guard first moves a thread. */
export function savedEntry(g: GuardInfo, opts: { model: string | null; reasoningLevel: string | null }): SavedExecution {
  const entry: SavedExecution = { model: opts.model, reasoningLevel: opts.reasoningLevel };
  return g.profile.key !== "claude" && g.target.model === null ? { ...entry, effortOnly: true } : entry;
}

/**
 * `threads.update` attempts that give a thread its saved execution back, in order. Claude, as in 0.1:
 * the saved model, then without `[1m]` (the catalog has no such ids). Codex: only the effort when the
 * guard changed only the effort (a model the user picked mid-week is not clobbered); otherwise the model,
 * and the effort alone if the model is gone from the catalog.
 */
export function restoreAttempts(g: GuardInfo, saved: SavedExecution, models: (model: string | null) => Array<string | null>): Array<{ model?: string | null; reasoningLevel: string | null }> {
  const withModel = models(saved.model).map((model) => ({ model, reasoningLevel: saved.reasoningLevel }));
  if (g.profile.key === "claude") return withModel;
  const effortOnly = { reasoningLevel: saved.reasoningLevel };
  return saved.effortOnly === true ? [effortOnly] : [...withModel, effortOnly];
}

// ── words ──────────────────────────────────────────────────────────────

function isSonnetId(model: string | null): boolean {
  return model !== null && model.startsWith("claude-sonnet");
}

/** «Sonnet xhigh», «effort medium», «gpt-6.2-sol medium». */
export function targetLabel(target: Target): string {
  if (target.model === null) return `effort ${target.effort}`;
  return isSonnetId(target.model) ? `Sonnet ${target.effort}` : `${target.model} ${target.effort}`;
}

/** «Sonnet», «effort medium», «gpt-6.2-sol» — after a count («на Sonnet 442 треда»). */
export function targetShort(target: Target): string {
  if (target.model === null) return `effort ${target.effort}`;
  return isSonnetId(target.model) ? "Sonnet" : target.model;
}

/** «claude-sonnet-5-5 / xhigh», «effort medium». */
export function targetExec(target: Target): string {
  return target.model === null ? `effort ${target.effort}` : `${target.model} / ${target.effort}`;
}

/** Spawn flags that land on the target. */
export function targetFlags(target: Target): string {
  return target.model === null ? `--reasoning-level ${target.effort}` : `--model ${target.model} --reasoning-level ${target.effort}`;
}

/** What a held turn ran on, for a hold reason: «Opus», «gpt-6.1-terra / xhigh». */
export function heldWord(g: GuardInfo, model: string | null, effort: string | null): string {
  if (g.profile.key === "claude") {
    if (model === null) return "другой модели";
    return /opus/i.test(model) ? "Opus" : model;
  }
  return `${model ?? "?"} / ${effort ?? "?"}`;
}

/** Which turns the guard holds, for a note: «Ходы на Opus», «Ходы с effort выше medium». */
export function heldTurns(g: GuardInfo): string {
  if (g.profile.key === "claude") return "Ходы на Opus";
  if (g.target.model === null) return `Ходы с effort выше ${g.target.effort}`;
  return `Ходы на других моделях и с effort выше ${g.target.effort}`;
}
