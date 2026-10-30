// Backend of Pult on a fake BB host (@get-bb/plugin-sdk/testing): the scan
// reads the right events, the seed and overlays land, nothing ever writes
// into a thread, hiding refuses approvals and the caller's own thread, a
// thread is filed as a task in the right tracker project (once), a deleted
// thread leaves nothing behind. Pure helpers are tested directly.
// Tests that need lib/queue.ts or lib/lanes.ts skip while those are stubs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { laneToPriority } from "../lib/lanes.ts";
import { buildQueue } from "../lib/queue.ts";
import plugin from "../server.ts";
import { parseSnooze } from "../server/cli.ts";
import { applySeed, latestExecution, toPendingInfo, vadimLastMessageAt } from "../server/collector.ts";
import { pickMainEnvironment } from "../server/git.ts";
import { parseAnswer } from "../server/llm.ts";
import { parseSeed, resolveSeedPath } from "../server/seed.ts";
import { pickPrefix, prefixCandidates } from "../server/tasks.ts";

function works(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}
const queueReady = works(() => buildQueue([], new Map(), 0));
const lanesReady = works(() => laneToPriority("now", "none"));

const T0 = Date.parse("2026-10-12T10:00:00+03:00");
const A = "thr_aaaaaaaaaa";
const B = "thr_bbbbbbbbbb";
const HIDDEN = "thr_hhhhhhhhhh";
const PROJECT = "proj_fixture01";

function listRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    archivedAt: null,
    createdAt: T0 - 86_400_000,
    deletedAt: null,
    environmentBranchName: null,
    environmentHostId: null,
    environmentId: null,
    environmentIsWorktree: null,
    environmentName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentWorkspaceDisplayKind: "other",
    hasPendingInteraction: false,
    id,
    lastReadAt: null,
    latestAttentionAt: T0,
    lifecycleOwnerThreadId: null,
    originKind: null,
    originPluginId: null,
    parentThreadId: null,
    pinSortKey: null,
    pinnedAt: null,
    projectId: PROJECT,
    providerId: "claude-code",
    queuedWork: "none",
    runtime: { displayStatus: "idle" },
    sectionId: null,
    sourceThreadId: null,
    status: "idle",
    title: `Тред ${id}`,
    titleFallback: null,
    updatedAt: T0,
    visibility: "visible",
    ...extra,
  };
}

function event(seq: number, createdAt: number, type: string, data: Record<string, unknown>) {
  return { id: `evt_${seq}`, scope: { kind: "thread" }, threadId: A, seq, createdAt, type, data };
}

const turnCompleted = event(40, T0 - 3_600_000, "turn/completed", {
  providerThreadId: "p",
  status: "completed",
});
const requests = [
  // Newest first: a system notice about a child, then the user's own message.
  event(30, T0 - 7_200_000, "client/turn/requested", {
    initiator: "system",
    senderThreadId: null,
    systemMessageKind: "child-completed",
  }),
  event(20, T0 - 10_800_000, "client/turn/requested", {
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
  }),
];
const QUESTION = "Готово с разбором.\n\nКакой вариант берём?\nА — раскатить всем сразу\nБ — сначала на одном проекте";

function openTask(priority: string) {
  return {
    id: "01OPENTASK",
    projectId: "01TRACKER",
    key: "OS-7",
    title: "Открытая задача",
    status: "todo",
    priority,
    dueDate: null,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
  };
}

const rpcCalls: { method: string; input: unknown }[] = [];
const archivedThreads = new Set<string>();
/** Threads whose interactions.list returns a pending approval. */
const pendingFor = new Set<string>();
/** LLM triage: what was spawned, and whether the host sees the temp directory. */
const spawned: { environment: unknown; permissionMode?: unknown; visibility?: unknown }[] = [];
let hostSeesTempDir = true;

