// The `message.dispatch` policy — pure logic, no SDK. One policy per guard
// (Claude Code, Codex — lib/profile.ts): a guard decides only turns of its own
// provider and lets every other turn through.
//
// BB asks every plugin hook before a message reaches a provider; a handler that
// throws or answers later than 10 s FAILS THE SEND in all of BB
// (bb-plugin-sdk.d.ts, PluginHooks.on: «Fail-closed»). So the decision is made
// only from the guard's state in memory, every step is wrapped, and anything
// unexpected answers `proceed` (createDispatchHook below).
//
// Order of the checks:
//   1. another provider, a join into a running turn, a thread outside the test
//      scope, or stage 0                                → proceed
//   2. stage ≥ 1, an execution off the target (Claude: a model other than
//      Sonnet; Codex: a higher effort or another model), the first message of a pending
//      thread not created from the app                  → reject with a hint
//      (core deletes the pending thread and returns 409 to whoever spawned it,
//      thread-create.ts; a held first message could not be re-queued on
//      Sonnet — queuedMessages.create on a thread without a session never
//      dispatches, and recheck only re-attempts plugin-held rows)
//   3. stage 2 without consent                           → wait «ждёт согласия»
//   4. first 10 min after consent and ≥ 2 threads of the
//      provider running                                  → wait «по очереди»
//   5. stage ≥ 1 and an execution off the target         → wait; the row is
//      re-queued on the target by the backend (or stays for Send now when it
//      cannot be: a new thread from the app, a group, a system row)
//   6. otherwise                                         → proceed
import { CLAUDE_GUARD, heldWord, holdsExecution, targetFlags, targetLabel, type GuardInfo } from "./profile.ts";
import type { Stage, Thresholds } from "./stage.ts";

export type DispatchDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string }
  | { action: "reject"; message: string };

/** What the policy needs to know about one dispatch attempt. */
export interface DispatchFacts {
  threadId: string;
  providerId: string;
  model: string | null;
  /** Requested effort; null when core resolves it from the defaults. */
  reasoningLevel?: string | null;
  /** "join-turn" | "start-turn" */
  attempt: string;
  threadStatus: string;
  /** "app" | "cli" | "plugin" | "sdk" | "mixed" | null */
  origin: string | null;
  /** True when no queued rows are re-attempted (someone just sent). */
  inline: boolean;
  /** Threads of the guard's provider running now; only filled in the drip window (the name is from 0.1, Claude only). */
  runningClaude?: number;
}

/** The guard's state as the hook sees it (memory only). */
export interface PolicyView {
  stage: Stage;
  consent: boolean;
  /** Start of the «one by one» window after consent released stage-2 holds (Phase.dripFrom). */
  dripFrom: number | null;
  /** Test mode: only these threads are guarded. null = every thread. */
  scope: ReadonlySet<string> | null;
  thresholds: Thresholds;
  /** Whose policy this is: the provider it guards and the target of stage 1. */
  guard: GuardInfo;
}

export interface Verdict {
  decision: DispatchDecision;
  /** The backend should re-queue this thread's held rows on the target. */
  reseat: boolean;
}

export const CLAUDE_PROVIDER = "claude-code";
/** Every reason and message of the guard starts with this — the backend finds its own rows by it. */
export const MARKER = "Сторож лимитов";
export const DRIP_WINDOW_MS = 10 * 60_000;
export const DRIP_MAX_RUNNING = 2;
/** BB caps a wait reason at 200 characters (QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH). */
export const MAX_REASON = 200;

const PROCEED: Verdict = { decision: { action: "proceed" }, reseat: false };

function cap(text: string): string {
  return text.length <= MAX_REASON ? text : `${text.slice(0, MAX_REASON - 1)}…`;
}

/** Part of the stage-2 reason the backend recognises its stage-2 holds by. */
export const STOP_MARK = "ждёт вашего согласия";

export function stopReason(t: Thresholds, g: GuardInfo = CLAUDE_GUARD): string {
  return cap(`${MARKER} · ${g.profile.weekWord} ≥${t.stop} %: ${STOP_MARK} (bb limit-guard resume${g.profile.cmd})`);
}

export const DRIP_REASON = `${MARKER}: после согласия запускаю треды по очереди`;

export function sonnetReason(t: Thresholds, model: string | null, g: GuardInfo = CLAUDE_GUARD, effort: string | null = null): string {
  return cap(
    `${MARKER} · ${g.profile.weekWord} ≥${t.sonnet} %: ход на ${heldWord(g, model, effort)} придержан и переставляется на ${targetLabel(g.target)}. ${g.profile.overrideTail}`,
  );
}

export function newThreadReason(t: Thresholds, model: string | null, g: GuardInfo = CLAUDE_GUARD, effort: string | null = null): string {
  return cap(
    `${MARKER} · ${g.profile.weekWord} ≥${t.sonnet} %: новый тред на ${heldWord(g, model, effort)} придержан. Нужен он — Send now; иначе создай тред на ${targetLabel(g.target)}`,
  );
}

export function rejectMessage(t: Thresholds, g: GuardInfo = CLAUDE_GUARD): string {
  return `${MARKER}: недельный лимит ${g.profile.title} ≥${t.sonnet} % — повтори с ${targetFlags(g.target)}`;
}

