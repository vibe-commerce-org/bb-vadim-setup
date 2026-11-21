// The outline drawer's list of headings. Pure functions: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headingText, outlineDepths, outlineEntries } from "../src/outline.ts";

test("the # marks Vditor keeps in a heading's text are not shown", () => {
  assert.equal(headingText("# План: дерево"), "План: дерево");
  assert.equal(headingText("### Риски ###"), "Риски");
  assert.equal(headingText("  ## С пробелами  "), "С пробелами");
  assert.equal(headingText("Без меток"), "Без меток");
  assert.equal(headingText("C# и F#"), "C# и F#");
});

test("each heading keeps its level and its place among all the headings", () => {
  const entries = outlineEntries([
    { tag: "H1", text: "# Заголовок" },
    { tag: "H2", text: "## Первый" },
    { tag: "H3", text: "### Вложенный" },
    { tag: "H2", text: "## Второй" },
  ]);
  assert.deepEqual(entries, [
    { index: 0, level: 1, text: "Заголовок" },
    { index: 1, level: 2, text: "Первый" },
    { index: 2, level: 3, text: "Вложенный" },
    { index: 3, level: 2, text: "Второй" },
  ]);
});

test("a heading with no words is left out, but the ones after it keep their position", () => {
  const entries = outlineEntries([
    { tag: "H2", text: "## " },
    { tag: "H2", text: "## Есть" },
  ]);
  assert.deepEqual(entries, [{ index: 1, level: 2, text: "Есть" }]);
});

test("a document with no headings has an empty outline", () => {
  assert.deepEqual(outlineEntries([]), []);
});

test("the shallowest level sits at the edge, deeper ones are pushed in", () => {
  const entries = outlineEntries([
    { tag: "H2", text: "## А" },
    { tag: "H3", text: "### Б" },
    { tag: "H4", text: "#### В" },
    { tag: "H2", text: "## Г" },
  ]);
  assert.deepEqual(outlineDepths(entries), [0, 1, 2, 0]);
});
