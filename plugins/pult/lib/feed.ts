// Pure: the «Лента» tab — every active thread as its own row, the newest
// conversation first, and the «Семьями» grouping (a thread with its
// subthreads inside). BB's own thread list always nests a subthread under
// its parent; this is the view where it stands alone, with its parent named.
//
// «Last conversation» is read from the conversation itself (the agent's last
// turn, the user's last message), never from `updatedAt`: BB bumps that on
// model switches, and on 2026-10-15 the limit guard's mass switch to Sonnet
// stamped 296 of 380 threads with one moment.
import { DAY, HOUR, MINUTE } from "./format.ts";
import { isWaitingKind, type Kind, type ThreadSnapshot } from "./types.ts";

/** What became of the thread's parent. */
export type ParentState = "none" | "active" | "archived" | "missing";

export interface FeedRow {
  threadId: string;
  title: string;
  projectName: string;
  /** The agent provider that runs the thread («claude-code», «codex», …): the logo before the title. */
  providerId: string;
  /** The model of the thread's latest turn, as its provider names it («gemini-4-argon»), or null. */
  model: string | null;
  /** The same model as BB names it («Gemini 4 Argon»), or null when its catalog has no name for it. */
  modelLabel: string | null;
  /** Its reasoning level («xhigh», «none», …), or null. */
  effort: string | null;
  /** ms: the later of the agent's last turn and the user's last message. */
  lastAt: number;
  parentThreadId: string | null;
  parentTitle: string | null;
  /** The repository (BB project) of the parent; null without a parent or when it is unknown. */
  parentProjectName: string | null;
  parentState: ParentState;
  /** Shown on the row: a waiting kind (not hidden by snooze / «не нужно») or "working"; else null. */
  kind: Kind | null;
  pinned: boolean;
}

/** The later of the agent's last turn and the user's last message; the creation time when neither is known. */
export function lastConversationAt(
  s: Pick<ThreadSnapshot, "lastAgentAt" | "lastHumanAt" | "createdAt">,
): number {
  if (s.lastAgentAt === null && s.lastHumanAt === null) return s.createdAt;
  return Math.max(s.lastAgentAt ?? -Infinity, s.lastHumanAt ?? -Infinity);
}

function compareRows(a: FeedRow, b: FeedRow): number {
  return b.lastAt - a.lastAt || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);
}

/**
 * One row per active thread, newest conversation first (ties by id).
 * `isHidden` says a waiting thread is snoozed or dismissed in the queue: its
 * kind is then not shown, as on the queue badge. Archived snapshots are
 * only read, to name a subthread's parent.
 */
export function buildFeed(
  snapshots: readonly ThreadSnapshot[],
  isHidden: (s: ThreadSnapshot) => boolean,
): FeedRow[] {
  const byId = new Map(snapshots.map((s) => [s.threadId, s]));
  const rows: FeedRow[] = [];
  for (const s of snapshots) {
    if (s.archived) continue;
    const parent = s.parentThreadId === null ? undefined : byId.get(s.parentThreadId);
    const kind = s.classification.kind;
    rows.push({
      threadId: s.threadId,
      title: s.title,
      projectName: s.projectName,
      providerId: s.providerId,
      model: s.model ?? null,
      modelLabel: s.modelLabel ?? null,
      effort: s.effort ?? null,
      lastAt: lastConversationAt(s),
      parentThreadId: s.parentThreadId,
      parentTitle: parent?.title ?? null,
      parentProjectName: parent?.projectName ?? null,
      parentState:
        s.parentThreadId === null
          ? "none"
          : parent === undefined
            ? "missing"
            : parent.archived
              ? "archived"
              : "active",
      kind: kind === "working" || (isWaitingKind(kind) && !isHidden(s)) ? kind : null,
      pinned: s.pinned,
    });
  }
  return rows.sort(compareRows);
}

/** The «Родитель» cell of a subthread's row: the parent's title, or why there is none; null without a parent. */
export function parentLabel(row: Pick<FeedRow, "parentState" | "parentTitle">): string | null {
  switch (row.parentState) {
    case "none":
      return null;
    case "active":
      return row.parentTitle === null || row.parentTitle === "" ? "Без названия" : row.parentTitle;
    case "archived":
      return "родитель в архиве";
    case "missing":
      return "родитель недоступен";
  }
}

