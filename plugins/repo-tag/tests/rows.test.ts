// Row decoration on a copy of bb's Thread list row markup (bb 0.46): the tag
// lands between the model icon and the title, is updated in place, survives
// re-renders, and leaves nothing behind on stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { RepoTag } from "../lib/labels.ts";
import { TAG_CLASS, decorateRows, removeTags, watchRows } from "../lib/rows.ts";

// One row as bb's Thread list renders it: the anchor, the wrapper with the
// model icon and the title, then the "in another project" folder.
function rowHtml(threadId: string, { provider = true, folder = false } = {}): string {
  return `
    <div class="row-host">
      <span class="relative flex min-w-0 flex-1 items-center gap-1.5 self-stretch">
        <a href="/threads/${threadId}" data-sidebar-thread-shortcut-target="" data-sidebar-thread-id="${threadId}"></a>
        <span class="pointer-events-none relative flex min-w-0 items-center self-stretch">
          ${provider ? `<span data-sidebar-thread-provider="claude-code" role="img"></span>` : ""}
          <span class="bb-thread-title" title="Title ${threadId}">Title ${threadId}</span>
        </span>
        ${folder ? `<span data-sidebar-thread-cross-project="" role="img"></span>` : ""}
      </span>
    </div>`;
}

const SHOP: RepoTag = { text: "onlinestor", compactText: "onl", hueIndex: 3, name: "onlinestore_code" };
const CRM: RepoTag = { text: "crm", compactText: "crm", hueIndex: 7, name: "crm-demo_code" };
const LENGTHS = { length: 10, compactLength: 3 };

function dom(html: string): JSDOM {
  return new JSDOM(`<!doctype html><html><body><nav>${html}</nav></body></html>`);
}

test("the tag goes after the model icon, before the title", () => {
  const { window } = dom(rowHtml("t1") + rowHtml("t2", { provider: false }));
  const doc = window.document;
  decorateRows(doc, (id) => (id === "t1" ? SHOP : CRM), LENGTHS);

  const tag1 = doc.querySelector(`[data-sidebar-thread-id="t1"]`)?.parentElement?.querySelector(`.${TAG_CLASS}`);
  assert.ok(tag1);
  assert.equal(tag1.previousElementSibling?.getAttribute("data-sidebar-thread-provider"), "claude-code");
  assert.ok(tag1.nextElementSibling?.classList.contains("bb-thread-title"));
  assert.equal(tag1.children[0]?.textContent, "onlinestor");
  assert.equal(tag1.children[1]?.textContent, "onl");
  assert.equal(tag1.getAttribute("aria-hidden"), "true");
  assert.match(tag1.getAttribute("style") ?? "", /--vbrt-h:130;--vbrt-len:10;--vbrt-len-compact:3/);

  // Without a model icon the tag is the first thing in the wrapper.
  const tag2 = doc.querySelector(`[data-sidebar-thread-id="t2"]`)?.parentElement?.querySelector(`.${TAG_CLASS}`);
  assert.ok(tag2);
  assert.equal(tag2.previousElementSibling, null);
  assert.equal(tag2.children[0]?.textContent, "crm");
});

test("decorating twice changes nothing; a new project updates in place", () => {
  const { window } = dom(rowHtml("t1"));
  const doc = window.document;
  decorateRows(doc, () => SHOP, LENGTHS);
  const first = doc.querySelector(`.${TAG_CLASS}`);
  const before = doc.body.innerHTML;
  decorateRows(doc, () => SHOP, LENGTHS);
  assert.equal(doc.body.innerHTML, before);

  decorateRows(doc, () => CRM, LENGTHS);
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 1);
  assert.equal(doc.querySelector(`.${TAG_CLASS}`), first);
  assert.equal(first?.children[0]?.textContent, "crm");
});

test("no tag for unknown threads and rows without a title (rename mode)", () => {
  const { window } = dom(rowHtml("t1") + rowHtml("t2"));
  const doc = window.document;
  decorateRows(doc, () => SHOP, LENGTHS);
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 2);

  // t2 enters rename mode: bb replaces the title with an input.
  const title = doc.querySelector(`[data-sidebar-thread-id="t2"]`)?.parentElement?.querySelector(".bb-thread-title");
  title?.replaceWith(doc.createElement("input"));
  decorateRows(doc, (id) => (id === "t1" ? null : SHOP), LENGTHS);
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 0);
});

test("watchRows decorates rows bb mounts later and cleans up on stop", async () => {
  const { window } = dom(rowHtml("t1", { folder: true }));
  const doc = window.document;
  const watcher = watchRows(doc, () => SHOP, () => LENGTHS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 1);

  // The virtualized list mounts another row.
  doc.querySelector("nav")?.insertAdjacentHTML("beforeend", rowHtml("t2"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 2);

  watcher.stop();
  assert.equal(doc.querySelectorAll(`.${TAG_CLASS}`).length, 0);
  // bb's own nodes are untouched.
  assert.equal(doc.querySelectorAll("[data-sidebar-thread-cross-project]").length, 1);
  assert.equal(doc.querySelectorAll(".bb-thread-title").length, 2);
  window.close();
});

test("removeTags removes only the plugin's nodes", () => {
  const { window } = dom(rowHtml("t1"));
  const doc = window.document;
  const before = doc.body.innerHTML;
  decorateRows(doc, () => SHOP, LENGTHS);
  removeTags(doc);
  assert.equal(doc.body.innerHTML, before);
});