const { bb, harness } = createFakePluginHost({
  pluginId: "pult",
  sdk: {
    projects: {
      list: async () => [
        { id: PROJECT, name: "studio_code", kind: "standard", createdAt: 0, updatedAt: 0, gitRemoteUrl: null, sources: [] },
      ],
    },
    threads: {
      list: async () => [
        listRow(A),
        listRow(B, {
          status: "active",
          runtime: { displayStatus: "active" },
          updatedAt: T0 + 1,
          hasPendingInteraction: pendingFor.has(B),
        }),
        listRow(HIDDEN, { originPluginId: "pult" }),
      ],
      get: async ({ threadId }: { threadId: string }) =>
        makeThreadResponse({
          id: threadId,
          projectId: PROJECT,
          title: `Тред ${threadId}`,
          archivedAt: archivedThreads.has(threadId) ? T0 : null,
          updatedAt: T0 + 60_000,
        }),
      events: {
        list: async ({ threadId, types }: { threadId: string; types?: readonly string[] }) => {
          if (types?.includes("turn/completed")) return [{ ...turnCompleted, threadId }];
          if (types?.includes("client/turn/requested")) {
            if (threadId === B) {
              // B: a new request after its last turn while active → running.
              return [event(50, T0 - 60_000, "client/turn/requested", {
                initiator: "user",
                senderThreadId: null,
              })];
            }
            return requests;
          }
          return [];
        },
      },
      output: async ({ threadId }: { threadId: string }) => ({ output: threadId === A ? QUESTION : "работаю" }),
      interactions: {
        list: async ({ threadId }: { threadId: string }) =>
          pendingFor.has(threadId)
            ? [{ id: "int_1", status: "pending", payload: { kind: "approval", subject: { kind: "command", command: "git push" } } }]
            : [],
      },
      spawn: async (args: { environment: unknown; permissionMode?: unknown; visibility?: unknown }) => {
        spawned.push(args);
        return makeThreadResponse({ id: "thr_classify01", projectId: PROJECT });
      },
      wait: async () => makeThreadResponse({ id: "thr_classify01", projectId: PROJECT }),
      archive: async () => makeThreadResponse({ id: "thr_classify01", projectId: PROJECT }),
      stop: async () => ({ ok: true }),
    },
    hosts: {
      list: async () => [{ id: "host_local", status: "connected", lifecycle: { phase: "active" } }],
      pathsExist: async ({ paths }: { paths: string[] }) => ({
        existence: Object.fromEntries(paths.map((path) => [path, hostSeesTempDir && existsSync(path)])),
      }),
    },
    plugins: {
      callRpc: async ({ method, input }: { method: string; input?: unknown }) => {
        rpcCalls.push({ method, input });
        switch (method) {
          case "listProjects":
            return { projects: [{ id: "01TRACKER", name: "online-store", prefix: "OS", linkedBbProjectId: "proj_other" }] };
          case "createProject":
            return { project: { id: "01NEWPROJ", name: "studio_code", prefix: (input as { prefix: string }).prefix, linkedBbProjectId: PROJECT } };
          case "createTask":
            return {
              ok: true,
              task: {
                id: "01TASK",
                projectId: "01NEWPROJ",
                key: "STU-1",
                title: (input as { title: string }).title,
                status: "todo",
                priority: (input as { priority: string }).priority,
                dueDate: null,
                createdAt: new Date(T0).toISOString(),
                updatedAt: new Date(T0).toISOString(),
              },
            };
          case "taskThreadsAttach":
            return { threadId: (input as { threadId: string }).threadId };
          case "listTasks":
            return { tasks: [openTask("high")], nextCursor: null };
          case "listTaskThreads":
            // Thread A is attached to OS-7 in BB Tasks itself (not through Pult).
            return {
              taskThreads:
                (input as { taskId: string }).taskId === "01OPENTASK"
                  ? [{ threadId: A, title: "x", liveStatus: "idle", updatedAt: new Date(T0).toISOString() }]
                  : [],
            };
          case "getTaskByKey":
            if ((input as { taskKey: string }).taskKey === "BROKEN-1") throw new Error("tasks timeout");
            return { task: openTask("high") };
          case "getTask":
            return { task: openTask("high") };
          case "updateTask":
            return { ok: true, task: openTask((input as { priority?: string }).priority ?? "high") };
          default:
            throw new Error(`unexpected tasks method ${method}`);
        }
      },
    },
  },
});
await plugin(bb);

after(async () => {
  await harness.lifecycle.dispose();
});

async function explain(threadId: string) {
  const result = await harness.behavior.runCli(["explain", threadId, "--json"]);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    snapshot: { classification: { kind: string; source: string }; lastAgentAt: number; lastHumanAt: number } | null;
    input: { lastTurn: string } | null;
    overlay: { snoozedUntil: number | null; dismissedAt: number | null; taskKey: string | null };
  };
}