/** How many characters of a repository name a table column shows. */
export const REPO_CHARS = 5;

/**
 * A repository name for a narrow column: without the `_code` suffix every
 * repository of the portfolio ends with, the first `max` characters
 * («fulfillments_code» → «fulfi», «market_web_code» → «marke»).
 * Five characters (the user, 30.10) — the tooltip keeps the whole name.
 *
 * A second word that starts within the first two characters after the cut
 * keeps its first letter, because that letter is what tells two repositories
 * of one family apart: «market_web_code» → «marke_w» while its sibling
 * «marketplace_code» → «marke» (the user, 30.10). A separator further away is
 * not the one the column needs («очень-длинное-название» → «очень»), and a
 * name that fits is left as it is («Shop_code» → «Shop»).
 * Null for a missing or empty name.
 */
export function shortRepo(name: string | null, max = REPO_CHARS): string | null {
  if (name === null) return null;
  const base = name.replace(/_code$/, "");
  if (base === "") return null;
  const chars = Array.from(base);
  if (chars.length <= max) return base;
  // A second word starting just past the cut keeps its first letter: that
  // letter is what tells two repositories of one family apart
  // («market_web_code» → «marke_w», while «marketplace_code» → «marke»).
  const separator = chars.findIndex((char, index) => index > 0 && index < max + 3 && /[-_. ]/.test(char));
  if (separator > 0) {
    const next = chars[separator + 1];
    if (next !== undefined && /\p{L}/u.test(next)) {
      return chars.slice(0, Math.min(max, separator)).join("") + `_${next.toLowerCase()}`;
    }
  }
  return chars.slice(0, max).join("");
}

/**
 * Time since the last conversation for the first column, as short as it can
 * be to keep the column narrow: «<1м», «5м», «3ч», «2д». Days go on past a
 * week (no weeks, no months): «45д». formatAge, with its «мин» and «дн.», stays
 * for the queue, the map and the CLI.
 */
export function feedAge(ms: number): string {
  const value = Math.max(0, ms);
  if (value < MINUTE) return "<1м";
  if (value < HOUR) return `${Math.floor(value / MINUTE)}м`;
  if (value < DAY) return `${Math.floor(value / HOUR)}ч`;
  return `${Math.floor(value / DAY)}д`;
}

/** The repository of the subthread's parent, for the second line of its row; null when it is not known. */
export function parentRepo(row: Pick<FeedRow, "parentProjectName">): string | null {
  return row.parentProjectName === null || row.parentProjectName === "" ? null : row.parentProjectName;
}

export interface FamilyNode {
  row: FeedRow;
  /** The newest conversation in this thread's whole subtree. */
  newestAt: number;
  children: FamilyNode[];
}

/**
 * «Семьями»: a root is a thread whose parent is not an active thread in
 * `rows`; subthreads sit under their parent. Roots and children go by the
 * newest conversation in their subtree. A parent cycle (not expected) cannot
 * hide a thread: what the walk from the roots did not reach comes out as roots.
 */
export function groupFamilies(rows: readonly FeedRow[]): FamilyNode[] {
  const ids = new Set(rows.map((r) => r.threadId));
  const kids = new Map<string, FeedRow[]>();
  const roots: FeedRow[] = [];
  for (const row of rows) {
    if (row.parentThreadId !== null && ids.has(row.parentThreadId)) {
      kids.set(row.parentThreadId, [...(kids.get(row.parentThreadId) ?? []), row]);
    } else {
      roots.push(row);
    }
  }
  const seen = new Set<string>();
  const node = (row: FeedRow): FamilyNode => {
    seen.add(row.threadId);
    const children = (kids.get(row.threadId) ?? []).filter((c) => !seen.has(c.threadId)).map(node);
    children.sort(compareNodes);
    return { row, newestAt: Math.max(row.lastAt, ...children.map((c) => c.newestAt)), children };
  };
  const result = roots.map(node);
  for (const row of rows) if (!seen.has(row.threadId)) result.push(node(row));
  return result.sort(compareNodes);
}

function compareNodes(a: FamilyNode, b: FamilyNode): number {
  return b.newestAt - a.newestAt || compareRows(a.row, b.row);
}

/** Threads in a family, the root included. */
export function familySize(node: FamilyNode): number {
  return 1 + node.children.reduce((sum, child) => sum + familySize(child), 0);
}
