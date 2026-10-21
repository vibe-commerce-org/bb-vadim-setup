// The page's shared queue cache and reply bookkeeping (hooks/queue-store.ts):
// one request per signal, replies only to the turn they were meant for, no
// second reply before the agent moves. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SENT_TTL_MS,
  createQueueStore,
  deriveMarks,
  findWaitingItem,
  pruneSent,
  replyTarget,
  sameCardItem,
  sendFailureKind,
  versionOf,
  type CardItemShape,
  type SentReply,
} from "../hooks/queue-store.ts";
import { MARK_LABELS } from "../lib/format.ts";
import type { WaitingKind } from "../lib/types.ts";

const NOW = Date.parse("2026-10-12T12:00:00+03:00");

interface TestItem extends CardItemShape {
  kind: WaitingKind;
  nested: readonly TestItem[];
}

function item(threadId: string, over: Partial<TestItem> = {}): TestItem {
  return {
    threadId,
    projectId: "prj_a",
    projectName: "studio_code",
    title: `Тред ${threadId}`,
    parentThreadId: null,
    parentTitle: null,
    kind: "decision",
    ask: "А или Б?",
    options: [
      { key: "А", label: "раскатить всем", recommended: true },
      { key: "Б", label: "сначала себе", recommended: false },
    ],
    multi: false,
    replyTemplate: null,
    due: null,
    ageBucket: "fresh",
    source: "rules",
    confidence: 0.7,
    pinned: false,
    taskKey: null,
    openChildren: 0,
    excerpt: null,
    lastAgentAt: NOW - 60_000,
    snoozedUntil: null,
    nested: [],
    ...over,
  };
}

type Item = TestItem;

function queueOf(items: Item[], stale: Item[] = []) {
  return { items, stale, total: items.length + stale.length };
}

function sent(threadId: string, over: Partial<SentReply> = {}): SentReply {
  return {
    threadId,
    lastAgentAt: NOW - 60_000,
    kind: "decision",
    text: "А",
    outcome: "sent",
    at: NOW,
    error: null,
    ...over,
  };
}

// ── «подтверждение отправит «А» на другой вопрос» ─────────────────────────

test("replyTarget: ok only while the thread waits on the same turn and kind", () => {
  const before = item("thr_a");
  const version = versionOf(before);
  assert.equal(replyTarget(before, version), "ok");
  assert.equal(replyTarget(item("thr_a", { lastAgentAt: NOW }), version), "changed", "a new agent turn");
  assert.equal(replyTarget(item("thr_a", { kind: "action" }), version), "changed", "same turn, other kind");
  assert.equal(replyTarget(null, version), "gone");
});

test("findWaitingItem looks into stale items and nested subthreads", () => {
  const child = item("thr_child", { parentThreadId: "thr_parent" });
  const queue = queueOf([item("thr_parent", { nested: [child] })], [item("thr_old", { ageBucket: "stale" })]);
  assert.equal(findWaitingItem(queue, "thr_child")?.threadId, "thr_child");
  assert.equal(findWaitingItem(queue, "thr_old")?.threadId, "thr_old");
  assert.equal(findWaitingItem(queue, "thr_none"), null);
});

// ── «повторный тап после обрыва сети / кнопки активны 2–3 с» ─────────────

test("pruneSent keeps a reply until the agent moves, then frees the card", () => {
  const records = new Map([["thr_a", sent("thr_a")]]);
  // Same turn still in the queue (the rescan has not caught up): keep.
  assert.equal(pruneSent(records, queueOf([item("thr_a")]), NOW + 2_000), records);
  // The thread went to work and left the queue: keep (no card to free).
  assert.equal(pruneSent(records, queueOf([]), NOW + 2_000), records);
  // A new agent turn: drop — the card answers the new question.
  assert.equal(pruneSent(records, queueOf([item("thr_a", { lastAgentAt: NOW + 5_000 })]), NOW + 6_000).size, 0);
  // Same turn, other kind (e.g. the run failed): drop.
  assert.equal(pruneSent(records, queueOf([item("thr_a", { kind: "failed" })]), NOW + 6_000).size, 0);
  // Nested subthreads count too.
  const parent = item("thr_p", { nested: [item("thr_a", { lastAgentAt: NOW + 5_000 })] });
  assert.equal(pruneSent(records, queueOf([parent]), NOW + 6_000).size, 0);
});

