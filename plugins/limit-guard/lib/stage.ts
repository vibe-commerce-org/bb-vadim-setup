// Stages of the limit guard — pure logic, no SDK.
//
// Stage 0: the weekly Claude window is below the Sonnet threshold (85 %).
// Stage 1: at or above it — claude-code threads run on Sonnet xhigh.
// Stage 2: at or above the stop threshold (93 %) and the user has not consented —
//          claude-code work is held and running turns are stopped.
//
// Hysteresis: a stage goes up as soon as the reading crosses a threshold and
// comes down only when the week rolls over (resetsAt changed or passed, and the
// reading is back under the Sonnet threshold). A dip inside the week is noise
// and changes nothing. Consent turns stage 2 into stage 1 until the reset;
// given in advance on stage 1, it keeps stage 2 from coming at all.
//
// Test mode (`bb limit-guard test`) takes the percent from the command instead
// of the reading and has no hysteresis: a percent under the Sonnet threshold is
// a simulated weekly reset.

export type Stage = 0 | 1 | 2;

export interface Thresholds {
  /** From this weekly percent claude-code runs on Sonnet xhigh. */
  sonnet: number;
  /** From this weekly percent claude-code stops until consent. */
  stop: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { sonnet: 85, stop: 93 };

export const SONNET_MODEL = "claude-sonnet-5-5";
export const SONNET_EFFORT = "xhigh";

/** resetsAt values closer than this are the same weekly reset. */
export const WEEK_SHIFT_MS = 60 * 60_000;

export interface Phase {
  stage: Stage;
  /** the user's «continue until the weekly reset» after stage 2. */
  consent: boolean;
  consentAt: number | null;
  /**
   * Start of the 10-minute «one by one» window: set when consent releases
   * stage-2 holds; null when consent came in advance (nothing was held).
   */
  dripFrom: number | null;
  /** resetsAt of the weekly window as last seen. */
  resetsAt: string | null;
}

export const INITIAL_PHASE: Phase = { stage: 0, consent: false, consentAt: null, dripFrom: null, resetsAt: null };

export interface Reading {
  percent: number;
  resetsAt: string | null;
}

export interface Step {
  phase: Phase;
  /** The week rolled over: saved models go back, consent is dropped. */
  reset: boolean;
  /** The stage just entered on the way up (1 or 2), null when none. */
  entered: Stage | null;
}

/** Thresholds from plugin settings; anything odd falls back to 85/93. `word` names the first threshold in the message. */
export function resolveThresholds(sonnet: unknown, stop: unknown, word = "Sonnet"): { thresholds: Thresholds; problem: string | null } {
  const ok =
    typeof sonnet === "number" &&
    typeof stop === "number" &&
    Number.isFinite(sonnet) &&
    Number.isFinite(stop) &&
    sonnet >= 1 &&
    sonnet < stop &&
    stop <= 100;
  if (ok) return { thresholds: { sonnet, stop }, problem: null };
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    problem: `пороги из настроек (${String(sonnet)} / ${String(stop)}) не годятся: нужно 1 ≤ ${word} < стоп ≤ 100 — беру ${DEFAULT_THRESHOLDS.sonnet} / ${DEFAULT_THRESHOLDS.stop}`,
  };
}

/** The stage a percent asks for, before hysteresis. */
export function stageFor(percent: number, t: Thresholds, consent: boolean): Stage {
  if (percent >= t.stop && !consent) return 2;
  if (percent >= t.sonnet) return 1;
  return 0;
}

/**
 * Whether the weekly window rolled over between the stored resetsAt and a new
 * one: the stored reset moment has passed, or resetsAt moved by more than an
 * hour (jitter of a few seconds is the same reset).
 */
export function weekRolledOver(prev: string | null, next: string | null, now: number): boolean {
  if (prev === null) return next !== null;
  const p = Date.parse(prev);
  if (Number.isFinite(p) && now >= p) return true;
  if (next === null) return false;
  const n = Date.parse(next);
  if (!Number.isFinite(p) || !Number.isFinite(n)) return prev !== next;
  return Math.abs(n - p) > WEEK_SHIFT_MS;
}

/** One reading of the real weekly window. */
export function advance(phase: Phase, reading: Reading, t: Thresholds, now: number): Step {
  if (phase.stage > 0 && reading.percent < t.sonnet && weekRolledOver(phase.resetsAt, reading.resetsAt, now)) {
    return { phase: { ...INITIAL_PHASE, resetsAt: reading.resetsAt }, reset: true, entered: null };
  }
  const floor: Stage = phase.consent && phase.stage === 2 ? 1 : phase.stage;
  const target = stageFor(reading.percent, t, phase.consent);
  const stage = (target > floor ? target : floor) as Stage;
  return {
    phase: { ...phase, stage, resetsAt: reading.resetsAt ?? phase.resetsAt },
    reset: false,
    entered: stage > phase.stage ? stage : null,
  };
}

/** Test mode: the stage follows the given percent; under the Sonnet threshold is a simulated reset. */
export function advanceTest(phase: Phase, percent: number, t: Thresholds): Step {
  const target = stageFor(percent, t, phase.consent);
  if (target === 0 && phase.stage > 0) {
    return { phase: { ...INITIAL_PHASE }, reset: true, entered: null };
  }
  return {
    phase: { ...phase, stage: target },
    reset: false,
    entered: target > phase.stage ? target : null,
  };
}

/**
 * the user's consent until the weekly reset. On stage 2 it turns into stage 1 and
 * the held turns go out one by one; on stage 1 it is given in advance — stage 2
 * will not come this week. Stage 0 is refused: nothing to consent to, and a
 * consent there would outlive the weekly reset (a reset is seen only from
 * stage ≥ 1).
 */
export function giveConsent(phase: Phase, now: number): { ok: boolean; phase: Phase } {
  if (phase.stage === 0) return { ok: false, phase };
  if (phase.consent) return { ok: true, phase };
  const drip = phase.stage === 2 ? now : null;
  return { ok: true, phase: { ...phase, stage: 1, consent: true, consentAt: now, dripFrom: drip } };
}

/** Sonnet in any spelling BB accepts: claude-sonnet-*, the `sonnet` alias. */
export function isSonnet(model: string | null | undefined): boolean {
  if (typeof model !== "string") return false;
  return model.startsWith("claude-sonnet") || model === "sonnet" || model.startsWith("sonnet[");
}

/** A turn this model would run is one the guard moves off (null = unknown, left alone). */
export function holdsForModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model !== "" && !isSonnet(model);
}

/** Already on the target execution: Sonnet 5.5 at xhigh. */
export function isTargetExecution(opts: { model: string | null; reasoningLevel: string | null } | null): boolean {
  return opts !== null && opts.model === SONNET_MODEL && opts.reasoningLevel === SONNET_EFFORT;
}

export const STAGE_TITLES: Record<Stage, string> = {
  0: "обычная работа",
  1: "Sonnet xhigh",
  2: "стоп до согласия",
};
