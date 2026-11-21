// Picking the weekly window out of `bb.sdk.system.usageLimits` — pure logic.
//
// The answer is `Record<providerId, {status, windows: [{label, usedPercent,
// resetsAt, ...}]}>` with a loose schema (bb-plugin-sdk.d.ts,
// providerUsageResponseSchema), so the providers' `kind` and `model` fields
// come through. The guard wants the weekly window over all models: kind ===
// "weekly" and no model — the same for claude-code (plus a per-model Fable
// window) and codex (plus a five-hour window), checked on bb 0.50, 20.11.
// Labels («Weekly limit») are display text and may change — never select by label.
import type { Reading } from "./stage.ts";

export type WeeklyPick = { ok: true; reading: Reading } | { ok: false; error: string };

/** The provider is not usable at all — said in words (a Codex guard on a machine without Codex). */
const NOT_CONNECTED: Record<string, string> = {
  not_installed: "провайдер не установлен в bb",
  unauthenticated: "нет входа в аккаунт провайдера",
  expired: "вход в аккаунт провайдера истёк — войти заново",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pickWeekly(response: unknown, providerId = "claude-code"): WeeklyPick {
  if (!isRecord(response)) return { ok: false, error: "usageLimits: пустой ответ" };
  const entry = response[providerId];
  if (!isRecord(entry)) return { ok: false, error: `usageLimits: нет данных ${providerId}` };
  if (entry.status !== "ok") {
    const message = typeof entry.message === "string" ? `: ${entry.message}` : "";
    const words = NOT_CONNECTED[String(entry.status)];
    const prefix = words === undefined ? "" : `${words} · `;
    return { ok: false, error: `usageLimits ${providerId}: ${prefix}status=${String(entry.status)}${message}` };
  }
  const windows = Array.isArray(entry.windows) ? entry.windows : [];
  for (const window of windows) {
    if (!isRecord(window)) continue;
    if (window.kind !== "weekly" || (window.model !== undefined && window.model !== null && window.model !== "")) continue;
    const percent = window.usedPercent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      return { ok: false, error: "usageLimits: у недельного окна нет usedPercent" };
    }
    const resetsAt = typeof window.resetsAt === "string" && window.resetsAt !== "" ? window.resetsAt : null;
    return { ok: true, reading: { percent, resetsAt } };
  }
  return { ok: false, error: `usageLimits: нет недельного окна (kind=weekly, без model) у ${providerId}` };
}
