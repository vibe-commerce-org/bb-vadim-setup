// BB Tasks through the built-in tasks plugin's RPC
// (bb.sdk.plugins.callRpc({ pluginId: "tasks", … })). The methods are not
// discoverable but answer; their schemas were read from
// bb-app/server/dist/builtin-plugins/tasks/dist/server.js (BB 0.46.0):
// - a tracker project links to a BB project by `linkedBbProjectId`
//   (the «BB PROJECT» column of `bb tasks project list`);
// - createProject { name, prefix /^[A-Z][A-Z0-9]{0,9}$/, color, folderId,
//   linkedBbProjectId } → { project };
// - createTask / updateTask → { ok: true, task } | { ok: false, error };
// - dates are ISO strings; a thread mention in markdown is
//   [label](bbthread://<thread id>).
import type { BbPluginApi, PluginBbSdk } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { cut } from "../lib/marker.ts";
import { laneToPriority, priorityToLane } from "../lib/lanes.ts";
import type {
  Lane,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  ThreadSnapshot,
  WaitingKind,
} from "../lib/types.ts";
import { errorText, mapLimit, timeoutSignal, type PultStore } from "./store.ts";

const PLUGIN = "tasks";
const CALL_TIMEOUT_MS = 15_000;
const CACHE_MS = 20_000;
const UNAVAILABLE_RETRY_MS = 60_000;
const OPEN_STATUSES: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review"];
const MAX_TASKS = 1_000;

type RpcInput = Parameters<PluginBbSdk["plugins"]["callRpc"]>[0]["input"];

const statusSchema = z.enum(["backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
const prioritySchema = z.enum(["urgent", "high", "medium", "low", "none"]);

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  linkedBbProjectId: z.string().nullable().optional(),
});
type TrackerProject = z.infer<typeof projectSchema>;

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  status: statusSchema,
  priority: prioritySchema,
  dueDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type RawTask = z.infer<typeof taskSchema>;

const taskThreadSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  liveStatus: z.string(),
  updatedAt: z.string(),
});

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string().optional(), message: z.string().optional() }),
});
const taskResultSchema = z.union([z.object({ ok: z.literal(true), task: taskSchema }), failureSchema]);

export interface TasksDeps {
  /** Waiting kinds of threads visible in the queue right now. */
  visibleWaiting(): Map<string, WaitingKind>;
  snapshot(threadId: string): ThreadSnapshot | null;
  onChange(): void;
}

export interface OpenTasks {
  available: boolean;
  tasks: TaskRecord[];
}

function isoToMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

// ── prefixes for new tracker projects ──────────────────────────────────

const TRANSLIT: Record<string, string> = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "E", Ж: "ZH", З: "Z", И: "I", Й: "Y",
  К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T", У: "U", Ф: "F",
  Х: "KH", Ц: "TS", Ч: "CH", Ш: "SH", Щ: "SCH", Ъ: "", Ы: "Y", Ь: "", Э: "E", Ю: "YU", Я: "YA",
};

function prefixWords(name: string): string[] {
  const latin = [...name.toUpperCase()].map((ch) => TRANSLIT[ch] ?? ch).join("");
  const words = latin
    .split(/[^A-Z0-9]+/)
    .map((word) => word.replace(/[^A-Z]/g, ""))
    .filter((word) => word.length > 0);
  // The user's repos are all "<name>_code": the suffix carries no meaning.
  const meaningful = words.filter((word) => word !== "CODE");
  return meaningful.length > 0 ? meaningful : words;
}

/** Candidate prefixes for a project name: 2–5 Latin capitals, best first. */
export function prefixCandidates(name: string): string[] {
  const words = prefixWords(name);
  const out: string[] = [];
  const first = words[0] ?? "";
  if (words.length >= 2) {
    out.push(words.map((word) => word[0]).join("").slice(0, 5));
    out.push((first.slice(0, 2) + (words[1] ?? "").slice(0, 1)).slice(0, 5));
  }
  for (const n of [3, 4, 2, 5]) if (first.length >= n) out.push(first.slice(0, n));
  const consonants = first.slice(0, 1) + first.slice(1).replace(/[AEIOUY]/g, "");
  for (const n of [3, 4, 2]) if (consonants.length >= n) out.push(consonants.slice(0, n));
  return [...new Set(out)].filter((prefix) => /^[A-Z]{2,5}$/.test(prefix));
}

