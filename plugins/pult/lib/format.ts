// Pure formatting shared by Pult's UI and its CLI (server/cli.ts): ages,
// dates, deadlines, snooze presets and the Russian labels of kinds, lanes,
// statuses, sources and thread-row marks. No React, no SDK, no DOM — loads
// under plain Node (`node --test`, the plugin backend) too. One source of
// wording: the page, the row marks and `bb pult` must say the same thing.
import type {
  AgeBucket,
  ClassificationSource,
  Kind,
  Lane,
  TaskStatus,
  WaitingKind,
} from "./types.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Russian plural: plural(5, "день", "дня", "дней") → "дней". */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Compact age: "только что", "5 мин", "3 ч", "2 дн.", "3 нед.", "4 мес.".
 * Every unit is floored (13.6 days is "13 дн.", 1.5 hours is "1 ч"), so an
 * age never reads older than it is and never crosses the 14-day «застряло»
 * line early. The CLI uses this same function.
 */
export function formatAge(ms: number): string {
  const value = Math.max(0, ms);
  if (value < MINUTE) return "только что";
  if (value < HOUR) return `${Math.floor(value / MINUTE)} мин`;
  if (value < DAY) return `${Math.floor(value / HOUR)} ч`;
  if (value < 14 * DAY) return `${Math.floor(value / DAY)} дн.`;
  if (value < 60 * DAY) return `${Math.floor(value / (7 * DAY))} нед.`;
  return `${Math.floor(value / (30 * DAY))} мес.`;
}

/** "только что" / "5 мин назад" / "3 ч назад"; "никогда" for null. */
export function formatAgo(at: number | null, now: number): string {
  if (at === null) return "никогда";
  const age = now - at;
  if (age < MINUTE) return "только что";
  return `${formatAge(age)} назад`;
}

/** "12 окт., 14:05" in the local time zone. */
export function formatDateTime(at: number): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

/** "10.10" (day.month) in the local time zone. */
export function formatShortDate(at: number): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(new Date(at));
}

/** "13 окт." in the local time zone. */
export function formatDay(at: number): string {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(
    new Date(at),
  );
}

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Parses "YYYY-MM-DD" as a local calendar day; null when malformed. */
export function parseIsoDay(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export type DueTone = "overdue" | "today" | "soon" | "later";

/** A deadline chip: "просрочено: 10 окт.", "срок сегодня", "срок завтра", "до 13 окт.". */
export function formatDue(iso: string, now: number): { text: string; tone: DueTone } {
  const day = parseIsoDay(iso);
  if (day === null) return { text: `срок ${iso}`, tone: "later" };
  const diff = Math.round((day - startOfDay(now)) / DAY);
  if (diff < 0) return { text: `просрочено: ${formatDay(day)}`, tone: "overdue" };
  if (diff === 0) return { text: "срок сегодня", tone: "today" };
  if (diff === 1) return { text: "срок завтра", tone: "soon" };
  return { text: `до ${formatDay(day)}`, tone: diff <= 3 ? "soon" : "later" };
}

/** "до 16:30" today, "до завтра 9:00", "до 15 окт., 09:00" later. */
export function formatUntil(until: number, now: number): string {
  const time = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(until),
  );
  const diff = Math.round((startOfDay(until) - startOfDay(now)) / DAY);
  if (diff <= 0) return `до ${time}`;
  if (diff === 1) return `до завтра ${time}`;
  return `до ${formatDateTime(until)}`;
}

export interface SnoozePreset {
  id: "2h" | "tomorrow" | "3d" | "week";
  label: string;
  until: number;
}

/** 9:00 tomorrow in the local time zone (DST-safe: calendar arithmetic). */
export function tomorrowMorning(now: number): number {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.getTime();
}

