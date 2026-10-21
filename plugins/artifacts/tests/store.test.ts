import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createArtifactStore, MIGRATIONS } from "../lib/store.ts";

const threadA = "thr_abcdef";
const threadB = "thr_ghijkl";

function store() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
  return createArtifactStore(db);
}

test("persists artifacts and isolates thread lists", () => {
  const artifacts = store();
  const created = artifacts.insert({ threadId: threadA, title: "Plan", kind: "plan", icon: "", description: "", target: { kind: "workspace-file", path: "backlog/plans/plan.md" } });
  artifacts.insert({ threadId: threadB, title: "Other", kind: "file", icon: "", description: "", target: { kind: "workspace-file", path: "README.md" } });
  assert.equal(artifacts.list(threadA).length, 1);
  assert.equal(artifacts.list(threadB).length, 1);
  assert.equal(artifacts.get(threadB, created.id), null);
});

test("updates order and archive state without deleting history", () => {
  const artifacts = store();
  const created = artifacts.insert({ threadId: threadA, title: "Plan", kind: "plan", icon: "", description: "", target: { kind: "workspace-file", path: "plan.md" } });
  artifacts.state(threadA, created.id, { pinned: true, archived: true, sortOrder: 4 });
  assert.equal(artifacts.list(threadA).length, 0);
  const archived = artifacts.list(threadA, true)[0]!;
  assert.equal(archived.pinned, true);
  assert.equal(archived.sortOrder, 4);
  artifacts.state(threadA, created.id, { archived: false });
  assert.equal(artifacts.list(threadA)[0]!.id, created.id);
});