test("pruneSent drops records older than a day even if the agent never moved", () => {
  const records = new Map([["thr_a", sent("thr_a", { outcome: "unknown", error: "Failed to fetch" })]]);
  assert.equal(pruneSent(records, queueOf([item("thr_a")]), NOW + SENT_TTL_MS - 1), records);
  assert.equal(pruneSent(records, queueOf([item("thr_a")]), NOW + SENT_TTL_MS + 1).size, 0);
});

test("sendFailureKind: only a clear 4xx refusal allows a retry", () => {
  for (const status of [400, 403, 404, 409, 422, 429]) {
    assert.equal(sendFailureKind(Object.assign(new Error("no"), { status })), "refused", String(status));
  }
  assert.equal(sendFailureKind({ response: { status: 409 } }), "refused");
  assert.equal(sendFailureKind({ statusCode: 400 }), "refused");
  assert.equal(sendFailureKind(Object.assign(new Error("timeout"), { status: 408 })), "unknown");
  assert.equal(sendFailureKind(Object.assign(new Error("bad gateway"), { status: 502 })), "unknown");
  assert.equal(sendFailureKind(new TypeError("Failed to fetch")), "unknown");
  assert.equal(sendFailureKind(new DOMException("aborted", "AbortError")), "unknown");
  assert.equal(sendFailureKind("boom"), "unknown");
});

// ── «два одинаковых queue.list на каждый сигнал» ──────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("store: the page and the badge share one request per signal", async () => {
  const store = createQueueStore<{ queue: ReturnType<typeof queueOf> }>({ now: () => NOW });
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { queue: queueOf([item("thr_a")]) };
  };
  const releasePage = store.retain(load);
  const releaseBadge = store.retain(load);
  await tick();
  assert.equal(calls, 1, "mounting two views costs one request");
  // Both views' useRealtime handlers fire for the same signal.
  store.signal({ total: 1 });
  store.signal({ total: 1 });
  await tick();
  assert.equal(calls, 2, "one signal, one request");
  assert.equal(store.getState().data?.queue.items[0]?.threadId, "thr_a");
  releasePage();
  releaseBadge();
  store.signal({ total: 3 });
  await tick();
  assert.equal(calls, 2, "nobody shows the queue: signals do not fetch");
  assert.equal(store.getState().total, 3, "the badge number still follows the payload");
});

test("store: a signal during a request yields one trailing request", async () => {
  const store = createQueueStore<{ queue: ReturnType<typeof queueOf> }>({ now: () => NOW });
  const pending: ReturnType<typeof deferred<{ queue: ReturnType<typeof queueOf> }>>[] = [];
  const release = store.retain(() => {
    const request = deferred<{ queue: ReturnType<typeof queueOf> }>();
    pending.push(request);
    return request.promise;
  });
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(store.getState().busy, true);
  store.signal({ total: 2 });
  store.refetch();
  await tick();
  assert.equal(pending.length, 1, "no parallel request");
  pending[0]!.resolve({ queue: queueOf([item("thr_a")]) });
  await tick();
  assert.equal(pending.length, 2, "one trailing request for the burst");
  pending[1]!.resolve({ queue: queueOf([item("thr_a"), item("thr_b")]) });
  await tick();
  assert.equal(store.getState().busy, false);
  assert.equal(store.getState().total, 2);
  release();
});

