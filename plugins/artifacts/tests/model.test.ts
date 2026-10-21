import test from "node:test";
import assert from "node:assert/strict";
import { validateTarget, sortArtifacts } from "../lib/model.ts";

test("accepts HTTPS and rejects unsafe or credentialed URLs", () => {
  const target = validateTarget({ kind: "url", url: "https://example.com/docs" });
  assert.equal(target.kind, "url");
  if (target.kind === "url") assert.equal(target.url, "https://example.com/docs");
  assert.throws(() => validateTarget({ kind: "url", url: "javascript:alert(1)" }), /HTTP\(S\)/);
  assert.throws(() => validateTarget({ kind: "url", url: "https://user:pass@example.com" }), /логином/);
});

test("rejects traversal in thread files and normalizes separators", () => {
  const target = validateTarget({ kind: "thread-file", path: "notes\\handoff.md" });
  assert.equal(target.kind, "thread-file");
  if (target.kind === "thread-file") assert.equal(target.path, "notes/handoff.md");
  assert.throws(() => validateTarget({ kind: "thread-file", path: "../secret.txt" }), /выходить/);
});

test("sorts pinned artifacts first, then explicit order", () => {
  const base = (id: string, pinned: boolean, sortOrder: number) => ({ id, threadId: "thr_abcdef", title: id, kind: "file" as const, icon: "File", description: "", target: { kind: "workspace-file" as const, path: `${id}.md` }, sortOrder, pinned, archived: false, createdAt: 1, updatedAt: 1 });
  assert.deepEqual(sortArtifacts([base("b", false, 0), base("c", true, 9), base("a", true, 1)]).map((item) => item.id), ["a", "c", "b"]);
});
