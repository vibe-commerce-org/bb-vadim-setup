// Parser of the optional end-of-turn marker an agent writes when the move is
// The user's:
//   ⏸ Ход за тобой · решение | действие | проверка · до 2026-10-13: <одна строка>
// «за» takes any one word: «Ход за тобой», «Ход за вами», «Ход за Вадимом».
//   Варианты: А — …; Б — …
// The "· до <date>" part and the «Варианты:» line are optional.
// Also home of the small text helpers the classifier shares: option keys,
// option lines, dates, markdown stripping. Pure, no I/O.
import type { AnswerOption, WaitingKind } from "./types.ts";

export interface Marker {
  kind: Extract<WaitingKind, "decision" | "action" | "review">;
  ask: string;
  due: string | null;
  options: AnswerOption[];
}

export const ASK_MAX = 600;
export const OPTION_LABEL_MAX = 140;

/** Option keys the user answers with by voice — Cyrillic only. */
export const OPTION_KEYS = ["А", "Б", "В", "Г", "Д"] as const;
const LATIN_TO_CYRILLIC: Record<string, string> = { A: "А", B: "Б", C: "В", D: "Г", E: "Д" };

/** "A"/"а"/"А" → "А"; Latin A–E map to А–Д by position; anything else → null. */
export function normalizeOptionKey(raw: string): string | null {
  const key = raw.trim();
  if (key.length !== 1) return null;
  const upper = key.toUpperCase();
  if ((OPTION_KEYS as readonly string[]).includes(upper)) return upper;
  return LATIN_TO_CYRILLIC[upper] ?? null;
}

// Letters an option line may start with (upper case only: a lower-case «в»
// or «а» is a preposition, not an option).
const KEY_CLASS = "[АБВГДABCDE]";
// Letter boundaries for Cyrillic text: JS \b only knows ASCII letters.
export const NB = "(?![\\p{L}\\p{N}])";
export const NA = "(?<![\\p{L}\\p{N}])";

const RECOMMENDED_RE = /рекоменд|recommend|⭐|★|\(лучше\)|\(советую\)/iu;

/** Strip markdown emphasis, links and inline-code ticks; keep the words. */
export function stripMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/(^|[\s(])[*_](?=\S)([^*_\n]+?)[*_](?=[\s).,:;!?]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[ \t]+/g, " ");
}

// ── length cuts that never split a surrogate pair ─────────────────────────
// String.slice counts UTF-16 units: a cut through an emoji leaves a lone
// surrogate, which renders as «�» and breaks strict UTF-8 consumers (Python's
// print of `bb pult queue --json`). Every cut of thread text goes through
// these helpers.

/** The first `n` UTF-16 units, minus a high surrogate left alone at the end. */
export function headUnits(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The last `n` UTF-16 units, minus a low surrogate left alone at the start. */
export function tailUnits(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  const cut = text.slice(text.length - n);
  return /^[\uDC00-\uDFFF]/.test(cut) ? cut.slice(1) : cut;
}

/** At most `max` units: the start plus «…» when cut (no word boundary). */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : headUnits(text, max - 1) + "…";
}

/** At most `max` units: «…» plus the end when cut. */
export function tail(text: string, max: number): string {
  return text.length <= max ? text : "…" + tailUnits(text, max - 1);
}

/** Cut to `max` chars on a word boundary, with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = headUnits(t, max - 1);
  const space = head.lastIndexOf(" ");
  return (space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:—–-]+$/u, "") + "…";
}

/**
 * One option line: «А — текст», «**Б.** текст», «- В) текст», «Вариант Г: …»,
 * «A — text» (Latin keys are normalized). Returns null for anything else.
 */
export function parseOptionLine(line: string): AnswerOption | null {
  const plain = stripMarkdown(line).trim();
  const re = new RegExp(
    `^(?:[-*+•]\\s+|\\d{1,2}[.)]\\s+)?(?:Вариант\\s+|Option\\s+)?(${KEY_CLASS})${NB}\\s*(?:[—–:.)]|-(?=\\s))\\s*(.+)$`,
    "u",
  );
  const m = plain.match(re);
  if (!m) return null;
  const key = normalizeOptionKey(m[1]!);
  const label = m[2]!.trim();
  if (!key || label.length < 2) return null;
  return { key, label: clip(label, OPTION_LABEL_MAX), recommended: RECOMMENDED_RE.test(label) };
}

/** True when the options run А, Б, В… from the start without gaps. */
export function isOptionSequence(options: readonly AnswerOption[]): boolean {
  if (options.length < 2) return false;
  return options.every((o, i) => o.key === OPTION_KEYS[i]);
}

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
};
// Calendar dates are the user's, Moscow time (UTC+3, no DST).
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A year-less date belongs to the current year, unless that is half a year back. */
function inferYear(month: number, day: number, now: number): number {
  const year = new Date(now + MSK_OFFSET_MS).getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  return candidate < now + MSK_OFFSET_MS - 183 * DAY_MS ? year + 1 : year;
}

