// In WSL2 the server runs in Ubuntu, but a student's repositories may live on
// the Windows disk: `C:\Users\Имя\Documents\repo` is `/mnt/c/Users/Имя/…` there,
// outside the Ubuntu home folder. This finds the Windows user's profile folder
// so the server can read it too — that folder and nothing else on `C:`.
//
// The profile is asked from Windows itself, the way the workstation kit does it:
// `powershell.exe` prints `%USERPROFILE%` in UTF-8 (a Cyrillic user name must
// survive), `wslpath` turns it into a Linux path. Any failure — not WSL, no
// interop with Windows, a slow or odd answer — gives `null` and the server
// keeps the Ubuntu home folder alone.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Runs a program, resolves with its stdout, rejects on any failure. */
export type Run = (file: string, args: readonly string[]) => Promise<string>;

const POWERSHELL = "powershell.exe";
const POWERSHELL_FALLBACK = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const PROFILE_SCRIPT = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $env:USERPROFILE";
const TIMEOUT_MS = 15_000;
/** A profile that was not found is looked for again after this long. */
export const RETRY_MS = 60_000;

export const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { timeout: TIMEOUT_MS, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end();
  });

/** True inside WSL (1 or 2): the kernel says so, and so do the variables WSL sets. */
export async function isWsl(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  readOsRelease: () => Promise<string> = () => readFile("/proc/sys/kernel/osrelease", "utf8"),
): Promise<boolean> {
  if (platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/iu.test(await readOsRelease());
  } catch {
    return false;
  }
}

const clean = (text: string) => text.replace(/^\uFEFF/u, "").trim();

/** `C:\Users\Имя` → `/mnt/c/Users/Имя`, if `wslpath` is not there to ask. */
function mountedPath(windowsPath: string): string {
  const [, drive = "", rest = ""] = /^([A-Za-z]):\\(.*)$/su.exec(windowsPath) ?? [];
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll("\\", "/")}`;
}

/** The Windows user's profile folder as a Linux path, or `null`. */
export async function windowsProfile(runner: Run = run, wsl: () => Promise<boolean> = isWsl): Promise<string | null> {
  try {
    if (!(await wsl())) return null;
    let output: string;
    try {
      output = await runner(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", PROFILE_SCRIPT]);
    } catch {
      output = await runner(POWERSHELL_FALLBACK, ["-NoProfile", "-NonInteractive", "-Command", PROFILE_SCRIPT]);
    }
    const windows = clean(output);
    // A real profile folder: `C:\Users\Имя`, not a drive root, not a network path.
    if (!/^[A-Za-z]:\\[^\r\n\0]+$/u.test(windows)) return null;
    let linux: string;
    try {
      linux = clean(await runner("wslpath", ["-u", windows]));
    } catch {
      linux = mountedPath(windows);
    }
    return linux.startsWith("/") && !linux.startsWith("//") && linux !== "/" && !linux.includes("\0") ? linux : null;
  } catch {
    return null;
  }
}

/**
 * Looks the profile up once and remembers it. A profile that was not found is
 * looked for again after `retryMs`, so a slow start of Windows interop does not
 * cost the whole session. Calls made while a lookup runs share it.
 */
export function profileLookup(
  find: () => Promise<string | null>,
  retryMs: number = RETRY_MS,
  now: () => number = Date.now,
): () => Promise<string | null> {
  let current: { at: number; found: boolean; value: Promise<string | null> } | undefined;
  return () => {
    if (current === undefined || (!current.found && now() - current.at > retryMs)) {
      const entry = { at: now(), found: false, value: find() };
      entry.value.then(
        (profile) => {
          entry.found = profile !== null;
        },
        () => undefined,
      );
      current = entry;
    }
    return current.value;
  };
}
