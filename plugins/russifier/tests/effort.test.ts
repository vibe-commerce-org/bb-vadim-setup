import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { DomTranslator } from "../lib/dom.ts";
import { Engine } from "../lib/engine.ts";

// Effort and its levels stay in English (GLOSSARY.md «Не переводим»), task
// priorities with the same words stay Russian. Uses the real dictionaries.
const load = (f: string) => JSON.parse(fs.readFileSync(new URL(`../dict/${f}`, import.meta.url), "utf8"));
const engine = new Engine(load("core.json"), load("builtin.json"), load("vibecom.json"), load("extra.json"));

test("effort words have no translation in the dictionaries", () => {
  for (const s of ["Reasoning", "Extra High", "Max", "Ultracode", "Low reasoning effort", "Maximum reasoning effort",
    "Full Access", "Accept Edits", "Approve for me", "Plan Mode", "Fast"]) {
    assert.equal(engine.translate(s), null, s);
  }
  assert.equal(engine.translate("Cycle reasoning effort forward"), "Следующий уровень effort");
});

// Shaped like bb 0.46.1: the model menu and the composer button.
const PAGE = `<!doctype html><html><body>
<button aria-label="Provider, model and reasoning (⇧ ⌘ M)"><span title="Claude Code: Opus 5.5 · High reasoning" class="contents">
  <span class="min-w-0 truncate">Opus 5.5</span><span data-promptbox-hide-compact="">High</span></span></button>
<div role="radiogroup" aria-label="Reasoning">
  <button role="radio" aria-label="Low"><span title="Low">Low</span></button>
  <button role="radio" aria-label="Extra High"><span title="Extra High">Extra High</span></button>
</div>
<div data-bb-plugin="tasks"><span data-promptbox-hide-compact="">High</span><span>Medium</span></div>
</body></html>`;

test("the effort menu and the composer level stay English, task priorities do not", () => {
  const doc = new JSDOM(PAGE).window.document;
  new DomTranslator(doc, engine).start();
  assert.equal(doc.querySelector("[title*=reasoning] > [data-promptbox-hide-compact]")!.textContent, "High");
  assert.equal(doc.querySelector("button")!.getAttribute("aria-label"), "Провайдер, модель и effort (⇧ ⌘ M)");
  assert.equal(doc.querySelector("[role=radiogroup]")!.getAttribute("aria-label"), "Reasoning");
  assert.deepEqual([...doc.querySelectorAll("[role=radio] span")].map((s) => s.textContent), ["Low", "Extra High"]);
  assert.equal(doc.querySelector("[role=radio]")!.getAttribute("aria-label"), "Low");
  assert.deepEqual([...doc.querySelectorAll("[data-bb-plugin=tasks] span")].map((s) => s.textContent), ["Высокий", "Средний"]);
});
