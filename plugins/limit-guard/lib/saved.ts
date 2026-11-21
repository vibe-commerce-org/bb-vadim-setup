// Saved previous models and the import from the interim script — pure logic.
//
// Before switching a thread to Sonnet the guard stores its previous model and
// effort; after the weekly reset they are written back. The interim script
// (scripts/limit-guard-interim.py) keeps the same map in its state.json as
// `saved: { threadId: { model, reasoningLevel } }`. If the plugin did not take
// it over, it would remember Sonnet — set by the script — as the «previous»
// model, so entries the plugin does not have yet are merged in (never over an
// entry it has).

export interface SavedExecution {
  model: string | null;
  reasoningLevel: string | null;
  /** The guard changed only the effort (Codex keeping the thread's model): the model is not written back. */
  effortOnly?: true;
}

export type SavedMap = Record<string, SavedExecution>;

export const THREAD_ID = /^thr_[a-z0-9]{6,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value.length <= 200 ? value : undefined;
}

/** Valid entries of a saved map; anything malformed is dropped. */
export function parseSaved(value: unknown): SavedMap {
  const out: SavedMap = {};
  if (!isRecord(value)) return out;
  for (const [threadId, entry] of Object.entries(value)) {
    if (!THREAD_ID.test(threadId) || !isRecord(entry)) continue;
    const model = stringOrNull(entry.model);
    const reasoningLevel = stringOrNull(entry.reasoningLevel);
    if (model === undefined || reasoningLevel === undefined) continue;
    out[threadId] = entry.effortOnly === true ? { model, reasoningLevel, effortOnly: true } : { model, reasoningLevel };
  }
  return out;
}

/** Entries of `from` the map does not have yet. */
export function mergeSaved(into: SavedMap, from: SavedMap): { merged: SavedMap; added: number } {
  const merged: SavedMap = { ...into };
  let added = 0;
  for (const [threadId, entry] of Object.entries(from)) {
    if (threadId in merged) continue;
    merged[threadId] = entry;
    added += 1;
  }
  return { merged, added };
}

/**
 * Import the interim state file only when it changed since the last import and
 * after the last weekly reset (an older file describes a week already restored).
 */
export function shouldImport(args: { mtimeMs: number; importedMtimeMs: number | null; lastResetAt: number | null }): boolean {
  if (args.importedMtimeMs !== null && args.mtimeMs <= args.importedMtimeMs) return false;
  if (args.lastResetAt !== null && args.mtimeMs <= args.lastResetAt) return false;
  return true;
}
