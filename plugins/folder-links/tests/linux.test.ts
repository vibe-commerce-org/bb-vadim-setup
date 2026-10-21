// The server's rules on a Linux machine — Ubuntu on its own, or Ubuntu in
// WSL2 under a Windows browser — run on any machine: POSIX path rules over a
// stand-in disk where names are case-sensitive, as on ext4. In WSL2 the
// Windows disk shows up as /mnt/c, outside the Ubuntu home folder, and BB
// itself refuses drive-letter paths there; the Windows user's profile folder
// is an extra root the server may read. Not tried on a live Ubuntu.
import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { inspectPath, listFolder } from "../src/folders.ts";
import type { System } from "../src/folders.ts";
import { dir, exactKey, fakeDisk, file, link } from "./fake-disk.ts";
import type { Node } from "./fake-disk.ts";

const linux = (tree: Record<string, Node>): System => ({ path: posix, disk: fakeDisk(tree, { path: posix, key: exactKey }) });

const tree: Record<string, Node> = {
  "/": dir,
  "/etc": dir,
  "/home": dir,
  "/home/kate": dir,
  "/home/kate/repo": dir,
  "/home/kate/repo/src": dir,
  "/home/kate/repo/.git": dir,
  "/home/kate/repo/notes.md": file,
  "/home/kate/Бэклог": dir,
  "/home/kate/My Docs": dir,
  "/home/kate/link-in": link("/home/kate/repo"),
  "/home/kate/link-out": link("/home/other/private"),
  "/home/kate/win-documents": link("/mnt/c/Users/Kate/Documents"),
  "/home/Kate": dir,
  "/home/Kate/secret": dir,
  "/home/other": dir,
  "/home/other/private": dir,
  "/mnt": dir,
  "/mnt/c": dir,
  "/mnt/c/Users": dir,
  "/mnt/c/Users/Kate": dir,
  "/mnt/c/Users/Kate/Documents": dir,
  "/mnt/c/Users/Kate/Documents/repo": dir,
  "/mnt/c/Users/Kate/Documents/repo/notes.md": file,
  "/mnt/c/Users/Public": dir,
  "/mnt/d": dir,
  "/mnt/d/data": dir,
};
const wsl = linux(tree);
const home = "/home/kate";
const kindOf = async (path: string) => (await inspectPath(path, home, wsl)).kind;

test("a folder in the Ubuntu home is found, with or without a trailing slash; a file is a file", async () => {
  for (const path of ["/home/kate/repo", "/home/kate/repo/", "/home/kate/Бэклог", "/home/kate/My Docs", "/home/kate"]) {
    assert.deepEqual(await inspectPath(path, home, wsl), { kind: "directory" }, path);
  }
  assert.deepEqual(await inspectPath("/home/kate/repo/notes.md", home, wsl), { kind: "file" });
});

test("names are case-sensitive: another user's /home/Kate is not /home/kate", async () => {
  assert.equal(await kindOf("/home/KATE/repo"), "outside");
  assert.equal(await kindOf("/home/Kate/secret"), "outside");
  assert.deepEqual(await inspectPath("/home/kate/REPO", home, wsl), { kind: "missing-folder", nearest: "/home/kate" });
});

test("a missing folder answers with its nearest existing folder, no higher than home; foo.md is left to BB", async () => {
  assert.deepEqual(await inspectPath("/home/kate/repo/nope/deeper", home, wsl), { kind: "missing-folder", nearest: "/home/kate/repo" });
  assert.deepEqual(await inspectPath("/home/kate/no-such/deeper", home, wsl), { kind: "missing-folder", nearest: "/home/kate" });
  assert.deepEqual(await inspectPath("/home/kate/repo/foo.md", home, wsl), { kind: "missing" });
  assert.deepEqual(await inspectPath("/home/kate/repo/notes.md/child", home, wsl), { kind: "missing" });
});

test("WSL2: the Windows disk is outside the Ubuntu home — /mnt/c, the Windows profile, a link into it", async () => {
  for (const path of [
    "/mnt/c",
    "/mnt/c/Users/Kate",
    "/mnt/c/Users/Kate/Documents",
    "/mnt/c/Users/Kate/no-such-folder",
    "/home/kate/win-documents",
    "/home/kate/win-documents/nope",
  ]) {
    assert.equal(await kindOf(path), "outside", path);
  }
  const listing = await listFolder("/home/kate/win-documents", home, wsl);
  assert.equal(listing.ok === false && listing.reason, "outside");
});

test("drive-letter and UNC paths are refused on a Linux server, as BB itself refuses them there", async () => {
  for (const path of ["C:\\Users\\Kate", "C:/Users/Kate", "c:\\users\\kate\\repo", "\\\\wsl$\\Ubuntu\\home\\kate", "\\\\server\\share"]) {
    assert.equal(await kindOf(path), "outside", path);
  }
});

test("nothing outside home: /etc, /, .., another user's folder, a link out", async () => {
  for (const path of ["/etc", "/", "/home", "/home/other/private", "/home/kate/../other/private", "/home/kate/link-out", "/home/kate/link-out/nope", "relative/path"]) {
    assert.equal(await kindOf(path), "outside", path);
  }
});

