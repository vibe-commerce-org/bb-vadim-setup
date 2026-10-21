import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { DomTranslator } from "../lib/dom.ts";
import { Engine } from "../lib/engine.ts";

const engine = new Engine({
  "New thread": "Новый чат",
  "Ask a follow-up": "Напишите следующее сообщение",
  Archive: "В архив",
  "Toggle sidebar": "Показать или скрыть боковую панель",
  "Search threads": "Поиск чатов",
  Settings: "Настройки",
  "Explored {0}": "Изучено: {0}",
  "Open {0}": "Открыть {0}",
});

// A page shaped like bb 0.46 (selectors checked on the live app 2026-10-14).
const PAGE = `<!doctype html><html><head></head><body>
<nav>
  <button aria-label="Toggle sidebar">≡</button><span>Settings</span>
  <div data-sidebar-rename-row><span class="bb-thread-title" title="Settings"><span class="truncate whitespace-pre">Settings</span></span>
    <a data-sidebar-thread-id="thr_1" aria-label="Open Settings"></a></div>
  <div data-bb-plugin="thread-list"><span>Archive</span></div>
  <div data-bb-plugin="simple-notes"><span>Archive</span></div>
</nav>
<main>
  <div data-timeline-row-id="r1"><span>Explored 4 lists, 1 file</span></div>
  <div data-message-column><div data-markdown-preview><p>Archive</p><p>New thread</p><pre><code>Settings</code></pre><a title="Archive">x</a></div></div>
  <div data-plan-step-status="done"><span>Archive</span></div>
  <form data-promptbox>
    <div data-promptbox-editor-content><div class="tiptap ProseMirror" contenteditable="true"><p class="is-editor-empty" data-placeholder="New thread"><br></p></div></div>
  </form>
  <ul role="tree"><li role="treeitem"><span>Archive</span></li></ul>
  <input value="Archive" placeholder="Search threads"><textarea placeholder="Search threads">Archive</textarea>
</main></body></html>`;

function setup() {
  const dom = new JSDOM(PAGE);
  const doc = dom.window.document;
  // The form's variable as bb sets it (style.setProperty with a JSON string).
  (doc.querySelector("form[data-promptbox]") as HTMLElement).style.setProperty(
    "--promptbox-container-compact-placeholder",
    JSON.stringify("Ask a follow-up"),
  );
  const missing: string[] = [];
  const translator = new DomTranslator(doc, engine, { onMissing: (t) => missing.push(t) });
  return { dom, doc, translator, missing };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("translates the interface and leaves the user's data byte for byte", () => {
  const { doc, translator } = setup();
  const protectedBefore = [...doc.querySelectorAll("[data-message-column], [data-plan-step-status], [role=tree], .ProseMirror, .bb-thread-title, [data-bb-plugin=simple-notes]")].map((el) => el.outerHTML);
  translator.start();

  assert.equal(doc.querySelector("nav > span")!.textContent, "Настройки");
  assert.equal(doc.querySelector("nav > button")!.getAttribute("aria-label"), "Показать или скрыть боковую панель");
  assert.equal(doc.querySelector("a[data-sidebar-thread-id]")!.getAttribute("aria-label"), "Открыть Settings");
  assert.equal(doc.querySelector("[data-bb-plugin=thread-list] span")!.textContent, "В архив");
  assert.equal(doc.querySelector("[data-timeline-row-id] span")!.textContent, "Изучено: 4 списка, 1 файл");
  assert.equal(doc.querySelector("input")!.getAttribute("placeholder"), "Поиск чатов");
  assert.equal((doc.querySelector("input") as HTMLInputElement).value, "Archive");
  assert.equal(doc.querySelector("textarea")!.getAttribute("placeholder"), "Поиск чатов");
  assert.equal(doc.querySelector("textarea")!.textContent, "Archive");

  const protectedAfter = [...doc.querySelectorAll("[data-message-column], [data-plan-step-status], [role=tree], .ProseMirror, .bb-thread-title, [data-bb-plugin=simple-notes]")].map((el) => el.outerHTML);
  assert.deepEqual(protectedAfter, protectedBefore);
});

test("the prompt editor is translated by CSS, not by touching it", () => {
  const { doc, translator } = setup();
  translator.start();
  const style = doc.querySelector("style[data-russifier]")!;
  assert.match(style.textContent ?? "", /\[data-placeholder="New thread"\]::before\{content:"Новый чат"\}/);
  assert.equal(doc.querySelector("p.is-editor-empty")!.getAttribute("data-placeholder"), "New thread");
  const form = doc.querySelector("form[data-promptbox]") as HTMLElement;
  assert.equal(form.style.getPropertyValue("--promptbox-container-compact-placeholder"), JSON.stringify("Напишите следующее сообщение"));
});

test("stop() brings back the exact English page without a reload", () => {
  const { doc, translator } = setup();
  const before = doc.body.innerHTML;
  translator.start();
  assert.notEqual(doc.body.innerHTML, before);
  translator.stop();
  assert.equal(doc.body.innerHTML, before);
  assert.equal(doc.querySelector("style[data-russifier]"), null);
});

test("what React renders later is translated; its own updates too", async () => {
  const { doc, translator } = setup();
  translator.start();
  const added = doc.createElement("button");
  added.textContent = "New thread";
  doc.querySelector("nav")!.appendChild(added);
  await tick();
  assert.equal(added.textContent, "Новый чат");

  const label = doc.querySelector("nav > span")!.firstChild as Text;
  label.data = "Archive"; // React sets nodeValue on its next render
  await tick();
  assert.equal(label.data, "В архив");
});

test("an agent streaming into a message costs nothing and changes nothing", async () => {
  const { doc, translator } = setup();
  translator.start();
  const md = doc.querySelector("[data-markdown-preview]")!;
  const before = translator.stats.translated;
  for (let i = 0; i < 1000; i++) {
    const p = doc.createElement("p");
    p.textContent = i % 2 ? "Archive" : "New thread";
    md.appendChild(p);
  }
  await tick();
  assert.equal(translator.stats.translated, before);
  const texts = [...md.querySelectorAll("p")].map((p) => p.textContent);
  assert.ok(texts.every((t) => t === "Archive" || t === "New thread"), "messages stay in English");
});

test("a node that keeps fighting back is left alone after a few rounds", async () => {
  const { dom, doc, translator } = setup();
  translator.start();
  const el = doc.createElement("span");
  el.setAttribute("title", "Archive");
  doc.querySelector("main")!.appendChild(el);
  // An app that puts its English back every time (like ProseMirror would).
  const app = new dom.window.MutationObserver(() => {
    if (el.getAttribute("title") !== "Archive") el.setAttribute("title", "Archive");
  });
  app.observe(el, { attributes: true });
  for (let i = 0; i < 60; i++) await tick();
  app.disconnect();
  assert.ok(translator.stats.blocked >= 1, "the loop guard stepped in");
});

test("strings without a translation are reported once seen", () => {
  const { doc, translator, missing } = setup();
  const b = doc.createElement("button");
  b.textContent = "Brand new label";
  doc.body.appendChild(b);
  translator.start();
  assert.ok(missing.includes("Brand new label"));
});
