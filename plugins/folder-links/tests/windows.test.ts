// The server's rules on a Windows machine, run on any machine: Windows path
// rules (`node:path` win32) over a stand-in disk that behaves like NTFS —
// names match regardless of case (one character to one upper-case character,
// as NTFS's upcase table does), realpath gives each name as it is on disk and
// follows junctions. Not tried on a live Windows.
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { inspectPath, listFolder, looksLikeFile } from "../src/folders.ts";
import type { Disk, System } from "../src/folders.ts";
import { dir, fakeDisk, file, link, ntfsKey } from "./fake-disk.ts";

const windowsDisk = (tree: Parameters<typeof fakeDisk>[0]) => fakeDisk(tree, { path: win32, key: ntfsKey });

const windows: System = {
  path: win32,
  disk: windowsDisk({
    "C:\\": dir,
    "C:\\Users": dir,
    "C:\\Users\\Имя": dir,
    "C:\\Users\\Имя\\Documents": dir,
    "C:\\Users\\Имя\\Documents\\repo": dir,
    "C:\\Users\\Имя\\Documents\\repo\\src": dir,
    "C:\\Users\\Имя\\Documents\\repo\\.git": dir,
    "C:\\Users\\Имя\\Documents\\repo\\notes.md": file,
    "C:\\Users\\Имя\\Documents\\My Docs": dir,
    "C:\\Users\\Имя\\Documents\\v1.2": dir,
    "C:\\Users\\Имя\\Documents\\link-in": link("C:\\Users\\Имя\\Documents\\repo"),
    "C:\\Users\\Имя\\Documents\\link-out": link("C:\\Users\\Другой\\private"),
    "C:\\Users\\Другой": dir,
    "C:\\Users\\Другой\\private": dir,
    "C:\\Users\\ИмяX": dir,
    "D:\\": dir,
    "D:\\data": dir,
  }),
};

/** `os.homedir()` on Windows: %USERPROFILE%. */
const home = "C:\\Users\\Имя";
const kindOf = async (path: string) => (await inspectPath(path, home, windows)).kind;

test("a folder is found in any spelling: \\ or /, mixed, any case, a trailing separator", async () => {
  for (const path of [
    "C:\\Users\\Имя\\Documents\\repo",
    "C:/Users/Имя/Documents/repo",
    "c:\\users\\имя\\documents\\REPO",
    "C:\\Users/Имя\\Documents/repo\\",
    "C:/Users/Имя/Documents/repo/",
    "C:\\Users\\Имя\\Documents\\My Docs",
    "C:/Users/Имя/Documents/v1.2",
    "C:\\Users\\Имя",
  ]) {
    assert.deepEqual(await inspectPath(path, home, windows), { kind: "directory" }, path);
  }
  assert.deepEqual(await inspectPath("C:/Users/Имя/Documents/repo/notes.md", home, windows), { kind: "file" });
});

test("the home folder as %USERPROFILE% may come in another case or with a trailing \\", async () => {
  assert.equal((await inspectPath("C:\\Users\\Имя\\Documents\\repo", "c:\\users\\имя\\", windows)).kind, "directory");
  assert.equal((await inspectPath("C:\\Users\\Другой", "c:\\users\\имя\\", windows)).kind, "outside");
});

test("a missing folder answers with its nearest existing folder, in Windows spelling, no higher than home", async () => {
  assert.deepEqual(await inspectPath("C:/Users/Имя/Documents/repo/nope/deeper", home, windows), {
    kind: "missing-folder",
    nearest: "C:\\Users\\Имя\\Documents\\repo",
  });
  assert.deepEqual(await inspectPath("c:\\Users\\Имя\\Documents\\nope", home, windows), {
    kind: "missing-folder",
    nearest: "C:\\Users\\Имя\\Documents",
  });
  assert.deepEqual(await inspectPath("C:\\Users\\Имя\\no-such\\deeper", home, windows), {
    kind: "missing-folder",
    nearest: home,
  });
  // BB opens these as files: left to it.
  assert.deepEqual(await inspectPath("C:\\Users\\Имя\\Documents\\foo.md", home, windows), { kind: "missing" });
  assert.deepEqual(await inspectPath("C:\\Users\\Имя\\Documents\\repo\\notes.md\\child", home, windows), { kind: "missing" });
});

test("nothing outside the home folder: other drive, other profile, a lookalike name, .., a junction out", async () => {
  for (const path of [
    "D:\\data",
    "D:\\no-such-folder",
    "C:\\",
    "C:\\Users",
    "C:\\Users\\Другой\\private",
    "C:\\Users\\ИмяX",
    "C:\\Users\\Имя\\..\\Другой\\private",
    "C:/Users/Имя/Documents/../../Другой",
    "C:\\Users\\Имя\\Documents\\link-out",
    "C:\\Users\\Имя\\Documents\\link-out\\nope",
  ]) {
    assert.equal(await kindOf(path), "outside", path);
  }
});