/** «Отложить»: 2 часа / до завтра 9:00 / 3 дня / неделя. */
export function snoozePresets(now: number): SnoozePreset[] {
  return [
    { id: "2h", label: "На 2 часа", until: now + 2 * HOUR },
    { id: "tomorrow", label: "До завтра 9:00", until: tomorrowMorning(now) },
    { id: "3d", label: "На 3 дня", until: now + 3 * DAY },
    { id: "week", label: "На неделю", until: now + 7 * DAY },
  ];
}

/** Queue group headings, in queue order. */
export const KIND_TITLES: Record<WaitingKind, string> = {
  approval: "Ждёт одобрения",
  decision: "Нужно решение",
  action: "Сделать руками",
  failed: "Упало или прервано",
  review: "Проверить",
  commit: "Коммит ждёт «да»",
};

/**
 * The label of a «ход за тобой» mark on a row of BB's own thread list (and
 * the bridge's marks derived from queue.list): the group heading, lowered.
 */
export const MARK_LABELS: Record<WaitingKind, string> = {
  approval: "Ход за тобой: ждёт одобрения",
  decision: "Ход за тобой: нужно решение",
  action: "Ход за тобой: сделать руками",
  failed: "Ход за тобой: упало или прервано",
  review: "Ход за тобой: проверить",
  commit: "Ход за тобой: коммит ждёт «да»",
};

/** Short chip labels for every kind. */
export const KIND_SHORT: Record<Kind, string> = {
  approval: "одобрение",
  decision: "решение",
  action: "руками",
  failed: "упало",
  review: "проверить",
  commit: "коммит",
  working: "работает",
  done: "готово",
  unknown: "неясно",
};

/** How a model's reasoning level reads on a tight row: "XH" for "Extra High". */
export const EFFORT_SHORT: Record<string, string> = {
  none: "Non",
  low: "Low",
  medium: "Med",
  high: "Hig",
  xhigh: "XHi",
  ultracode: "Ult",
  ultra: "Ult",
  max: "Max",
};

/** The same level in full, as BB's own composer chip words it. */
export const EFFORT_LONG: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  ultra: "Ultra",
  max: "Max",
};

/** A reasoning level as BB names it; a level we do not know passes through. */
export function effortLabel(level: string | null, short = false): string | null {
  if (level === null) return null;
  const table = short ? EFFORT_SHORT : EFFORT_LONG;
  return table[level] ?? level;
}

/** A model's id as a readable name, for models BB's catalog has no name for: «neuraldeep/qwen3.6-35b-a3b» → «qwen3.6 35b a3b». */
export function shortModelId(model: string | null): string | null {
  if (model === null || model === "") return null;
  const segment = model.split("/").filter((part) => part !== "" && part !== "latest").pop() ?? model;
  return segment.replace(/[-_]+/g, " ").trim() || model;
}

/** A model's name without the vendor BB appends: «DeepSeek V4.1 Flash · Yandex» → «DeepSeek V4.1 Flash». */
export function withoutVendor(label: string | null): string | null {
  if (label === null) return null;
  const cut = label.lastIndexOf(" · ");
  return cut > 0 ? label.slice(0, cut) : label;
}

/**
 * The three letters of a model's name that name the model, for a phone row:
 * «Opus 5.5» → «Opu», «Sonnet 5.5» → «Son», «Gemini 4 Argon» → «Arg»,
 * «DeepSeek V4.1 Flash» → «Dee», «GPT-6.1-Sol» → «Sol».
 *
 * A GPT model takes its code name («Sol», «Ter», «Lun»): «GPT» alone would say
 * nothing about which one runs, and the vendor is in the logo beside it.
 * A DeepSeek keeps its family name («Dee») — «V4.1 Flash» alone does not say
 * whose model it is, unlike «Argon» after «Gemini» (the user, 29.10).
 * Every other model takes its last word — the one that names it, unlike the
 * family («Gemini») or the number — or the first word when there is only one.
 */
