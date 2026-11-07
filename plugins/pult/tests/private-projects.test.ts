// Projects in __PRIVATE (server/private-projects.ts): the rule on paths, and
// the backend on a fake BB host — a private project's threads are not read,
// what Pult stored of them goes, no surface shows them; a project without a
// known folder or missing from the project list is not shown either
// (fail-closed).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";

// A home of its own with a __PRIVATE folder in its _CODE folder, so the test runs the
// same where the real home has no such folder; the plugin reads it at import.
const base = await realpath(await mkdtemp(join(tmpdir(), "pult-private-")));
await mkdir(join(base, "Documents", "_CODE", "__PRIVATE"), { recursive: true });
process.env.HOME = base;
const { default: plugin } = await import("../server.ts");
const { PRIVATE_ROOT, projectAccess } = await import("../server/private-projects.ts");

// ── the rule ───────────────────────────────────────────────────────────

const root = join(base, "__PRIVATE");
await mkdir(join(root, "diary_code"), { recursive: true });
await mkdir(join(base, "__PRIVATE_old"));
await mkdir(join(base, "work_code"));
await symlink(join(root, "diary_code"), join(base, "link_code"));
await symlink(root, join(base, "private-link"));

function project(paths: string[], kind = "standard") {
  return { kind, sources: paths.map((path) => ({ path })) };
}

test("a project inside __PRIVATE is private: by folder, not by string prefix", () => {
  assert.equal(projectAccess(project([join(root, "diary_code")]), root), "private");
  assert.equal(projectAccess(project([root]), root), "private", "the folder itself");
  assert.equal(projectAccess(project([join(root, "not-on-disk_code")]), root), "private", "a folder not on disk");
  assert.equal(projectAccess(project([join(base, "__PRIVATE_old")]), root), "shown", "a sibling with the same prefix");
  assert.equal(projectAccess(project([join(base, "work_code")]), root), "shown");
  assert.equal(
    projectAccess(project([join(base, "work_code"), join(root, "diary_code")]), root),
    "private",
    "any of its folders",
  );
});

test("symlinks are resolved on both sides", () => {
  assert.equal(projectAccess(project([join(base, "link_code")]), root), "private", "a link into __PRIVATE");
  assert.equal(projectAccess(project([join(base, "private-link", "diary_code")]), root), "private");
  assert.equal(projectAccess(project([join(root, "diary_code")]), join(base, "private-link")), "private", "the root as a link");
});

test(
  "letter case does not matter where the disk ignores it",
  { skip: !existsSync(root.toUpperCase()) && "case-sensitive disk" },
  () => {
    assert.equal(projectAccess(project([join(root, "diary_code").toUpperCase()]), root), "private");
  },
);

test("no known folder: not shown, except BB's own Personal", () => {
  assert.equal(projectAccess(project([]), root), "unknown");
  assert.equal(projectAccess(project(["work_code"]), root), "unknown", "a relative path names no folder");
  assert.equal(projectAccess(project([""]), root), "unknown");
  assert.equal(projectAccess(project([], "personal"), root), "shown");
});

test("without the private folder on this machine every project is shown", () => {
  const absent = join(base, "no-such-folder");
  assert.equal(projectAccess(project([]), absent), "shown");
  assert.equal(projectAccess(project(["work_code"]), absent), "shown");
  assert.equal(projectAccess(project([join(absent, "diary_code")]), absent), "private", "a project inside it still is");
});

test("the private folder is __PRIVATE inside _CODE inside Documents of the home folder", () => {
  assert.equal(PRIVATE_ROOT, join(base, "Documents", "_CODE", "__PRIVATE"));
});

// ── the backend ────────────────────────────────────────────────────────

const T0 = Date.parse("2026-11-07T10:00:00+03:00");
const SHOWN = "proj_shown0001";
const PRIVATE = "proj_private01";
const NO_FOLDER = "proj_nofolder1";
const MISSING = "proj_missing01"; // not in projects.list
const S = "thr_ssssssssss";
const P = "thr_pppppppppp";
const N = "thr_nnnnnnnnnn";
const M = "thr_mmmmmmmmmm";
const projectOf: Record<string, string> = { [S]: SHOWN, [P]: PRIVATE, [N]: NO_FOLDER, [M]: MISSING };

function source(projectId: string, path: string) {
  return { id: `src_${projectId}`, hostId: "host_local", path, isDefault: true, projectId, type: "local_path" as const, createdAt: 0, updatedAt: 0 };
}

function thread(id: string) {
  return makeThreadResponse({ id, projectId: projectOf[id], title: `Тред ${id}`, updatedAt: T0, createdAt: T0 - 86_400_000 });
}

const { bb, harness } = createFakePluginHost({
  pluginId: "pult",
  sdk: {
    projects: {
      list: async () => [
        { id: SHOWN, name: "work_code", kind: "standard", createdAt: 0, updatedAt: 0, gitRemoteUrl: null, sources: [source(SHOWN, "/work/work_code")] },
        { id: PRIVATE, name: "diary_code", kind: "standard", createdAt: 0, updatedAt: 0, gitRemoteUrl: null, sources: [source(PRIVATE, join(PRIVATE_ROOT, "diary_code"))] },
        { id: NO_FOLDER, name: "nofolder_code", kind: "standard", createdAt: 0, updatedAt: 0, gitRemoteUrl: null, sources: [] },
      ],
    },
    threads: {
      list: async () => [S, P, N, M].map((id) => ({ ...thread(id), hasPendingInteraction: false })),
      get: async ({ threadId }: { threadId: string }) => thread(threadId),
      events: { list: async () => [] },
      output: async () => ({ output: "Какой вариант берём?\nА — один\nБ — другой" }),
      interactions: { list: async () => [] },
    },
    plugins: {
      callRpc: async ({ method }: { method: string }) =>
        method === "listProjects" ? { projects: [] } : { tasks: [], nextCursor: null },
    },
  },
});
await plugin(bb);

