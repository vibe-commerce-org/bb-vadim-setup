// Finding the Windows user's profile folder from Ubuntu in WSL2. Windows and
// `wslpath` are stood in for by a fake runner; any failure must leave the
// answer `null` (the server then keeps the Ubuntu home folder alone).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isWsl, profileLookup, windowsProfile } from "../src/wsl.ts";
import type { Run } from "../src/wsl.ts";

const wsl = async () => true;
const notWsl = async () => false;

/** A runner that answers by program name; a missing answer fails like a missing program. */
function runner(answers: { powershell?: string | Error; fallback?: string | Error; wslpath?: string | Error }): { run: Run; calls: string[] } {
  const calls: string[] = [];
  const answer = (value: string | Error | undefined) => {
    if (value === undefined) return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };
  const run: Run = (file) => {
    calls.push(file);
    if (file === "powershell.exe") return answer(answers.powershell);
    if (file.endsWith("powershell.exe")) return answer(answers.fallback);
    if (file === "wslpath") return answer(answers.wslpath);
    return Promise.reject(new Error(`unexpected program ${file}`));
  };
  return { run, calls };
}

test("outside WSL nothing is asked of Windows", async () => {
  const { run, calls } = runner({ powershell: "C:\\Users\\Иван\r\n" });
  assert.equal(await windowsProfile(run, notWsl), null);
  assert.deepEqual(calls, []);
});

test("the profile comes from Windows in UTF-8 and goes through wslpath: a Cyrillic name survives", async () => {
  const { run, calls } = runner({ powershell: "C:\\Users\\Иван\r\n", wslpath: "/mnt/c/Users/Иван\n" });
  assert.equal(await windowsProfile(run, wsl), "/mnt/c/Users/Иван");
  assert.deepEqual(calls, ["powershell.exe", "wslpath"]);
});

test("a byte order mark, blank lines and a profile on another drive are handled", async () => {
  const bom = runner({ powershell: "\uFEFFC:\\Users\\Kate\r\n", wslpath: "/mnt/c/Users/Kate\n" });
  assert.equal(await windowsProfile(bom.run, wsl), "/mnt/c/Users/Kate");
  const other = runner({ powershell: "\r\nD:\\Profiles\\Kate\r\n", wslpath: "/mnt/d/Profiles/Kate" });
  assert.equal(await windowsProfile(other.run, wsl), "/mnt/d/Profiles/Kate");
});

test("without wslpath the mount path is made by hand; powershell is looked for by full path if not on PATH", async () => {
  const noWslpath = runner({ powershell: "D:\\Users\\Kate Smith\r\n" });
  assert.equal(await windowsProfile(noWslpath.run, wsl), "/mnt/d/Users/Kate Smith");
  const noPath = runner({ fallback: "C:\\Users\\Kate\r\n", wslpath: "/mnt/c/Users/Kate" });
  assert.equal(await windowsProfile(noPath.run, wsl), "/mnt/c/Users/Kate");
  assert.equal(noPath.calls[1], "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
});

test("anything that is not a profile folder gives null: no Windows interop, a drive root, a network path, noise", async () => {
  for (const powershell of [new Error("interop is off"), "", "\r\n", "C:\\", "C:", "\\\\server\\share\\Kate", "Kate", "ERROR: something", "C:\\Users\\Kate\0"]) {
    const { run } = runner({ powershell, fallback: new Error("also off"), wslpath: "/mnt/c/Users/Kate" });
    assert.equal(await windowsProfile(run, wsl), null, String(powershell));
  }
});

test("a strange answer from wslpath is not trusted", async () => {
  for (const wslpath of ["/", "\\\\server\\x", "//server/share", "relative/path", ""]) {
    const { run } = runner({ powershell: "C:\\Users\\Kate", wslpath });
    assert.equal(await windowsProfile(run, wsl), null, wslpath);
  }
});

test("WSL is told by the kernel and by the variables WSL sets, and only on Linux", async () => {
  const kernel = async () => "5.15.153.1-microsoft-standard-WSL2\n";
  const plain = async () => "6.8.0-45-generic\n";
  assert.equal(await isWsl({}, "linux", kernel), true);
  assert.equal(await isWsl({}, "linux", plain), false);
  assert.equal(await isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "linux", plain), true);
  assert.equal(await isWsl({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux", plain), true);
  assert.equal(await isWsl({}, "linux", async () => Promise.reject(new Error("no such file"))), false);
  assert.equal(await isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "darwin", kernel), false);
  assert.equal(await isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "win32", kernel), false);
});

test("the lookup runs once while it finds the profile and looks again after a miss", async () => {
  let clock = 0;
  const answers: (string | null)[] = [null, null, "/mnt/c/Users/Kate"];
  let runs = 0;
  const lookup = profileLookup(async () => answers[runs++] ?? null, 1000, () => clock);

  assert.equal(await lookup(), null);
  clock = 500;
  assert.equal(await lookup(), null);
  assert.equal(runs, 1, "a miss is not asked again before the retry time");
  clock = 1500;
  assert.equal(await lookup(), null);
  assert.equal(runs, 2, "a miss is asked again after the retry time");
  clock = 3000;
  assert.equal(await lookup(), "/mnt/c/Users/Kate");
  assert.equal(runs, 3);
  clock = 1_000_000;
  assert.equal(await lookup(), "/mnt/c/Users/Kate");
  assert.equal(runs, 3, "a found profile is kept");
});

test("calls made while a lookup runs share it", async () => {
  let runs = 0;
  let finish: (value: string | null) => void = () => undefined;
  const lookup = profileLookup(() => {
    runs += 1;
    return new Promise<string | null>((resolve) => {
      finish = resolve;
    });
  });
  const first = lookup();
  const second = lookup();
  finish("/mnt/c/Users/Kate");
  assert.deepEqual(await Promise.all([first, second]), ["/mnt/c/Users/Kate", "/mnt/c/Users/Kate"]);
  assert.equal(runs, 1);
});
