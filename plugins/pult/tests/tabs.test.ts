// The Pult page's tabs: «Приоритеты» first and by default. Runs under `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_ORDER, TAB_SUB_PATH, tabOf } from "../lib/tabs.ts";

test("«Приоритеты» is the first tab and the bare page opens it", () => {
  assert.equal(TAB_ORDER[0], "priorities");
  assert.equal(TAB_SUB_PATH.priorities, "");
  assert.equal(tabOf(""), "priorities");
  assert.equal(tabOf("/"), "priorities");
});

test("every tab's subPath leads back to it; the old «priorities» link still works", () => {
  for (const tab of TAB_ORDER) assert.equal(tabOf(TAB_SUB_PATH[tab]), tab);
  assert.equal(tabOf("priorities"), "priorities");
  assert.equal(tabOf("/queue/extra"), "queue");
  assert.equal(tabOf("nonsense"), "priorities");
});
