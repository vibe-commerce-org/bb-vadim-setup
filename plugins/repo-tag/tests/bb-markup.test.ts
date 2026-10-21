// Canary for bb updates: the installed bb's Thread list still renders the
// markup lib/rows.ts relies on. Skipped where bb is not installed in the
// default macOS location.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const BUNDLE =
  "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/server/dist/builtin-plugins/thread-list/dist/app.js";

test("bb's thread row keeps the anchor, the title class and the folder marker", { skip: !existsSync(BUNDLE) }, () => {
  const source = readFileSync(BUNDLE, "utf8");
  for (const marker of [
    '"data-sidebar-thread-id"',
    '"data-sidebar-thread-provider"',
    '"bb-thread-title"',
    '"data-sidebar-thread-cross-project"',
  ]) {
    assert.ok(source.includes(marker), `${marker} is gone: check lib/rows.ts against the new markup`);
  }
});
