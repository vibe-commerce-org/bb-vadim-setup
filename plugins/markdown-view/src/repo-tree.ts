// What the repository tree shows and in what order, decided without touching
// the page: paths relative to the root, the folders leading to a file, how a
// folder's entries are sorted and filtered, and where the repository starts
// for a file that arrived without a checkout.

export interface TreeEntry {
  kind: "directory" | "file";
  name: string;
  /** Absolute path on the host. */
  path: string;
}

/** Folders nobody browses for documents; big, and not the repository's own words. */
const SKIPPED_NAMES = new Set(["node_modules", "__pycache__"]);

/** How far up from a file the search for `.git` goes; deeper than this is not a project folder. */
const MAX_ROOT_SEARCH_DEPTH = 12;

const trimSlash = (path: string) => path.replace(/\/+$/, "") || "/";
const dirname = (path: string) => path.replace(/\/[^/]*$/, "") || "/";

/** `path` as seen from `root` (`docs/a.md`); "" for the root itself, null outside it. */
export function relativeTo(root: string, path: string): string | null {
  const base = trimSlash(root);
  if (path === base) return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

/** The folders from `root` down to the one holding `path`, root first; empty when `path` is outside `root`. */
export function folderChain(root: string, path: string): string[] {
  const base = trimSlash(root);
  const relative = relativeTo(base, dirname(path));
  if (relative === null) return [];
  const chain = [base];
  for (const part of relative === "" ? [] : relative.split("/")) {
    const last = chain[chain.length - 1];
    chain.push(last === "/" ? `/${part}` : `${last}/${part}`);
  }
  return chain;
}

/** Folders first, then files; each group by name, numbers by value, case ignored. */
export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** What a folder row expands to: its entries without the skipped folders, sorted. */
export const visibleEntries = (entries: readonly TreeEntry[]): TreeEntry[] =>
  sortEntries(entries.filter((entry) => entry.kind === "file" || !SKIPPED_NAMES.has(entry.name)));

/** A file this plugin shows in place; anything else goes to BB's own preview. */
export const isMarkdownName = (name: string) => /\.(md|mdx|markdown)$/i.test(name);

/**
 * The repository `path` belongs to: the deepest folder above it that `hasGit`
 * confirms. All candidates are probed at once; null when none is a repository.
 */
export async function findRepoRoot(path: string, hasGit: (folder: string) => Promise<boolean>): Promise<string | null> {
  const candidates: string[] = [];
  for (let folder = dirname(path); folder !== "/" && candidates.length < MAX_ROOT_SEARCH_DEPTH; folder = dirname(folder)) {
    candidates.push(folder);
  }
  const found = await Promise.all(candidates.map((folder) => hasGit(folder).catch(() => false)));
  const index = found.indexOf(true);
  return index === -1 ? null : candidates[index];
}
