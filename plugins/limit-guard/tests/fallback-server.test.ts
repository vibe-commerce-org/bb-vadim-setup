// The Gemini auto-switch on the fake bb (plan Ф4, contract C15–C22): the reactive switch with a retry, the family
// breaker, threads moved off a shut family before they fail, the probe and the return, and the cases it must ignore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { settle, T0, thread } from "./fake-bb.ts";
import { A, setup, standardWorld } from "./harness.ts";

const P1 = "thr_pifb0001";
const P2 = "thr_pifb0002";
const P3 = "thr_pifb0003";
const YA = "thr_pifbyand";
const V = (id: string) => `google-vertex/${id}`;
const MIN = 60_000;

function world() {
  const w = standardWorld();
  w.threads.set(P1, thread(P1, { providerId: "pi", model: V("gemini-4-neon"), reasoningLevel: "xhigh" }));
  w.threads.set(P2, thread(P2, { providerId: "pi", model: V("gemini-4-neon"), reasoningLevel: "high" }));
  w.threads.set(P3, thread(P3, { providerId: "pi", model: V("gemini-3.1-pro-preview"), reasoningLevel: "high" }));
  w.threads.set(YA, thread(YA, { providerId: "pi", model: "yandex/gpt://f/deepseek-v4.1-flash/latest", reasoningLevel: "high" }));
  return w;
}

let seq = 0;
function failed(threadId: string, extra: { category?: string; attempt?: number } = {}) {
  seq += 1;
  return { threadId, requestId: `creq_${seq}`, turnId: null, errorInfo: { category: extra.category ?? "rate-limit", providerCode: null, httpStatusCode: null }, inputAccepted: false, rateLimits: null, attemptNumber: extra.attempt ?? 1 };
}
const updates = (t: ReturnType<typeof setup>, id?: string) =>
  (t.host.callsTo("threads.update") as Array<{ threadId: string; model?: string; reasoningLevel?: string }>).filter((u) => id === undefined || u.threadId === id);
/** The failed turn sent again: `threads.send` with the thread's new model (`threads.retry` would keep the old one). */
const retries = (t: ReturnType<typeof setup>) => t.host.callsTo("threads.send") as Array<{ threadId: string; model?: string; reasoningLevel?: string; input: Array<{ text: string }>; mode: string }>;

test("C15: a 429 on Neon moves the thread to the next model of the bench chain, caps xhigh, sends the failed turn again there; the old model is remembered", async () => {
  const w = world();
  const t = setup(w);
  const ev = failed(P1);
  await t.host.emit("turn.failed", ev);
  await settle(40);
  assert.deepEqual(updates(t, P1), [{ threadId: P1, model: V("gemini-4-carbon"), reasoningLevel: "high" }], "Carbon has no xhigh");
  assert.equal(w.threads.get(P1)!.model, V("gemini-4-carbon"));
  assert.equal(retries(t).length, 1);
  assert.equal(retries(t)[0]!.threadId, P1);
  assert.equal(retries(t)[0]!.model, V("gemini-4-carbon"), "sent on the NEW model — retry would have kept Neon");
  assert.equal(retries(t)[0]!.reasoningLevel, "high");
  assert.equal(retries(t)[0]!.input[0]!.text, "Привет, что ты умеешь?", "the failed turn's own text, once");
  assert.equal(retries(t)[0]!.mode, "queue-if-active");
  assert.deepEqual(t.host.callsTo("threads.retry"), [], "threads.retry is not used");
  assert.equal(t.fallback.snapshot().moved, 2, "P1 by the failure, P2 (also on Neon) by the spread");
  assert.equal(t.fallback.snapshot().last?.from, V("gemini-4-neon"));
  assert.equal(w.threads.get(P2)!.model, V("gemini-4-carbon"), "P2 never failed and is already off Neon");
  // The same failure heard twice is one switch.
  await t.host.emit("turn.failed", ev);
  await settle(20);
  assert.equal(retries(t).length, 1);
});