/** The first free candidate, else a base plus a letter (ORCA, ORCB…). */
export function pickPrefix(name: string, taken: ReadonlySet<string>): string {
  const candidates = prefixCandidates(name);
  for (const candidate of candidates) if (!taken.has(candidate)) return candidate;
  const base = (candidates[0] ?? "PRJ").slice(0, 3).padEnd(2, "X");
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) {
    if (!taken.has(base + a)) return base + a;
  }
  for (const a of letters) {
    for (const b of letters) if (!taken.has(base.slice(0, 3) + a + b)) return base.slice(0, 3) + a + b;
  }
  throw new Error(`Не нашёл свободный префикс для «${name}»`);
}

// ── the service ────────────────────────────────────────────────────────

export function createTasks(bb: BbPluginApi, store: PultStore, deps: TasksDeps) {
  let cache: { at: number; value: OpenTasks } | null = null;
  let unavailableUntil = 0;

  async function call<T>(method: string, input: RpcInput, schema: z.ZodType<T>): Promise<T> {
    return bb.sdk.plugins.callRpc({
      pluginId: PLUGIN,
      method,
      input,
      outputSchema: schema,
      signal: timeoutSignal(CALL_TIMEOUT_MS),
    });
  }

  function invalidate(): void {
    cache = null;
  }

  async function listProjects(): Promise<TrackerProject[]> {
    const result = await call("listProjects", {}, z.object({ projects: z.array(projectSchema) }));
    return result.projects;
  }

  async function fetchOpenTasks(): Promise<OpenTasks> {
    try {
      return await fetchOpenTasksOrThrow();
    } catch (error) {
      unavailableUntil = Date.now() + UNAVAILABLE_RETRY_MS;
      bb.log.warn(`tasks plugin unavailable: ${errorText(error)}`);
      return { available: false, tasks: [] };
    }
  }

  async function fetchOpenTasksOrThrow(): Promise<OpenTasks> {
    const projects = await listProjects();
    const byId = new Map(projects.map((project) => [project.id, project]));

    const raw: RawTask[] = [];
    let cursor: string | null = null;
    do {
      const page: { tasks: RawTask[]; nextCursor: string | null } = await call(
        "listTasks",
        cursor === null
          ? { statuses: OPEN_STATUSES, limit: 500 }
          : { statuses: OPEN_STATUSES, limit: 500, cursor },
        z.object({ tasks: z.array(taskSchema), nextCursor: z.string().nullable() }),
      );
      raw.push(...page.tasks);
      cursor = page.nextCursor;
    } while (cursor !== null && raw.length < MAX_TASKS);

    const waiting = deps.visibleWaiting();
    const tasks = await mapLimit(raw, 4, async (task): Promise<TaskRecord> => {
      let threads: z.infer<typeof taskThreadSchema>[] = [];
      try {
        threads = (
          await call("listTaskThreads", { taskId: task.id }, z.object({ taskThreads: z.array(taskThreadSchema) }))
        ).taskThreads;
      } catch (error) {
        bb.log.warn(`listTaskThreads ${task.key} failed: ${errorText(error)}`);
      }
      const project = byId.get(task.projectId);
      return {
        id: task.id,
        key: task.key,
        title: task.title,
        status: task.status,
        priority: task.priority,
        dueDate: task.dueDate,
        createdAt: isoToMs(task.createdAt),
        updatedAt: isoToMs(task.updatedAt),
        trackerProjectId: task.projectId,
        trackerProjectName: project?.name ?? "",
        bbProjectId: project?.linkedBbProjectId ?? null,
        threads: threads.map((thread) => {
          const snapshot = deps.snapshot(thread.threadId);
          let lastActivityAt: number | null = isoToMs(thread.updatedAt) || null;
          if (snapshot !== null) {
            const known = Math.max(snapshot.lastAgentAt ?? 0, snapshot.lastHumanAt ?? 0);
            lastActivityAt = known > 0 ? known : snapshot.updatedAt;
          }
          return {
            threadId: thread.threadId,
            title: snapshot?.title ?? thread.title,
            liveStatus: thread.liveStatus,
            queueKind: waiting.get(thread.threadId) ?? null,
            lastActivityAt,
          };
        }),
      };
    });
    return { available: true, tasks };
  }

  /** Open tasks (backlog…in_review) with their threads; cached ~20 s. */
  async function listOpenTasks(): Promise<OpenTasks> {
    const now = Date.now();
    if (cache !== null && now - cache.at < CACHE_MS) return cache.value;
    if (now < unavailableUntil) return { available: false, tasks: [] };
    const value = await fetchOpenTasks();
    cache = { at: now, value };
    return value;
  }

  async function getTask(taskId: string): Promise<RawTask | null> {
    return (await call("getTask", { taskId }, z.object({ task: taskSchema.nullable() }))).task;
  }

  async function getTaskByKey(taskKey: string): Promise<RawTask | null> {
    return (await call("getTaskByKey", { taskKey }, z.object({ task: taskSchema.nullable() }))).task;
  }

  async function updateTask(input: {
    taskId: string;
    priority?: TaskPriority;
    status?: TaskStatus;
  }): Promise<RawTask> {
    const result = await call("updateTask", { ...input, authorName: "Пульт" }, taskResultSchema);
    if (!result.ok) throw new Error(`BB Tasks: ${result.error.message ?? result.error.code ?? "ошибка"}`);
    return result.task;
  }

  /**
   * Changes the task's priority to the lane's one and remembers the move. A
   * task already in that lane is left as it is (its lane age included).
   */
  async function moveLane(taskId: string, lane: Lane): Promise<RawTask> {
    const task = await getTask(taskId);
    if (task === null) throw new Error(`Задача не найдена: ${taskId}`);
    if (priorityToLane(task.priority) === lane) return task;
    const updated = await updateTask({ taskId, priority: laneToPriority(lane, task.priority) });
    store.setLane(taskId, { lane, since: Date.now(), approx: false });
    invalidate();
    deps.onChange();
    return updated;
  }

  async function markDone(taskId: string): Promise<RawTask> {
    const updated = await updateTask({ taskId, status: "done" });
    invalidate();
    deps.onChange();
    return updated;
  }

  /**
   * «В архив»: the user no longer wants the task — status «canceled», not
   * «done» (BB Tasks shows it as Canceled). Returns the threads attached to
   * it; when BB Tasks does not list them, none — the task is archived anyway.
   */
  async function archive(taskId: string): Promise<{ task: RawTask; threadIds: string[] }> {
    let threadIds: string[] = [];
    try {
      threadIds = (
        await call("listTaskThreads", { taskId }, z.object({ taskThreads: z.array(taskThreadSchema) }))
      ).taskThreads.map((thread) => thread.threadId);
    } catch (error) {
      bb.log.warn(`listTaskThreads ${taskId} failed: ${errorText(error)}`);
    }
    const updated = await updateTask({ taskId, status: "canceled" });
    invalidate();
    deps.onChange();
    return { task: updated, threadIds };
  }

  /** The tracker project linked to a BB project, created when missing. */
  async function trackerFor(bbProjectId: string, bbProjectName: string): Promise<TrackerProject> {
    const projects = await listProjects();
    const linked = projects.find((project) => project.linkedBbProjectId === bbProjectId);
    if (linked !== undefined) return linked;
    const prefix = pickPrefix(bbProjectName, new Set(projects.map((project) => project.prefix.toUpperCase())));
    const name = bbProjectName.trim() || prefix;
    const created = await call(
      "createProject",
      { name, prefix, color: "blue", folderId: null, linkedBbProjectId: bbProjectId },
      z.object({ project: projectSchema }),
    );
    bb.log.info(`created tracker project ${created.project.prefix} for ${bbProjectId}`);
    return created.project;
  }

  /** An open task the thread is attached to (through Pult, BB Tasks or `bb tasks attach`). */
  async function openTaskWithThread(threadId: string): Promise<TaskRecord | null> {
    const fresh = cache !== null && cache.value.available && Date.now() - cache.at < CACHE_MS;
    // Throws when BB Tasks does not answer: better no task than a duplicate.
    const open = fresh ? cache!.value : await fetchOpenTasksOrThrow();
    return open.tasks.find((task) => task.threads.some((ref) => ref.threadId === threadId)) ?? null;
  }

  /**
   * Files a thread as a task in a lane. A thread already attached to an open
   * task — filed from Pult before, or attached in BB Tasks — moves that task
   * to the lane instead of getting a second one. Errors of BB Tasks are not
   * taken for «no such task».
   */
  async function fileThread(threadId: string, lane: Lane, title?: string): Promise<string> {
    const overlay = store.getOverlay(threadId);
    if (overlay.taskKey !== null) {
      const existing = await getTaskByKey(overlay.taskKey);
      if (existing !== null && existing.status !== "done" && existing.status !== "canceled") {
        await moveLane(existing.id, lane);
        return existing.key;
      }
    }
    const attached = await openTaskWithThread(threadId);
    if (attached !== null) {
      await moveLane(attached.id, lane);
      if (overlay.taskKey !== attached.key) store.patchOverlay(threadId, { taskKey: attached.key });
      invalidate();
      deps.onChange();
      return attached.key;
    }

    const snapshot = deps.snapshot(threadId);
    let bbProjectId = snapshot?.projectId ?? null;
    let threadTitle = snapshot?.title ?? null;
    let projectName = snapshot?.projectName ?? null;
    if (bbProjectId === null) {
      const thread = await bb.sdk.threads.get({ threadId, signal: timeoutSignal(CALL_TIMEOUT_MS) });
      bbProjectId = thread.projectId;
      threadTitle = thread.title ?? thread.titleFallback ?? "Без названия";
      const project = await bb.sdk.projects.get({ projectId: thread.projectId });
      projectName = project.name;
    }
    const tracker = await trackerFor(bbProjectId, projectName ?? bbProjectId);

    const taskTitle = cut((title ?? threadTitle ?? "Тред").trim(), 200) || "Тред";
    const label = (threadTitle ?? threadId).replace(/[[\]]/g, "");
    const lines = [`Тред: [${label}](bbthread://${threadId})`];
    const ask = snapshot?.classification.ask ?? null;
    if (ask !== null) lines.push("", `Что нужно: ${ask}`);
    const created = await call(
      "createTask",
      {
        projectId: tracker.id,
        title: taskTitle,
        description: lines.join("\n"),
        status: "todo",
        priority: laneToPriority(lane, "medium"),
      },
      taskResultSchema,
    );
    if (!created.ok) throw new Error(`BB Tasks: ${created.error.message ?? created.error.code ?? "ошибка"}`);
    const task = created.task;

    try {
      await call("taskThreadsAttach", { taskId: task.id, threadId }, z.object({ threadId: z.string() }));
    } catch (error) {
      bb.log.warn(`taskThreadsAttach ${task.key} ← ${threadId} failed: ${errorText(error)}`);
    }
    store.patchOverlay(threadId, { taskKey: task.key });
    store.setLane(task.id, { lane, since: Date.now(), approx: false });
    invalidate();
    deps.onChange();
    return task.key;
  }

  return { listOpenTasks, getTaskByKey, moveLane, markDone, archive, fileThread, invalidate };
}

export type PultTasks = ReturnType<typeof createTasks>;
