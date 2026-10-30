// The Pult page's tabs: «Лента» first and by default. Runs under `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TAB_ORDER, TAB_SUB_PATH, tabOf } from "../lib/tabs.ts";

test("«Лента» is the first tab and the bare page opens it", () => {
  assert.equal(TAB_ORDER[0], "feed");
  assert.equal(TAB_SUB_PATH.feed, "");
  assert.equal(tabOf(""), "feed");
  assert.equal(tabOf("/"), "feed");
});

test("the tabs go «Лента», «Приоритеты», «Ход за тобой», «Карта»", () => {
  assert.deepEqual([...TAB_ORDER], ["feed", "priorities", "queue", "map"]);
});

test("every tab's subPath leads back to it; old links still land somewhere sensible", () => {
  for (const tab of TAB_ORDER) assert.equal(tabOf(TAB_SUB_PATH[tab]), tab);
  assert.equal(tabOf("priorities"), "priorities");
  assert.equal(tabOf("/queue/extra"), "queue");
  assert.equal(tabOf("/feed"), "feed");
  assert.equal(tabOf("nonsense"), "feed");
});
