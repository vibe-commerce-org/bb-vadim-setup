// sessionStorage memory of the queue page (filter, unfolded groups, scroll):
// guarded reads and writes. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSession, writeSession } from "../hooks/useSessionState.ts";

function fakeStorage(): Storage & { data: Map<string, string>; full: boolean } {
  const data = new Map<string, string>();
  return {
    data,
    full: false,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem(key: string, value: string) {
      if (this.full) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

// Node 25 ships its own sessionStorage global; each test swaps it and puts it back.
function withStorage(descriptor: PropertyDescriptor, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { ...descriptor, configurable: true });
  try {
    run();
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, "sessionStorage");
    else Object.defineProperty(globalThis, "sessionStorage", original);
  }
}

test("storage that throws on access (disabled, private mode): reads fall back, writes do nothing", () => {
  withStorage(
    {
      get() {
        throw new Error("SecurityError");
      },
    },
    () => {
      assert.equal(readSession("queue:project", null), null);
      writeSession("queue:project", "prj_a");
    },
  );
  withStorage({ value: undefined }, () => {
    assert.equal(readSession("scroll:queue", 0), 0);
    writeSession("scroll:queue", 10);
  });
});

test("values round-trip under the pult: prefix; junk and a full quota are survived", () => {
  const storage = fakeStorage();
  withStorage({ value: storage }, () => {
    writeSession("queue:project", "prj_a");
    writeSession("scroll:queue", 1240);
    writeSession("open:queue:stale", true);
    assert.equal(storage.data.get("pult:queue:project"), '"prj_a"');
    assert.equal(readSession<string | null>("queue:project", null), "prj_a");
    assert.equal(readSession("scroll:queue", 0), 1240);
    assert.equal(readSession("open:queue:stale", false), true);
    assert.equal(readSession("limit:kind:decision", 20), 20, "missing key → fallback");
    storage.data.set("pult:broken", "{not json");
    assert.equal(readSession("broken", 7), 7);
    storage.full = true;
    writeSession("scroll:queue", 99);
    assert.equal(readSession("scroll:queue", 0), 1240, "a failed write keeps the old value");
  });
});
