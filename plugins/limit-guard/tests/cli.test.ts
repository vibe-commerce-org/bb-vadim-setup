// `bb limit-guard` argv parsing and the Telegram notifier (never --yes).
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../server/cli.ts";
import { createTelegramNotifier } from "../server/notify.ts";

test("parseArgs: status, resume, test on/off, help, errors", () => {
  assert.deepEqual(parseArgs([]), { kind: "help" });
  assert.deepEqual(parseArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseArgs(["status"]), { kind: "status", json: false });
  assert.deepEqual(parseArgs(["status", "--json"]), { kind: "status", json: true });
  assert.deepEqual(parseArgs(["resume"]), { kind: "resume" });
  assert.deepEqual(parseArgs(["test", "--off"]), { kind: "test-off" });
  assert.deepEqual(parseArgs(["test", "--threads", "thr_aaaaaaaa,thr_bbbbbbbb", "--percent", "90"]), {
    kind: "test-on",
    threads: ["thr_aaaaaaaa", "thr_bbbbbbbb"],
    percent: 90,
  });
  assert.deepEqual(parseArgs(["test", "--percent=95", "--threads=thr_aaaaaaaa, thr_aaaaaaaa"]), {
    kind: "test-on",
    threads: ["thr_aaaaaaaa"],
    percent: 95,
  });
  for (const argv of [
    ["test"],
    ["test", "--threads", "thr_aaaaaaaa"],
    ["test", "--threads", "not-a-thread", "--percent", "90"],
    ["test", "--threads", "thr_aaaaaaaa", "--percent", "101"],
    ["test", "--threads", "thr_aaaaaaaa", "--percent", "9.5"],
    ["test", "--threads", "", "--percent", "9"],
    ["pause"],
  ]) {
    assert.equal(parseArgs(argv).kind, "error", argv.join(" "));
  }
});

test("notifier: runs the notification script with --file and --note, never --yes; guard exit 2 is reported, not retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "limit-guard-notify-"));
  const argsLog = join(dir, "args.txt");
  const script = join(dir, "fake-send.sh");
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsLog}'\necho "guard: похоже на секреты — не отправлено" >&2\nexit 2\n`);
  await chmod(script, 0o755);
  const notify = createTelegramNotifier({ python: "/bin/sh", script, dir: join(dir, "notes") });
  const record = await notify("enter-2", { md: "# Сторож лимитов", note: "Две фразы. Вторая." });
  assert.equal(record.ok, false);
  assert.equal(record.kind, "enter-2");
  assert.match(record.message, /защита скрипта уведомлений требует подтверждения/);
  const args = (await readFile(argsLog, "utf8")).trim().split("\n");
  assert.equal(args[0], "--file");
  assert.match(args[1]!, /limit-guard-enter-2\.md$/);
  assert.deepEqual(args.slice(2), ["--note", "Две фразы. Вторая.", "--quiet"]);
  assert.ok(!args.includes("--yes"));
  assert.equal((await readFile(args[1]!, "utf8")).trim(), "# Сторож лимитов");
});

test("notifier: a missing interpreter is a failed note, not a crash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "limit-guard-notify-"));
  const notify = createTelegramNotifier({ python: join(dir, "no-such-python"), script: "x", dir });
  const record = await notify("consent", { md: "x", note: "y" });
  assert.equal(record.ok, false);
  assert.match(record.message, /не запустился/);
});
