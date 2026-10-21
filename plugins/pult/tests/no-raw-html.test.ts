// Text from threads (agent replies, titles, asks) must reach the page only as
// React text nodes. This guard fails the suite if any UI source starts writing
// raw HTML. The escaping itself is React's; see components/pult/bits.tsx.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const FORBIDDEN = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mjs|js)$/.test(name) ? [path] : [];
  });
}

test("UI sources never write raw HTML", () => {
  const files = ["app.tsx", ...sources(join(ROOT, "components/pult")), ...sources(join(ROOT, "hooks")), join(ROOT, "lib/format.ts")]
    .map((f) => (f.startsWith("/") ? f : join(ROOT, f)));
  assert.ok(files.length > 5);
  const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});
