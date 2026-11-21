// The shared spend counter over Pi's session files — one for all budgets
// (server/budget.ts asks it for its provider).
//
// Files are read by increment (an offset per file), so three guards asking every
// minute cost three `stat`s per file and the bytes appended since. Pi writes one
// JSON line per event; lib/ledger.ts parses a line. What this module adds:
//   - the session's current model (`model_change`), because a compaction record
//     has a price but no provider — it is billed to the session's model;
//   - per provider, the latest answer with a cost and the latest suspect line (an
//     answer without a cost, a priced line that is not an answer): while a suspect
//     line is newer than the last priced answer the provider's counter says «format
//     changed?» instead of a zero — the problem is kept from scan to scan;
//   - the folders: the main one missing is an error even when the old one is there.
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { dayStart, formatMsk, weekStart } from "../lib/budget.ts";
import { parseLine, totalsFor, type CostEntry, type Totals } from "../lib/ledger.ts";

/** Where bb's Pi bridge keeps sessions: bb ≥ 0.50, and the older place (still read for this week). */
export function defaultPiSessionDirs(home = homedir()): string[] {
  return [join(home, ".bb/plugins/provider-pi/bridge-data/sessions"), join(home, ".bb/pi-bridge-sessions")];
}

/** A file read in one go at most; bigger appends are read over several scans. */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** A suspect line that names no provider is held against every provider. */
const ANY = "*";

interface FileCursor {
  offset: number;
  partial: string;
  entries: CostEntry[];
  /** Latest answer with a cost per provider, ms. */
  good: Map<string, number>;
  /** Latest suspect line per provider (or ANY), ms and why. */
  bad: Map<string, { at: number; why: string }>;
  /** The session's current model (last `model_change`) — compactions are billed to it. */
  provider: string | null;
  model: string | null;
}

export interface PiLedger {
  /** Read what was appended since the last scan. Throws when the sessions cannot be read at all. Calls are serialized. */
  scan(now: number): Promise<void>;
  /** The week's totals of one provider (after a scan). */
  totals(provider: string, now: number): Totals;
  /** Why this provider's counter must not be trusted (format changed?), or null. */
  problem(provider: string): string | null;
}

export function createPiLedger(opts: { dirs: string[]; providers: readonly string[] }): PiLedger {
  const { dirs, providers } = opts;
  const cursors = new Map<string, FileCursor>();
  const problems = new Map<string, string>();
  let chain: Promise<unknown> = Promise.resolve();

  async function scanNow(now: number): Promise<void> {
    const from = weekStart(now);
    let readable = 0;
    let primaryReadable = false;
    for (const [index, dir] of dirs.entries()) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      readable += 1;
      if (index === 0) primaryReadable = true;
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(path);
        } catch {
          continue;
        }
        if (info.mtimeMs < from) continue; // nothing of this week in it
        let cursor = cursors.get(path);
        if (cursor === undefined || info.size < cursor.offset) {
          cursor = { offset: 0, partial: "", entries: [], good: new Map(), bad: new Map(), provider: null, model: null };
          cursors.set(path, cursor);
        }
        if (info.size === cursor.offset) continue;
        const length = Math.min(info.size - cursor.offset, MAX_READ_BYTES);
        let text: string;
        try {
          const handle = await open(path, "r");
          try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
            cursor.offset += bytesRead;
            text = cursor.partial + buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
        } catch {
          continue; // gone between stat and open — the next scan finds it again (or not)
        }
        const lines = text.split("\n");
        cursor.partial = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = parseLine(line);
          if (parsed.kind === "model") {
            cursor.provider = parsed.provider;
            cursor.model = parsed.model;
          } else if (parsed.kind === "compaction") {
            // A compaction is a model call of the session's current model; unknown model — not ours to count.
            if (cursor.provider === null || !providers.includes(cursor.provider)) continue;
            cursor.entries.push({ at: parsed.at, provider: cursor.provider, model: cursor.model ?? "?", cost: parsed.cost, compaction: true });
            cursor.good.set(cursor.provider, Math.max(cursor.good.get(cursor.provider) ?? 0, parsed.at));
          } else if (parsed.kind === "cost") {
            const p = parsed.entry.provider;
            if (!providers.includes(p)) continue;
            cursor.entries.push(parsed.entry);
            cursor.good.set(p, Math.max(cursor.good.get(p) ?? 0, parsed.entry.at));
          } else if (parsed.kind === "suspect" && (parsed.provider === null || providers.includes(parsed.provider))) {
            // No time on the line — it is at least as new as this scan.
            const at = parsed.at ?? now;
            const key = parsed.provider ?? ANY;
            const held = cursor.bad.get(key);
            if (held === undefined || at >= held.at) cursor.bad.set(key, { at, why: parsed.why });
          }
        }
      }
    }
    if (readable === 0) throw new Error(`счётчик не видит файлы Pi: нет папок ${dirs.join(", ")}`);
    if (!primaryReadable) throw new Error(`нет основной папки сессий Pi (${dirs[0]}) — bb мог перенести их; счётчик не верит нулю`);
    const good = new Map<string, number>();
    const bad = new Map<string, { at: number; why: string }>();
    for (const cursor of cursors.values()) {
      cursor.entries = cursor.entries.filter((e) => e.at >= from);
      for (const [p, at] of cursor.good) good.set(p, Math.max(good.get(p) ?? 0, at));
      for (const [p, b] of cursor.bad) {
        if (b.at < from) continue;
        const held = bad.get(p);
        if (held === undefined || b.at > held.at) bad.set(p, b);
      }
    }
    // Kept from scan to scan (the cursors remember it) until a later answer with a cost clears it.
    problems.clear();
    for (const p of providers) {
      const candidates = [bad.get(p), bad.get(ANY)].filter((b): b is { at: number; why: string } => b !== undefined);
      const worst = candidates.sort((a, b) => b.at - a.at)[0];
      const last = good.get(p) ?? null;
      if (worst !== undefined && (last === null || worst.at > last)) {
        problems.set(p, `формат Pi сменился? ${worst.why} (${formatMsk(worst.at, false)} МСК) — счётчик не верит нулю`);
      }
    }
  }

  return {
    scan(now) {
      const run = chain.then(() => scanNow(now), () => scanNow(now));
      chain = run.catch(() => undefined);
      return run;
    },
    totals(provider, now) {
      const all: CostEntry[] = [];
      for (const cursor of cursors.values()) all.push(...cursor.entries);
      return totalsFor(all, { from: weekStart(now), dayFrom: dayStart(now), providers: [provider] });
    },
    problem: (provider) => problems.get(provider) ?? null,
  };
}
