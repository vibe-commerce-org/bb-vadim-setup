// Pult's own SQLite store (bb.storage.database()): thread snapshots, the user's
// overlays (snooze / dismiss / task link), lane memory, the inventory seed,
// git state of projects, LLM triage results and small meta values.
//
// The host closes the database handle on reload, so every operation asks
// bb.storage.database() again (cheap: the same handle for the whole load).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LaneMemory } from "../lib/lanes.ts";
import type {
  Classification,
  ClassifyInput,
  GitState,
  Lane,
  Overlay,
  ThreadSnapshot,
} from "../lib/types.ts";

/** Append-only: never edit or reorder shipped statements. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS snapshots (
     thread_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     json TEXT NOT NULL,
     input_json TEXT,
     fingerprint TEXT,
     updated_at INTEGER NOT NULL,
     last_agent_at INTEGER,
     archived INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS snapshots_project ON snapshots (project_id)`,
  `CREATE TABLE IF NOT EXISTS overlays (
     thread_id TEXT PRIMARY KEY,
     snoozed_until INTEGER,
     snoozed_at INTEGER,
     dismissed_at INTEGER,
     task_key TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS lane_memory (
     task_id TEXT PRIMARY KEY,
     lane TEXT NOT NULL,
     since INTEGER NOT NULL,
     approx INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seed (
     thread_id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     ask TEXT,
     task TEXT,
     as_of INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS git_state (
     project_id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     checked_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS llm_triage (
     thread_id TEXT PRIMARY KEY,
     last_agent_at INTEGER,
     json TEXT,
     triaged_at INTEGER NOT NULL
   )`,
];

/** What the classifier saw for a thread, kept to re-classify without I/O. */
export interface StoredInput extends Omit<ClassifyInput, "now"> {
  /** seq of the latest turn/completed event, to skip re-reading the output. */
  turnSeq: number | null;
  /**
   * The model and the reasoning level of the thread's latest turn, as the
   * provider names them; `modelLabel` is BB's name for that model. Read from
   * rows stored before 29.10 they are missing, hence the `?? null` at the
   * place they are read.
   */
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
}

export type SeedStatus =
  | "WAITING_VADIM"
  | "IN_PROGRESS"
  | "ABANDONED"
  | "BLOCKED"
  | "DONE"
  | "CHILD_DONE";

export interface SeedRow {
  threadId: string;
  status: SeedStatus;
  ask: string | null;
  task: string | null;
  /** The inventory covers activity up to this time (ms). */
  asOf: number;
}

export interface LlmRow {
  threadId: string;
  lastAgentAt: number | null;
  /** null when the model was asked but gave nothing usable. */
  classification: Classification | null;
  triagedAt: number;
}

export interface KnownThread {
  fingerprint: string | null;
  archived: boolean;
}

