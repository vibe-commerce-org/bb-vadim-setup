// Which project folders become readable next to the home folder, and the short
// memory in front of BB's project list. Platforms the tests do not run on are
// stood in for by their path rules; only the paths matter here, no disk.
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { cachedFor } from "../src/cache.ts";
import { extraRoots, inspectPath, listFolder } from "../src/folders.ts";
import type { System } from "../src/folders.ts";
import { dir, exactKey, fakeDisk, file, ntfsKey } from "./fake-disk.ts";

const noDisk = (path: typeof posix | typeof win32): System => ({
  path,
  disk: {
    realpath: async (p) => assert.fail(`disk read for ${p}`),
    stat: async (p) => assert.fail(`disk read for ${p}`),
    readdir: async (p) => assert.fail(`disk read for ${p}`),
  },
});

test("Windows: a repository on another drive or outside the profile is added; a whole disk, Users, UNC and POSIX paths are not", () => {
  const system = noDisk(win32);
  const base = ["C:\\Users\\Имя"];
  assert.deepEqual(
    extraRoots(
      [
        "D:\\work\\repo",
        "d:/work/repo/",
        "C:\\dev\\app",
        "C:\\Users\\Имя\\Documents\\proj",
        "C:\\Users\\Имя",
        "c:\\users\\имя\\other",
        "C:\\Users",
        "C:\\",
        "D:\\",
        "\\\\server\\share\\repo",
        "/home/kate/repo",
        "relative\\path",
        "D:\\work\\repo\\sub",
        "E:\\data\\a\0b",
      ],
      base,
      system,
    ),
    ["D:\\work\\repo", "C:\\dev\\app"],
  );
});

test("Ubuntu and Mac: only projects outside the home folder are added", () => {
  const ubuntu = noDisk(posix);
  assert.deepEqual(
    extraRoots(["/home/kate/repo", "/home/kate", "/srv/projects/app", "/srv/projects/app/", "/srv/projects/app/sub", "/home", "/", "relative", "C:\\dev"], ["/home/kate"], ubuntu),
    ["/srv/projects/app"],
  );
  assert.deepEqual(extraRoots(["/Volumes/Work/repo", "/Users/me/Documents/x", "/Users"], ["/Users/me"], ubuntu), ["/Volumes/Work/repo"]);
});

test("WSL2: a repository on C: or D: outside the profile is added; /mnt/c, /mnt/c/Users and the profile's parents are not", () => {
  const base = ["/home/kate", "/mnt/c/Users/Kate"];
  assert.deepEqual(
    extraRoots(
      ["/mnt/c/dev/app", "/mnt/d/work/repo", "/mnt/c/Users/Kate/Documents/repo", "/mnt/c/Users", "/mnt/c", "/mnt", "/mnt/c/Users/Other/repo", "/home/kate/x"],
      base,
      noDisk(posix),
    ),
    ["/mnt/c/dev/app", "/mnt/d/work/repo", "/mnt/c/Users/Other/repo"],
  );
});

test("with the project folders as roots a repository outside home is served, and nothing next to it", async () => {
  const system: System = {
    path: posix,
    disk: fakeDisk(
      {
        "/": dir,
        "/home": dir,
        "/home/kate": dir,
        "/mnt": dir,
        "/mnt/d": dir,
        "/mnt/d/work": dir,
        "/mnt/d/work/repo": dir,
        "/mnt/d/work/repo/notes.md": file,
        "/mnt/d/other": dir,
        "/mnt/d/work-secret": dir,
      },
      { path: posix, key: exactKey },
    ),
  };
  const roots = ["/home/kate", ...extraRoots(["/mnt/d/work/repo"], ["/home/kate"], system)];
  assert.deepEqual(roots, ["/home/kate", "/mnt/d/work/repo"]);
  assert.deepEqual(await inspectPath("/mnt/d/work/repo", roots, system), { kind: "directory" });
  assert.deepEqual(await inspectPath("/mnt/d/work/repo/notes.md", roots, system), { kind: "file" });
  assert.deepEqual(await inspectPath("/mnt/d/work/repo/nope", roots, system), { kind: "missing-folder", nearest: "/mnt/d/work/repo" });
  for (const path of ["/mnt/d", "/mnt/d/work", "/mnt/d/other", "/mnt/d/work-secret", "/mnt/d/work/repo/../../other"]) {
    assert.deepEqual(await inspectPath(path, roots, system), { kind: "outside" }, path);
  }
  const listing = await listFolder("/mnt/d/work/repo", roots, system);
  assert.ok(listing.ok);
  assert.equal(listing.parent, null, "the tree stops at the project folder");
});

test("Windows: a repository on D: is served with the NTFS rules", async () => {
  const system: System = {
    path: win32,
    disk: fakeDisk(
      {
        "C:\\": dir,
        "C:\\Users": dir,
        "C:\\Users\\Имя": dir,
        "D:\\": dir,
        "D:\\Work": dir,
        "D:\\Work\\Repo": dir,
        "D:\\Work\\Other": dir,
      },
      { path: win32, key: ntfsKey },
    ),
  };
  const home = "C:\\Users\\Имя";
  const roots = [home, ...extraRoots(["D:/work/repo"], [home], system)];
  assert.equal((await inspectPath("d:\\WORK\\repo", roots, system)).kind, "directory");
  assert.equal((await inspectPath("D:\\Work\\Other", roots, system)).kind, "outside");
  assert.equal((await inspectPath("D:\\Work", roots, system)).kind, "outside");
});

test("the project list is asked once for a burst of questions, again after the time, and a failure keeps the last answer", async () => {
  let clock = 0;
  let asked = 0;
  let fail = false;
  const folders = cachedFor(
    async () => {
      asked += 1;
      if (fail) throw new Error("server busy");
      return [`/srv/p${asked}`];
    },
    10_000,
    [],
    () => clock,
  );
  assert.deepEqual(await Promise.all([folders(), folders(), folders()]), [["/srv/p1"], ["/srv/p1"], ["/srv/p1"]]);
  clock = 5_000;
  assert.deepEqual(await folders(), ["/srv/p1"]);
  assert.equal(asked, 1);
  clock = 11_000;
  assert.deepEqual(await folders(), ["/srv/p2"], "a new project is picked up after the time");
  fail = true;
  clock = 22_000;
  assert.deepEqual(await folders(), ["/srv/p2"], "a failed question leaves the last answer");
  assert.equal(asked, 3);
});

test("a project list that fails from the start gives the fallback, not an error", async () => {
  const folders = cachedFor(async () => Promise.reject(new Error("no server")), 10_000, ["fallback"]);
  assert.deepEqual(await folders(), ["fallback"]);
});
