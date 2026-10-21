// What the server knows about a path from a chat link: whether it is a folder,
// and what lies one level inside it.
//
// A path is answered only as it was written — no search by name, no guessing
// which repository it meant. Before anything is read, the path goes through
// realpath, and both the path as written and the real path must lie inside the
// home folder (or another root): a symlink pointing out of them is refused like any outside path.
//
// A missing path that BB would send to its browser (no dot in the last
// segment) is answered with the nearest existing folder up the same path, no
// higher than the home folder. A missing `foo.md` is left to BB, which shows
// "not found" in its own panel.
//
// The path rules are those of the machine BB's server runs on, never of the
// browser: on Windows only `C:\…` with a drive letter, either separator, any
// case; UNC paths (`\\server\share`) are not served. The tests swap in
// Windows rules and a stand-in Windows disk.
import { readdir, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { PlatformPath } from "node:path";

/** `file` is anything that is not a folder: BB keeps handling those links. */
export type PathKind = "directory" | "file" | "missing" | "outside" | "denied";

/** What a link path is; for a missing folder, the folder shown instead. */
export type PathVerdict = { kind: PathKind } | { kind: "missing-folder"; nearest: string };

export interface FolderEntry {
  name: string;
  /** Absolute path as seen from the listed folder, not resolved. */
  path: string;
  kind: "directory" | "file";
  /** Hidden entries and heavy service folders: shown dimmed, never expanded on their own. */
  muted: boolean;
  /** A symlink whose target lies outside the home folder: shown, but not opened. */
  outside: boolean;
}

export type FolderListing =
  | { ok: true; path: string; parent: string | null; entries: FolderEntry[]; truncated: boolean }
  | { ok: false; reason: "missing" | "not-directory" | "outside" | "denied"; message: string };

export const MAX_ENTRIES = 5000;
const SERVICE_FOLDERS = new Set([".git", "node_modules", ".venv", "__pycache__"]);

export interface DiskEntry {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The few disk calls the server makes, all read-only. */
export interface Disk {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  readdir(path: string): Promise<DiskEntry[]>;
}

/** The machine BB's server runs on: its path rules and its disk. */
export interface System {
  path: PlatformPath;
  disk: Disk;
}

export const thisSystem: System = {
  path: process.platform === "win32" ? win32 : posix,
  disk: {
    realpath: (path) => realpath(path),
    stat: (path) => stat(path),
    readdir: (path) => readdir(path, { withFileTypes: true }),
  },
};

const isWindows = (system: System) => system.path === win32;
/** An absolute Windows path with a drive letter: `C:\…` or `C:/…`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u;

const insideOf = (path: string, root: string, sep: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * A path as written lies under `root`. Windows matches names regardless of
 * case, so this check only picks which paths to look up on disk.
 */
const caseOf = (path: string, system: System) => (isWindows(system) ? path.toLowerCase() : path);
const same = (a: string, b: string, system: System) => caseOf(a, system) === caseOf(b, system);
const within = (path: string, root: string, system: System) =>
  insideOf(caseOf(path, system), caseOf(root, system), system.path.sep);

/**
 * A real path, as the disk returned it, lies under a real root folder. Both
 * carry the names as stored, so they are compared exactly, all but the drive
 * letter: `toLowerCase` would join names NTFS keeps apart, such as `Kate`
 * and `\u212Aate` with the Kelvin sign.
 */
const driveOf = (path: string, system: System) => (isWindows(system) ? path.charAt(0).toUpperCase() + path.slice(1) : path);
const realWithin = (real: string, realRoot: string, system: System) =>
  insideOf(driveOf(real, system), driveOf(realRoot, system), system.path.sep);

/**
 * Only an absolute path is answered. On Windows that is `C:\…`: not UNC, not
 * `\\?\…`, not `C:foo` or `\foo`, and no colon past the drive letter.
 */
function accepted(path: string, system: System): boolean {
  if (path.includes("\0")) return false;
  if (!isWindows(system)) return system.path.isAbsolute(path);
  return DRIVE_PATH.test(path) && !path.slice(2).includes(":");
}

/**
 * `/a/b/` and `/a/./b` become `/a/b`; the root stays `/`. On Windows
 * `c:/a//b/` becomes `C:\a\b`: the drive letter upper case, the root `C:\`.
 */
function tidy(path: string, system: System): string {
  let normalized = system.path.normalize(path);
  if (isWindows(system)) normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  const { root } = system.path.parse(normalized);
  return normalized.length > root.length && normalized.endsWith(system.path.sep) ? normalized.slice(0, -1) : normalized;
}

function errorCode(cause: unknown): string {
  return typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
}

/**
 * The folders the server may read: the home folder first, then any more
 * (WSL2: the Windows user's profile, where repositories on `C:` usually live).
 */
export type Roots = string | readonly string[];

interface Root {
  /** As given, tidied. */
  written: string;
  /** As the disk spells it. */
  real: string;
}

/**
 * The roots as written and as the disk spells them. A root that cannot be
 * read is skipped — except the first, the home folder, whose failure is the
 * caller's to see.
 */
async function loadRoots(roots: Roots, system: System): Promise<Root[]> {
  const loaded: Root[] = [];
  for (const [index, root] of (typeof roots === "string" ? [roots] : roots).entries()) {
    const written = tidy(root, system);
    try {
      loaded.push({ written, real: await system.disk.realpath(written) });
    } catch (cause) {
      if (index === 0) throw cause;
    }
  }
  return loaded;
}

/**
 * Folders of the projects BB works in, as more roots next to the base ones
 * (the home folder, in WSL2 also the Windows profile): a student opens a
 * repository in BB, and its links should just work, wherever it lies. Left
 * out: what is not an absolute path of this machine, a whole disk, a folder
 * that contains a base root (a project at `/home` or `C:\Users` must not
 * open other users' folders), what lies inside a base root already, and
 * repeats.
 */
export function extraRoots(candidates: readonly string[], base: readonly string[], system: System = thisSystem): string[] {
  const bases = base.map((root) => tidy(root, system));
  const found: string[] = [];
  for (const candidate of candidates) {
    if (!accepted(candidate, system)) continue;
    const root = tidy(candidate, system);
    if (root === system.path.parse(root).root) continue;
    if (bases.some((known) => within(known, root, system) || within(root, known, system))) continue;
    if (found.some((known) => within(root, known, system))) continue;
    found.push(root);
  }
  return found;
}

const insideAny = (real: string, roots: readonly Root[], system: System) => roots.some((root) => realWithin(real, root.real, system));

type Resolved =
  | { ok: true; path: string; real: string; root: Root; roots: Root[] }
  | { ok: false; kind: "outside" | "denied" }
  | { ok: false; kind: "missing"; path: string; base: string; roots: Root[] };

/** The path inside the home folder (or another root), or why it is not served. Nothing outside the roots is touched. */
async function resolveInRoots(path: string, roots: Roots, system: System): Promise<Resolved> {
  if (!accepted(path, system)) return { ok: false, kind: "outside" };
  const loaded = await loadRoots(roots, system);
  const tidyPath = tidy(path, system);
  const root =
    loaded.find((candidate) => within(tidyPath, candidate.written, system)) ??
    loaded.find((candidate) => within(tidyPath, candidate.real, system));
  if (root === undefined) return { ok: false, kind: "outside" };
  const base = within(tidyPath, root.written, system) ? root.written : root.real;
  let real: string;
  try {
    real = await system.disk.realpath(tidyPath);
  } catch (cause) {
    const code = errorCode(cause);
    if (code === "EACCES" || code === "EPERM") return { ok: false, kind: "denied" };
    return { ok: false, kind: "missing", path: tidyPath, base, roots: loaded };
  }
  if (!insideAny(real, loaded, system)) return { ok: false, kind: "outside" };
  return { ok: true, path: tidyPath, real, root, roots: loaded };
}

/**
 * BB's own test for "a link to a file": the last segment has a dot and the
 * path does not end with a separator — for a path with a drive letter, `\`
 * counts as one too. Such a link BB opens in its file panel; any other it
 * treats as a web address.
 */
export function looksLikeFile(path: string): boolean {
  const drive = DRIVE_PATH.test(path);
  if (path.endsWith("/") || (drive && path.endsWith("\\"))) return false;
  return ((drive ? path.split(/[\\/]/u) : path.split("/")).pop() ?? "").includes(".");
}

/**
 * The first ancestor of a missing path that exists, walking up the same path
 * and stopping at the root it lies in. It must be a folder inside the roots;
 * a file or a symlink out on the way leaves the link to BB.
 */
async function nearestFolder(path: string, base: string, roots: readonly Root[], system: System): Promise<PathVerdict> {
  const { dirname } = system.path;
  for (let candidate = dirname(path); within(candidate, base, system); candidate = dirname(candidate)) {
    let real: string;
    try {
      real = await system.disk.realpath(candidate);
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "EACCES" || code === "EPERM") return { kind: "denied" };
      if (same(candidate, base, system) || dirname(candidate) === candidate) break;
      continue;
    }
    if (!insideAny(real, roots, system)) return { kind: "outside" };
    try {
      return (await system.disk.stat(real)).isDirectory() ? { kind: "missing-folder", nearest: candidate } : { kind: "missing" };
    } catch {
      return { kind: "missing" };
    }
  }
  return { kind: "missing" };
}

export async function inspectPath(path: string, home: Roots, system: System = thisSystem): Promise<PathVerdict> {
  const resolved = await resolveInRoots(path, home, system);
  if (!resolved.ok) {
    if (resolved.kind !== "missing" || looksLikeFile(path)) return { kind: resolved.kind };
    return nearestFolder(resolved.path, resolved.base, resolved.roots, system);
  }
  try {
    return { kind: (await system.disk.stat(resolved.real)).isDirectory() ? "directory" : "file" };
  } catch {
    return { kind: "missing" };
  }
}

const MESSAGES = {
  missing: "Такой папки нет.",
  "not-directory": "Это не папка.",
  outside: "Папка вне домашней папки и папок проектов BB — плагин её не показывает.",
  denied: "Нет доступа к папке.",
} as const;

const refuse = (reason: keyof typeof MESSAGES): FolderListing => ({ ok: false, reason, message: MESSAGES[reason] });

/** One level of the folder: folders first, then files, by name. */
export async function listFolder(path: string, home: Roots, system: System = thisSystem): Promise<FolderListing> {
  const resolved = await resolveInRoots(path, home, system);
  if (!resolved.ok) return refuse(resolved.kind);
  const { dirname, join } = system.path;
  let dirents;
  try {
    if (!(await system.disk.stat(resolved.real)).isDirectory()) return refuse("not-directory");
    dirents = await system.disk.readdir(resolved.real);
  } catch (cause) {
    const code = errorCode(cause);
    return refuse(code === "EACCES" || code === "EPERM" ? "denied" : "missing");
  }
  const truncated = dirents.length > MAX_ENTRIES;
  const entries = await Promise.all(
    dirents.slice(0, MAX_ENTRIES).map(async (dirent): Promise<FolderEntry> => {
      const entryPath = join(resolved.path, dirent.name);
      const muted = dirent.name.startsWith(".") || SERVICE_FOLDERS.has(dirent.name);
      if (!dirent.isSymbolicLink()) {
        return { name: dirent.name, path: entryPath, kind: dirent.isDirectory() ? "directory" : "file", muted, outside: false };
      }
      try {
        const target = await system.disk.realpath(join(resolved.real, dirent.name));
        const kind = (await system.disk.stat(target)).isDirectory() ? "directory" : "file";
        return { name: dirent.name, path: entryPath, kind, muted, outside: !insideAny(target, resolved.roots, system) };
      } catch {
        // A broken link: BB shows its own error if it is opened.
        return { name: dirent.name, path: entryPath, kind: "file", muted, outside: false };
      }
    }),
  );
  entries.sort(
    (a, b) =>
      Number(a.kind === "file") - Number(b.kind === "file") ||
      a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }),
  );
  const parentPath = dirname(resolved.path);
  const { written, real } = resolved.root;
  const parent =
    parentPath !== resolved.path && (within(parentPath, written, system) || within(parentPath, real, system)) ? parentPath : null;
  return { ok: true, path: resolved.path, parent, entries, truncated };
}