test("scan reads turn, the user's last message and text; skips Pult's own threads", async () => {
  const result = (await harness.behavior.callRpc("scan.run", { full: true })) as { scanned: number };
  assert.equal(result.scanned, 2);
  const a = await explain(A);
  assert.ok(a.snapshot !== null);
  assert.equal(a.snapshot.lastAgentAt, turnCompleted.createdAt);
  // The child notice is newer, but only the user's own message counts.
  assert.equal(a.snapshot.lastHumanAt, T0 - 10_800_000);
  assert.equal(a.input?.lastTurn, "completed");
  const b = await explain(B);
  assert.equal(b.input?.lastTurn, "running");
  const hidden = await harness.behavior.runCli(["explain", HIDDEN]);
  assert.match(hidden.stdout, /ещё не видел/);
});

test("an unchanged thread is not re-read on an incremental scan", async () => {
  const before = harness.inspection.sdk.callsTo("threads.output").length;
  const result = (await harness.behavior.callRpc("scan.run", {})) as { scanned: number };
  assert.equal(result.scanned, 0);
  assert.equal(harness.inspection.sdk.callsTo("threads.output").length, before);
});

/** Runs `fn` with HOME pointed at `home` (the seed import reads only inside it). */
async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = saved;
  }
}

test("seed import marks a thread done while it has not moved since", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 + 3_600_000 });
  try {
  const home = await mkdtemp(join(tmpdir(), "pult-home-"));
  const file = join(home, "seed.json");
  await writeFile(file, JSON.stringify({ [A]: { status: "DONE", source: "inventory-2026-10-12" } }));
  const result = await withHome(home, () => harness.behavior.runCli(["seed", "import", file, "--json"]));
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).imported, 1);
  const a = await explain(A);
  assert.equal(a.snapshot?.classification.kind, "done");
  assert.equal(a.snapshot?.classification.source, "inventory");

  // An inventory older than the thread's last activity does not apply.
  await writeFile(file, JSON.stringify({ asOf: T0 - 86_400_000, threads: { [A]: { status: "DONE" } } }));
  await withHome(home, () => harness.behavior.runCli(["seed", "import", file]));
  assert.notEqual((await explain(A)).snapshot?.classification.source, "inventory");
  } finally {
    mock.timers.reset();
  }
});

test("seed import merges by default and replaces only with --replace", async () => {
  mock.timers.enable({ apis: ["Date"], now: T0 + 3_600_000 });
  try {
  const home = await mkdtemp(join(tmpdir(), "pult-home-"));
  const file = join(home, "seed.json");
  const db = bb.storage.database();
  const seedRows = () =>
    (db.prepare("SELECT thread_id FROM seed ORDER BY thread_id").all() as { thread_id: string }[]).map((r) => r.thread_id);
  await writeFile(file, JSON.stringify({ asOf: "2026-10-10", threads: { [B]: { status: "IN_PROGRESS" } } }));
  assert.equal((await withHome(home, () => harness.behavior.runCli(["seed", "import", file]))).exitCode, 0);
  assert.deepEqual(seedRows(), [A, B]); // A from the earlier import is kept
  const list = (await harness.behavior.callRpc("queue.list", null)) as { scan: { seedAsOf: number | null } };
  // The newest row's date: A's (one day before T0) is newer than B's 10.10.
  assert.equal(list.scan.seedAsOf, T0 - 86_400_000);
  assert.equal((await withHome(home, () => harness.behavior.runCli(["seed", "import", file, "--replace"]))).exitCode, 0);
  assert.deepEqual(seedRows(), [B]);
  } finally {
    mock.timers.reset();
  }
});

