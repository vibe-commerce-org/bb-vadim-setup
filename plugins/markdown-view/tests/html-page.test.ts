// Where the bridge goes into an HTML page, what base the page gets, where a
// link of the page leads, and which link messages the panel follows. Pure
// functions: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBridgeWatch,
  createLinkGate,
  hrefToOpen,
  isLinkMessage,
  isReadyMessage,
  LINK_MESSAGE,
  ownBaseHref,
  READY_MESSAGE,
  withBridge,
} from "../src/html-page.ts";

const FOLDER = "http://127.0.0.1:38886/api/v1/file-previews/p1/docs/";
const OPTIONS = { folderHref: FOLDER, parentOrigin: "http://127.0.0.1:38886" };
const inserted = (html: string) => withBridge(html, OPTIONS).srcdoc;
const baseOf = (html: string) => withBridge(html, OPTIONS).base;
const BASE = `<base href="${FOLDER}">`;

test("the base and the bridge go right after the doctype, the page follows untouched", () => {
  const html = '<!DOCTYPE html>\n<html lang="ru"><head><meta charset="utf-8"><title>План</title></head><body>Текст</body></html>';
  const page = inserted(html);
  assert.ok(page.startsWith(`<!DOCTYPE html>${BASE}<script>`), page.slice(0, 120));
  assert.ok(page.endsWith(`</script>${html.slice("<!DOCTYPE html>".length)}`));
});

test("a byte-order mark, blanks and comments ahead of the doctype stay ahead", () => {
  const page = inserted("\uFEFF  <!-- made by an agent --><!doctype html><p>Абзац</p>");
  assert.ok(page.startsWith(`\uFEFF  <!-- made by an agent --><!doctype html>${BASE}<script>`), page.slice(0, 120));
});

test("a page without a doctype gets them first; a page that is only text too", () => {
  assert.ok(inserted('<html lang="ru"><body>x</body></html>').startsWith(`${BASE}<script>`));
  assert.ok(inserted("Просто текст").startsWith(`${BASE}<script>`));
  assert.ok(inserted("Просто текст").endsWith("</script>Просто текст"));
});

test("tags inside attributes, comments, CDATA or a script do not move the insertion", () => {
  for (const html of [
    '<!doctype html><html><head data-x="a>b"><title>t</title></head></html>',
    '<!doctype html><title>t</title><p title="the <head> tag">x</p>',
    "<!doctype html><body><svg><![CDATA[ <head> ]]></svg></body>",
    "<!doctype html><body><script>var t = '<head>';</script></body>",
  ]) {
    const page = inserted(html);
    assert.ok(page.startsWith(`<!doctype html>${BASE}<script>`), page.slice(0, 120));
    assert.ok(page.endsWith(`</script>${html.slice("<!doctype html>".length)}`), html);
  }
});

test("the page's own <base>: ours goes first with its address made absolute", () => {
  assert.equal(baseOf('<html><head><base href="assets/"></head></html>'), `${FOLDER}assets/`);
  assert.equal(baseOf("<html><head><base target=_top href='./'></head></html>"), FOLDER);
  assert.equal(baseOf("<html><head><base href=../up/></head></html>"), "http://127.0.0.1:38886/api/v1/file-previews/p1/up/");
  assert.equal(baseOf('<html><head><base href=""></head></html>'), FOLDER);
  assert.equal(baseOf('<html><head><base href="https://example.com/"></head></html>'), "https://example.com/");
  assert.equal(baseOf('<html><head><base href="a&amp;b/"></head></html>'), `${FOLDER}a&b/`);
  assert.ok(inserted('<html><head><base href="assets/"></head></html>').startsWith(`<base href="${FOLDER}assets/"><script>`));
  // A <base> with a target only is no base address.
  assert.equal(baseOf('<html><head><base target="_top"></head></html>'), FOLDER);
});

test("text that only looks like a <base> is not one", () => {
  assert.equal(ownBaseHref('<head><!-- <base href="/x/"> --></head>'), null);
  assert.equal(ownBaseHref('<head><meta name="d" content="Use <base href=x> carefully"></head>'), null);
  assert.equal(ownBaseHref("<head><noscript><base href=x></noscript></head>"), null);
  assert.equal(ownBaseHref("<body><script>document.write('<base href=x>')</script></body>"), null);
  assert.equal(ownBaseHref('<head><base data-x="href=evil" href="a/"></head>'), "a/");
  assert.equal(ownBaseHref('<head><BASE HREF="Up/"></head>'), "Up/");
});

test("the base address is escaped as an attribute", () => {
  const page = withBridge("<p>x</p>", { ...OPTIONS, folderHref: 'http://h/a"b&c/' }).srcdoc;
  assert.ok(page.startsWith('<base href="http://h/a&quot;b&amp;c/">'));
});

