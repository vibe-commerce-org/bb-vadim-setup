// Import of the thread inventory (2026-10-10) as a seed under the rules.
//
// Accepted file shapes:
// - { asOf, source?, threads: { [threadId]: { status, task?, ask?, signals? } } }
// - the raw inventory: { [threadId]: { status, task?, ask?, signals?, source? … } }
//   where asOf comes from --as-of, or from "inventory-YYYY-MM-DD" in `source`.
// A date-only asOf means the end of that day (local time); an asOf in the
// future is refused (it would pin the seed over every later turn). A new
// import is merged over the previous seed (a row per thread); `replace`
// drops the previous seed first. Affected threads are re-classified from
// their stored inputs (no SDK calls).
//
// The file is read by the BB server, outside any agent sandbox: only files
// inside the user's home directory (after resolving symlinks) are read, and
// errors never echo the file's content.
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import { cut } from "../lib/marker.ts";
import type { Collector } from "./collector.ts";
import type { PultStore, SeedRow } from "./store.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const TEXT_MAX = 600;

const statusSchema = z.enum(["WAITING_VADIM", "IN_PROGRESS", "ABANDONED", "BLOCKED", "DONE", "CHILD_DONE"]);
const threadIdSchema = z.string().regex(/^thr_[a-z0-9]{6,40}$/);

const entrySchema = z.object({
  status: statusSchema,
  task: z.string().nullish(),
  ask: z.string().nullish(),
  signals: z.union([z.string(), z.array(z.string())]).nullish(),
  source: z.string().nullish(),
});

const wrappedSchema = z.object({
  asOf: z.union([z.string(), z.number()]),
  source: z.string().optional(),
  threads: z.record(threadIdSchema, entrySchema),
});

const flatSchema = z.record(threadIdSchema, entrySchema);

export interface SeedImportResult {
  imported: number;
  asOf: number;
  /** Threads whose classification changed (re-classified from stored inputs). */
  reclassified: number;
  /** Seed threads Pult has not scanned yet (they get the seed on their scan). */
  unknown: number;
}

/** "YYYY-MM-DD" → the end of that day, local time; ISO or ms → as is. */
export function parseAsOf(value: string | number): number {
  if (typeof value === "number") return value;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day !== null) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59, 999).getTime();
  }
  const ms = Date.parse(value);
  // Never echo the value: the file may not be an inventory at all.
  if (Number.isNaN(ms)) throw new Error("Не понял дату инвентаризации (asOf)");
  return ms;
}

function clip(text: string | null | undefined): string | null {
  const t = text?.trim() ?? "";
  return t === "" ? null : cut(t, TEXT_MAX);
}

/** Parses either file shape into seed rows; refuses an asOf after `now`. */
export function parseSeed(
  data: unknown,
  asOfOverride?: string,
  now: number = Date.now(),
): { rows: SeedRow[]; asOf: number } {
  let threads: Record<string, z.infer<typeof entrySchema>>;
  let asOfRaw: string | number | undefined = asOfOverride;
  const wrapped = wrappedSchema.safeParse(data);
  if (wrapped.success) {
    threads = wrapped.data.threads;
    asOfRaw ??= wrapped.data.asOf;
  } else {
    const flat = flatSchema.safeParse(data);
    if (!flat.success) {
      // No paths or messages from the file: keys may be anything.
      throw new Error("Файл не похож на инвентаризацию Пульта");
    }
    threads = flat.data;
    if (asOfRaw === undefined) {
      for (const entry of Object.values(threads)) {
        const match = /(\d{4}-\d{2}-\d{2})/.exec(entry.source ?? "");
        if (match !== null) {
          asOfRaw = match[1];
          break;
        }
      }
    }
  }
  if (asOfRaw === undefined) throw new Error("Нет даты инвентаризации: укажите --as-of YYYY-MM-DD");
  const parsed = parseAsOf(asOfRaw);
  // A date-only asOf is the end of that day: today's inventory is fine...
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  if (parsed > endOfToday.getTime()) throw new Error("Дата инвентаризации в будущем — не загружаю");
  // ...but it never covers the future: activity after the import always wins.
  const asOf = Math.min(parsed, now);
  const rows: SeedRow[] = Object.entries(threads).map(([threadId, entry]) => ({
    threadId,
    status: entry.status,
    ask: clip(entry.ask),
    task: clip(entry.task),
    asOf,
  }));
  return { rows, asOf };
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The real path of `path` when it is a regular file inside the home
 * directory; throws a message that tells nothing about files elsewhere.
 */
export async function resolveSeedPath(path: string, cwd: string | undefined, home: string = homedir()): Promise<string> {
  const outside = new Error("Инвентаризацию читаю только из файлов внутри домашней папки");
  const full = isAbsolute(path) ? resolve(path) : resolve(cwd ?? process.cwd(), path);
  let root: string;
  try {
    root = await realpath(home);
  } catch {
    throw outside;
  }
  // Lexical check first: no stat of anything outside home at all.
  if (!inside(resolve(home), full) && !inside(root, full)) throw outside;
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    throw new Error(`Файл не найден: ${full}`);
  }
  // Symlinks may point out of home: check the resolved path again.
  if (!inside(root, real)) throw outside;
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`Не файл: ${full}`);
  if (info.size > MAX_BYTES) throw new Error(`Файл больше ${MAX_BYTES / 1024 / 1024} МБ: ${full}`);
  return real;
}

export async function importSeedFile(
  store: PultStore,
  collector: Collector,
  path: string,
  opts: { cwd?: string; asOf?: string; replace?: boolean } = {},
): Promise<SeedImportResult> {
  const full = await resolveSeedPath(path, opts.cwd);
  let data: unknown;
  try {
    data = JSON.parse(await readFile(full, "utf8"));
  } catch {
    // Never the parser's message: it quotes the file's first characters.
    throw new Error(`Файл не JSON: ${full}`);
  }
  const { rows, asOf } = parseSeed(data, opts.asOf);
  const replace = opts.replace === true;
  const affected = new Set([...(replace ? store.seedIds() : []), ...rows.map((row) => row.threadId)]);
  store.writeSeed(rows, { replace });
  store.setMeta("seed", JSON.stringify({ path: full, asOf, count: rows.length, replace, importedAt: Date.now() }));
  const reclassified = collector.reclassify([...affected]);
  const known = store.knownThreads();
  const unknown = rows.filter((row) => !known.has(row.threadId)).length;
  return { imported: rows.length, asOf, reclassified, unknown };
}
