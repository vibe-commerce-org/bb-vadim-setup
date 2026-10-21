// Reading the path out of a chat link's `href`: the same in any browser, for
// either platform. Which paths are served is the server's business.
import assert from "node:assert/strict";
import { test } from "node:test";
import { folderTitle, hostFilePath, isAbsoluteLinkPath, linkPath } from "../src/link-path.ts";

test("Mac and Linux links read as before", () => {
  assert.equal(linkPath("/Users/me/repo"), "/Users/me/repo");
  assert.equal(linkPath("/Users/me/repo/"), "/Users/me/repo/");
  assert.equal(linkPath("/Users/me/My%20Docs/%D0%91%D1%8D%D0%BA%D0%BB%D0%BE%D0%B3"), "/Users/me/My Docs/Бэклог");
  assert.equal(linkPath("/Users/me/repo#section"), "/Users/me/repo");
  assert.equal(linkPath("file:///Users/me/My%20Docs"), "/Users/me/My Docs");
  assert.equal(linkPath("file:///home/me/repo"), "/home/me/repo");
});

test("a file:///C:/ link gives a Windows path: percent-encoding, Cyrillic, spaces, drive letter case", () => {
  // As BB 0.46 leaves it in the chat for a folder link written as file:///C:/…
  assert.equal(linkPath("file:///C:/Users/%D0%98%D0%BC%D1%8F/My%20Docs/repo"), "C:/Users/Имя/My Docs/repo");
  assert.equal(linkPath("file:///c:/Users/Ivan/repo"), "c:/Users/Ivan/repo");
  assert.equal(linkPath("file:///C:/Users/Ivan/repo%5Csrc"), "C:/Users/Ivan/repo\\src");
  // As BB rewrites C:\…\v1.2 (a dot in the last segment).
  assert.equal(linkPath("file:///C:/Users/%D0%98%D0%BC%D1%8F/v1.2"), "C:/Users/Имя/v1.2");
});

test("a bare Windows path reads as written, either separator", () => {
  assert.equal(linkPath("C:\\Users\\Имя\\repo"), "C:\\Users\\Имя\\repo");
  assert.equal(linkPath("C:/Users/Имя/repo"), "C:/Users/Имя/repo");
  assert.equal(linkPath("c:\\Users/Имя\\Documents/repo"), "c:\\Users/Имя\\Documents/repo");
  assert.equal(linkPath("C:%5CUsers%5C%D0%98%D0%BC%D1%8F%5Crepo"), "C:\\Users\\Имя\\repo");
  assert.equal(linkPath("C:/Users/%D0%98%D0%BC%D1%8F/My%20Docs"), "C:/Users/Имя/My Docs");
  assert.equal(linkPath("/C:/Users/Ivan/repo"), "C:/Users/Ivan/repo");
});

test("UNC paths and anything else are not ours", () => {
  for (const href of [
    "\\\\server\\share\\folder",
    "%5C%5Cserver%5Cshare%5Cfolder",
    "file://server/share/folder",
    "//cdn.example.com/folder",
    "https://example.com/C:/folder",
    "mailto:me@example.com",
    "C:folder",
    "repo/docs",
    "/Users/me/repo?x=1",
    "C:\\Users\\me?x=1",
    "file:///Users/me/repo?x=1",
    "/Users/me/%E0%A4%A",
  ]) {
    assert.equal(linkPath(href), null, href);
  }
});

test("absolute path in either spelling, for persisted tab params", () => {
  assert.equal(isAbsoluteLinkPath("/Users/me"), true);
  assert.equal(isAbsoluteLinkPath("C:\\Users\\Имя"), true);
  assert.equal(isAbsoluteLinkPath("c:/Users/Имя"), true);
  assert.equal(isAbsoluteLinkPath("\\\\server\\share"), false);
  // As before the change: file:////Users/me gives //Users/me, and its tab must open.
  assert.equal(linkPath("file:////Users/me"), "//Users/me");
  assert.equal(isAbsoluteLinkPath("//Users/me"), true);
  assert.equal(isAbsoluteLinkPath("Users/me"), false);
});

test("a tab is titled with the last segment; only a path with a drive letter splits on \\", () => {
  assert.equal(folderTitle("/Users/me/repo"), "repo");
  assert.equal(folderTitle("/Users/me/repo/"), "repo");
  assert.equal(folderTitle("/"), "/");
  assert.equal(folderTitle("/Users/me/a\\b"), "a\\b", "on a Mac a backslash is part of the name");
  assert.equal(folderTitle("C:\\Users\\Имя\\repo"), "repo");
  assert.equal(folderTitle("C:/Users/Имя\\My Docs\\"), "My Docs");
  assert.equal(folderTitle("C:\\"), "C:\\");
});

test("a file path goes to BB the way BB writes it: a Windows path with forward slashes, others untouched", () => {
  assert.equal(hostFilePath("C:\\Users\\Имя\\repo\\notes.md"), "C:/Users/Имя/repo/notes.md");
  assert.equal(hostFilePath("c:/Users/Имя\\repo\\notes.md"), "c:/Users/Имя/repo/notes.md");
  assert.equal(hostFilePath("/home/kate/repo/notes.md"), "/home/kate/repo/notes.md");
  assert.equal(hostFilePath("/home/kate/a\\b.md"), "/home/kate/a\\b.md", "on Linux a backslash is part of the name");
});
