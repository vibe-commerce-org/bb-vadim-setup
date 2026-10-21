// A small subset of ICU MessageFormat for the dictionary's Russian side:
//   {0}                                   — the captured text, as is
//   {0, plural, one {…} few {…} many {…} other {…}}
//                                         — a branch by the Russian plural rule
//                                           of capture 0; «#» inside is the number
// Branches may nest {N}. Anything unparsable renders literally.
import { parseCount, pluralForm } from "./nouns.ts";

type Part =
  | { kind: "text"; text: string }
  | { kind: "arg"; index: number }
  | { kind: "plural"; index: number; branches: Map<string, Part[]> };

export type Message = Part[];

/** Parse the Russian side of a template entry. */
export function parseMessage(source: string): Message {
  let pos = 0;

  function readUntilClose(): Part[] {
    const parts: Part[] = [];
    let text = "";
    const flush = () => {
      if (text) parts.push({ kind: "text", text });
      text = "";
    };
    while (pos < source.length) {
      const ch = source[pos];
      if (ch === "}") break;
      if (ch === "{") {
        const start = pos;
        const parsed = readPlaceholder();
        if (parsed) {
          flush();
          parts.push(parsed);
        } else {
          pos = start + 1;
          text += "{";
        }
        continue;
      }
      text += ch;
      pos++;
    }
    flush();
    return parts;
  }

  function readPlaceholder(): Part | null {
    // at «{»
    const m = /^\{\s*(\d+)\s*(\}|,\s*plural\s*,)/.exec(source.slice(pos));
    if (!m) return null;
    const index = Number(m[1]);
    pos += m[0].length;
    if (m[2] === "}") return { kind: "arg", index };
    const branches = new Map<string, Part[]>();
    for (;;) {
      const sel = /^\s*(zero|one|two|few|many|other|=\d+)\s*\{/.exec(source.slice(pos));
      if (!sel) break;
      pos += sel[0].length;
      const body = readUntilClose();
      if (source[pos] !== "}") return null;
      pos++; // closing «}» of the branch
      branches.set(sel[1], body);
    }
    const close = /^\s*\}/.exec(source.slice(pos));
    if (!close || branches.size === 0) return null;
    pos += close[0].length;
    return { kind: "plural", index, branches };
  }

  const parts = readUntilClose();
  // A stray «}» at the top level: keep the rest as text.
  if (pos < source.length) parts.push({ kind: "text", text: source.slice(pos) });
  return parts;
}

/**
 * Render a parsed message with captures. `mapArg` may translate a capture
 * (a counted list such as «4 lists, 1 file»); it returns null to keep it as is.
 */
export function renderMessage(message: Message, captures: readonly string[], mapArg?: (value: string) => string | null): string {
  const render = (parts: Part[], hash: string | null): string => {
    let out = "";
    for (const part of parts) {
      if (part.kind === "text") {
        out += hash === null ? part.text : part.text.replace(/#/g, hash);
      } else if (part.kind === "arg") {
        const value = captures[part.index] ?? "";
        out += mapArg?.(value) ?? value;
      } else {
        const raw = captures[part.index] ?? "";
        const count = parseCount(raw);
        const exact = count === null ? undefined : part.branches.get(`=${count}`);
        const branch =
          exact ??
          (count === null
            ? part.branches.get("other") ?? part.branches.get("many")
            : pluralForm(
                count,
                part.branches.get("one") ?? part.branches.get("other"),
                part.branches.get("few") ?? part.branches.get("other"),
                part.branches.get("many") ?? part.branches.get("other"),
              ));
        out += branch ? render(branch, raw.replace(/,/g, " ")) : raw;
      }
    }
    return out;
  };
  return render(message, null);
}

/** Placeholder indexes a message uses, for dictionary checks. */
export function messageArgs(message: Message): Set<number> {
  const found = new Set<number>();
  const walk = (parts: Part[]) => {
    for (const part of parts) {
      if (part.kind === "arg") found.add(part.index);
      else if (part.kind === "plural") {
        found.add(part.index);
        for (const branch of part.branches.values()) walk(branch);
      }
    }
  };
  walk(message);
  return found;
}