test("seed import refuses files outside home and future dates, never echoes the content", async () => {
  const home = await mkdtemp(join(tmpdir(), "pult-home-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "pult-elsewhere-"));
  const secret = join(elsewhere, "secret.json");
  await writeFile(secret, JSON.stringify({ [A]: { status: "DONE", source: "inventory-2026-10-10" } }));
  const outside = await withHome(home, () => harness.behavior.runCli(["seed", "import", secret]));
  assert.equal(outside.exitCode, 1);
  assert.match(outside.stderr ?? "", /домашней папки/);
  // A symlink inside home that points outside is refused too.
  await symlink(secret, join(home, "link.json"));
  await assert.rejects(resolveSeedPath(join(home, "link.json"), undefined, home), /домашней папки/);
  // ../ out of home is refused before anything is read.
  await assert.rejects(resolveSeedPath("../x/secret.json", home, home), /домашней папки/);

  const notJson = join(home, "token.txt");
  await writeFile(notJson, "sk-ant-api-very-secret");
  const bad = await withHome(home, () => harness.behavior.runCli(["seed", "import", notJson]));
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr ?? "", /Файл не JSON/);
  assert.doesNotMatch(bad.stderr ?? "", /sk-ant/);

  const future = join(home, "future.json");
  await writeFile(future, JSON.stringify({ asOf: "2099-12-31", threads: { [A]: { status: "DONE" } } }));
  const late = await withHome(home, () => harness.behavior.runCli(["seed", "import", future]));
  assert.equal(late.exitCode, 1);
  assert.match(late.stderr ?? "", /в будущем/);
});

test("snooze, dismiss and restore write overlays", async () => {
  assert.equal((await harness.behavior.runCli(["snooze", A, "2h"])).exitCode, 0);
  assert.ok(((await explain(A)).overlay.snoozedUntil ?? 0) > Date.now());
  await harness.behavior.callRpc("queue.dismiss", { threadId: A });
  const dismissed = await explain(A);
  assert.ok(dismissed.overlay.dismissedAt !== null);
  assert.equal(dismissed.overlay.snoozedUntil, null);
  await harness.behavior.callRpc("queue.restore", { threadId: A });
  const restored = await explain(A);
  assert.equal(restored.overlay.dismissedAt, null);
});

test("hiding: no approval, not the caller's own thread, at most 30 days; logged", async () => {
  const own = await harness.behavior.runCli(["dismiss", A], { threadId: A });
  assert.equal(own.exitCode, 1);
  assert.match(own.stderr ?? "", /сам себя/);
  const ownSnooze = await harness.behavior.runCli(["snooze", A, "2h"], { threadId: A });
  assert.equal(ownSnooze.exitCode, 1);
  const tooLong = await harness.behavior.runCli(["snooze", A, "5w"]);
  assert.equal(tooLong.exitCode, 1);
  assert.match(tooLong.stderr ?? "", /30 дней/);
  await assert.rejects(
    harness.behavior.callRpc("queue.snooze", { threadId: A, until: Date.now() + 31 * 86_400_000 }),
    /30 дней/,
  );
  // Another thread may hide A when the user asked it to; the log names who did.
  const other = await harness.behavior.runCli(["dismiss", A], { threadId: B });
  assert.equal(other.exitCode, 0, other.stderr);
  assert.ok(harness.inspection.logEntries.some((l) => l.message.includes(`cli dismiss ${A} by ${B}`)));
  await harness.behavior.callRpc("queue.restore", { threadId: A });
});

test("nothing writes into a thread: no reply RPC, no threads.send", async () => {
  await assert.rejects(harness.behavior.callRpc("queue.reply", { threadId: A, text: "да" }));
  assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 0);
});

test("queue.list and marks.list", { skip: !queueReady && "lib/queue.ts is a stub" }, async () => {
  const list = (await harness.behavior.callRpc("queue.list", null)) as { scan: { threadCount: number } };
  assert.equal(list.scan.threadCount, 2);
  const marks = (await harness.behavior.callRpc("marks.list", null)) as { marks: { label: string }[] };
  for (const mark of marks.marks) assert.match(mark.label, /^Ход за тобой: /);
});

test("feed.list: every active thread once, newest conversation first, read-only", async () => {
  const sdk = harness.inspection.sdk;
  const writesBefore = ["threads.send", "threads.archive", "threads.spawn"].map((m) => sdk.callsTo(m).length);
  const list = (await harness.behavior.callRpc("queue.list", null)) as { scan: { threadCount: number } };
  const feed = (await harness.behavior.callRpc("feed.list", null)) as {
    rows: { threadId: string; providerId: string; lastAt: number; parentState: string; parentProjectName: string | null }[];
  };
  // The same threads the scan counts (Pult's own hidden thread is not among them).
  assert.equal(feed.rows.length, list.scan.threadCount);
  assert.deepEqual(feed.rows.map((r) => r.threadId).sort(), [A, B]);
  for (let i = 1; i < feed.rows.length; i += 1) assert.ok(feed.rows[i - 1]!.lastAt >= feed.rows[i]!.lastAt);
  // B is the one the user wrote to last (a minute before T0), A's newest event is an hour old.
  assert.equal(feed.rows[0]?.threadId, B);
  assert.ok(feed.rows.every((r) => r.parentState === "none" && r.parentProjectName === null));
  assert.ok(feed.rows.every((r) => r.providerId === "claude-code"));
  const writesAfter = ["threads.send", "threads.archive", "threads.spawn"].map((m) => sdk.callsTo(m).length);
  assert.deepEqual(writesAfter, writesBefore);
});

