// A disk in memory for the tests of a platform the tests do not run on: the
// folder tree is a plain object, path rules come from `node:path` (win32 or
// posix) and `key` says when two names are the same name — exactly for Linux,
// the way NTFS does it for Windows. realpath gives each name as it is stored
// and follows links and junctions; the errors carry the codes the server reads.
import type { PlatformPath } from "node:path";
import type { Disk, DiskEntry } from "../src/folders.ts";

export type Node = { kind: "dir" } | { kind: "file" } | { kind: "link"; target: string };

export const dir = { kind: "dir" } as const;
export const file = { kind: "file" } as const;
export const link = (target: string) => ({ kind: "link", target }) as const;

const fail = (code: string, path: string) => Object.assign(new Error(`${code}: ${path}`), { code });

/** Linux: a name is the same name only if it is spelled the same. */
export const exactKey = (path: string) => path;

/** NTFS compares names by upper-casing each character on its own: `ß` stays `ß`, the Kelvin sign U+212A stays apart from `K`. */
export const ntfsKey = (path: string) =>
  Array.from(path, (char) => {
    const upper = char.toUpperCase();
    return Array.from(upper).length === 1 ? upper : char;
  }).join("");

export function fakeDisk(tree: Record<string, Node>, rules: { path: PlatformPath; key: (path: string) => string }): Disk {
  const { path: api, key } = rules;
  const nodes = new Map(Object.entries(tree).map(([path, node]) => [key(path), { path, node }]));

  const resolve = (input: string, depth = 0): string => {
    if (depth > 8) throw fail("ELOOP", input);
    const normalized = api.normalize(input);
    const { root } = api.parse(normalized);
    const start = nodes.get(key(root));
    if (start === undefined) throw fail("ENOENT", input);
    const names = normalized.slice(root.length).split(api.sep).filter((part) => part !== "");
    let current = start.path;
    for (const [index, name] of names.entries()) {
      const entry = nodes.get(key(api.join(current, name)));
      if (entry === undefined) throw fail("ENOENT", input);
      if (entry.node.kind === "file" && index < names.length - 1) throw fail("ENOTDIR", input);
      current = entry.node.kind === "link" ? resolve(entry.node.target, depth + 1) : entry.path;
    }
    return current;
  };

  return {
    realpath: async (path) => resolve(path),
    stat: async (path) => {
      const kind = nodes.get(key(resolve(path)))?.node.kind;
      return { isDirectory: () => kind === "dir" };
    },
    readdir: async (path) => {
      const folder = key(resolve(path));
      const entries: DiskEntry[] = [];
      for (const { path: child, node } of nodes.values()) {
        if (key(child) === folder || key(api.dirname(child)) !== folder) continue;
        entries.push({
          name: api.basename(child),
          isDirectory: () => node.kind === "dir",
          isSymbolicLink: () => node.kind === "link",
        });
      }
      return entries;
    },
  };
}
