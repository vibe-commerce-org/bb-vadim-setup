// What the repository tree shows and in what order. Pure functions: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findRepoRoot, folderChain, isMarkdownName, relativeTo, sortEntries, visibleEntries } from "../src/repo-tree.ts";
import type { TreeEntry } from "../src/repo-tree.ts";

const entry = (kind: TreeEntry["kind"], name: string): TreeEntry => ({ kind, name, path: `/r/${name}` });

test("a path is shown relative to the root, with or without a trailing slash on the root", () => {
  assert.equal(relativeTo("/work/repo", "/work/repo/docs/a.md"), "docs/a.md");
  assert.equal(relativeTo("/work/repo/", "/work/repo/a.md"), "a.md");
  assert.equal(relativeTo("/work/repo", "/work/repo"), "");
  assert.equal(relativeTo("/", "/etc/hosts"), "etc/hosts");
});

test("a path outside the root has no relative form, even when a sibling folder shares its prefix", () => {
  assert.equal(relativeTo("/work/repo", "/work/repo-old/a.md"), null);
  assert.equal(relativeTo("/work/repo", "/other/a.md"), null);
});

test("the folders leading to a file run from the root down to the file's own folder", () => {
  assert.deepEqual(folderChain("/work/repo", "/work/repo/backlog/plans/p.md"), [
    "/work/repo",
    "/work/repo/backlog",
    "/work/repo/backlog/plans",
  ]);
  assert.deepEqual(folderChain("/work/repo/", "/work/repo/README.md"), ["/work/repo"]);
  assert.deepEqual(folderChain("/", "/etc/hosts"), ["/", "/etc"]);
});

test("a file outside the root has no folder chain", () => {
  assert.deepEqual(folderChain("/work/repo", "/work/repo-old/a.md"), []);
  assert.deepEqual(folderChain("/work/repo", "/other/a.md"), []);
});

test("folders come first, then files; names ignore case and compare numbers by value", () => {
  const sorted = sortEntries([
    entry("file", "b.md"),
    entry("directory", "Zeta"),
    entry("file", "A.md"),
    entry("directory", "alpha"),
    entry("file", "plan-10.md"),
    entry("file", "plan-9.md"),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["alpha", "Zeta", "A.md", "b.md", "plan-9.md", "plan-10.md"],
  );
});

test("sorting leaves the listing it was given untouched", () => {
  const listing = [entry("file", "b.md"), entry("file", "a.md")];
  sortEntries(listing);
  assert.deepEqual(
    listing.map((item) => item.name),
    ["b.md", "a.md"],
  );
});

test("the node_modules and __pycache__ folders are not shown; a file with such a name is", () => {
  const names = visibleEntries([
    entry("directory", "node_modules"),
    entry("directory", "__pycache__"),
    entry("directory", "src"),
    entry("file", "README.md"),
    entry("file", "node_modules"),
  ]).map((item) => item.name);
  assert.deepEqual(names, ["src", "node_modules", "README.md"]);
});

test("Markdown is recognised by extension, case aside; other documents are not", () => {
  for (const name of ["a.md", "A.MD", "notes.markdown", "page.mdx"]) assert.equal(isMarkdownName(name), true, name);
  for (const name of ["a.md.bak", "image.png", "README", "md", "data.json"]) assert.equal(isMarkdownName(name), false, name);
});

test("the repository root is the deepest folder above the file that has .git", async () => {
  const withGit = new Set(["/work/repo", "/work"]);
  const probed: string[] = [];
  const root = await findRepoRoot("/work/repo/docs/deep/a.md", async (folder) => {
    probed.push(folder);
    return withGit.has(folder);
  });
  assert.equal(root, "/work/repo");
  assert.deepEqual(probed, ["/work/repo/docs/deep", "/work/repo/docs", "/work/repo", "/work"]);
});

test("a file in the repository's own top folder finds that folder", async () => {
  assert.equal(await findRepoRoot("/work/repo/a.md", async (folder) => folder === "/work/repo"), "/work/repo");
});

test("no repository above the file gives null, and a probe that throws counts as 'no'", async () => {
  assert.equal(await findRepoRoot("/tmp/notes/a.md", async () => false), null);
  assert.equal(
    await findRepoRoot("/work/repo/a.md", async (folder) => {
      if (folder === "/work/repo") throw new Error("host unreachable");
      return false;
    }),
    null,
  );
});

test("the search stops after a bounded number of levels and never probes the filesystem root", async () => {
  const probed: string[] = [];
  const deep = `/${Array.from({ length: 30 }, (_, i) => `d${i}`).join("/")}/a.md`;
  assert.equal(
    await findRepoRoot(deep, async (folder) => {
      probed.push(folder);
      return false;
    }),
    null,
  );
  assert.equal(probed.length, 12);
  assert.equal(probed.includes("/"), false);
});