test("C22 + C18: the benchmark chain is walked model by model — Carbon fails too, the thread lands on Hydrogen; Neon's other threads move before they fail; healthy models stay alone", async () => {
  const w = world();
  w.threads.set("thr_pifbhyd0", thread("thr_pifbhyd0", { providerId: "pi", model: V("gemini-4-hydrogen"), reasoningLevel: "xhigh" }));
  const t = setup(w);
  await t.host.emit("turn.failed", failed(P1)); // Neon shut → P1 to Carbon
  await settle(60);
  t.host.clearCalls();
  await t.host.emit("turn.failed", failed(P1)); // Carbon shut too → Hydrogen, the next one down the bench that is alive
  await settle(60);
  assert.deepEqual(updates(t, P1), [{ threadId: P1, model: V("gemini-4-hydrogen"), reasoningLevel: "xhigh" }], "Hydrogen takes xhigh");
  assert.equal(retries(t).length, 1);
  assert.deepEqual(t.fallback.snapshot().shut.map((s) => s.model).sort(), ["gemini-4-carbon", "gemini-4-neon"]);
  // P2 was on Neon and never failed: moved off to the first alive one (Hydrogen). Hydrogen's own thread, 3.1 Pro, Yandex, Claude: untouched.
  assert.equal(w.threads.get(P2)!.model, V("gemini-4-hydrogen"));
  assert.deepEqual(updates(t, "thr_pifbhyd0"), []);
  assert.deepEqual(updates(t, P3), []);
  assert.deepEqual(updates(t, YA), []);
  assert.deepEqual(updates(t, A), []);
  assert.equal(t.notes.filter((n) => n.kind === "fallback-open").length, 1, "one message, not one per model");
  assert.match(t.notes.find((n) => n.kind === "fallback-open")!.note.note, /^Google отвечает 429 \(перегрузка\) на: Gemini 4 Neon \(до \d\d:\d\d МСК\)/);
  // A thread that wakes on a shut model is moved at once; a Yandex one is not.
  t.host.clearCalls();
  w.threads.set("thr_pifbnew0", thread("thr_pifbnew0", { providerId: "pi", model: V("gemini-4-carbon"), reasoningLevel: "high" }));
  await t.host.emit("thread.created", { thread: { ...w.threads.get("thr_pifbnew0")! } });
  await t.host.emit("thread.active", { thread: { ...w.threads.get(YA)!, status: "active" } });
  await settle(40);
  assert.deepEqual(updates(t, "thr_pifbnew0"), [{ threadId: "thr_pifbnew0", model: V("gemini-4-hydrogen"), reasoningLevel: "high" }]);
  assert.deepEqual(updates(t, YA), []);
  const line = t.gemini.snapshot().facts.find((f) => f.label === "Автопереключение");
  assert.match(line?.value ?? "", /Gemini 4 Neon перегружена у Google до \d\d:\d\d МСК/);
  assert.match(line?.value ?? "", /\d+ (тред|треда|тредов) на запасной модели/);
});

test("all four Gemini 4 down (11:43 on 21.11): the turn walks Neon → Carbon → Hydrogen → Argon and lands on 3.1 Pro", async () => {
  const w = world();
  const t = setup(w);
  for (let i = 0; i < 4; i += 1) {
    await t.host.emit("turn.failed", failed(P1));
    await settle(50);
  }
  assert.equal(w.threads.get(P1)!.model, V("gemini-3.1-pro-preview"));
  assert.equal(retries(t).length, 4);
  assert.equal(w.threads.get(P2)!.model, V("gemini-3.1-pro-preview"), "the other Neon thread went straight to the survivor");
});

test("C16: 429 on the last model of the chain — nothing to switch to, the turn stays failed, no loop", async () => {
  const w = world();
  w.threads.set("thr_pifblast", thread("thr_pifblast", { providerId: "pi", model: V("gemini-3.8-flash"), reasoningLevel: "high" }));
  const t = setup(w);
  await t.host.emit("turn.failed", failed("thr_pifblast"));
  await settle(40);
  assert.deepEqual(updates(t, "thr_pifblast"), []);
  assert.deepEqual(retries(t), []);
});

test("C17: only rate-limit on a Pi thread on a Vertex model counts — not billing, not Yandex, not Claude, not a retry chain gone on", async () => {
  const w = world();
  const t = setup(w);
  await t.host.emit("turn.failed", failed(P1, { category: "auth" }));
  await t.host.emit("turn.failed", failed(P1, { category: "unknown" }));
  await t.host.emit("turn.failed", failed(YA));
  await t.host.emit("turn.failed", failed(A));
  await t.host.emit("turn.failed", failed(P1, { attempt: 9 }));
  await settle(60);
  assert.deepEqual(updates(t), []);
  assert.deepEqual(retries(t), []);
});

test("off in the settings: nothing is switched; the chain setting reorders the targets", async () => {
  const off = setup(world(), { settings: { geminiFallback: false } });
  await off.host.emit("turn.failed", failed(P1));
  await settle(40);
  assert.deepEqual(updates(off), []);
  const custom = setup(world(), { settings: { geminiFallbackChain: "gemini-4-neon, gemini-3.1-pro-preview, gemini-4-carbon" } });
  await custom.host.emit("turn.failed", failed(P1));
  await settle(40);
  assert.equal(updates(custom, P1)[0]?.model, V("gemini-3.1-pro-preview"));
  const bad = setup(world(), { settings: { geminiFallbackChain: "gemini-4-neon; DROP TABLE" } });
  await bad.host.emit("turn.failed", failed(P1));
  await settle(40);
  assert.equal(updates(bad, P1)[0]?.model, V("gemini-4-carbon"), "garbage falls back to the bench order");
});

