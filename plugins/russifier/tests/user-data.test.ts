import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { DomTranslator } from "../lib/dom.ts";
import { Engine, formatTokenAmount } from "../lib/engine.ts";

// What looks like a word but is data: git branch names stay as they are,
// token amounts are not minutes (author, 2026-11-22). Uses the real dictionaries.
const load = (f: string) => JSON.parse(fs.readFileSync(new URL(`../dict/${f}`, import.meta.url), "utf8"));
const engine = new Engine(load("core.json"), load("builtin.json"), load("vibecom.json"), load("extra.json"));

test("token amounts read as thousands and millions, bare durations as minutes", () => {
  assert.equal(formatTokenAmount("1m"), "1 млн");
  assert.equal(formatTokenAmount("350k"), "350 тыс.");
  assert.equal(formatTokenAmount("1.2M"), "1,2 млн");
  assert.equal(formatTokenAmount("5 min"), null);
  assert.equal(engine.translate("1M tokens"), "1 млн токенов");
  assert.equal(engine.translate("200k tokens"), "200 тыс. токенов");
  assert.equal(engine.translate("5m"), "5 мин");
});

// Shaped like bb 0.50.1 (checked on the live app 2026-11-22).
const PAGE = `<!doctype html><html><body>
<div data-follow-up-composer-footer>
  <button data-promptbox-hide-branch-compact=""><svg></svg><span class="truncate">local</span></button>
  <span data-promptbox-hide-branch-compact="" title="Empty branch: main"><svg></svg><span class="truncate">main</span></span>
</div>
<div data-bb-plugin="environment-project-checkout">
  <button aria-label="Branch" role="combobox"><span class="contents" title="Checkout branch: main"><svg></svg>
    <span class="flex min-w-0 items-baseline truncate"><span data-promptbox-hide-compact="" class="shrink-0 text-muted-foreground">Current:</span><span class="min-w-0 truncate font-medium text-foreground">local</span></span>
  </span></button>
  <button data-branch-picker-row="" data-value="intent:new" title="Default branch"><svg></svg><span>Default branch</span></button>
  <button data-branch-picker-row="" data-value="branch:main" title="main"><svg></svg><span>main</span></button>
  <button data-branch-picker-row="" data-value="test" title="test"><svg></svg><span>test</span></button>
</div>
<div class="tabular-nums"><span id="context"><span class="font-medium">350k</span></span><span>25% left</span></div>
<a data-sidebar-thread-id="thr_1"><span class="bb-thread-title">1m tokens</span><span>5m</span></a>
</body></html>`;

test("branch names stay as they are, the words around them are translated", () => {
  const doc = new JSDOM(PAGE).window.document;
  new DomTranslator(doc, engine).start();
  const texts = (selector: string) => [...doc.querySelectorAll(selector)].map((el) => el.textContent);
  assert.deepEqual(texts("[data-promptbox-hide-branch-compact] > span"), ["local", "main"]);
  assert.equal(doc.querySelector("span[data-promptbox-hide-branch-compact]")!.getAttribute("title"), "Пустая ветка: main");
  assert.equal(doc.querySelector("[role=combobox] [data-promptbox-hide-compact]")!.textContent, "Текущая:");
  assert.equal(doc.querySelector("[role=combobox] .font-medium")!.textContent, "local");
  assert.equal(doc.querySelector("[role=combobox]")!.getAttribute("aria-label"), "Ветка");
  assert.deepEqual(texts("[data-branch-picker-row] span"), ["Основная ветка", "main", "test"]);
  assert.deepEqual([...doc.querySelectorAll("[data-branch-picker-row]")].map((el) => el.getAttribute("title")), ["Основная ветка", "main", "test"]);
});

test("the context window counts tokens in thousands and millions", () => {
  const doc = new JSDOM(PAGE).window.document;
  // React renders [used, " ", "/ ", total, " tokens"] as separate text nodes.
  for (const piece of [" ", "/ ", "1m", " tokens"]) doc.getElementById("context")!.append(doc.createTextNode(piece));
  new DomTranslator(doc, engine).start();
  assert.equal(doc.querySelector(".tabular-nums > span")!.textContent, "350 тыс. / 1 млн токенов");
  assert.equal(doc.querySelector("[data-sidebar-thread-id] > span:last-child")!.textContent, "5 мин");
});

