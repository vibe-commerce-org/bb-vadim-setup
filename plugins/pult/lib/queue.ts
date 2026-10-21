// Pure: builds the «Ход за тобой» queue from snapshots and the user's overlays.
import { tail } from "./marker.ts";
import {
  WAITING_KINDS,
  isWaitingKind,
  type AgeBucket,
  type Kind,
  type Overlay,
  type Queue,
  type QueueItem,
  type ThreadSnapshot,
  type WaitingKind,
} from "./types.ts";

export const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** The longest snooze Pult accepts, from any caller. */
export const MAX_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/** A queue item carries the end of the agent's text only without an ask, this long at most. */
export const QUEUE_EXCERPT_CHARS = 600;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function ageBucket(ageMs: number): AgeBucket {
  if (ageMs < DAY_MS) return "fresh";
  if (ageMs < 7 * DAY_MS) return "day";
  if (ageMs < STALE_AFTER_MS) return "week";
  return "stale";
}

/** When the agent last moved in the thread: its last turn, else the last update. */
export function agentMovedAt(s: ThreadSnapshot): number {
  return s.lastAgentAt ?? s.updatedAt;
}

/** A thread counts as open while it waits for the user or the agent works. */
export function isOpenKind(kind: Kind): boolean {
  return kind === "working" || isWaitingKind(kind);
}

/**
 * Whether an overlay set at `at` (ms) may still hide the thread. Never for an
 * approval: BB blocks the agent on it in the middle of a turn, so no new
 * agent turn will ever come to lift the overlay. Never once the user himself
 * wrote into the thread after it: the thread is back in work by his will.
 */
function overlayHolds(s: ThreadSnapshot, at: number): boolean {
  if (s.classification.kind === "approval") return false;
  return s.lastHumanAt === null || s.lastHumanAt <= at;
}

/** «Не нужно» holds until the agent (or the user) writes again after it. */
export function isDismissed(s: ThreadSnapshot, o: Overlay | undefined): boolean {
  if (!o || o.dismissedAt === null || !overlayHolds(s, o.dismissedAt)) return false;
  return o.dismissedAt >= agentMovedAt(s);
}

/** A snooze holds until its time or until the agent (or the user) writes again after it. */
export function isSnoozed(s: ThreadSnapshot, o: Overlay | undefined, now: number): boolean {
  if (!o || o.snoozedUntil === null || o.snoozedUntil <= now) return false;
  if (o.snoozedAt === null) return s.classification.kind !== "approval";
  if (!overlayHolds(s, o.snoozedAt)) return false;
  return agentMovedAt(s) <= o.snoozedAt;
}

/** Why `until` is not an acceptable snooze end (Russian, for the caller), or null. */
export function snoozeUntilProblem(until: number, now: number): string | null {
  if (!Number.isFinite(until) || until <= now) return "Срок отложения уже прошёл";
  if (until > now + MAX_SNOOZE_MS) return "Отложить можно не больше чем на 30 дней";
  return null;
}

/**
 * Every waiting item the queue shows: top-level items, stale ones and the
 * subthreads nested in their cards. Use it wherever «all threads waiting for
 * the user» is meant (row marks, task lanes), never `items` alone.
 */
export function flatItems(queue: Pick<Queue, "items" | "stale">): QueueItem[] {
  return [...queue.items, ...queue.stale].flatMap((item) => [item, ...item.nested]);
}

const KIND_ORDER = new Map<string, number>(WAITING_KINDS.map((k, i) => [k, i]));

function compareItems(a: QueueItem, b: QueueItem): number {
  const kind = KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!;
  if (kind !== 0) return kind;
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due < b.due ? -1 : 1;
  }
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  // Newest agent turn first: ageMs is measured from it (or from the update).
  if (a.ageMs !== b.ageMs) return a.ageMs - b.ageMs;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/** Order inside a card's `nested`: kind order, then the newest agent turn first. */
function compareNested(a: QueueItem, b: QueueItem): number {
  const kind = KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!;
  if (kind !== 0) return kind;
  if (a.ageMs !== b.ageMs) return a.ageMs - b.ageMs;
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
}

/**
 * Visible: waiting kind, not archived, not dismissed (dismissedAt ≥ the
 * agent's last turn), not snoozed (snoozedUntil > now and no agent turn after
 * snoozedAt). Overlays never hide an approval and lapse once the user wrote into
 * the thread after them. Sort: kind order (WAITING_KINDS), then due date ascending (none
 * last), then pinned first, then the agent's last turn newest first.
 * Items 14+ days old go to `stale`; active snoozes go to `snoozed` (flat).
 *
 * Nesting: a visible waiting thread whose ancestor (walking parentThreadId
 * through all snapshots, archived and non-waiting ones included) is itself a
 * top-level visible item goes into the `nested` of the nearest such ancestor
 * instead of the top level — one level deep, so a grandchild under a nested
 * child lands in the top-level card too. A «commit» item does not take
 * children: it sits in a collapsed group and is not counted, so a real ask
 * under it must stay visible. `counts` and `total` cover the top level only;
 * `total` leaves out «commit».
 */