const DUE_LEAD = `${NA}(?:до|к|дедлайн|срок(?:\\s+до)?|не\\s+позднее|не\\s+позже|by|until|due)${NB}\\s*:?\\s*~?\\s*`;
const DUE_ISO_RE = new RegExp(`${DUE_LEAD}(\\d{4})-(\\d{2})-(\\d{2})${NB}`, "iu");
const DUE_DOTTED_RE = new RegExp(
  `${DUE_LEAD}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?(?!\\.?\\d)`,
  "iu",
);
const DUE_WORDS_RE = new RegExp(
  `${DUE_LEAD}(\\d{1,2})\\s+(${Object.keys(MONTHS).join("|")})(?:\\s+(\\d{4}))?`,
  "iu",
);

/**
 * A deadline in the text: «до 13.10», «к 12.10», «до 2026-10-13»,
 * «дедлайн 15.10», «до 13 октября» → YYYY-MM-DD; the year comes from `now`
 * when the text has none. Returns the earliest valid deadline, or null.
 */
export function parseDue(text: string, now: number): string | null {
  const found: string[] = [];
  const scan = (re: RegExp, build: (m: RegExpExecArray) => string | null) => {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (let m = g.exec(text); m; m = g.exec(text)) {
      const date = build(m);
      if (date) found.push(date);
    }
  };
  scan(DUE_ISO_RE, (m) => iso(Number(m[1]), Number(m[2]), Number(m[3])));
  scan(DUE_DOTTED_RE, (m) => {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = m[3] ? Number(m[3]) : inferYear(month, day, now);
    if (year < 100) year += 2000;
    return iso(year, month, day);
  });
  scan(DUE_WORDS_RE, (m) => {
    const day = Number(m[1]);
    const month = MONTHS[m[2]!.toLowerCase()]!;
    const year = m[3] ? Number(m[3]) : inferYear(month, day, now);
    return iso(year, month, day);
  });
  if (found.length === 0) return null;
  return found.sort()[0]!;
}

/**
 * The fence a text starts inside of: a tail cut («…» first) with an odd
 * number of fence lines begins in the middle of a code block.
 */
export function initialFence(lines: readonly string[]): string | null {
  if (!/^\s*…/u.test(lines[0] ?? "")) return null;
  const fences = lines.map((l) => l.match(/^\s*(```+|~~~+)/)).filter((m) => m !== null);
  return fences.length % 2 === 1 ? fences[0]![1]![0]! : null;
}

/** Lines outside fenced code blocks (``` / ~~~). */
export function proseLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = initialFence(lines);
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out;
}

const MARKER_KINDS: Record<string, Marker["kind"]> = {
  решение: "decision",
  действие: "action",
  проверка: "review",
};
const MARKER_RE = new RegExp(
  `^(?:[>\\-*+]\\s*)*(?:⏸\\uFE0F?\\s*)?Ход\\s+за\\s+[\\p{L}-]+\\s*[·•|]\\s*(решение|действие|проверка)${NB}(.*)$`,
  "iu",
);
const VARIANTS_RE = /^(?:[>\-*+]\s*)*Варианты\s*:\s*(.*)$/iu;

function parseMarkerOptions(lines: string[], from: number): AnswerOption[] {
  const options: AnswerOption[] = [];
  let inVariants = false;
  for (let i = from; i < Math.min(lines.length, from + 8); i++) {
    const plain = stripMarkdown(lines[i]!).trim();
    if (plain === "") {
      if (options.length > 0) break;
      continue;
    }
    const v = plain.match(VARIANTS_RE);
    if (v && !inVariants) {
      inVariants = true;
      for (const part of v[1]!.split(/\s*;\s*/u)) {
        const opt = parseOptionLine(part);
        if (opt) options.push(opt);
      }
      continue;
    }
    const opt = inVariants ? parseOptionLine(plain) : null;
    if (opt) {
      options.push(opt);
      continue;
    }
    break;
  }
  // Keep the first option per key.
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}

/**
 * Returns the last marker in the text, or null when there is none. `now`
 * only resolves a year-less «до 13.10»; the classifier passes its own.
 */
export function parseMarker(text: string, now: number = Date.now()): Marker | null {
  const lines = proseLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const plain = stripMarkdown(lines[i]!).trim();
    const m = plain.match(MARKER_RE);
    if (!m) continue;
    const kind = MARKER_KINDS[m[1]!.toLowerCase()]!;
    let rest = m[2]!.trim();
    let due: string | null = null;
    const dueMatch = rest.match(/^[·•|]\s*((?:до|срок|дедлайн)\s*:?\s*[^:]+?)\s*(?=:|$)/iu);
    if (dueMatch) {
      due = parseDue(dueMatch[1]!, now);
      rest = rest.slice(dueMatch[0].length).trim();
    }
    let ask = rest.replace(/^[:—–-]\s*/u, "").trim();
    let next = i + 1;
    if (ask === "") {
      while (next < lines.length && stripMarkdown(lines[next]!).trim() === "") next++;
      const candidate = next < lines.length ? stripMarkdown(lines[next]!).trim() : "";
      if (candidate && !VARIANTS_RE.test(candidate)) {
        ask = candidate;
        next++;
      }
    }
    if (ask === "") continue;
    return { kind, ask: clip(ask, ASK_MAX), due, options: parseMarkerOptions(lines, next) };
  }
  return null;
}