test("the bridge posts to the panel's origin only and leaves handled links alone", () => {
  const page = inserted("<p>x</p>");
  assert.ok(page.includes(`var ORIGIN = ${JSON.stringify(OPTIONS.parentOrigin)};`));
  assert.ok(page.includes("event.defaultPrevented"));
  assert.ok(page.includes("composedPath"));
  assert.ok(page.includes('"a[href], area[href], a[*|href]"'));
  assert.ok(page.includes("http://www.w3.org/1999/xlink"));
  assert.ok(page.includes("javascript:"));
  assert.ok(page.includes("location.hash"));
});

test("a link of the page leads where the page means it", () => {
  const where = { base: FOLDER, servedAt: "http://127.0.0.1:38886/api/v1/file-previews/p1/", root: "/work/repo" };
  assert.equal(hrefToOpen("../plans/план.md#top", where), "/work/repo/plans/план.md");
  assert.equal(hrefToOpen("img/a%20b.png?x=1", where), "/work/repo/docs/img/a b.png");
  assert.equal(hrefToOpen("https://example.com/a", where), "https://example.com/a");
  assert.equal(hrefToOpen("file:///Users/me/a.md", where), "file:///Users/me/a.md");
  assert.equal(hrefToOpen("mailto:a@b.ru", where), "mailto:a@b.ru");
  // Above the served folder: as written, resolved later from the file's folder.
  assert.equal(hrefToOpen("../../../../other/a.md", where), "../../../../other/a.md");
  // The page's own base decides.
  assert.equal(hrefToOpen("x.md", { ...where, base: `${FOLDER}a/` }), "/work/repo/docs/a/x.md");
  assert.equal(hrefToOpen("page.html", { ...where, base: "https://example.com/" }), "https://example.com/page.html");
});

test("messages are told apart", () => {
  assert.equal(isReadyMessage({ type: READY_MESSAGE }), true);
  assert.equal(isReadyMessage({ type: LINK_MESSAGE, href: "a.md" }), false);
  assert.equal(isLinkMessage({ type: LINK_MESSAGE, href: "a.md" }), true);
  assert.equal(isLinkMessage({ type: LINK_MESSAGE, href: 1 }), false);
  assert.equal(isLinkMessage("html-view:link"), false);
  assert.equal(isLinkMessage(null), false);
});

test("only links the file has, at most one a second, the same one at most once in two", () => {
  const gate = createLinkGate(new Set(["../plans/plan.md", "https://example.com/"]));
  const link = (href: string) => ({ type: LINK_MESSAGE, href });
  const soon = { refused: "too-soon" };

  assert.deepEqual(gate(link("../plans/plan.md"), 10_000), { href: "../plans/plan.md" });
  assert.deepEqual(gate(link("https://example.com/"), 10_500), soon, "another link within a second");
  assert.deepEqual(gate(link("https://example.com/"), 11_000), { href: "https://example.com/" });
  assert.deepEqual(gate(link("https://example.com/"), 12_500), soon, "the same link within two seconds, a second after any");
  assert.deepEqual(gate(link("../plans/plan.md"), 12_600), { href: "../plans/plan.md" });
  assert.deepEqual(gate(link("https://example.com/"), 13_100), soon, "within a second of the last one");
  assert.deepEqual(gate(link("https://example.com/"), 13_700), { href: "https://example.com/" });

  assert.deepEqual(gate(link("/Users/me/.ssh/id_rsa"), 60_000), { refused: "not-in-file" });
  assert.deepEqual(gate(link("file:///Users/me/.ssh/id_rsa"), 70_000), { refused: "not-in-file" });
  assert.deepEqual(gate({ type: READY_MESSAGE }, 80_000), { refused: "not-a-link" });
});

test("a refused message does not use up the second", () => {
  const gate = createLinkGate(new Set(["a.md", "b.md"]));
  assert.deepEqual(gate({ type: LINK_MESSAGE, href: "secret.md" }, 1_000), { refused: "not-in-file" });
  assert.deepEqual(gate({ type: LINK_MESSAGE, href: "a.md" }, 1_100), { href: "a.md" });
});


test("a document that left past the bridge is noticed, whatever comes first, load or READY", () => {
  const watch = createBridgeWatch();
  const first = watch.loaded(); // the page loads, its READY is delivered after the load
  watch.ready();
  assert.equal(watch.missing(first), false);
  const second = watch.loaded(); // the page's script took the frame to note.md: no bridge there
  assert.equal(watch.missing(second), true);

  watch.reset();
  watch.ready(); // READY delivered before the load this time
  assert.equal(watch.missing(watch.loaded()), false);
});
