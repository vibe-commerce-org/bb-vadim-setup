// Projects Pult never shows: those whose folder lies inside the __PRIVATE folder
// in the _CODE folder of the user's Documents (the author's convention for
// projects that must stay out of Pult). New projects in that folder are
// excluded by their path, with no setting.
//
// Fail-closed while that folder exists: a project is shown only when BB names
// its folder and none of its folders is inside __PRIVATE. A project without a
// folder is not shown, except BB's own «Personal», which never has one.
// Without the folder (a user who keeps no private projects) every project is
// shown. Paths compare folder by
// folder, as given and with symlinks resolved (realpath.native also gives the
// on-disk letter case on macOS).
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const PRIVATE_ROOT = join(homedir(), "Documents", "_CODE", "__PRIVATE");

/**
 * shown — Pult shows the project's threads; private — the folder is inside
 * __PRIVATE, Pult keeps nothing of its threads; unknown — no folder known, the
 * threads are not shown, but what Pult stored stays (BB may answer again).
 */
export type ProjectAccess = "shown" | "private" | "unknown";

/** The path made absolute and, when it exists here, its real path. */
function forms(path: string): string[] {
  const absolute = resolve(path);
  try {
    return [absolute, realpathSync.native(absolute)];
  } catch {
    return [absolute];
  }
}

/** True when `path` is the folder `root` or lies inside it. */
export function insideFolder(path: string, root: string): boolean {
  const roots = forms(root);
  return forms(path).some((p) => roots.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep)));
}

export function projectAccess(
  project: { kind: string; sources: readonly { path: string }[] },
  root: string = PRIVATE_ROOT,
): ProjectAccess {
  const paths = project.sources.map((source) => source.path);
  if (paths.some((path) => isAbsolute(path) && insideFolder(path, root))) return "private";
  // No private folder on this machine (most users of the kit): nothing to keep out.
  if (!existsSync(root)) return "shown";
  if (paths.length === 0) return project.kind === "personal" ? "shown" : "unknown";
  return paths.every(isAbsolute) ? "shown" : "unknown";
}
