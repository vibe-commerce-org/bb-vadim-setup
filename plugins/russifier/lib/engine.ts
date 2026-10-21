// Translation engine: English interface string → Russian, or null.
//
// Order of attempts for one string:
//   1. exact dictionary entry (after normalising spaces, ’ and …);
//   2. the same, ignoring letter case («Toggle Sidebar» = «Toggle sidebar»);
//   3. a trailing shortcut hint or duration, then the rest: «Search threads (⌘ K)»,
//      «Thought (2m 38s)»;
//   4. templates with {0}… compiled to anchored regexes, indexed by first word;
//   5. a counted noun bb pluralised itself: «4 lists» → «4 списка»; a bare
//      duration «2m 38s»; a known verb before a count: «created 17 files»;
//   6. a comma list bb glued from pieces: «Edited 3 files, ran 1 command».
// An empty dictionary value keeps the string English: no later step may
// translate it piecemeal («Approve for me» is not «{0} for {1}»).
// Pure module: no DOM, so it is unit-tested directly.
import { parseMessage, renderMessage, type Message } from "./icu.ts";
import { translateCount } from "./nouns.ts";

export type Dictionary = Readonly<Record<string, string>>;

interface Pattern {
  key: string;
  re: RegExp;
  message: Message;
  startsWithArg: boolean;
  literal: number;
}

const LATIN = /[A-Za-z]/;
const CYRILLIC_START = /^[А-ЯЁа-яё]/;
const SHORTCUT_SUFFIX =
  /^(.*?\S)(\s*\((?:⌘|⇧|⌥|⌃|Ctrl|Control|Alt|Option|Shift|Cmd|Command|Mod|Enter|Return|Esc|Escape|Tab|Space|Backspace|Delete|F\d{1,2})[^()]*\))$/;
const DURATION_SUFFIX = /^(.*?\S)(\s*)\((\d+h ?)?(\d+m ?)?(\d+(?:\.\d+)?s)?\)$/;
const DURATION_ONLY = /^(\d+h ?)?(\d+m ?)?(\d+(?:\.\d+)?s)?$/;
const VERB_COUNT = /^([A-Za-z]+(?: [A-Za-z]+)?) (\d[\s\S]*)$/;
const CACHE_LIMIT = 20_000;
const MAX_LENGTH = 400;