test("toTask creates a linked tracker project and a task with the thread", { skip: !lanesReady && "lib/lanes.ts is a stub" }, async () => {
  const result = (await harness.behavior.callRpc("queue.toTask", { threadId: B, lane: "now" })) as { taskKey: string };
  assert.equal(result.taskKey, "STU-1");
  const project = rpcCalls.find((call) => call.method === "createProject")?.input as Record<string, unknown>;
  assert.equal(project.prefix, "STU");
  assert.equal(project.linkedBbProjectId, PROJECT);
  const task = rpcCalls.find((call) => call.method === "createTask")?.input as Record<string, string>;
  assert.equal(task.priority, "urgent");
  assert.equal(task.status, "todo");
  assert.match(task.description, new RegExp(`\\(bbthread://${B}\\)`));
  assert.ok(rpcCalls.some((call) => call.method === "taskThreadsAttach"));
  assert.equal((await explain(B)).overlay.taskKey, "STU-1");
});

test("toTask: a thread attached in BB Tasks moves its task; a Tasks error is not «no task»", { skip: !lanesReady && "lib/lanes.ts is a stub" }, async () => {
  const created = () => rpcCalls.filter((call) => call.method === "createTask").length;
  const before = created();
  const result = (await harness.behavior.callRpc("queue.toTask", { threadId: A, lane: "now" })) as { taskKey: string };
  assert.equal(result.taskKey, "OS-7");
  assert.equal(created(), before);
  assert.equal((await explain(A)).overlay.taskKey, "OS-7");

  bb.storage.database().prepare("UPDATE overlays SET task_key = 'BROKEN-1' WHERE thread_id = ?").run(B);
  await assert.rejects(harness.behavior.callRpc("queue.toTask", { threadId: B, lane: "now" }), /tasks timeout/);
  assert.equal(created(), before);
});


test("lanes from BB Tasks; a lane move changes the priority as «Пульт»", { skip: !lanesReady && "lib/lanes.ts is a stub" }, async () => {
  const listed = (await harness.behavior.callRpc("lanes.list", null)) as {
    tasksAvailable: boolean;
    lanes: { next: { key: string; threads: { threadId: string }[] }[] };
  };
  assert.equal(listed.tasksAvailable, true);
  assert.equal(listed.lanes.next[0]?.key, "OS-7");
  assert.equal(listed.lanes.next[0]?.threads[0]?.threadId, A);
  const moved = await harness.behavior.runCli(["lane", "OS-7", "now"]);
  assert.equal(moved.exitCode, 0, moved.stderr);
  const update = rpcCalls.filter((call) => call.method === "updateTask").at(-1)?.input as Record<string, string>;
  assert.equal(update.priority, "urgent");
  assert.equal(update.authorName, "Пульт");
  assert.match((await harness.behavior.runCli(["lanes"])).stdout, /Сейчас/);
});

test("lane memory: a move into the same lane changes nothing; closed tasks are forgotten", { skip: !lanesReady && "lib/lanes.ts is a stub" }, async () => {
  const db = bb.storage.database();
  db.prepare("INSERT OR REPLACE INTO lane_memory (task_id, lane, since, approx) VALUES ('01GONE', 'now', 1, 0)").run();
  db.prepare("INSERT OR REPLACE INTO lane_memory (task_id, lane, since, approx) VALUES ('01OPENTASK', 'next', 42, 0)").run();
  const updates = () => rpcCalls.filter((call) => call.method === "updateTask").length;
  const before = updates();
  // The mock keeps OS-7 at «high» = «Дальше».
  assert.equal((await harness.behavior.runCli(["lane", "OS-7", "next"])).exitCode, 0);
  assert.equal(updates(), before);
  const since = db.prepare("SELECT since FROM lane_memory WHERE task_id = '01OPENTASK'").get() as { since: number } | undefined;
  assert.equal(since?.since, 42);
  await harness.behavior.callRpc("lanes.list", null);
  assert.equal(db.prepare("SELECT 1 FROM lane_memory WHERE task_id = '01GONE'").get(), undefined);
});

