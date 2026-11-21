// Where a click on a link in the document leads, and where relative images
// load from. Pure functions: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileLocation } from "../src/file-access.ts";
import { linkBase, pageRoot, previewRoot, resolveLink } from "../src/links.ts";

const inCheckout: FileLocation = {
  hostId: "host_a",
  path: "/work/repo/docs/plans/plan.md",
  checkout: { environmentId: "env_1", rootPath: "/work/repo/" },
  root: "/work/repo/",
};
const loose: FileLocation = { hostId: "host_a", path: "/data/storage/thr_1/notes/report.md", checkout: null, root: null };

test("web, mail and phone links keep their address", () => {
  assert.deepEqual(resolveLink("https://example.com/a?b=1", inCheckout), { kind: "web", url: "https://example.com/a?b=1" });
  assert.deepEqual(resolveLink(" mailto:a@b.ru ", inCheckout), { kind: "system", url: "mailto:a@b.ru" });
  assert.deepEqual(resolveLink("tel:+7900", inCheckout), { kind: "system", url: "tel:+7900" });
});

test("a heading anchor stays in the document", () => {
  assert.deepEqual(resolveLink("#риски", inCheckout), { kind: "anchor", id: "риски" });
  assert.deepEqual(resolveLink("#%D1%80%D0%B8%D1%81%D0%BA%D0%B8", inCheckout), { kind: "anchor", id: "риски" });
});

test("a relative path resolves from the file's folder, inside the checkout as a workspace file", () => {
  assert.deepEqual(resolveLink("../README.md#top", inCheckout), {
    kind: "file",
    target: { kind: "workspace", environmentId: "env_1", path: "docs/README.md" },
  });
  assert.deepEqual(resolveLink("./sub/%D0%BF%D0%BB%D0%B0%D0%BD.md", inCheckout), {
    kind: "file",
    target: { kind: "workspace", environmentId: "env_1", path: "docs/plans/sub/план.md" },
  });
});

test("an absolute path or file:// outside the checkout opens as a host file", () => {
  const target = { kind: "host", hostId: "host_a", path: "/Users/me/other/a.md" };
  assert.deepEqual(resolveLink("/Users/me/other/a.md", inCheckout), { kind: "file", target });
  assert.deepEqual(resolveLink("file:///Users/me/other/a.md", inCheckout), { kind: "file", target });
  assert.deepEqual(resolveLink("/work/repo/x.md", inCheckout), {
    kind: "file",
    target: { kind: "workspace", environmentId: "env_1", path: "x.md" },
  });
  assert.deepEqual(resolveLink("chart.png", loose), {
    kind: "file",
    target: { kind: "host", hostId: "host_a", path: "/data/storage/thr_1/notes/chart.png" },
  });
});

test("app schemes, javascript: and paths above the root are ignored", () => {
  assert.equal(resolveLink("javascript:alert(1)", inCheckout), null);
  assert.equal(resolveLink("vscode://file/x", inCheckout), null);
  assert.equal(resolveLink("../../../../../../x.md", inCheckout), null);
  assert.equal(resolveLink("", inCheckout), null);
  assert.equal(resolveLink("#", inCheckout), null);
});

test("images load from a preview of the checkout, at the file's folder", () => {
  assert.equal(previewRoot(inCheckout), "/work/repo");
  assert.equal(linkBase(inCheckout, "/api/v1/file-previews/abc"), "/api/v1/file-previews/abc/docs/plans/");
  assert.equal(previewRoot(loose), "/data/storage/thr_1/notes");
  assert.equal(linkBase(loose, "/api/v1/file-previews/abc/"), "/api/v1/file-previews/abc/");
  const spaced: FileLocation = { ...inCheckout, path: "/work/repo/мои отчёты/a.md" };
  assert.equal(linkBase(spaced, "/p"), "/p/%D0%BC%D0%BE%D0%B8%20%D0%BE%D1%82%D1%87%D1%91%D1%82%D1%8B/");
});

test("an HTML page is served from the checkout, else the thread's storage, else its own folder", () => {
  assert.equal(pageRoot(inCheckout), "/work/repo");
  const stored: FileLocation = { ...loose, root: "/data/storage/thr_1/" };
  assert.equal(pageRoot(stored), "/data/storage/thr_1");
  assert.equal(linkBase(stored, "/api/v1/file-previews/abc", pageRoot(stored)), "/api/v1/file-previews/abc/notes/");
  assert.equal(pageRoot(loose), "/data/storage/thr_1/notes");
  assert.equal(linkBase(loose, "/p", pageRoot(loose)), "/p/");
});
