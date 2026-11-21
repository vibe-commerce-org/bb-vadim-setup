// node --test tests/*.test.ts
// The end-to-end case needs a real install; it runs when PARAKEET_E2E_AUDIO points at a
// Russian recording and transcribe-cli + model are found (settings-free defaults or
// PARAKEET_E2E_CLI / PARAKEET_E2E_MODEL). PARAKEET_E2E_BACKEND=auto tries Metal. Inside an agent sandbox
// use a CPU-only build: a Metal build starts Metal even with --backend cpu, and Metal crashes there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePaths, installDir, resolveTools, transcribe } from "../lib/engine.ts";

const EMPTY = { cliPath: "", modelPath: "", ffmpegPath: "", backend: "cpu" } as const;

async function script(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * PIDs of every process this test started, at any depth (ffmpeg, transcribe-cli, a fake's children).
 * The process table comes from lsof itself (-R adds the parent PID): ps and pgrep fail inside the
 * macOS agent sandbox, lsof works there and outside it.
 */
function descendants(root: number): { pid: number; command: string }[] {
  const out = spawnSync("lsof", ["-R", "-F", "pcR", "-d", "cwd"], { encoding: "utf8" }).stdout ?? "";
  const parentOf = new Map<number, number>();
  const commandOf = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("c")) commandOf.set(pid, line.slice(1));
    else if (line.startsWith("R")) parentOf.set(pid, Number(line.slice(1)));
  }
  const found: number[] = [];
  const frontier = [root];
  while (frontier.length > 0) {
    const current = frontier.pop();
    for (const [child, parent] of parentOf) {
      if (parent === current && !found.includes(child)) {
        found.push(child);
        frontier.push(child);
      }
    }
  }
  return found.map((child) => ({ pid: child, command: commandOf.get(child) ?? "" }));
}

/**
 * Polls lsof every 100 ms while `work` runs. `enginePolls` counts polls that saw ffmpeg or
 * transcribe-cli among the descendants (lsof itself is one of them); `socketPolls` counts polls
 * where any descendant held a network socket.
 */
async function socketPollsDuring<T>(work: Promise<T>): Promise<{ result: T; enginePolls: number; socketPolls: number }> {
  let settled = false;
  void work.finally(() => (settled = true));
  let enginePolls = 0;
  let socketPolls = 0;
  while (!settled) {
    const processes = descendants(process.pid);
    if (processes.some(({ command }) => /^(transcrib|ffmpeg)/.test(command))) enginePolls += 1;
    if (processes.length > 0) {
      // lsof exits 1 when it finds nothing; read stdout whatever the exit code is.
      const pids = processes.map(({ pid }) => pid).join(",");
      const out = spawnSync("lsof", ["-a", "-i", "-p", pids], { encoding: "utf8" }).stdout ?? "";
      if (out.trim() !== "") socketPolls += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { result: await work, enginePolls, socketPolls };
}

const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
test("the socket check catches an engine that opens a socket", { skip: !hasPython }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  const ffmpeg = await script(dir, "ffmpeg", 'for a; do last="$a"; done; printf "RIFF" > "$last"');
  const cli = await script(
    dir,
    "transcribe-cli",
    `python3 -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); time.sleep(1.5)"
for a; do last="$a"; done; prev=""; for a; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done; echo "текст." > "$out"`,
  );
  const { result, socketPolls } = await socketPollsDuring(
    transcribe(
      { cli, model: "m", ffmpeg },
      { inputPath: "in", workDir: dir, backend: "cpu", timeoutMs: 20_000, signal: new AbortController().signal },
    ),
  );
  assert.ok(result.ok, result.ok ? "" : result.message);
  assert.ok(socketPolls > 0, "a listening socket went unnoticed");
});

test("install dir: PARAKEET_VOICE_HOME wins over ~/.local/share", () => {
  assert.equal(installDir({ home: "/h", env: {} }), "/h/.local/share/parakeet-voice");
  assert.equal(installDir({ home: "/h", env: { PARAKEET_VOICE_HOME: "/srv/pv" } }), "/srv/pv");
});

test("a setting is the only candidate; defaults search the install dir, then PATH", () => {
  const host = { home: "/h", env: { PATH: "/a:relative:/b" } };
  const set = candidatePaths({ ...EMPTY, cliPath: "/x/cli", modelPath: "/x/m.gguf", ffmpegPath: "/x/ff" }, host);
  assert.deepEqual(set, { cli: ["/x/cli"], model: ["/x/m.gguf"], ffmpeg: ["/x/ff"] });
  const found = candidatePaths(EMPTY, host);
  assert.equal(found.cli[0], "/h/.local/share/parakeet-voice/bin/transcribe-cli");
  assert.deepEqual(found.cli.slice(1, 3), ["/a/transcribe-cli", "/b/transcribe-cli"]);
  assert.ok(!found.cli.some((path) => path.startsWith("relative")));
  assert.deepEqual(found.model, [
    "/h/.local/share/parakeet-voice/models/parakeet-ultra-Q8_0.gguf",
    "/h/.local/share/parakeet-voice/models/parakeet-ultra-Q5_K_M.gguf",
  ]);
  assert.ok(found.ffmpeg.includes("/opt/homebrew/bin/ffmpeg"));
});

test("missing model: not ready with a message that says what to do", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  await mkdir(join(dir, "bin"));
  await script(join(dir, "bin"), "transcribe-cli", "exit 0");
  const ffmpeg = await script(dir, "ffmpeg", "exit 0");
  const result = await resolveTools({ ...EMPTY, ffmpegPath: ffmpeg }, { home: "/nowhere", env: { PARAKEET_VOICE_HOME: dir } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "not_installed");
  assert.match(result.message, /model not found/);
  assert.doesNotMatch(result.message, /transcribe-cli not found/);
  assert.match(result.message, /setup\.sh/);
});

test("an empty model file does not count as installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  const model = join(dir, "m.gguf");
  await writeFile(model, "");
  const result = await resolveTools({ ...EMPTY, modelPath: model }, { home: dir, env: {} });
  assert.equal(result.ok, false);
});

