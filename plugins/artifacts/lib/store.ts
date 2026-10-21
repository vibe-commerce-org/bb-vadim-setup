import type Database from "better-sqlite3";
import type { Artifact } from "../rpc.ts";
import { newArtifactId, normalizeInput, parseArtifact, sortArtifacts, type ArtifactInput, type ArtifactPatch } from "./model.ts";

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     title TEXT NOT NULL,
     kind TEXT NOT NULL,
     icon TEXT NOT NULL,
     description TEXT NOT NULL,
     target_json TEXT NOT NULL,
     sort_order INTEGER NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS artifacts_thread ON artifacts (thread_id, archived, pinned, sort_order, updated_at)",
];

type Row = {
  id: string; thread_id: string; title: string; kind: Artifact["kind"]; icon: string; description: string;
  target_json: string; sort_order: number; pinned: number; archived: number; created_at: number; updated_at: number;
};

function fromRow(row: Row): Artifact {
  return parseArtifact({
    id: row.id, threadId: row.thread_id, title: row.title, kind: row.kind, icon: row.icon,
    description: row.description, target: JSON.parse(row.target_json), sortOrder: row.sort_order,
    pinned: row.pinned === 1, archived: row.archived === 1, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

export function createArtifactStore(db: Database.Database) {
  const listStmt = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND (? = 1 OR archived = 0)");
  const byIdStmt = db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND id = ?");

  const list = (threadId: string, includeArchived = false): Artifact[] => sortArtifacts((listStmt.all(threadId, includeArchived ? 1 : 0) as Row[]).map(fromRow));
  const get = (threadId: string, id: string): Artifact | null => {
    const row = byIdStmt.get(threadId, id) as Row | undefined;
    return row === undefined ? null : fromRow(row);
  };

  const insert = db.transaction((input: ArtifactInput): Artifact => {
    const now = Date.now();
    const current = list(input.threadId, true);
    if (current.length >= 200) throw new Error("В одном треде можно хранить не больше 200 артефактов");
    const normalized = normalizeInput(input, current.length === 0 ? 0 : Math.max(...current.map((item) => item.sortOrder)) + 1);
    const id = newArtifactId();
    db.prepare("INSERT INTO artifacts (id, thread_id, title, kind, icon, description, target_json, sort_order, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)")
      .run(id, normalized.threadId, normalized.title, normalized.kind, normalized.icon, normalized.description, JSON.stringify(normalized.target), normalized.sortOrder, now, now);
    return get(input.threadId, id)!;
  });

  const update = db.transaction((threadId: string, id: string, patch: ArtifactPatch): Artifact => {
    const current = get(threadId, id);
    if (current === null) throw new Error("Артефакт не найден в этом треде");
    const next = {
      ...current,
      ...patch,
      target: patch.target ?? current.target,
      updatedAt: Date.now(),
    };
    const normalized = normalizeInput({ ...next, sortOrder: next.sortOrder }, next.sortOrder);
    db.prepare("UPDATE artifacts SET title=?, kind=?, icon=?, description=?, target_json=?, sort_order=?, updated_at=? WHERE thread_id=? AND id=?")
      .run(normalized.title, normalized.kind, normalized.icon, normalized.description, JSON.stringify(normalized.target), normalized.sortOrder, next.updatedAt, threadId, id);
    return get(threadId, id)!;
  });

  const state = db.transaction((threadId: string, id: string, patch: { pinned?: boolean; archived?: boolean; sortOrder?: number }): Artifact => {
    const current = get(threadId, id);
    if (current === null) throw new Error("Артефакт не найден в этом треде");
    db.prepare("UPDATE artifacts SET pinned=COALESCE(?, pinned), archived=COALESCE(?, archived), sort_order=COALESCE(?, sort_order), updated_at=? WHERE thread_id=? AND id=?")
      .run(patch.pinned === undefined ? null : patch.pinned ? 1 : 0, patch.archived === undefined ? null : patch.archived ? 1 : 0, patch.sortOrder ?? null, Date.now(), threadId, id);
    return get(threadId, id)!;
  });

  const remove = db.transaction((threadId: string, id: string): void => {
    const result = db.prepare("DELETE FROM artifacts WHERE thread_id=? AND id=?").run(threadId, id);
    if (result.changes === 0) throw new Error("Артефакт не найден в этом треде");
  });

  return { list, get, insert, update, state, remove };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
