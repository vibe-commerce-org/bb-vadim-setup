// HTML_vibecom takes .html and .htm on a client once, over nothing or BB's
// own preview, and never over a choice made since. Pure: `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT_IN_PREVIEW, HTML_OPENER, OPENER_PREFERENCE_KEY, PIN_DONE_KEY, pinHtmlOpener } from "../src/html-pin.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const preferences = (storage: ReturnType<typeof memoryStorage>) =>
  JSON.parse(storage.values.get(OPENER_PREFERENCE_KEY) ?? "null");

test("a client that chose nothing gets HTML_vibecom for .html and .htm", () => {
  const storage = memoryStorage();
  const written = pinHtmlOpener(storage);
  assert.deepEqual(preferences(storage), { html: HTML_OPENER, htm: HTML_OPENER });
  assert.equal(written, storage.values.get(OPENER_PREFERENCE_KEY));
  assert.ok(storage.values.has(PIN_DONE_KEY));
});

test("BB's preview pinned by Explorer on 14.10 is taken over, other extensions kept", () => {
  const storage = memoryStorage({
    [OPENER_PREFERENCE_KEY]: JSON.stringify({ html: BUILT_IN_PREVIEW, htm: BUILT_IN_PREVIEW, md: "markdown-view:markdown" }),
  });
  pinHtmlOpener(storage);
  assert.deepEqual(preferences(storage), { html: HTML_OPENER, htm: HTML_OPENER, md: "markdown-view:markdown" });
});

test("another opener chosen for .html stays; only the free .htm is taken", () => {
  const storage = memoryStorage({ [OPENER_PREFERENCE_KEY]: JSON.stringify({ html: "monaco-editor:code" }) });
  pinHtmlOpener(storage);
  assert.deepEqual(preferences(storage), { html: "monaco-editor:code", htm: HTML_OPENER });
});

test("nothing to take: nothing written, but the pass is done", () => {
  const value = JSON.stringify({ html: "monaco-editor:code", htm: "monaco-editor:code" });
  const storage = memoryStorage({ [OPENER_PREFERENCE_KEY]: value });
  assert.equal(pinHtmlOpener(storage), null);
  assert.equal(storage.values.get(OPENER_PREFERENCE_KEY), value);
  assert.ok(storage.values.has(PIN_DONE_KEY));
});

test("once only: BB's preview or Automatic picked afterwards is left alone", () => {
  const storage = memoryStorage();
  pinHtmlOpener(storage);
  storage.values.set(OPENER_PREFERENCE_KEY, JSON.stringify({ html: BUILT_IN_PREVIEW }));
  assert.equal(pinHtmlOpener(storage), null);
  assert.deepEqual(preferences(storage), { html: BUILT_IN_PREVIEW });
});

test("a value BB writes differently now is left alone and looked at again next time", () => {
  for (const raw of ["not json", "[]", "null", '"text"']) {
    const storage = memoryStorage({ [OPENER_PREFERENCE_KEY]: raw });
    assert.equal(pinHtmlOpener(storage), null, raw);
    assert.equal(storage.values.get(OPENER_PREFERENCE_KEY), raw);
    assert.equal(storage.values.has(PIN_DONE_KEY), false, raw);
  }
});
