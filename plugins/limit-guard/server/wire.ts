// Two guards — Claude Code and Codex (lib/profile.ts) — and the budget guards
// (Gemini, Yandex, Cloud.ru: lib/budget.ts, server/budget.ts) in one plugin.
//
// The SDK allows some registrations only once per plugin: «At most one handler
// per hook per plugin; registering a second replaces» (PluginHooks.on), one
// agents.configure, one settings definition, one CLI command name, one RPC
// contract. They are made here and handed to both guards; events and the
// background services each guard registers itself (events are additive,
// services have distinct names).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { DispatchDecision, HookContextLike } from "../lib/policy.ts";
import { CLAUDE_PROFILE, CODEX_PROFILE, SETTINGS, type GuardKey } from "../lib/profile.ts";
import { registerCli } from "./cli.ts";
import { BUDGET_KEYS, BUDGET_PROFILES, type BudgetKey } from "../lib/budget.ts";
import { createBudgetGuard, type BudgetFact, type BudgetGuard } from "./budget.ts";
import { createFallback, type GeminiFallback } from "./fallback.ts";
import { createGuard, type Guard, type GuardOptions } from "./guard.ts";
import { createPiLedger, defaultPiSessionDirs } from "./ledger.ts";
import { registerRpc } from "./rpc.ts";

export type Guards = Record<GuardKey, Guard>;

export type Budgets = Record<BudgetKey, BudgetGuard>;

export type InstallOptions = Omit<GuardOptions, "settings"> & {
  /** Pi session folders the budget counter reads (tests pass their own; default — bb's). */
  piSessionDirs?: string[];
  /** Figures from outside Pi's files per budget (the Yandex balance, Google's month spend). */
  facts?: Partial<Record<BudgetKey, BudgetFact[]>>;
  /** The auto-switch message waits this long for neighbours that shut with the first model (default 2 s). */
  fallbackJoinMs?: number;
};

const PROCEED: DispatchDecision = { action: "proceed" };
/** bb fails a send whose hook answers later than 10 s; each guard answers within ~4.5 s, this is the safety net. */
const HOOK_CUTOFF_MS = 8_000;

function proceedAfter(ms: number): Promise<DispatchDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(PROCEED), ms);
    timer.unref?.();
  });
}

export function installGuards(bb: BbPluginApi, opts: InstallOptions): Guards & Budgets & { budgets: Budgets; fallback: GeminiFallback } {
  const { piSessionDirs, facts, fallbackJoinMs, ...guardOpts } = opts;
  const settings = bb.settings.define(SETTINGS);
  const source = {
    get: async () => (await settings.get()) as Record<string, unknown>,
    set: async (values: Record<string, unknown>) => await settings.experimental_set(values as Parameters<typeof settings.experimental_set>[0]),
  };
  const guards: Guards = {
    claude: createGuard(bb, CLAUDE_PROFILE, { ...guardOpts, settings: source }),
    // The interim script of October imported Claude models only.
    codex: createGuard(bb, CODEX_PROFILE, { ...guardOpts, settings: source, interimStatePath: null }),
  };
  // One counter over Pi's session files for all budgets; each budget guard asks it for its provider.
  const ledger = createPiLedger({ dirs: piSessionDirs ?? defaultPiSessionDirs(), providers: BUDGET_KEYS.map((key) => BUDGET_PROFILES[key].piProvider) });
  // The Gemini auto-switch lives next to the Gemini budget: it shows its line in that block and yields to its stop.
  let fallback: GeminiFallback | null = null;
  const budgets = Object.fromEntries(
    BUDGET_KEYS.map((key) => [
      key,
      createBudgetGuard(bb, BUDGET_PROFILES[key], {
        settings: source,
        notifier: opts.notifier,
        ledger,
        ...(facts?.[key] !== undefined ? { facts: facts[key] } : {}),
        ...(key === "gemini" ? { notes: [() => fallback?.line() ?? null] } : {}),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        ...(opts.sendNowGraceMs !== undefined ? { sendNowGraceMs: opts.sendNowGraceMs } : {}),
        ...(opts.stopBudgetMs !== undefined ? { stopBudgetMs: opts.stopBudgetMs } : {}),
      }),
    ]),
  ) as Budgets;
  const budgetList = BUDGET_KEYS.map((key) => budgets[key]);
  fallback = createFallback(bb, {
    settings: source,
    notifier: opts.notifier,
    blocked: () => {
      const s = budgets.gemini.snapshot();
      return s.enabled && s.stage === 2 && !s.consent;
    },
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(fallbackJoinMs !== undefined ? { joinMs: fallbackJoinMs } : {}),
  });
  const fallbackRef = fallback;
  const list: Array<Pick<Guard, "dispatch">> = [guards.claude, guards.codex, ...budgetList];

  settings.onChange((next) => {
    for (const guard of [guards.claude, guards.codex, ...budgetList]) guard.onSettings(next as Record<string, unknown>);
    fallbackRef.onSettings(next as Record<string, unknown>);
  });

  // Every guard sees every dispatch (it learns thread providers from them) and answers
  // `proceed` for other providers' turns, so at most one answer is not `proceed`.
  // Fail-open: a throw or a slow answer would fail the send in all of BB.
  bb.experimental_hooks.on("message.dispatch", async (ctx): Promise<DispatchDecision> => {
    try {
      const decide = Promise.all(list.map((guard) => guard.dispatch(ctx as HookContextLike).catch(() => PROCEED))).then(
        (answers) => answers.find((answer) => answer.action !== "proceed") ?? PROCEED,
      );
      return await Promise.race([decide, proceedAfter(HOOK_CUTOFF_MS)]);
    } catch {
      return PROCEED;
    }
  });

  bb.agents.configure((ctx) => {
    const hints = [guards.claude, guards.codex].map((guard) => guard.agentHint(ctx)).filter((hint): hint is string => hint !== null);
    return hints.length === 0 ? { tools: [], skills: [] } : { tools: [], skills: [], instructions: hints.join("\n") };
  });

  registerCli(bb, guards, budgets);
  registerRpc(bb, guards, budgets);
  return { ...guards, ...budgets, budgets, fallback: fallbackRef };
}