after(async () => {
  await harness.lifecycle.dispose();
});

const db = () => bb.storage.database();
const THREAD_TABLES = ["snapshots", "overlays", "llm_triage", "seed"] as const;

/** Rows of `threadId` in every table where Pult keeps thread data. */
function rowsOf(threadId: string): number {
  return THREAD_TABLES.reduce(
    (n, table) => n + (db().prepare(`SELECT count(*) AS n FROM ${table} WHERE thread_id = ?`).get(threadId) as { n: number }).n,
    0,
  );
}

test("a scan reads only threads of shown projects and forgets what it kept of private ones", async () => {
  // What an earlier build stored of the private thread.
  const snapshot = { threadId: P, projectId: PRIVATE, projectName: "diary_code", title: "Личное", archived: false };
  db().prepare("INSERT INTO snapshots (thread_id, project_id, json, input_json, updated_at, archived) VALUES (?, ?, ?, '{}', ?, 0)").run(P, PRIVATE, JSON.stringify(snapshot), T0);
  db().prepare("INSERT INTO overlays (thread_id, dismissed_at) VALUES (?, ?)").run(P, T0);
  db().prepare("INSERT INTO llm_triage (thread_id, last_agent_at, json, triaged_at) VALUES (?, 1, NULL, 1)").run(P);
  db().prepare("INSERT INTO seed (thread_id, status, ask, task, as_of) VALUES (?, 'WAITING_VADIM', 'личное', NULL, ?)").run(P, T0);
  db().prepare("INSERT INTO git_state (project_id, json, checked_at) VALUES (?, '{}', ?)").run(PRIVATE, T0);
  assert.equal(rowsOf(P), 4);

  const result = (await harness.behavior.callRpc("scan.run", { full: true })) as { scanned: number };
  assert.equal(result.scanned, 1, "only the thread of the shown project is read");
  for (const id of [P, N, M]) {
    const read = harness.inspection.sdk.callsTo("threads.output").some(([args]) => (args as { threadId: string }).threadId === id);
    assert.equal(read, false, `${id} is not read`);
  }
  assert.equal(rowsOf(P), 0, "snapshot, input, overlay, triage and seed of the private thread are gone");
  assert.equal(rowsOf(N) + rowsOf(M), 0);
  assert.equal(rowsOf(S) > 0, true);
});

test("no surface shows them: feed, queue, marks, CLI, map", async () => {
  const feed = (await harness.behavior.callRpc("feed.list", null)) as { rows: { threadId: string }[] };
  assert.deepEqual(feed.rows.map((r) => r.threadId), [S]);
  const list = (await harness.behavior.callRpc("queue.list", null)) as { scan: { threadCount: number } };
  assert.equal(list.scan.threadCount, 1);
  const marks = (await harness.behavior.callRpc("marks.list", null)) as { marks: { threadId: string }[] };
  assert.ok(marks.marks.every((m) => m.threadId === S));
  const cli = await harness.behavior.runCli(["queue", "--all", "--json"]);
  assert.equal(cli.exitCode, 0, cli.stderr);
  for (const id of [P, N, M, PRIVATE, "diary_code"]) assert.equal(cli.stdout.includes(id), false, id);
  assert.match((await harness.behavior.runCli(["explain", P])).stdout, /ещё не видел/);
  const map = (await harness.behavior.callRpc("map.get", { openOnly: false })) as { projects: { id: string }[] };
  const ids = map.projects.map((node) => node.id);
  assert.ok(ids.includes(SHOWN));
  for (const id of [PRIVATE, NO_FOLDER, MISSING]) assert.equal(ids.includes(id), false, id);
});

test("the thread panel of a private thread says so and tells nothing of its project", async () => {
  const panel = (await harness.behavior.callRpc("panel.forThread", { threadId: P })) as {
    projectId: string | null;
    projectName: string | null;
    hidden: boolean;
    items: unknown[];
    git: unknown;
  };
  assert.deepEqual(
    { projectId: panel.projectId, projectName: panel.projectName, hidden: panel.hidden, items: panel.items, git: panel.git },
    { projectId: null, projectName: null, hidden: true, items: [], git: null },
  );
  const shown = (await harness.behavior.callRpc("panel.forThread", { threadId: S })) as { hidden: boolean; projectId: string | null };
  assert.equal(shown.hidden, false);
  assert.equal(shown.projectId, SHOWN);
});

test("events: a private thread is not re-read; one of an unknown project is re-read and still not shown", async () => {
  const gets = () => harness.inspection.sdk.callsTo("threads.get").map(([args]) => (args as { threadId: string }).threadId);
  const before = gets().length;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread(P), lastAssistantText: "личное" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: thread(M), lastAssistantText: "текст" });
    mock.timers.tick(2_100);
  } finally {
    mock.timers.reset();
  }
  for (let i = 0; i < 50 && !gets().slice(before).includes(M); i++) await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(gets().slice(before), [M], "only the thread of the project Pult did not know is read");
  assert.equal(rowsOf(P) + rowsOf(M), 0);
});

test("the git state of a private project is dropped and not read again", async () => {
  // Stored by the first test; the «Карта» above started a git refresh.
  const gone = () => db().prepare("SELECT 1 FROM git_state WHERE project_id = ?").get(PRIVATE) === undefined;
  for (let i = 0; i < 50 && !gone(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(gone());
  const looked = harness.inspection.sdk.callsTo("environments.list").map(([args]) => (args as { projectId: string }).projectId);
  assert.equal(looked.includes(PRIVATE), false);
});
