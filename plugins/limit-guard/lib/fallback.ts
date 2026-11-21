// Gemini auto-switch on 429 (plan Ф4) — pure logic, no SDK (server/fallback.ts is the SDK side).
//
// Vertex keeps a capacity pool per model and they empty and refill independently: on 21.11 at 11:43 Neon, Carbon,
// Hydrogen and Argon all answered 429, at 16:00 Neon and Hydrogen were fine while Carbon and Argon still were not.
// So the breaker works per MODEL:
//   - a 429 that survived Pi's own retries (a Pi thread on `google-vertex/<model>`, rate-limit) shuts that model for 30
//     minutes (then 60, 120, 240, 360 on each failed probe);
//   - a thread on a shut model goes to the first model of the chain after it that is not shut, and a failed turn is
//     retried there; when the pause is over one thread goes back as the probe.
// The chain is the author's benchmark order, strongest first (settings `geminiFallbackChain`), only models of one provider.
export const VERTEX_PREFIX = "google-vertex/";
export const DEFAULT_CHAIN: readonly string[] = [
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
  "gemini-4-argon",
  "gemini-3.1-pro-preview",
  "gemini-3.8-flash",
];
export const PAUSES_MIN: readonly number[] = [30, 60, 120, 240, 360];
const MODEL_ID = /^gemini-[a-z0-9.\-]{1,60}$/;
/** Models that take `xhigh` (the Pi override maps it to `high` for Google; the others have no such level at all). */
const XHIGH_OK = new Set(["gemini-4-neon", "gemini-4-hydrogen"]);
const EFFORT_RANK: Record<string, number> = { none: 0, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

/** `google-vertex/gemini-4-neon` → `gemini-4-neon`; a model of another provider → null. */
export function vertexId(model: string | null | undefined): string | null {
  return typeof model === "string" && model.startsWith(VERTEX_PREFIX) ? model.slice(VERTEX_PREFIX.length) : null;
}

export interface Chain {
  chain: string[];
  /** What in the setting did not fit (shown in `status`), null when all is well. */
  problem: string | null;
}

/** The setting is a comma-separated list of model ids, strongest first; anything odd falls back to the default. */
export function parseChain(raw: unknown): Chain {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return { chain: [...DEFAULT_CHAIN], problem: null };
  if (typeof raw !== "string") return { chain: [...DEFAULT_CHAIN], problem: `цепочка Gemini «${String(raw)}» не годится — беру прежнюю` };
  const ids = [...new Set(raw.split(/[,\n;]/).map((id) => id.trim().replace(/^google-vertex\//, "")).filter(Boolean))];
  const bad = ids.filter((id) => !MODEL_ID.test(id));
  if (bad.length > 0 || ids.length < 2) {
    return { chain: [...DEFAULT_CHAIN], problem: `цепочка Gemini не годится (${bad.length > 0 ? `не похоже на id модели: ${bad.slice(0, 3).join(", ")}` : "нужно хотя бы две модели"}) — беру прежнюю` };
  }
  return { chain: ids, problem: null };
}

export interface ModelState {
  /** The pause ends at this moment, ms. */
  until: number;
  /** How many failed probes so far: the pause grows with it. */
  step: number;
  /** The pause is over and one thread is trying the model again. */
  probing: boolean;
}

export interface Breaker {
  /** Shut models by Vertex id without the prefix. */
  open: Record<string, ModelState>;
}

export const EMPTY_BREAKER: Breaker = { open: {} };

export function pauseMinutes(step: number): number {
  return PAUSES_MIN[Math.min(Math.max(step, 0), PAUSES_MIN.length - 1)]!;
}

export interface Recorded {
  breaker: Breaker;
  /** The model this failure shut (or shut again after a failed probe), null when it was shut already. */
  opened: string | null;
}

/** A 429 on `model` (a Vertex id without the prefix) at `now`. */
export function recordFailure(b: Breaker, model: string, now: number): Recorded {
  const held = b.open[model];
  // A failure while the probe runs: the model stays shut for a longer pause.
  if (held !== undefined && held.probing) {
    const step = held.step + 1;
    return { breaker: { open: { ...b.open, [model]: { until: now + pauseMinutes(step) * 60_000, step, probing: false } } }, opened: model };
  }
  if (held !== undefined && held.until > now) return { breaker: b, opened: null };
  const step = held?.step ?? 0;
  return { breaker: { open: { ...b.open, [model]: { until: now + pauseMinutes(step) * 60_000, step, probing: false } } }, opened: model };
}

/** Models shut right now (pause not over). */
export function shutModels(b: Breaker, now: number): Set<string> {
  return new Set(Object.entries(b.open).filter(([, f]) => f.until > now && !f.probing).map(([model]) => model));
}

/** Models whose pause is over and that nobody is probing yet. */
export function dueProbes(b: Breaker, now: number): string[] {
  return Object.entries(b.open).filter(([, f]) => f.until <= now && !f.probing).map(([model]) => model);
}

export function startProbe(b: Breaker, model: string): Breaker {
  const f = b.open[model];
  return f === undefined ? b : { open: { ...b.open, [model]: { ...f, probing: true } } };
}

/** The probe passed: the model works again and its step starts over. */
export function closeModel(b: Breaker, model: string): Breaker {
  const { [model]: _gone, ...rest } = b.open;
  return { open: rest };
}

/**
 * Where a thread on `current` should go: the first model of the chain after it (or from the top when it is not in the
 * chain) that is not shut. `null` — nothing is left.
 */
export function pickTarget(chain: readonly string[], current: string, shut: ReadonlySet<string>): string | null {
  const at = chain.indexOf(current);
  for (let i = at + 1; i < chain.length; i += 1) {
    const id = chain[i]!;
    if (!shut.has(id)) return id;
  }
  return null;
}

/** The first model of the chain that is not shut. */
export function firstAvailable(chain: readonly string[], shut: ReadonlySet<string>): string | null {
  return chain.find((id) => !shut.has(id)) ?? null;
}

/** A thread's effort on the target: `xhigh` only where the model has it, never raised. */
export function capEffort(effort: string | null | undefined, target: string): string | null {
  if (typeof effort !== "string") return null;
  const rank = EFFORT_RANK[effort];
  if (rank === undefined) return effort;
  const ceiling = XHIGH_OK.has(target) ? EFFORT_RANK.xhigh! : EFFORT_RANK.high!;
  return rank > ceiling ? "high" : effort;
}

/** «12:10» — when the shut family is tried again, Moscow time. */
export function untilText(ms: number): string {
  const d = new Date(ms + 3 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