test("«В архив» cancels the task as «Пульт» (not done) and hides its waiting thread", { skip: !(lanesReady && queueReady) && "lib is a stub" }, async () => {
  await harness.behavior.callRpc("scan.run", { full: true });
  assert.equal((await explain(A)).overlay.dismissedAt, null);
  const result = (await harness.behavior.callRpc("lanes.archive", { taskId: "01OPENTASK" })) as { hidden: number };
  const update = rpcCalls.filter((call) => call.method === "updateTask").at(-1)?.input as Record<string, string>;
  assert.equal(update.taskId, "01OPENTASK");
  assert.equal(update.status, "canceled");
  assert.equal(update.authorName, "Пульт");
  assert.equal(update.priority, undefined);
  // OS-7 holds thread A, which waits for a decision.
  assert.equal(result.hidden, 1);
  assert.notEqual((await explain(A)).overlay.dismissedAt, null);
  const queue = (await harness.behavior.callRpc("queue.list", null)) as {
    queue: { dismissed: { threadId: string }[] };
  };
  assert.ok(queue.queue.dismissed.some((item) => item.threadId === A));
  await harness.behavior.callRpc("queue.restore", { threadId: A });
});


test("CLI queue prints a Russian summary", { skip: !queueReady && "lib/queue.ts is a stub" }, async () => {
  const result = await harness.behavior.runCli(["queue"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^Ход за тобой: \d+/);
  assert.ok(result.stdout.split("\n").length <= 200);
});

test("a resolved approval leaves the queue on the thread's event stream, without waiting for a scan", async () => {
  pendingFor.add(B);
  await harness.behavior.callRpc("scan.run", { full: true });
  assert.equal((await explain(B)).snapshot?.classification.kind, "approval");
  pendingFor.delete(B); // The user approved in BB: the thread stays active, no lifecycle event
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const thread = makeThreadResponse({ id: B, projectId: PROJECT, status: "active", updatedAt: T0 + 60_000 });
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 61 });
    // A second event within the debounce does not postpone the read.
    mock.timers.tick(1_500);
    await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 62 });
    mock.timers.tick(600);
  } finally {
    mock.timers.reset();
  }
  for (let i = 0; i < 50 && (await explain(B)).snapshot?.classification.kind === "approval"; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.notEqual((await explain(B)).snapshot?.classification.kind, "approval");
});

test("explain hands out no agent text of an archived thread", async () => {
  await harness.behavior.emitThreadEvent("thread.archived", { thread: makeThreadResponse({ id: A, projectId: PROJECT, archivedAt: T0 }) });
  const result = await harness.behavior.runCli(["explain", A, "--json"]);
  const data = JSON.parse(result.stdout) as { snapshot: { archived: boolean; excerpt: string | null }; input: { lastAgentText: string | null } };
  assert.equal(data.snapshot.archived, true);
  assert.equal(data.snapshot.excerpt, null);
  assert.equal(data.input.lastAgentText, null);
});

