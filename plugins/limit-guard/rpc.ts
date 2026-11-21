// The RPC contract between the sidebar-footer card (app.tsx) and the guards
// (server/rpc.ts). Both sides validate at the wire; the frontend imports only
// the type of `rpcContract`, so it does not bundle zod.
//
// Plugin RPC is callable by any local agent (`bb plugin rpc call limit-guard …`),
// like the `bb limit-guard` commands: turning the guard off is the user's to do by
// convention, and Claude Code deny rules on his side back that up (README).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const stage = z.union([z.literal(0), z.literal(1), z.literal(2)]);

/** Which guard: Claude Code or Codex. Methods without it address Claude, as before 0.2.0. */
export const guardKey = z.enum(["claude", "codex"]);
const which = z.object({ provider: guardKey }).nullable();

export const statusSchema = z.object({
  provider: guardKey,
  /** Block heading: «Claude Code», «Codex». */
  name: z.string(),
  /** In texts: «Claude», «Codex». */
  title: z.string(),
  /** Stage-1 target: «Sonnet xhigh», «effort medium». */
  target: z.string(),
  /** The same after a count: «Sonnet». */
  targetShort: z.string(),
  enabled: z.boolean(),
  /** Stage the guard enforces now (0 while it is off). */
  stage,
  /** Stage the weekly reading would put it on. */
  realStage: stage,
  percent: z.number().nullable(),
  /** ISO time of the weekly reset. */
  resetsAt: z.string().nullable(),
  /** Last successful reading, ms. */
  checkedAt: z.number().nullable(),
  consent: z.boolean(),
  /** Threads known to be on the target right now (the name is from 0.1, Claude only). */
  onSonnet: z.number(),
  /** Threads with a saved previous model (what «return the models» gives back). */
  saved: z.number(),
  stopped: z.number(),
  restoring: z.boolean(),
  testActive: z.boolean(),
  error: z.string().nullable(),
  thresholds: z.object({ sonnet: z.number(), stop: z.number() }),
});

export const commandResult = z.object({ ok: z.boolean(), text: z.string() });

export const budgetKey = z.enum(["gemini", "yandex", "cloudru"]);

/** One budget block of the card (server/budget.ts): money in the budget's own currency. */
export const budgetStatusSchema = z.object({
  key: budgetKey,
  /** Block heading: «Gemini · Vertex», «Яндекс», «Cloud.ru (GLM)». */
  title: z.string(),
  /** In texts: «Gemini», «Яндекс», «Cloud.ru». */
  word: z.string(),
  /** What waits on the stop, in the genitive: «ходы Яндекса». */
  turns: z.string(),
  currency: z.enum(["USD", "RUB"]),
  enabled: z.boolean(),
  stage,
  realStage: stage,
  consent: z.boolean(),
  limit: z.number(),
  warnPercent: z.number(),
  /** null — the counter has not read Pi's files (or cannot). */
  spent: z.number().nullable(),
  today: z.number().nullable(),
  percent: z.number().nullable(),
  byModel: z.array(z.object({ model: z.string(), cost: z.number() })),
  /** ISO of the next weekly reset (Monday 00:00 MSK). */
  resetsAt: z.string(),
  lastScanAt: z.number().nullable(),
  stopped: z.number(),
  testActive: z.boolean(),
  error: z.string().nullable(),
  /** Figures from outside Pi's files: the account balance, Google's month spend. */
  facts: z.array(z.object({ label: z.string(), value: z.string(), kind: z.enum(["ok", "error", "off"]) })),
});

export const rpcContract = defineRpcContract({
  /** Card data of one guard: stage, week percent, counts. */
  status: { input: which, output: statusSchema },
  /** Switch a guard on or off. */
  setEnabled: { input: z.object({ enabled: z.boolean(), provider: guardKey.optional() }), output: commandResult },
  /** Give a guard's saved previous models back (guard off, or stage 0). */
  restoreModels: { input: which, output: commandResult },
  /** Card data of all budget guards (Gemini, Yandex, Cloud.ru), in this order. */
  budgets: { input: z.null(), output: z.array(budgetStatusSchema) },
  /** Switch one budget guard on or off. Consent (resume) is deliberately not here: it is the user's, by CLI. */
  budgetSetEnabled: { input: z.object({ key: budgetKey, enabled: z.boolean() }), output: commandResult },
});

export type LimitGuardContract = typeof rpcContract;