export function modelTag(label: string | null): string | null {
  if (label === null) return null;
  const letters = modelTagWord(label).match(/\p{L}/gu)?.slice(0, 3).join("");
  return letters ? letters.charAt(0).toUpperCase() + letters.slice(1) : null;
}

/** The word of a model's name that {@link modelTag} takes its letters from. */
function modelTagWord(label: string): string {
  const words = label
    .replace(/^\s*gpt[-_\s]*\d*(\.\d+)?[-_\s]*/i, "")
    .split(/[\s\-_/]+/)
    .filter((word) => /\p{L}/u.test(word));
  // DeepSeek's own name is the model's, where the suffix only says its size.
  if (words[0]?.toLowerCase().startsWith("deepseek")) return words[0];
  return words.at(-1) ?? "";
}

/** «Gemini 4 Argon · Med»: the model and the effort of one row, whichever is known. */
export function modelLine(model: string | null, effort: string | null, short = true): string | null {
  const e = effortLabel(effort, short);
  if (model === null || model === "") return e;
  return e === null ? model : `${model} · ${e}`;
}

export const LANE_TITLES: Record<Lane, string> = {
  now: "Сейчас",
  next: "Дальше",
  later: "Потом",
};

export const LANE_ORDER: readonly Lane[] = ["now", "next", "later"];

export const TASK_STATUS_TITLES: Record<TaskStatus, string> = {
  backlog: "бэклог",
  todo: "к выполнению",
  in_progress: "в работе",
  in_review: "на проверке",
  done: "готово",
  canceled: "отменена",
};

/**
 * Where the classification came from, as the card's small print. `seedAsOf`
 * is the as-of time of the imported inventory (scan.seedAsOf); without it an
 * inventory item just says «из инвентаризации».
 */
export function sourceLabel(
  source: ClassificationSource,
  confidence: number,
  seedAsOf: number | null = null,
): string {
  const percent = `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`;
  switch (source) {
    case "native":
      return "сигнал BB";
    case "marker":
      return "маркер агента";
    case "inventory":
      return seedAsOf === null ? "из инвентаризации" : `из разбора ${formatShortDate(seedAsOf)}`;
    case "rules":
      return `по тексту, уверенность ${percent}`;
    case "llm":
      return `LLM, уверенность ${percent}`;
    case "manual":
      return "вручную";
  }
}

/** A piece of agent text: plain text, or a mention of another thread. */
export type TextPart =
  | { type: "text"; text: string }
  | { type: "thread"; threadId: string };

// "@thread:thr_xxxxxxxxxx" or a bare "thr_xxxxxxxxxx": exactly 10 [a-z0-9]
// after the prefix. The left boundary of the bare form is checked by hand
// (no lookbehind, for older WebKit).
const THREAD_MENTION = /(@thread:)?thr_[a-z0-9]{10}(?![A-Za-z0-9_])/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Splits agent text into plain runs and thread mentions, so the UI can render
 * mentions as buttons while everything else stays a text node (never HTML).
 */
export function splitThreadMentions(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(THREAD_MENTION)) {
    const start = match.index;
    const prefixed = match[1] !== undefined;
    if (!prefixed && start > 0 && WORD_CHAR.test(text[start - 1] as string)) continue;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "thread", threadId: match[0].slice(prefixed ? "@thread:".length : 0) });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** Age bucket → text color class (theme tokens plus the amber pair only). */
export function ageToneClass(bucket: AgeBucket): string {
  switch (bucket) {
    case "fresh":
      return "text-muted-foreground";
    case "day":
      return "text-foreground";
    case "week":
      return "text-amber-600 dark:text-amber-400";
    case "stale":
      return "text-destructive";
  }
}

/** Deadline tone → text color class. */
export function dueToneClass(tone: DueTone): string {
  switch (tone) {
    case "overdue":
      return "text-destructive";
    case "today":
    case "soon":
      return "text-amber-600 dark:text-amber-400";
    case "later":
      return "text-muted-foreground";
  }
}
