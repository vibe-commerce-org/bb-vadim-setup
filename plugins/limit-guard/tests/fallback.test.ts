// Gemini auto-switch, pure logic (plan Ф4, contract C15–C22): a breaker per MODEL, the chain in the author's bench order.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capEffort,
  closeModel,
  DEFAULT_CHAIN,
  dueProbes,
  EMPTY_BREAKER,
  firstAvailable,
  parseChain,
  pauseMinutes,
  pickTarget,
  recordFailure,
  shutModels,
  startProbe,
  vertexId,
} from "../lib/fallback.ts";

const MIN = 60_000;
const T = Date.parse("2026-11-21T12:00:00+03:00");

test("the provider prefix is optional", () => {
  assert.equal(vertexId("google-vertex/gemini-4-neon"), "gemini-4-neon");
  assert.equal(vertexId("yandex/gpt://f/deepseek/latest"), null);
  assert.equal(vertexId(null), null);
});

test("chain setting: the author's bench order by default, ids cleaned, garbage falls back", () => {
  assert.deepEqual(parseChain(undefined).chain, [...DEFAULT_CHAIN]);
  assert.deepEqual(DEFAULT_CHAIN.slice(0, 4), ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon"]);
  assert.deepEqual(parseChain("google-vertex/gemini-4-neon, gemini-3.1-pro-preview ,gemini-4-neon").chain, ["gemini-4-neon", "gemini-3.1-pro-preview"]);
  const bad = parseChain("gemini-4-neon; DROP TABLE models");
  assert.deepEqual(bad.chain, [...DEFAULT_CHAIN]);
  assert.match(bad.problem ?? "", /не похоже на id модели/);
  assert.match(parseChain("gemini-4-neon").problem ?? "", /хотя бы две модели/);
  assert.notEqual(parseChain(42).problem, null);
});

test("C22: a 429 shuts that model for 30 minutes and only that model — its healthy neighbours stay in the chain", () => {
  const r = recordFailure(EMPTY_BREAKER, "gemini-4-neon", T);
  assert.equal(r.opened, "gemini-4-neon");
  assert.deepEqual([...shutModels(r.breaker, T)], ["gemini-4-neon"]);
  assert.equal(r.breaker.open["gemini-4-neon"]!.until, T + 30 * MIN);
  // The same model failing again while shut is not news.
  assert.equal(recordFailure(r.breaker, "gemini-4-neon", T + 5 * MIN).opened, null);
  // A neighbour fails on its own account.
  const two = recordFailure(r.breaker, "gemini-4-carbon", T + 40_000);
  assert.deepEqual([...shutModels(two.breaker, T + 41_000)].sort(), ["gemini-4-carbon", "gemini-4-neon"]);
  // The pause is over and nobody probed: the next failure shuts it again at the same step.
  const again = recordFailure(r.breaker, "gemini-4-neon", T + 31 * MIN);
  assert.equal(again.opened, "gemini-4-neon");
  assert.equal(again.breaker.open["gemini-4-neon"]!.step, 0);
});

test("target: the next model of the chain that is not shut — the bench order, skipping what is down", () => {
  const chain = [...DEFAULT_CHAIN];
  assert.equal(pickTarget(chain, "gemini-4-neon", new Set(["gemini-4-neon"])), "gemini-4-carbon");
  assert.equal(pickTarget(chain, "gemini-4-neon", new Set(["gemini-4-neon", "gemini-4-carbon"])), "gemini-4-hydrogen", "16:00 on 21.11: Carbon down, Hydrogen up");
  assert.equal(pickTarget(chain, "gemini-4-neon", new Set(["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon"])), "gemini-3.1-pro-preview", "11:43 on 21.11: all four down");
  assert.equal(pickTarget(chain, "gemini-3.1-pro-preview", new Set()), "gemini-3.8-flash");
  assert.equal(pickTarget(chain, "gemini-3.8-flash", new Set()), null, "nothing left after the last");
  assert.equal(pickTarget(chain, "gemini-2.5-flash", new Set(["gemini-4-neon"])), "gemini-4-carbon", "a model outside the chain goes in from the top");
  assert.equal(firstAvailable(chain, new Set(["gemini-4-neon", "gemini-4-carbon"])), "gemini-4-hydrogen");
  assert.equal(firstAvailable(chain, new Set(chain)), null);
});

test("effort: xhigh only where the model has it, never raised", () => {
  assert.equal(capEffort("xhigh", "gemini-4-carbon"), "high");
  assert.equal(capEffort("xhigh", "gemini-3.1-pro-preview"), "high");
  assert.equal(capEffort("xhigh", "gemini-4-hydrogen"), "xhigh");
  assert.equal(capEffort("medium", "gemini-4-carbon"), "medium");
  assert.equal(capEffort("max", "gemini-3.8-flash"), "high");
  assert.equal(capEffort(null, "gemini-4-carbon"), null);
});

test("C19: the pause grows 30 → 60 → 120 min with each failed probe; a passed probe closes the model and starts over", () => {
  const first = recordFailure(EMPTY_BREAKER, "gemini-4-neon", T).breaker;
  const state = first.open["gemini-4-neon"]!;
  assert.equal(pauseMinutes(state.step), 30);
  assert.deepEqual(dueProbes(first, T + 29 * MIN), []);
  assert.deepEqual(dueProbes(first, state.until), ["gemini-4-neon"]);
  const probing = startProbe(first, "gemini-4-neon");
  assert.deepEqual(dueProbes(probing, state.until + MIN), [], "a model under probe is not due again");
  assert.deepEqual([...shutModels(probing, state.until + MIN)], [], "and not shut: the probe thread is on it");
  const failed = recordFailure(probing, "gemini-4-neon", state.until + 20_000);
  assert.equal(failed.opened, "gemini-4-neon");
  assert.equal(failed.breaker.open["gemini-4-neon"]!.step, 1);
  assert.equal(failed.breaker.open["gemini-4-neon"]!.until, state.until + 20_000 + 60 * MIN);
  const failed2 = recordFailure(startProbe(failed.breaker, "gemini-4-neon"), "gemini-4-neon", failed.breaker.open["gemini-4-neon"]!.until + 5000);
  assert.equal(pauseMinutes(failed2.breaker.open["gemini-4-neon"]!.step), 120);
  assert.equal(pauseMinutes(99), 360, "never longer than 6 hours");
  assert.deepEqual(closeModel(probing, "gemini-4-neon").open, {});
});