test("not served on Windows: UNC, \\\\?\\, a path without a drive letter, a stream after a colon", async () => {
  for (const path of [
    "\\\\server\\share\\folder",
    "//server/share/folder",
    "\\\\?\\C:\\Users\\Имя\\Documents",
    "\\\\.\\C:\\Users\\Имя",
    "C:Users\\Имя",
    "\\Users\\Имя",
    "/Users/Имя",
    "/C:/Users/Имя",
    "Users\\Имя",
    "C:\\Users\\Имя\\Documents:stream",
    "C:\\Users\\Имя\\Documents\0",
  ]) {
    assert.equal(await kindOf(path), "outside", path);
  }
});

test("a junction inside home is followed; a listing gives Windows paths, folders first, muted .git", async () => {
  assert.equal(await kindOf("C:\\Users\\Имя\\Documents\\link-in"), "directory");

  const listing = await listFolder("C:/Users/Имя/Documents/repo/", home, windows);
  assert.ok(listing.ok);
  assert.equal(listing.path, "C:\\Users\\Имя\\Documents\\repo");
  assert.equal(listing.parent, "C:\\Users\\Имя\\Documents");
  assert.deepEqual(
    listing.entries.map(({ name, path, kind, muted }) => ({ name, path, kind, muted })),
    [
      { name: ".git", path: "C:\\Users\\Имя\\Documents\\repo\\.git", kind: "directory", muted: true },
      { name: "src", path: "C:\\Users\\Имя\\Documents\\repo\\src", kind: "directory", muted: false },
      { name: "notes.md", path: "C:\\Users\\Имя\\Documents\\repo\\notes.md", kind: "file", muted: false },
    ],
  );

  const documents = await listFolder("C:\\Users\\Имя\\Documents", home, windows);
  assert.ok(documents.ok);
  const byName = new Map(documents.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual({ kind: byName.get("link-out")?.kind, outside: byName.get("link-out")?.outside }, { kind: "directory", outside: true });
  assert.deepEqual({ kind: byName.get("link-in")?.kind, outside: byName.get("link-in")?.outside }, { kind: "directory", outside: false });

  const refused = await listFolder("C:\\Users\\Имя\\Documents\\link-out", home, windows);
  assert.equal(refused.ok === false && refused.reason, "outside");
});

test("a name NTFS keeps apart is not taken for the home folder: Kate and its lookalike with the Kelvin sign U+212A", async () => {
  const kelvin = "\u212A";
  const disk: System = {
    path: win32,
    disk: windowsDisk({
      "C:\\": dir,
      "C:\\Users": dir,
      "C:\\Users\\Kate": dir,
      "C:\\Users\\Kate\\repo": dir,
      [`C:\\Users\\${kelvin}ate`]: dir,
      [`C:\\Users\\${kelvin}ate\\secret`]: dir,
    }),
  };
  assert.equal(`${kelvin}ate`.toLowerCase(), "kate", "JavaScript's lower case joins them");
  assert.equal((await inspectPath("c:\\users\\KATE\\repo", "C:\\Users\\Kate", disk)).kind, "directory");
  assert.equal((await inspectPath(`C:\\Users\\${kelvin}ate\\secret`, "C:\\Users\\Kate", disk)).kind, "outside");
  assert.equal((await inspectPath(`C:\\Users\\${kelvin}ate\\nope`, "C:\\Users\\Kate", disk)).kind, "outside");
  const listing = await listFolder(`C:\\Users\\${kelvin}ate`, "C:\\Users\\Kate", disk);
  assert.equal(listing.ok === false && listing.reason, "outside");
});

test("going up stops at the home folder", async () => {
  const atHome = await listFolder("c:/users/имя", home, windows);
  assert.ok(atHome.ok);
  assert.equal(atHome.parent, null);
});

test("BB's file test for a path with a drive letter: \\ is a separator too", () => {
  assert.equal(looksLikeFile("C:\\Users\\Имя\\notes.md"), true);
  assert.equal(looksLikeFile("C:\\Users\\Имя\\.env"), true);
  assert.equal(looksLikeFile("C:\\Users\\Имя\\no-such-folder"), false);
  assert.equal(looksLikeFile("C:\\Users\\Имя.Old\\no-such-folder"), false, "a dot in an earlier segment does not count");
  assert.equal(looksLikeFile("C:\\Users\\Имя\\v1.2\\"), false);
  assert.equal(looksLikeFile("C:/Users/Имя/v1.2/"), false);
});

test("on a Mac or Linux server a Windows path is simply outside the home folder", async () => {
  const untouched: Disk = {
    realpath: async (path) => assert.fail(`disk read for ${path}`),
    stat: async (path) => assert.fail(`disk read for ${path}`),
    readdir: async (path) => assert.fail(`disk read for ${path}`),
  };
  const unix: System = { path: posix, disk: untouched };
  for (const path of ["C:\\Users\\me\\repo", "C:/Users/me/repo", "\\\\server\\share"]) {
    assert.deepEqual(await inspectPath(path, "/Users/me", unix), { kind: "outside" }, path);
  }
});