test("store: the badge total comes from the signal before the refetch lands", async () => {
  const store = createQueueStore<{ queue: ReturnType<typeof queueOf> }>({ now: () => NOW });
  const request = deferred<{ queue: ReturnType<typeof queueOf> }>();
  const release = store.retain(() => request.promise);
  store.signal({ total: 7 });
  assert.equal(store.getState().total, 7);
  store.signal({ total: "x" });
  store.signal(null);
  assert.equal(store.getState().total, 7, "malformed payloads are ignored");
  request.resolve({ queue: queueOf([item("thr_a")]) });
  await tick();
  assert.equal(store.getState().total, 1, "fresh data wins");
  release();
});

test("store: errors keep the last data; a new retainer after idle refetches", async () => {
  const store = createQueueStore<{ queue: ReturnType<typeof queueOf> }>({ now: () => NOW });
  let fail = false;
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (fail) throw new Error("offline");
    return { queue: queueOf([item("thr_a")]) };
  };
  let release = store.retain(load);
  await tick();
  fail = true;
  store.refetch();
  await tick();
  assert.equal(store.getState().error, "offline");
  assert.equal(store.getState().data?.queue.items.length, 1, "old data stays on screen");
  release();
  fail = false;
  release = store.retain(load);
  await tick();
  assert.equal(calls, 3, "coming back to the page refreshes the cached queue");
  assert.equal(store.getState().error, null);
  release();
});

test("store: sent replies are pruned when new data shows the agent moved", async () => {
  const store = createQueueStore<{ queue: ReturnType<typeof queueOf> }>({ now: () => NOW + 1_000 });
  let next = queueOf([item("thr_a")]);
  const release = store.retain(async () => ({ queue: next }));
  await tick();
  store.markSent(sent("thr_a"));
  assert.equal(store.getState().sent.get("thr_a")?.text, "А");
  store.refetch();
  await tick();
  assert.equal(store.getState().sent.has("thr_a"), true, "same turn: the card stays «отправлено»");
  next = queueOf([item("thr_a", { lastAgentAt: NOW + 500 })]);
  store.refetch();
  await tick();
  assert.equal(store.getState().sent.has("thr_a"), false, "new turn: the card is live again");
  release();
});

// ── row marks from the shared source ──────────────────────────────────────

test("deriveMarks: top level, stale and nested, one mark per thread, shared labels", () => {
  const queue = queueOf(
    [item("thr_p", { kind: "decision", nested: [item("thr_c", { kind: "approval" })] }), item("thr_k", { kind: "commit" })],
    [item("thr_s", { kind: "action" })],
  );
  assert.deepEqual(deriveMarks(queue), [
    { threadId: "thr_p", kind: "decision", label: MARK_LABELS.decision },
    { threadId: "thr_c", kind: "approval", label: MARK_LABELS.approval },
    { threadId: "thr_k", kind: "commit", label: MARK_LABELS.commit },
    { threadId: "thr_s", kind: "action", label: MARK_LABELS.action },
  ]);
  const twice = queueOf([item("thr_p", { nested: [item("thr_c")] }), item("thr_c")]);
  assert.deepEqual(
    deriveMarks(twice).map((mark) => mark.threadId),
    ["thr_p", "thr_c"],
  );
});

// ── «весь список перерисовывается каждые 30 с» ────────────────────────────

test("sameCardItem: a fresh copy with another age is the same card", () => {
  const a = item("thr_a", { nested: [item("thr_c")] });
  const b = { ...structuredClone(a), ageMs: 999_999 } as CardItemShape;
  assert.equal(sameCardItem(a, b), true);
});

test("sameCardItem: anything the card draws makes it render again", () => {
  const base = item("thr_a", { nested: [item("thr_c")] });
  const changes: Partial<TestItem>[] = [
    { lastAgentAt: NOW },
    { kind: "action" },
    { taskKey: "ORC-3" },
    { ask: "Новый вопрос?" },
    { title: "Новое имя" },
    { source: "llm" },
    { pinned: true },
    { ageBucket: "day" },
    { options: [{ key: "А", label: "другое", recommended: true }] },
    { nested: [] },
    { nested: [item("thr_c", { lastAgentAt: NOW })] },
  ];
  for (const change of changes) {
    assert.equal(sameCardItem(base, { ...base, ...change }), false, JSON.stringify(change));
  }
});
