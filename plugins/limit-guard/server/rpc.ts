// RPC handlers of the sidebar-footer card. Thin: all decisions are the guards'
// (server/guard.ts), the card only shows their snapshots and presses their
// buttons. Without `provider` a method addresses Claude, as before 0.2.0.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { targetLabel, targetShort, type GuardKey } from "../lib/profile.ts";
import { rpcContract } from "../rpc.ts";
import { BUDGET_KEYS, type BudgetKey } from "../lib/budget.ts";
import type { BudgetGuard } from "./budget.ts";
import type { Guard } from "./guard.ts";

// The app, the CLI and agents all arrive as `client` (d.ts ExperimentalPluginRpcCaller) — the card cannot be told from an agent.
const CALLER = "rpc";

export function registerRpc(bb: BbPluginApi, guards: Record<GuardKey, Guard>, budgets: Record<BudgetKey, BudgetGuard>): void {
  const pick = (input: { provider?: GuardKey } | null | undefined): Guard => guards[input?.provider ?? "claude"];
  bb.rpc.register(rpcContract, {
    status: async (input) => {
      const guard = pick(input);
      await guard.ready;
      const s = guard.snapshot();
      const { profile, target } = s.guard;
      return {
        provider: profile.key,
        name: profile.cardTitle,
        title: profile.title,
        target: targetLabel(target),
        targetShort: targetShort(target),
        enabled: s.enabled,
        stage: s.enabled ? s.stage : (0 as const),
        realStage: s.realStage,
        percent: s.reading === null ? null : s.reading.percent,
        resetsAt: s.reading === null ? null : s.reading.resetsAt,
        checkedAt: s.lastCheckedAt,
        consent: s.consent,
        onSonnet: s.onSonnet,
        saved: s.saved,
        stopped: s.stoppedThreads.length,
        restoring: s.restoring,
        testActive: s.test !== null,
        // The card shows an error only while it is still the latest word: a reading that came after it
        // (`status` in the CLI keeps the dated line for the log) means the problem is gone.
        error: s.lastError !== null && (s.lastCheckedAt === null || s.lastError.at > s.lastCheckedAt) ? s.lastError.message : null,
        thresholds: { sonnet: s.thresholds.sonnet, stop: s.thresholds.stop },
      };
    },
    setEnabled: async ({ enabled, provider }) => await pick({ provider }).setEnabled(enabled, CALLER),
    restoreModels: async (input) => await pick(input).restoreModels(CALLER),
    budgets: async () => {
      return await Promise.all(
        BUDGET_KEYS.map(async (key) => {
          const guard = budgets[key];
          await guard.ready;
          const s = guard.snapshot();
          return {
            key,
            title: s.title,
            word: s.word,
            turns: s.turns,
            currency: s.currency,
            enabled: s.enabled,
            stage: s.stage,
            realStage: s.realStage,
            consent: s.consent,
            limit: s.limit,
            warnPercent: s.warnPercent,
            spent: s.spent,
            today: s.today,
            percent: s.test !== null ? s.test.percent : s.percent,
            byModel: s.byModel.slice(0, 6),
            resetsAt: s.resetsAt,
            lastScanAt: s.lastScanAt,
            stopped: s.stoppedThreads.length,
            testActive: s.test !== null,
            // As for Claude/Codex: an error shows only while no successful count came after it.
            error: s.lastError !== null && (s.lastScanAt === null || s.lastError.at > s.lastScanAt) ? s.lastError.message : null,
            facts: s.facts,
          };
        }),
      );
    },
    budgetSetEnabled: async ({ key, enabled }) => await budgets[key].setEnabled(enabled, CALLER),
  });
}