function parseJson<T>(text: string | null | undefined): T | null {
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function emptyOverlay(threadId: string): Overlay {
  return { threadId, snoozedUntil: null, snoozedAt: null, dismissedAt: null, taskKey: null };
}

export function createStore(bb: BbPluginApi) {
  const db = () => bb.storage.database();

  function getOverlay(threadId: string): Overlay {
    const row = db().prepare("SELECT * FROM overlays WHERE thread_id = ?").get(threadId) as
      | {
          snoozed_until: number | null;
          snoozed_at: number | null;
          dismissed_at: number | null;
          task_key: string | null;
        }
      | undefined;
    if (row === undefined) return emptyOverlay(threadId);
    return {
      threadId,
      snoozedUntil: row.snoozed_until,
      snoozedAt: row.snoozed_at,
      dismissedAt: row.dismissed_at,
      taskKey: row.task_key,
    };
  }

  function getLaneMemory(): Map<string, LaneMemory> {
    const rows = db().prepare("SELECT * FROM lane_memory").all() as {
      task_id: string;
      lane: Lane;
      since: number;
      approx: number;
    }[];
    return new Map(
      rows.map((row) => [row.task_id, { lane: row.lane, since: row.since, approx: row.approx === 1 }]),
    );
  }

  function setLane(taskId: string, memory: LaneMemory): void {
    db()
      .prepare(
        `INSERT INTO lane_memory (task_id, lane, since, approx) VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET lane = excluded.lane, since = excluded.since,
           approx = excluded.approx`,
      )
      .run(taskId, memory.lane, memory.since, memory.approx ? 1 : 0);
  }

  return {
    migrate(): void {
      bb.storage.migrate(db(), MIGRATIONS);
    },

    // ── snapshots ──────────────────────────────────────────────────────
    getSnapshot(threadId: string): ThreadSnapshot | null {
      const row = db().prepare("SELECT json FROM snapshots WHERE thread_id = ?").get(threadId) as
        | { json: string }
        | undefined;
      return parseJson<ThreadSnapshot>(row?.json);
    },

    getStoredInput(threadId: string): StoredInput | null {
      const row = db()
        .prepare("SELECT input_json FROM snapshots WHERE thread_id = ?")
        .get(threadId) as { input_json: string | null } | undefined;
      return parseJson<StoredInput>(row?.input_json);
    },

    /** Snapshots, archived ones excluded unless asked. */
    listSnapshots(opts: { includeArchived?: boolean } = {}): ThreadSnapshot[] {
      const sql = opts.includeArchived
        ? "SELECT json FROM snapshots"
        : "SELECT json FROM snapshots WHERE archived = 0";
      const rows = db().prepare(sql).all() as { json: string }[];
      const out: ThreadSnapshot[] = [];
      for (const row of rows) {
        const snapshot = parseJson<ThreadSnapshot>(row.json);
        if (snapshot !== null) out.push(snapshot);
      }
      return out;
    },

    /** Thread ids with stored inputs, for re-classification without I/O. */
    listStored(): { snapshot: ThreadSnapshot; input: StoredInput }[] {
      const rows = db()
        .prepare("SELECT json, input_json FROM snapshots WHERE archived = 0 AND input_json IS NOT NULL")
        .all() as { json: string; input_json: string }[];
      const out: { snapshot: ThreadSnapshot; input: StoredInput }[] = [];
      for (const row of rows) {
        const snapshot = parseJson<ThreadSnapshot>(row.json);
        const input = parseJson<StoredInput>(row.input_json);
        if (snapshot !== null && input !== null) out.push({ snapshot, input });
      }
      return out;
    },

    knownThreads(): Map<string, KnownThread> {
      const rows = db().prepare("SELECT thread_id, fingerprint, archived FROM snapshots").all() as {
        thread_id: string;
        fingerprint: string | null;
        archived: number;
      }[];
      return new Map(
        rows.map((row) => [row.thread_id, { fingerprint: row.fingerprint, archived: row.archived === 1 }]),
      );
    },

    countLive(): number {
      const row = db().prepare("SELECT count(*) AS n FROM snapshots WHERE archived = 0").get() as {
        n: number;
      };
      return row.n;
    },

    putSnapshot(snapshot: ThreadSnapshot, input: StoredInput | null, fingerprint: string | null): void {
      db()
        .prepare(
          `INSERT INTO snapshots (thread_id, project_id, json, input_json, fingerprint, updated_at, last_agent_at, archived)
           VALUES (@threadId, @projectId, @json, @input, @fingerprint, @updatedAt, @lastAgentAt, @archived)
           ON CONFLICT(thread_id) DO UPDATE SET
             project_id = excluded.project_id, json = excluded.json,
             input_json = COALESCE(excluded.input_json, snapshots.input_json),
             fingerprint = COALESCE(excluded.fingerprint, snapshots.fingerprint),
             updated_at = excluded.updated_at, last_agent_at = excluded.last_agent_at,
             archived = excluded.archived`,
        )
        .run({
          threadId: snapshot.threadId,
          projectId: snapshot.projectId,
          json: JSON.stringify(snapshot),
          input: input === null ? null : JSON.stringify(input),
          fingerprint,
          updatedAt: snapshot.updatedAt,
          lastAgentAt: snapshot.lastAgentAt,
          archived: snapshot.archived ? 1 : 0,
        });
    },

    /** Marks snapshots archived (or not); returns how many changed. */
    setArchived(threadIds: readonly string[], archived: boolean): number {
      if (threadIds.length === 0) return 0;
      const read = db().prepare("SELECT json FROM snapshots WHERE thread_id = ?");
      const write = db().prepare(
        "UPDATE snapshots SET json = ?, archived = ?, fingerprint = NULL WHERE thread_id = ?",
      );
      let changed = 0;
      db().transaction(() => {
        for (const threadId of threadIds) {
          const row = read.get(threadId) as { json: string } | undefined;
          const snapshot = parseJson<ThreadSnapshot>(row?.json);
          if (snapshot === null || snapshot.archived === archived) continue;
          snapshot.archived = archived;
          write.run(JSON.stringify(snapshot), archived ? 1 : 0, threadId);
          changed += 1;
        }
      })();
      return changed;
    },

    deleteSnapshot(threadId: string): void {
      db().prepare("DELETE FROM snapshots WHERE thread_id = ?").run(threadId);
    },

    /**
     * Forgets a deleted thread: its snapshot (agent text included), the user's
     * overlay and the LLM triage rows. Returns true when anything was stored.
     */
    deleteThreadData(threadId: string): boolean {
      let removed = 0;
      db().transaction(() => {
        for (const table of ["snapshots", "overlays", "llm_triage"] as const) {
          removed += db().prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(threadId).changes;
        }
      })();
      return removed > 0;
    },

    // ── overlays ───────────────────────────────────────────────────────
    getOverlays(): Map<string, Overlay> {
      const rows = db().prepare("SELECT * FROM overlays").all() as {
        thread_id: string;
        snoozed_until: number | null;
        snoozed_at: number | null;
        dismissed_at: number | null;
        task_key: string | null;
      }[];
      return new Map(
        rows.map((row) => [
          row.thread_id,
          {
            threadId: row.thread_id,
            snoozedUntil: row.snoozed_until,
            snoozedAt: row.snoozed_at,
            dismissedAt: row.dismissed_at,
            taskKey: row.task_key,
          },
        ]),
      );
    },

    getOverlay,

    /** Merges `patch` into the thread's overlay. */
    patchOverlay(threadId: string, patch: Partial<Omit<Overlay, "threadId">>): Overlay {
      const next: Overlay = { ...getOverlay(threadId), ...patch, threadId };
      db()
        .prepare(
          `INSERT INTO overlays (thread_id, snoozed_until, snoozed_at, dismissed_at, task_key)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET snoozed_until = excluded.snoozed_until,
             snoozed_at = excluded.snoozed_at, dismissed_at = excluded.dismissed_at,
             task_key = excluded.task_key`,
        )
        .run(next.threadId, next.snoozedUntil, next.snoozedAt, next.dismissedAt, next.taskKey);
      return next;
    },

    // ── lane memory ────────────────────────────────────────────────────
    getLaneMemory,

    setLane,

    /**
     * Writes back only entries that differ from what is stored. With prune,
     * `memory` is the full set of open tasks: entries of other tasks (closed,
     * deleted) are dropped, so a reopened task does not inherit an old since.
     */
    saveLaneMemory(memory: ReadonlyMap<string, LaneMemory>, opts: { prune?: boolean } = {}): void {
      const current = getLaneMemory();
      const remove = db().prepare("DELETE FROM lane_memory WHERE task_id = ?");
      db().transaction(() => {
        if (opts.prune === true) {
          for (const taskId of current.keys()) if (!memory.has(taskId)) remove.run(taskId);
        }
        for (const [taskId, next] of memory) {
          const prev = current.get(taskId);
          if (
            prev !== undefined &&
            prev.lane === next.lane &&
            prev.since === next.since &&
            prev.approx === next.approx
          ) {
            continue;
          }
          setLane(taskId, next);
        }
      })();
    },

    // ── seed ───────────────────────────────────────────────────────────
    getSeed(threadId: string): SeedRow | null {
      const row = db().prepare("SELECT * FROM seed WHERE thread_id = ?").get(threadId) as
        | { status: SeedStatus; ask: string | null; task: string | null; as_of: number }
        | undefined;
      if (row === undefined) return null;
      return { threadId, status: row.status, ask: row.ask, task: row.task, asOf: row.as_of };
    },

    seedIds(): string[] {
      return (db().prepare("SELECT thread_id FROM seed").all() as { thread_id: string }[]).map(
        (row) => row.thread_id,
      );
    },

    /**
     * Writes seed rows: merged over the stored ones (a row per thread, the
     * imported one wins), or, with replace, instead of all of them.
     */
    writeSeed(rows: readonly SeedRow[], opts: { replace: boolean }): void {
      const upsert = db().prepare(
        `INSERT INTO seed (thread_id, status, ask, task, as_of) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, ask = excluded.ask,
           task = excluded.task, as_of = excluded.as_of`,
      );
      db().transaction(() => {
        if (opts.replace) db().prepare("DELETE FROM seed").run();
        for (const row of rows) upsert.run(row.threadId, row.status, row.ask, row.task, row.asOf);
      })();
    },

    /** The newest as-of time (ms) among stored seed rows, null without a seed. */
    seedAsOf(): number | null {
      const row = db().prepare("SELECT max(as_of) AS asOf FROM seed").get() as { asOf: number | null };
      return row.asOf ?? null;
    },

    // ── git ────────────────────────────────────────────────────────────
    getGitStates(): Map<string, GitState> {
      const rows = db().prepare("SELECT project_id, json FROM git_state").all() as {
        project_id: string;
        json: string;
      }[];
      const out = new Map<string, GitState>();
      for (const row of rows) {
        const state = parseJson<GitState>(row.json);
        if (state !== null) out.set(row.project_id, state);
      }
      return out;
    },

    putGitState(state: GitState): void {
      db()
        .prepare(
          `INSERT INTO git_state (project_id, json, checked_at) VALUES (?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at`,
        )
        .run(state.projectId, JSON.stringify(state), state.checkedAt);
    },

    // ── llm triage ─────────────────────────────────────────────────────
    getLlm(threadId: string): LlmRow | null {
      const row = db().prepare("SELECT * FROM llm_triage WHERE thread_id = ?").get(threadId) as
        | { last_agent_at: number | null; json: string | null; triaged_at: number }
        | undefined;
      if (row === undefined) return null;
      return {
        threadId,
        lastAgentAt: row.last_agent_at,
        classification: parseJson<Classification>(row.json),
        triagedAt: row.triaged_at,
      };
    },

    putLlm(row: LlmRow): void {
      db()
        .prepare(
          `INSERT INTO llm_triage (thread_id, last_agent_at, json, triaged_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET last_agent_at = excluded.last_agent_at,
             json = excluded.json, triaged_at = excluded.triaged_at`,
        )
        .run(
          row.threadId,
          row.lastAgentAt,
          row.classification === null ? null : JSON.stringify(row.classification),
          row.triagedAt,
        );
    },

    // ── meta ───────────────────────────────────────────────────────────
    getMeta(key: string): string | null {
      const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },

    setMeta(key: string, value: string): void {
      db()
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    },
  };
}

export type PultStore = ReturnType<typeof createStore>;

// ── small async helpers shared by the backend modules ──────────────────

/** Runs `fn` over `items` with at most `limit` in flight; keeps order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A signal that aborts after `ms` or when `parent` aborts. */
export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