export function buildQueue(
  snapshots: readonly ThreadSnapshot[],
  overlays: ReadonlyMap<string, Overlay>,
  now: number,
): Queue {
  const byId = new Map(snapshots.map((s) => [s.threadId, s]));
  const openChildren = new Map<string, number>();
  for (const s of snapshots) {
    if (s.archived || s.parentThreadId === null || !isOpenKind(s.classification.kind)) continue;
    openChildren.set(s.parentThreadId, (openChildren.get(s.parentThreadId) ?? 0) + 1);
  }

  const visible: QueueItem[] = [];
  const snoozed: QueueItem[] = [];
  const dismissed: QueueItem[] = [];
  for (const s of snapshots) {
    const kind = s.classification.kind;
    if (s.archived || !isWaitingKind(kind)) continue;
    const o = overlays.get(s.threadId);
    const hidden = isDismissed(s, o);
    const ageMs = Math.max(0, now - agentMovedAt(s));
    const c = s.classification;
    const item: QueueItem = {
      threadId: s.threadId,
      projectId: s.projectId,
      projectName: s.projectName,
      title: s.title,
      parentThreadId: s.parentThreadId,
      parentTitle: s.parentThreadId ? (byId.get(s.parentThreadId)?.title ?? null) : null,
      kind,
      ask: c.ask,
      options: c.options,
      multi: c.multi,
      replyTemplate: c.replyTemplate,
      due: c.due,
      ageMs,
      ageBucket: ageBucket(ageMs),
      source: c.source,
      confidence: c.confidence,
      pinned: s.pinned,
      taskKey: o?.taskKey ?? null,
      openChildren: openChildren.get(s.threadId) ?? 0,
      // The card shows `ask ?? excerpt`: the text travels only when it is shown.
      excerpt: c.ask === null && s.excerpt !== null ? tail(s.excerpt, QUEUE_EXCERPT_CHARS) : null,
      lastAgentAt: s.lastAgentAt,
      snoozedUntil: null,
      nested: [],
    };
    // Hidden items stay listed: any local agent can call queue.dismiss, so
    // nothing may vanish from the page without a trace.
    if (hidden) dismissed.push(item);
    else if (isSnoozed(s, o, now)) snoozed.push({ ...item, snoozedUntil: o!.snoozedUntil });
    else visible.push(item);
  }

  // The top-level card each visible item sits in (null: it is top-level).
  const visibleById = new Map(visible.map((it) => [it.threadId, it]));
  const hostMemo = new Map<string, string | null>();
  const resolving = new Set<string>();
  const hostOf = (id: string): string | null => {
    const known = hostMemo.get(id);
    if (known !== undefined) return known;
    // An approval blocks its agent mid-turn: it always stays top-level and counted.
    if (visibleById.get(id)?.kind === "approval") {
      hostMemo.set(id, null);
      return null;
    }
    resolving.add(id);
    let host: string | null = null;
    const seen = new Set([id]);
    for (let cur = byId.get(id)?.parentThreadId ?? null; cur !== null && !seen.has(cur); ) {
      seen.add(cur);
      const it = visibleById.get(cur);
      // An ancestor still being resolved is part of a parent cycle: skip it.
      if (it && it.kind !== "commit" && !resolving.has(cur) && hostOf(cur) === null) {
        host = cur;
        break;
      }
      cur = byId.get(cur)?.parentThreadId ?? null;
    }
    resolving.delete(id);
    hostMemo.set(id, host);
    return host;
  };

  const items: QueueItem[] = [];
  const stale: QueueItem[] = [];
  for (const it of visible) {
    if (hostOf(it.threadId) !== null) continue;
    (it.ageMs >= STALE_AFTER_MS ? stale : items).push(it);
  }
  for (const it of visible) {
    const host = hostOf(it.threadId);
    if (host !== null) visibleById.get(host)!.nested.push({ ...it, nested: [] });
  }
  for (const it of [...items, ...stale]) it.nested.sort(compareNested);
  items.sort(compareItems);
  stale.sort(compareItems);
  // Snoozed: the one that wakes first on top.
  snoozed.sort((a, b) => a.snoozedUntil! - b.snoozedUntil! || compareItems(a, b));
  dismissed.sort(compareItems);

  const counts = Object.fromEntries(WAITING_KINDS.map((k) => [k, 0])) as Record<WaitingKind, number>;
  for (const it of [...items, ...stale]) counts[it.kind]++;
  return { items, stale, snoozed, dismissed, counts, total: items.length + stale.length - counts.commit };
}
