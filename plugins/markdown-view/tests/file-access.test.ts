// Where the opened file is read from: every source BB hands an opener resolves
// to a host and an absolute path for `sdk.files`. Runs against a fake SDK.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginBrowserBbSdk, PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import { FileTooLargeError, locateFile, readFromDisk } from "../src/file-access.ts";

const environments = [
  { id: "env_wt", hostId: "host_a", path: "/work/repo-wt", isWorktree: true },
  { id: "env_main", hostId: "host_a", path: "/work/repo/", isWorktree: false },
];

function fakeSdk(read: (args: { hostId?: string; path: string }) => unknown = () => ({})): PluginBrowserBbSdk {
  return {
    threads: {
      get: async () => ({ environmentId: "env_main" }),
      storageLocation: async ({ threadId }: { threadId: string }) => ({
        hostId: "host_s",
        storageRootPath: `/data/thread-storage/${threadId}`,
      }),
    },
    environments: {
      get: async ({ environmentId }: { environmentId: string }) => environments.find((e) => e.id === environmentId),
      list: async () => environments,
    },
    files: { read: async (args: { hostId?: string; path: string }) => read(args) },
  } as unknown as PluginBrowserBbSdk;
}

const source = (overrides: Partial<PluginFileOpenerSource>): PluginFileOpenerSource => ({
  kind: "workspace",
  threadId: null,
  environmentId: null,
  projectId: null,
  ...overrides,
});
const signal = new AbortController().signal;

test("a workspace file opened in a thread is read from that thread's checkout", async () => {
  const file = await locateFile(fakeSdk(), "docs/plan.md", source({ threadId: "thr_1" }), signal);
  assert.deepEqual(file, {
    hostId: "host_a",
    path: "/work/repo/docs/plan.md",
    checkout: { environmentId: "env_main", rootPath: "/work/repo/" },
  });
});

test("a project file opened without a thread is read from the project's own checkout", async () => {
  const file = await locateFile(fakeSdk(), "a.md", source({ projectId: "proj_1" }), signal);
  assert.equal(file?.path, "/work/repo/a.md");
});

test("a host file keeps its absolute path, on the thread's host", async () => {
  const path = "/Users/me/other-repo/notes.md";
  const file = await locateFile(fakeSdk(), path, source({ kind: "host", threadId: "thr_1" }), signal);
  assert.deepEqual(file, { hostId: "host_a", path, checkout: null });
});

test("a host file opened outside any thread is read on the host BB names", async () => {
  // What BB hands an opener for a host file with no thread (Files page, Pult): the host and nothing else.
  const path = "/Users/me/notes/other/AGENTS.md";
  const file = await locateFile(fakeSdk(), path, source({ kind: "host", experimental_hostId: "host_a" }), signal);
  assert.deepEqual(file, { hostId: "host_a", path, checkout: null });
});

test("a thread-storage file is read under the thread's storage root", async () => {
  const file = await locateFile(fakeSdk(), "report.md", source({ kind: "thread-storage", threadId: "thr_9" }), signal);
  assert.deepEqual(file, { hostId: "host_s", path: "/data/thread-storage/thr_9/report.md", checkout: null });
});

test("a source BB left incomplete has no location", async () => {
  assert.equal(await locateFile(fakeSdk(), "x.md", source({ kind: "thread-storage" }), signal), null);
  assert.equal(await locateFile(fakeSdk(), "x.md", source({ kind: "host" }), signal), null);
  assert.equal(await locateFile(fakeSdk(), "x.md", source({}), signal), null);
});

test("reads through sdk.files on the file's host, decoding base64 as UTF-8", async () => {
  let asked: unknown;
  const sdk = fakeSdk((args) => {
    asked = args;
    return { content: Buffer.from("# Отчёт\n").toString("base64"), contentEncoding: "base64", sha256: "abc" };
  });
  const disk = await readFromDisk(sdk, { hostId: "host_a", path: "/work/repo/r.md", checkout: null });
  assert.deepEqual(disk, { text: "# Отчёт\n", sha256: "abc" });
  assert.deepEqual(asked, { hostId: "host_a", path: "/work/repo/r.md", signal: undefined });
});

test("BB's 413 becomes FileTooLargeError; other errors pass through", async () => {
  const file = { hostId: "host_a", path: "/big.md", checkout: null };
  const tooLarge = fakeSdk(() => {
    throw Object.assign(new Error("HTTP 413"), { status: 413, code: "file_too_large" });
  });
  await assert.rejects(readFromDisk(tooLarge, file), FileTooLargeError);
  const missing = fakeSdk(() => {
    throw Object.assign(new Error("HTTP 404"), { status: 404, code: "ENOENT" });
  });
  await assert.rejects(readFromDisk(missing, file), /HTTP 404/);
});