test("C20: the Gemini budget on its stop is stronger — no spare Vertex models are switched on", async () => {
  const w = world();
  const t = setup(w);
  await t.host.cli(["test", "gemini", "100"]);
  await settle(20);
  assert.equal(t.gemini.snapshot().stage, 2);
  await t.host.emit("turn.failed", failed(P1));
  await settle(40);
  assert.deepEqual(updates(t, P1), []);
  assert.deepEqual(retries(t), []);
});

test("C19: after the pause ONE moved thread returns to Neon as the probe; a passed turn closes Neon and its threads go home; a failed one lengthens the pause", async () => {
  const w = world();
  const t = setup(w);
  await t.host.emit("turn.failed", failed(P1)); // Neon shut, P1 → Carbon; P2 spread → Carbon
  await settle(60);
  const neon = t.fallback.snapshot().shut.find((s) => s.model === "gemini-4-neon")!;
  assert.equal(neon.probing, false);
  // Before the pause is over: nothing.
  t.advance(10 * MIN);
  await t.fallback.tick();
  assert.equal(t.fallback.snapshot().shut.find((s) => s.model === "gemini-4-neon")!.probing, false);
  // After it: the probe — one thread, on its own model.
  t.advance(25 * MIN);
  t.host.clearCalls();
  await t.fallback.tick();
  assert.equal(t.fallback.snapshot().shut.find((s) => s.model === "gemini-4-neon")!.probing, true);
  assert.equal(updates(t).length, 1, "one probe, not all threads at once");
  const probeThread = updates(t)[0]!.threadId;
  assert.equal(updates(t)[0]!.model, V("gemini-4-neon"));
  assert.equal(w.threads.get(probeThread)!.model, V("gemini-4-neon"));
  // The probe fails (429 again): Neon shut for 60 minutes, the thread back on the spare.
  await t.host.emit("turn.failed", failed(probeThread));
  await settle(60);
  const again = t.fallback.snapshot().shut.find((s) => s.model === "gemini-4-neon")!;
  assert.equal(again.probing, false);
  assert.equal(again.step, 1);
  assert.equal(w.threads.get(probeThread)!.model, V("gemini-4-carbon"));
  // Next time it passes: the thread ends its turn on Neon, Neon closes, every thread that came from it is back.
  t.advance(61 * MIN);
  await t.fallback.tick();
  const second = updates(t).filter((u) => u.model === V("gemini-4-neon")).at(-1)!;
  await t.host.emit("thread.idle", { thread: { ...w.threads.get(second.threadId)!, status: "idle" } });
  await settle(60);
  assert.equal(t.fallback.snapshot().shut.find((s) => s.model === "gemini-4-neon"), undefined);
  assert.equal(t.fallback.snapshot().moved, 0);
  assert.equal(w.threads.get(P1)!.model, V("gemini-4-neon"));
  assert.equal(w.threads.get(P1)!.reasoningLevel, "xhigh", "the effort comes back too");
  assert.equal(w.threads.get(P2)!.model, V("gemini-4-neon"));
  assert.equal(w.threads.get(P3)!.model, V("gemini-3.1-pro-preview"), "a thread that never was on Neon is not touched");
  assert.ok(t.notes.some((n) => n.kind === "fallback-open" && /Gemini 4 Neon снова отвечает/.test(n.note.note)));
});

test("a thread the user moved by hand during the pause is not dragged back on the return", async () => {
  const w = world();
  const t = setup(w);
  await t.host.emit("turn.failed", failed(P1));
  await settle(60);
  w.threads.get(P2)!.model = V("gemini-3.8-flash"); // the user's own choice
  t.advance(31 * MIN);
  await t.fallback.tick();
  const probe = (t.host.callsTo("threads.update") as Array<{ threadId: string; model?: string }>).filter((u) => u.model === V("gemini-4-neon")).at(-1)!;
  await t.host.emit("thread.idle", { thread: { ...w.threads.get(probe.threadId)!, status: "idle" } });
  await settle(60);
  assert.equal(w.threads.get(P2)!.model, V("gemini-3.8-flash"), "his choice stands");
});

test("the breaker survives a reload of the plugin (kv)", async () => {
  const w = world();
  const t = setup(w);
  await t.host.emit("turn.failed", failed(P1));
  await settle(60);
  const stored = t.host.kv.get("gemini:fallback") as { breaker: { open: Record<string, { until: number }> }; moved: Record<string, unknown> };
  assert.ok(stored.breaker.open["gemini-4-neon"]!.until > T0);
  assert.ok(Object.keys(stored.moved).length >= 1);
});

test("a turn the provider had already taken gets a nudge on the new model, not a second copy of the prompt", async () => {
  const t = setup(world());
  await t.host.emit("turn.failed", { ...failed(P1), inputAccepted: true });
  await settle(60);
  assert.equal(retries(t).length, 1);
  assert.match(retries(t)[0]!.input[0]!.text, /^Продолжай с того места, где остановился/);
  assert.equal(retries(t)[0]!.model, V("gemini-4-carbon"));
});