// More of bb 0.50.1: the branch picker's «Current: local» action, the sidebar
// grouped by environment, the git plugin's info rows, the composer's «/» menu,
// a queued message, and the plugins bb moved out of its core.
const MORE = `<!doctype html><html><body>
<div data-bb-plugin="environment-project-checkout">
  <button data-branch-picker-row="" data-value="intent:current" title="Current: local"><svg class="text-muted-foreground shrink-0"></svg>
    <span class="flex min-w-0 items-baseline gap-1"><span class="shrink-0 text-muted-foreground">Current:</span><span class="min-w-0 font-medium text-foreground">local</span></span></button>
  <button data-branch-picker-row="" data-value="intent:checkout"><svg class="text-muted-foreground shrink-0"></svg><span class="min-w-0 truncate">Checkout</span></button>
</div>
<div data-bb-plugin="thread-list">
  <span class="relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left"><span class="min-w-0 truncate">Pinned</span><button data-sidebar-rename-anchor aria-expanded="true"></button></span>
  <span class="relative z-10 flex min-w-0 flex-1 items-center gap-1.5 text-left"><span class="min-w-0 truncate">main</span><button data-sidebar-rename-anchor aria-expanded="true"></button></span>
</div>
<div data-bb-plugin="bb--git">
  <span class="flex items-baseline gap-x-3"><span class="truncate">Branch</span><span class="truncate text-muted-foreground"><span class="block truncate" title="test">test</span></span></span>
  <span class="flex items-baseline gap-x-3"><span class="truncate">Git status</span><span class="truncate text-muted-foreground"><span class="block min-w-0 truncate text-foreground">Even with main</span></span></span>
  <button role="combobox"><span class="flex min-w-0 items-center overflow-hidden" title="main"><span class="min-w-0 truncate text-left">main</span></span></button>
</div>
<div data-bb-plugin="bb--composer">
  <button aria-label="Collapse prompt box"></button>
  <div data-promptbox-typeahead-menu><div class="sticky top-0"><span><span>Skills</span></span></div>
    <button class="w-full scroll-mt-7 rounded" title="docs"><div><span class="truncate text-foreground">docs</span><span class="truncate text-subtle-foreground">Continue</span></div></button></div>
</div>
<div data-queued-message-row><div class="min-w-0 flex-1 overflow-hidden text-foreground" title="Continue"><span>Continue</span></div><span>Retry</span></div>
<div data-bb-plugin="navigation"><a aria-label="Home"></a><span>New thread</span></div>
<div class="tabular-nums"><span><span>21</span><span>% used</span></span><span><span>79</span><span>% left</span></span></div>
</body></html>`;

test("names in pickers, the sidebar, git rows, the «/» menu and queued messages stay as they are", () => {
  const doc = new JSDOM(MORE).window.document;
  new DomTranslator(doc, engine).start();
  const text = (selector: string) => doc.querySelector(selector)!.textContent;
  assert.equal(text("[data-value='intent:current'] span.shrink-0.text-muted-foreground"), "Текущая:");
  assert.equal(text("[data-value='intent:current'] .font-medium"), "local");
  assert.equal(text("[data-value='intent:checkout'] span"), "Другая ветка");
  assert.equal(text(".gap-1 > .truncate"), "Закреплённые");
  assert.equal(text(".gap-1\\.5 > .truncate"), "main");
  assert.deepEqual([...doc.querySelectorAll("[data-bb-plugin='bb--git'] .gap-x-3 > .truncate:first-child")].map((el) => el.textContent), ["Ветка", "Статус Git"]);
  assert.equal(text("[data-bb-plugin='bb--git'] .block.truncate[title]"), "test");
  assert.equal(text("[data-bb-plugin='bb--git'] .text-foreground"), "Совпадает с main");
  assert.equal(text("[data-bb-plugin='bb--git'] [role=combobox]"), "main");
  assert.equal(doc.querySelector("[aria-label]")!.getAttribute("aria-label"), "Свернуть поле ввода");
  assert.equal(text(".sticky"), "Скиллы");
  assert.equal(text("button.scroll-mt-7"), "docsContinue");
  assert.equal(text("[data-queued-message-row] [title]"), "Continue");
  assert.equal(text("[data-queued-message-row] > span"), "Повторить");
  assert.equal(doc.querySelector("[data-bb-plugin=navigation] a")!.getAttribute("aria-label"), "Главная");
  assert.equal(text("[data-bb-plugin=navigation] span"), "Новый чат");
  assert.equal(text(".tabular-nums"), "21% занято79% осталось");
});

test("token amounts inside templates and child-thread toggles", () => {
  assert.equal(engine.translate("Compact 210k tokens before sending"), "Сжать историю (210 тыс. токенов) перед отправкой");
  assert.equal(engine.translate("Keep all 1.2m tokens of history"), "Оставить всю историю (1,2 млн токенов)");
  assert.equal(engine.translate("Collapse 3 child threads"), "Свернуть дочерние чаты: 3");
});
