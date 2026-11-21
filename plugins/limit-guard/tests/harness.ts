// Shared by the backend tests: a guard on the fake BB host (tests/fake-bb.ts)
// with a controllable clock and a recording notifier, plus the standard world.
import type { Note, NotifyKind, NotifyRecord } from "../lib/format.ts";
import { installGuards, type InstallOptions } from "../server/wire.ts";
import { createFakeBb, newWorld, T0, thread, type World } from "./fake-bb.ts";

export const A = "thr_aaaaaaaa";
export const B = "thr_bbbbbbbb";
export const C = "thr_cccccccc";
export const CODEX = "thr_codex000";
export const PI = "thr_pi000000";

export const CLAUDE_AGENT = { id: "claude-code" };

export function setup(world: World, extra: { interim?: string | null; settings?: Record<string, unknown>; stopBudgetMs?: number; piDirs?: string[]; facts?: InstallOptions["facts"] } = {}) {
  const host = createFakeBb(world, { settings: extra.settings ?? {} });
  const notes: Array<{ kind: NotifyKind; note: Note }> = [];
  let now = T0;
  // Both guards as in the plugin; `guard` is Claude (every test before 0.2.0), `codex` the second one.
  const guards = installGuards(host.bb, {
    notifier: async (kind, note): Promise<NotifyRecord> => {
      notes.push({ kind, note });
      return { at: now, kind, ok: true, message: "доставлено" };
    },
    interimStatePath: extra.interim ?? null,
    now: () => now,
    minReadMs: 0,
    reseatDelayMs: 5,
    sendNowGraceMs: 5,
    // Never the real ~/.bb: the Gemini counter reads only what a test gives it.
    piSessionDirs: extra.piDirs ?? [],
    ...(extra.facts !== undefined ? { facts: extra.facts } : {}),
    ...(extra.stopBudgetMs !== undefined ? { stopBudgetMs: extra.stopBudgetMs } : {}),
  });
  return {
    host,
    guard: guards.claude,
    codex: guards.codex,
    gemini: guards.gemini,
    yandex: guards.yandex,
    cloudru: guards.cloudru,
    notes,
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

export function standardWorld(extra: Partial<World> = {}): World {
  return newWorld(
    [
      thread(A),
      thread(B, { model: "claude-opus-5-5[1m]", reasoningLevel: "max", updatedAt: T0 - 3 * 24 * 3600_000 }),
      thread(C, { model: "claude-sonnet-5-5", reasoningLevel: "xhigh" }),
      thread(CODEX, { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" }),
      thread(PI, { providerId: "pi", model: "yandex", reasoningLevel: "medium" }),
    ],
    extra,
  );
}