test("a link inside home is followed; a listing is one level, folders first, .git muted, parent stops at home", async () => {
  assert.equal(await kindOf("/home/kate/link-in"), "directory");

  const listing = await listFolder("/home/kate/repo", home, wsl);
  assert.ok(listing.ok);
  assert.equal(listing.path, "/home/kate/repo");
  assert.equal(listing.parent, "/home/kate");
  assert.deepEqual(
    listing.entries.map(({ name, kind, muted }) => ({ name, kind, muted })),
    [
      { name: ".git", kind: "directory", muted: true },
      { name: "src", kind: "directory", muted: false },
      { name: "notes.md", kind: "file", muted: false },
    ],
  );

  const top = await listFolder("/home/kate", home, wsl);
  assert.ok(top.ok);
  assert.equal(top.parent, null);
  const byName = new Map(top.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual({ kind: byName.get("link-out")?.kind, outside: byName.get("link-out")?.outside }, { kind: "directory", outside: true });
  assert.deepEqual({ kind: byName.get("win-documents")?.kind, outside: byName.get("win-documents")?.outside }, { kind: "directory", outside: true });
  assert.deepEqual({ kind: byName.get("link-in")?.kind, outside: byName.get("link-in")?.outside }, { kind: "directory", outside: false });
});

test("a home folder that is itself a link to another volume: the path as written and the real path both work", async () => {
  const moved = linux({
    "/": dir,
    "/home": dir,
    "/home/kate": link("/data/kate"),
    "/data": dir,
    "/data/kate": dir,
    "/data/kate/repo": dir,
    "/data/other": dir,
  });
  assert.deepEqual(await inspectPath("/home/kate/repo", "/home/kate", moved), { kind: "directory" });
  assert.deepEqual(await inspectPath("/data/kate/repo", "/home/kate", moved), { kind: "directory" });
  assert.deepEqual(await inspectPath("/home/kate/nope", "/home/kate", moved), { kind: "missing-folder", nearest: "/home/kate" });
  assert.deepEqual(await inspectPath("/data/other", "/home/kate", moved), { kind: "outside" });
  const listing = await listFolder("/home/kate/repo", "/home/kate", moved);
  assert.ok(listing.ok);
  assert.equal(listing.parent, "/home/kate");
});

// WSL2 with the Windows profile as a second root: where students' repositories
// on `C:` live. The profile folder, and nothing else on the Windows disk.
const profile = "/mnt/c/Users/Kate";
const roots = [home, profile];
const kindIn = async (path: string) => (await inspectPath(path, roots, wsl)).kind;

test("WSL2 with the Windows profile: folders on C: inside the profile are served", async () => {
  for (const path of ["/mnt/c/Users/Kate", "/mnt/c/Users/Kate/Documents", "/mnt/c/Users/Kate/Documents/repo/", "/home/kate/repo"]) {
    assert.equal(await kindIn(path), "directory", path);
  }
  assert.equal(await kindIn("/mnt/c/Users/Kate/Documents/repo/notes.md"), "file");
  assert.deepEqual(await inspectPath("/mnt/c/Users/Kate/Documents/repo/nope/deeper", roots, wsl), {
    kind: "missing-folder",
    nearest: "/mnt/c/Users/Kate/Documents/repo",
  });
  assert.deepEqual(await inspectPath("/mnt/c/Users/Kate/zzz", roots, wsl), { kind: "missing-folder", nearest: profile });
  assert.deepEqual(await inspectPath("/mnt/c/Users/Kate/Documents/foo.md", roots, wsl), { kind: "missing" });
});

test("WSL2 with the Windows profile: the rest of C: and other drives stay outside", async () => {
  for (const path of [
    "/mnt/c",
    "/mnt/c/Users",
    "/mnt/c/Users/Public",
    "/mnt/c/Users/Other",
    "/mnt/c/Windows",
    "/mnt/c/Users/Kate/../Public",
    "/mnt/c/users/kate/Documents",
    "/mnt/d",
    "/mnt/d/data",
    "/mnt/c/Users/KateX",
    "C:\\Users\\Kate\\Documents",
  ]) {
    assert.equal(await kindIn(path), "outside", path);
  }
  const listing = await listFolder("/mnt/c/Users/Public", roots, wsl);
  assert.equal(listing.ok === false && listing.reason, "outside");
});

test("WSL2 with the Windows profile: a link from home into the profile is followed, a link out of both is not", async () => {
  assert.equal(await kindIn("/home/kate/win-documents"), "directory");
  assert.equal(await kindIn("/home/kate/link-out"), "outside");
  const top = await listFolder("/home/kate", roots, wsl);
  assert.ok(top.ok);
  const byName = new Map(top.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("win-documents")?.outside, false);
  assert.equal(byName.get("link-out")?.outside, true);
});

test("WSL2 with the Windows profile: the tree goes up to the profile folder and no higher", async () => {
  const documents = await listFolder("/mnt/c/Users/Kate/Documents", roots, wsl);
  assert.ok(documents.ok);
  assert.equal(documents.path, "/mnt/c/Users/Kate/Documents");
  assert.equal(documents.parent, profile);
  assert.deepEqual(documents.entries.map((entry) => entry.name), ["repo"]);
  const top = await listFolder(profile, roots, wsl);
  assert.ok(top.ok);
  assert.equal(top.parent, null);
  const inHome = await listFolder("/home/kate/repo", roots, wsl);
  assert.ok(inHome.ok);
  assert.equal(inHome.parent, "/home/kate", "home keeps its own limit");
});

test("a second root that cannot be read is skipped, the home folder alone still works", async () => {
  const gone = ["/home/kate", "/mnt/c/Users/Nobody"];
  assert.deepEqual(await inspectPath("/home/kate/repo", gone, wsl), { kind: "directory" });
  assert.deepEqual(await inspectPath("/mnt/c/Users/Nobody/x", gone, wsl), { kind: "outside" });
  assert.deepEqual(await inspectPath("/mnt/c/Users/Kate/Documents", gone, wsl), { kind: "outside" });
});