test("engine failure surfaces the tail of stderr, not an empty text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  const input = join(dir, "in.webm");
  await writeFile(input, "x");
  const ffmpeg = await script(dir, "ffmpeg", 'for a; do last="$a"; done; printf "RIFF" > "$last"');
  const cli = await script(dir, "transcribe-cli", 'echo "error: bad model file" >&2; exit 3');
  const result = await transcribe(
    { cli, model: join(dir, "m.gguf"), ffmpeg },
    { inputPath: input, workDir: dir, backend: "cpu", timeoutMs: 10_000, signal: new AbortController().signal },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "engine_failed");
  assert.match(result.message, /bad model file/);
});

test("a hung engine is killed at the deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  const ffmpeg = await script(dir, "ffmpeg", 'for a; do last="$a"; done; printf "RIFF" > "$last"');
  const cli = await script(dir, "transcribe-cli", "sleep 30");
  const started = Date.now();
  const result = await transcribe(
    { cli, model: "m", ffmpeg },
    { inputPath: "in", workDir: dir, backend: "cpu", timeoutMs: 1500, signal: new AbortController().signal },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "timeout");
  assert.ok(Date.now() - started < 10_000);
});

test("cancel stops the engine and reports cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pv-"));
  const ffmpeg = await script(dir, "ffmpeg", 'for a; do last="$a"; done; printf "RIFF" > "$last"');
  const cli = await script(dir, "transcribe-cli", "sleep 30");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await transcribe(
    { cli, model: "m", ffmpeg },
    { inputPath: "in", workDir: dir, backend: "cpu", timeoutMs: 20_000, signal: controller.signal },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cancelled");
});

const e2eAudio = process.env.PARAKEET_E2E_AUDIO;
test("end to end: Russian recording → text, no network sockets while it runs", { skip: !e2eAudio }, async () => {
  const config = {
    ...EMPTY,
    cliPath: process.env.PARAKEET_E2E_CLI ?? "",
    modelPath: process.env.PARAKEET_E2E_MODEL ?? "",
  };
  const tools = await resolveTools(config, { home: homedir(), env: process.env });
  assert.ok(tools.ok, tools.ok ? "" : tools.message);
  if (!tools.ok) return;
  const workDir = await mkdtemp(join(tmpdir(), "pv-e2e-"));
  const { result, enginePolls, socketPolls } = await socketPollsDuring(transcribe(tools, {
    inputPath: e2eAudio as string,
    workDir,
    // auto = Metal when the binary has it; never inside an agent sandbox.
    backend: process.env.PARAKEET_E2E_BACKEND === "auto" ? "auto" : "cpu",
    timeoutMs: 65_000,
    signal: new AbortController().signal,
  }));
  assert.ok(result.ok, result.ok ? "" : result.message);
  if (!result.ok) return;
  assert.ok(enginePolls > 0, "lsof never saw ffmpeg or transcribe-cli running");
  assert.equal(socketPolls, 0, "engine opened a network socket");
  assert.match(result.text, /[а-яё]{3,}/i, "expected Russian text");
  assert.match(result.text, /[.,!?]/, "expected punctuation");
  console.log(`e2e: ${enginePolls} polls saw the engine, 0 sockets; ${result.audioSeconds.toFixed(1)} s audio, ffmpeg ${result.convertMs} ms, parakeet ${result.transcribeMs} ms`);
  console.log(`e2e text: ${result.text.slice(0, 160)}…`);
});
