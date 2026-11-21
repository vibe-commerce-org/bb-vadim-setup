// bb-plugin-limit-guard — «Сторож лимитов_vibecom».
//
// Two guards on one code, each with its own switch, thresholds and state
// (lib/profile.ts):
//   Claude Code (on by default) — weekly Claude window ≥ 85 %: every claude-code
//     thread goes to claude-sonnet-5-5 / xhigh from its next turn (previous model
//     saved), turns on Opus are held and re-queued on Sonnet; ≥ 93 %: claude-code
//     turns are held and running ones stopped until `bb limit-guard resume`;
//     weekly reset — the previous models come back.
//   Codex (off by default; `bb limit-guard on codex`) — the same on the weekly
//     Codex window with its own thresholds; stage 1 lowers the effort (and the
//     model, if one is set in the settings).
//   Gemini budget (on by default; server/budget.ts, since 0.3.0) — the user's weekly dollar
//     limit for Pi threads on google-vertex/* models, counted from Pi's session files:
//     80 % — a warning, 100 % — those turns wait and running ones stop until
//     `bb limit-guard resume gemini`.
// Other Pi models and other providers are never touched.
//
// Plans: backlog/plans/2026-10-15-limit-guard.md, 2026-11-20-limit-guard-per-provider.md.
// Logic without the SDK is in lib/ (tests/), the SDK side in server/guard.ts,
// the once-per-plugin registrations in server/wire.ts, the command in server/cli.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GuardOptions } from "./server/guard.ts";
import { createTelegramNotifier } from "./server/notify.ts";
import { installGuards } from "./server/wire.ts";

/** state.json of the author's earlier interim script — its saved models are taken over. The kit has none. */
export const INTERIM_STATE_PATH: string | null = null;

export function createPlugin(overrides: Partial<Omit<GuardOptions, "settings">> = {}): (bb: BbPluginApi) => void {
  return (bb) => {
    installGuards(bb, {
      notifier: overrides.notifier ?? createTelegramNotifier(),
      interimStatePath: overrides.interimStatePath === undefined ? INTERIM_STATE_PATH : overrides.interimStatePath,
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
      ...(overrides.pollMs !== undefined ? { pollMs: overrides.pollMs } : {}),
      ...(overrides.minReadMs !== undefined ? { minReadMs: overrides.minReadMs } : {}),
      ...(overrides.reseatDelayMs !== undefined ? { reseatDelayMs: overrides.reseatDelayMs } : {}),
    });
  };
}

export default createPlugin();