/** Key form shared by the dictionary and the page: single spaces, ' and ... */
export function normalizeKey(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/…/g, "...").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstWord(text: string): string {
  const m = /^[A-Za-z][A-Za-z'-]*/.exec(text);
  return m ? m[0].toLowerCase() : "*";
}

/** Match the case of the first letter to the original string's. */
function adaptCase(original: string, translated: string): string {
  if (!CYRILLIC_START.test(translated)) return translated;
  const o = original.charAt(0);
  if (o >= "a" && o <= "z") return translated.charAt(0).toLowerCase() + translated.slice(1);
  if (o >= "A" && o <= "Z") return translated.charAt(0).toUpperCase() + translated.slice(1);
  return translated;
}

/** «2m 38s» → «2 мин 38 с»; null for anything else. */
export function formatDuration(text: string): string | null {
  const m = DURATION_ONLY.exec(text.trim());
  if (!m || !(m[1] || m[2] || m[3])) return null;
  const parts: string[] = [];
  if (m[1]) parts.push(`${parseInt(m[1], 10)} ч`);
  if (m[2]) parts.push(`${parseInt(m[2], 10)} мин`);
  if (m[3]) parts.push(`${m[3].slice(0, -1).replace(".", ",")} с`);
  return parts.join(" ");
}

export class Engine {
  private readonly exact = new Map<string, string>();
  private readonly keep = new Set<string>();
  private readonly folded = new Map<string, string | null>();
  private readonly buckets = new Map<string, Pattern[]>();
  private readonly cache = new Map<string, string | null>();
  readonly size: number;
  readonly patternCount: number;

  constructor(...dictionaries: Dictionary[]) {
    let patterns = 0;
    for (const dictionary of dictionaries) {
      for (const [en, ru] of Object.entries(dictionary)) {
        if (typeof ru !== "string") continue;
        const key = normalizeKey(en);
        if (!key || !LATIN.test(key)) continue;
        if (ru.trim() === "") {
          if (!/\{\d+\}/.test(key)) this.keep.add(key);
          continue;
        }
        this.keep.delete(key);
        if (/\{\d+\}/.test(key)) {
          if (this.addPattern(key, ru)) patterns++;
          continue;
        }
        this.exact.set(key, ru);
        const lower = key.toLowerCase();
        const prev = this.folded.get(lower);
        this.folded.set(lower, prev === undefined || prev === ru ? ru : null);
      }
    }
    for (const list of this.buckets.values()) list.sort((a, b) => b.literal - a.literal);
    this.size = this.exact.size + patterns;
    this.patternCount = patterns;
  }

  private addPattern(key: string, ru: string): boolean {
    const pieces = key.split(/(\{\d+\})/);
    let source = "^";
    let literal = 0;
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const arg = /^\{(\d+)\}$/.exec(piece);
      if (!arg) {
        source += escapeRegExp(piece);
        literal += piece.replace(/\s/g, "").length;
        continue;
      }
      // «command{1}»: a placeholder glued to a word is an English plural ending.
      const glued = i > 0 && /[A-Za-z]$/.test(pieces[i - 1]);
      source += glued ? "([a-z]{0,2})" : "(.+?)";
    }
    source += "$";
    if (literal < 3) return false; // «{0} {1}» would match anything
    let re: RegExp;
    try {
      re = new RegExp(source, "i");
    } catch {
      return false;
    }
    const startsWithArg = /^\{\d+\}/.test(key);
    const pattern: Pattern = { key, re, message: parseMessage(ru), startsWithArg, literal };
    const bucket = startsWithArg ? "*" : firstWord(key);
    const list = this.buckets.get(bucket);
    if (list) list.push(pattern);
    else this.buckets.set(bucket, [pattern]);
    return true;
  }

  /** Russian for an interface string, keeping its surrounding spaces; null if unknown. */
  translate(text: string): string | null {
    if (text.length > MAX_LENGTH || !LATIN.test(text)) return null;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    if (!m || !m[2]) return null;
    const core = this.translateCore(normalizeKey(m[2]), 0);
    return core === null ? null : m[1] + core + m[3];
  }

  private translateCore(key: string, depth: number): string | null {
    if (!LATIN.test(key) || this.keep.has(key)) return null;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const result =
      this.exact.get(key) ??
      this.lookupFolded(key) ??
      this.lookupShortcut(key, depth) ??
      this.lookupDuration(key, depth) ??
      this.lookupPattern(key, depth) ??
      translateCount(key) ??
      formatDuration(key) ??
      this.lookupVerbCount(key, depth) ??
      this.lookupList(key, depth);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(key, result);
    return result;
  }

  private lookupFolded(key: string): string | null {
    const hit = this.folded.get(key.toLowerCase());
    return hit ? adaptCase(key, hit) : null;
  }

  private lookupPattern(key: string, depth: number): string | null {
    const word = firstWord(key);
    const candidates = word === "*" ? this.buckets.get("*") : [...(this.buckets.get(word) ?? []), ...(this.buckets.get("*") ?? [])];
    if (!candidates) return null;
    for (const pattern of candidates) {
      const m = pattern.re.exec(key);
      if (!m) continue;
      const out = renderMessage(pattern.message, m.slice(1), (value) => this.translateCapture(value, depth));
      return pattern.startsWithArg ? out : adaptCase(key, out);
    }
    return null;
  }

  /** A capture is translated only when it is a counted phrase or list of them. */
  private translateCapture(value: string, depth: number): string | null {
    if (depth > 2 || !/^\d/.test(value.trim())) return null;
    return translateCount(value) ?? this.lookupList(value, depth + 1);
  }

  private lookupShortcut(key: string, depth: number): string | null {
    if (depth > 2) return null;
    const m = SHORTCUT_SUFFIX.exec(key);
    if (!m) return null;
    const base = this.translateCore(m[1], depth + 1);
    return base === null ? null : base + m[2];
  }

  /** «created 17 files» → «создано: 17 файлов» when «Created» is in the dictionary. */
  private lookupVerbCount(key: string, depth: number): string | null {
    if (depth > 3) return null;
    const m = VERB_COUNT.exec(key);
    if (!m) return null;
    const verb = this.exact.get(m[1]) ?? this.lookupFolded(m[1]);
    if (!verb) return null;
    const rest = translateCount(m[2]) ?? this.lookupList(m[2], depth + 1);
    if (rest === null) return null;
    return adaptCase(key, `${verb.replace(/[:.]$/, "")}: ${rest}`);
  }

  /** «Thought (2m 38s)» → «Размышления (2 мин 38 с)». */
  private lookupDuration(key: string, depth: number): string | null {
    if (depth > 2) return null;
    const m = DURATION_SUFFIX.exec(key);
    if (!m || !(m[3] || m[4] || m[5])) return null;
    const base = this.translateCore(m[1], depth + 1);
    if (base === null) return null;
    return `${base}${m[2]}(${formatDuration(`${m[3] ?? ""}${m[4] ?? ""}${m[5] ?? ""}`)})`;
  }


  private lookupList(key: string, depth: number): string | null {
    if (depth > 2 || !key.includes(", ")) return null;
    const parts = key.split(", ");
    const out: string[] = [];
    for (const part of parts) {
      if (!LATIN.test(part)) {
        out.push(part);
        continue;
      }
      const tr = this.translateCore(part, depth + 1);
      if (tr === null) return null;
      out.push(tr);
    }
    return adaptCase(key, out.join(", "));
  }
}