export function inScope(view: Pick<PolicyView, "scope">, threadId: string): boolean {
  return view.scope === null || view.scope.has(threadId);
}

export function inDripWindow(view: Pick<PolicyView, "consent" | "dripFrom">, now: number): boolean {
  return view.consent && view.dripFrom !== null && now >= view.dripFrom && now - view.dripFrom < DRIP_WINDOW_MS;
}

function guarded(f: DispatchFacts, view: PolicyView): boolean {
  return f.providerId === view.guard.profile.providerId && f.attempt !== "join-turn" && inScope(view, f.threadId);
}

/** The hook should count running threads of the provider (an SDK call) only for this. */
export function needsRunningCount(f: DispatchFacts, view: PolicyView, now: number): boolean {
  return guarded(f, view) && view.stage === 1 && inDripWindow(view, now);
}

export function decide(f: DispatchFacts, view: PolicyView, now: number): Verdict {
  if (!guarded(f, view) || view.stage === 0) return PROCEED;
  const g = view.guard;
  const effort = f.reasoningLevel ?? null;
  const offSonnet = holdsExecution(g, f.model, effort);
  const pending = f.threadStatus === "pending";
  if (offSonnet && pending && f.inline && f.origin !== "app") {
    return { decision: { action: "reject", message: rejectMessage(view.thresholds, g) }, reseat: false };
  }
  if (view.stage === 2 && !view.consent) {
    return { decision: { action: "wait", reason: stopReason(view.thresholds, g) }, reseat: offSonnet };
  }
  if (inDripWindow(view, now) && (f.runningClaude ?? 0) >= DRIP_MAX_RUNNING) {
    return { decision: { action: "wait", reason: DRIP_REASON }, reseat: offSonnet && !pending };
  }
  if (offSonnet) {
    if (pending) return { decision: { action: "wait", reason: newThreadReason(view.thresholds, f.model, g, effort) }, reseat: false };
    return { decision: { action: "wait", reason: sonnetReason(view.thresholds, f.model, g, effort) }, reseat: true };
  }
  return PROCEED;
}

/** The fields of MessageDispatchHookContext the policy reads (structural, no SDK import). */
export interface HookContextLike {
  thread: { id: string; status: string };
  requestedExecution: { providerId: string; model: string | null; reasoningLevel?: string | null };
  attempt: string;
  origin: string | null;
  queuedMessages: readonly unknown[];
}

export function factsFromContext(ctx: HookContextLike): DispatchFacts {
  return {
    threadId: ctx.thread.id,
    providerId: ctx.requestedExecution.providerId,
    model: ctx.requestedExecution.model ?? null,
    reasoningLevel: ctx.requestedExecution.reasoningLevel ?? null,
    attempt: ctx.attempt,
    threadStatus: ctx.thread.status,
    origin: ctx.origin ?? null,
    inline: ctx.queuedMessages.length === 0,
  };
}

export interface HookDeps {
  view(): PolicyView;
  /** Resolves when the persisted state is loaded; the hook waits for it at most `readyBudgetMs`. */
  ready(): Promise<void>;
  /** Threads of the guard's provider running now (listRunning + the provider cache + fresh grants). */
  countRunningClaude(): Promise<number>;
  /** A turn was let through in the drip window. */
  onGranted(threadId: string): void;
  /** The thread's held rows should move to the target (called after the decision, never awaited). */
  onReseat(threadId: string): void;
  /** Provider of a thread seen in a dispatch (fills the cache for counting). */
  onSeen(threadId: string, providerId: string): void;
  warn(message: string): void;
  now(): number;
  readyBudgetMs?: number;
  countBudgetMs?: number;
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: нет ответа за ${ms} мс`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The handler registered for `message.dispatch`. Fail-open: any throw, a
 * malformed context, a slow SDK call — the answer is `proceed`.
 */
export function createDispatchHook(deps: HookDeps): (ctx: HookContextLike) => Promise<DispatchDecision> {
  const readyBudget = deps.readyBudgetMs ?? 1_500;
  const countBudget = deps.countBudgetMs ?? 3_000;
  return async (ctx) => {
    try {
      await within(deps.ready(), readyBudget, "загрузка состояния").catch(() => undefined);
      const facts = factsFromContext(ctx);
      deps.onSeen(facts.threadId, facts.providerId);
      const view = deps.view();
      const now = deps.now();
      const counted = needsRunningCount(facts, view, now);
      if (counted) facts.runningClaude = await within(deps.countRunningClaude(), countBudget, "listRunning");
      const verdict = decide(facts, view, now);
      if (verdict.reseat) {
        try {
          deps.onReseat(facts.threadId);
        } catch (error) {
          deps.warn(`hook: reseat не запланирован: ${errorText(error)}`);
        }
      }
      if (counted && verdict.decision.action === "proceed") deps.onGranted(facts.threadId);
      return verdict.decision;
    } catch (error) {
      try {
        deps.warn(`hook: ошибка, пропускаю ход (fail-open): ${errorText(error)}`);
      } catch {
        // logging must not turn fail-open into fail-closed
      }
      return { action: "proceed" };
    }
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