test("a deleted thread leaves no snapshot, overlay or LLM row behind", async () => {
  const db = bb.storage.database();
  db.prepare("INSERT OR REPLACE INTO llm_triage (thread_id, last_agent_at, json, triaged_at) VALUES (?, 1, NULL, 1)").run(A);
  assert.ok(db.prepare("SELECT 1 FROM overlays WHERE thread_id = ?").get(A) !== undefined);
  await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: A, projectId: PROJECT, deletedAt: T0 }) });
  for (const table of ["snapshots", "overlays", "llm_triage"]) {
    assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE thread_id = ?`).get(A), undefined, table);
  }
  assert.match((await harness.behavior.runCli(["explain", A])).stdout ?? "", /ещё не видел/);
});

test("LLM triage is compiled out of this build: no schedule, nothing spawned even when the setting is on", async () => {
  await harness.behavior.setSettings({ llmTriage: true });
  await assert.rejects(() => harness.behavior.runSchedule("llm-triage"), /no schedule/);
  assert.equal(spawned.length, 0);
  const list = (await harness.behavior.callRpc("queue.list", null)) as { scan: { llmEnabled: boolean } };
  assert.equal(list.scan.llmEnabled, false);
  await harness.behavior.setSettings({ llmTriage: false });
});

test("the user's last message: a subthread's spawn prompt is not his", () => {
  const spawn = { createdAt: 5, initiator: "user", senderThreadId: null, systemMessageKind: "unlabeled", source: "spawn" };
  const tell = { createdAt: 3, initiator: "user", senderThreadId: null, source: "tell" };
  assert.equal(vadimLastMessageAt([spawn, tell], true), 3);
  assert.equal(vadimLastMessageAt([spawn], true), null);
  // A thread the user started himself: his first prompt counts.
  assert.equal(vadimLastMessageAt([spawn, tell], false), 5);
  // Notices and other threads' messages never count.
  assert.equal(vadimLastMessageAt([{ createdAt: 9, initiator: "system", senderThreadId: null }, { createdAt: 8, initiator: "user", senderThreadId: "thr_x" }], false), null);
});

test("main checkout: the default source's path on its own host", () => {
  const env = (id: string, path: string, hostId: string, extra = {}) => ({
    id, path, hostId, isWorktree: false, isGitRepo: true, status: "ready", hostLifecycle: "active", ...extra,
  }) as Parameters<typeof pickMainEnvironment>[1][number];
  const sources = [{ isDefault: true, path: "/repo", hostId: "host_a" }];
  assert.equal(pickMainEnvironment(sources, [env("e1", "/repo", "host_b"), env("e2", "/repo", "host_a")]), "e2");
  assert.equal(pickMainEnvironment(sources, [env("e1", "/repo", "host_b")]), null);
  assert.equal(pickMainEnvironment(sources, [env("e2", "/repo", "host_a", { status: "provisioning" })]), null);
});

test("prefixes: 2–5 Latin capitals, the _code suffix ignored, unique", () => {
  assert.equal(pickPrefix("studio_code", new Set()), "STU");
  assert.equal(pickPrefix("online-store_code", new Set()), "OS");
  assert.notEqual(pickPrefix("online-store_code", new Set(["OS"])), "OS");
  assert.equal(pickPrefix("ERP_code", new Set()), "ERP");
  for (const name of ["B2B_code", "Личное", "x"]) {
    const prefix = pickPrefix(name, new Set());
    assert.match(prefix, /^[A-Z]{2,5}$/, name);
  }
  assert.ok(prefixCandidates("photo-studio-lab_code").includes("PSL"));
});

test("snooze periods", () => {
  const now = Date.parse("2026-10-12T15:00:00");
  assert.equal(parseSnooze("2h", now), now + 2 * 3_600_000);
  assert.equal(parseSnooze("1w", now), now + 7 * 86_400_000);
  assert.equal(new Date(parseSnooze("tomorrow", now) ?? 0).getHours(), 9);
  assert.equal(parseSnooze("soon", now), null);
});

test("pending interactions reduce to the queue's shape", () => {
  const question = toPendingInfo({
    id: "int_1",
    status: "pending",
    payload: { kind: "user_question", questions: [{ prompt: "Какой?", options: [{ label: "А", value: "a" }] }] },
  });
  assert.deepEqual(question?.options, [{ label: "А", value: "a" }]);
  const plan = toPendingInfo({
    id: "int_2",
    status: "pending",
    payload: { kind: "approval", subject: { kind: "plan", plan: "1. Сделать" }, reason: null },
  });
  assert.equal(plan?.subjectKind, "plan");
  assert.equal(plan?.prompt, "1. Сделать");
  assert.equal(toPendingInfo({ id: "int_3", status: "resolved", payload: {} }), null);
});

test("the seed never beats a native approval", () => {
  const native = {
    kind: "approval" as const,
    ask: "Разрешить команду",
    options: [],
    multi: false,
    replyTemplate: null,
    due: null,
    confidence: 1,
    source: "native" as const,
    reasons: [],
  };
  const input = {
    threadId: A,
    status: "idle",
    runtimeStatus: null,
    hasPendingInteraction: true,
    pending: null,
    lastTurn: "completed" as const,
    lastAgentText: null,
    lastAgentAt: 1,
    lastHumanAt: null,
    lastErrorText: null,
    isChild: false,
    turnSeq: 1,
    model: null,
    modelLabel: null,
    effort: null,
  };
  const seed = { threadId: A, status: "DONE" as const, ask: null, task: null, asOf: 10 };
  assert.equal(applySeed(native, seed, input, 1).kind, "approval");
  assert.equal(applySeed({ ...native, source: "rules", kind: "unknown" }, seed, input, 1).kind, "done");
});

test("the LLM answer is parsed from noisy output and filtered", () => {
  const output = `Вот ответ:\n[{"threadId":"${A}","kind":"decision","ask":"Выбрать","options":["раз","два"]},{"threadId":"thr_zzzzzzzzzz","kind":"done"}]\n`;
  const result = parseAnswer(output, new Set([A]), "m");
  assert.equal(result.size, 1);
  assert.deepEqual(
    result.get(A)?.options.map((o) => o.key),
    ["А", "Б"],
  );
  assert.equal(parseAnswer("нет json", new Set([A]), "m").size, 0);
});

test("seed file shapes", () => {
  const flat = parseSeed({ [A]: { status: "WAITING_VADIM", ask: "x", source: "inventory-2026-10-10" } });
  assert.equal(flat.rows[0]?.status, "WAITING_VADIM");
  assert.equal(new Date(flat.asOf).getDate(), 10);
  assert.throws(() => parseSeed({ [A]: { status: "DONE" } }), /as-of/);
  assert.throws(() => parseSeed({ foo: 1 }));
  // An asOf after today is refused: it would pin the seed over later turns.
  const now = Date.parse("2026-10-12T10:00:00");
  assert.throws(() => parseSeed({ asOf: "2026-10-13", threads: {} }, undefined, now), /в будущем/);
  assert.equal(parseSeed({ asOf: "2026-10-12", threads: {} }, undefined, now).rows.length, 0);
});

test("seed: an asOf later today is clamped to now; errors never echo the file", () => {
  const now = Date.parse("2026-10-12T10:00:00+03:00");
  const { asOf } = parseSeed({ asOf: "2026-10-12", threads: {} }, undefined, now);
  assert.equal(asOf, now);
  assert.throws(
    () => parseSeed({ asOf: "SECRET-TOKEN-xyz", threads: {} }, undefined, now),
    (e: Error) => !e.message.includes("SECRET"),
  );
  assert.throws(
    () => parseSeed({ "sk-SECRETKEY": 1 }, undefined, now),
    (e: Error) => !e.message.includes("SECRET"),
  );
});

test("queue.dismiss and queue.snooze refuse an approval instead of a silent no-op", async () => {
  const db = bb.storage.database();
  const D = "thr_dddddddddd";
  const snap = {
    threadId: D,
    projectId: PROJECT,
    projectName: "studio_code",
    title: "Ждёт одобрения",
    parentThreadId: null,
    providerId: "claude-code",
    model: null,
    modelLabel: null,
    effort: null,
    status: "active",
    pinned: false,
    archived: false,
    createdAt: Date.now() - 3_600_000,
    updatedAt: Date.now() - 60_000,
    lastAgentAt: Date.now() - 600_000,
    lastHumanAt: null,
    excerpt: null,
    classification: { kind: "approval", ask: "rm -rf build", options: [], multi: false, replyTemplate: null, due: null, confidence: 1, source: "native", reasons: [] },
    classifiedAt: Date.now(),
  };
  db.prepare("INSERT OR REPLACE INTO snapshots (thread_id, project_id, json, updated_at, archived) VALUES (?, ?, ?, ?, 0)").run(
    D,
    PROJECT,
    JSON.stringify(snap),
    snap.updatedAt,
  );
  await assert.rejects(() => harness.behavior.callRpc("queue.dismiss", { threadId: D }), /Одобрение/);
  await assert.rejects(() => harness.behavior.callRpc("queue.snooze", { threadId: D, until: Date.now() + 3_600_000 }), /Одобрение/);
  assert.equal(db.prepare("SELECT 1 FROM overlays WHERE thread_id = ?").get(D), undefined);
});

test("latestExecution reads the model and the effort off the newest turn that has them", () => {
  const asked = (over: Record<string, unknown> = {}) => ({ createdAt: 1, ...over });
  assert.deepEqual(
    latestExecution([
      asked({ execution: { model: "gemini-4-argon", reasoningLevel: "xhigh" } }),
      asked({ execution: { model: "claude-opus-5-5", reasoningLevel: "high" } }),
    ]),
    { model: "gemini-4-argon", effort: "xhigh" },
    "the newest turn wins: the thread may have switched model since",
  );
  assert.deepEqual(
    latestExecution([
      asked(),
      asked({ execution: { model: "claude-opus-5-5[1m]", reasoningLevel: "xhigh" } }),
    ]),
    { model: "claude-opus-5-5[1m]", effort: "xhigh" },
    "a turn with no execution (an older BB) does not hide the ones that have it",
  );
  assert.deepEqual(latestExecution([asked({ execution: { model: "", reasoningLevel: 7 } })]), {
    model: null,
    effort: null,
  }, "junk from the event log is dropped, not shown");
  assert.deepEqual(latestExecution([]), { model: null, effort: null });
});
