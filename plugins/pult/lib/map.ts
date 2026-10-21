// Pure: the «Карта» tree — project → tasks → threads, plus threads without a
// task as families (root → children).
import { priorityToLane } from "./lanes.ts";
import { isDismissed, isOpenKind, isSnoozed } from "./queue.ts";
import {
  WAITING_KINDS,
  isWaitingKind,
  type GitState,
  type Kind,
  type Lane,
  type MapNode,
  type Overlay,
  type TaskRecord,
  type ThreadSnapshot,
} from "./types.ts";

export interface MapProject {
  id: string;
  name: string;
}

const CLOSED = new Set(["done", "canceled"]);
const LANE_ORDER: Record<Lane, number> = { now: 0, next: 1, later: 2 };
// Most urgent first: the waiting kinds in queue order, then working.
const URGENCY: Kind[] = [...WAITING_KINDS, "working"];

function urgency(kind: Kind | null): number {
  const i = kind === null ? -1 : URGENCY.indexOf(kind);
  return i === -1 ? URGENCY.length : i;
}

function mostUrgent(kinds: Iterable<Kind | null>): Kind | null {
  let best: Kind | null = null;
  for (const k of kinds) if (k !== null && urgency(k) < urgency(best)) best = k;
  return best !== null && urgency(best) < URGENCY.length ? best : null;
}

function lastActivity(s: ThreadSnapshot): number {
  return Math.max(s.updatedAt, s.lastAgentAt ?? -Infinity, s.lastHumanAt ?? -Infinity);
}

function compareThreadNodes(a: MapNode, b: MapNode): number {
  return (
    urgency(a.kind) - urgency(b.kind) ||
    (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function compareTaskNodes(a: MapNode, b: MapNode): number {
  return (
    LANE_ORDER[a.lane ?? "later"] - LANE_ORDER[b.lane ?? "later"] ||
    b.waiting - a.waiting ||
    (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Sum of the counts of the children plus the node's own contribution. */
function withCounts(node: MapNode, own: { waiting: number; working: number; open: number }): MapNode {
  let { waiting, working, open } = own;
  for (const c of node.children) {
    waiting += c.waiting;
    working += c.working;
    open += c.open;
  }
  return { ...node, waiting, working, open };
}

/**
 * openOnly hides done/unknown threads that have no open descendants and
 * tasks in done/canceled. A thread whose parent waits for the user (counted as
 * below) and which itself neither waits for the user nor is done/unknown (it
 * works) gets blockedByThreadId = parent id. Projects are sorted by
 * waiting desc, then by the newest activity; projects with nothing open are
 * dropped when openOnly.
 *
 * «Waits for the user» means what the queue badge counts: a waiting kind other
 * than «commit», not hidden by «не нужно» / «отложить» (`overlays`, checked
 * at `now`). A hidden thread keeps its own kind on its node but adds nothing
 * to the counts and to the kind of its task and project.
 *
 * Every thread appears once: under the task it is attached to (the first
 * such task), else under its parent (same project), else as the root of a
 * family. Counts: waiting / working threads in the subtree; open = open
 * threads (waiting or working) plus open tasks, the node itself included.
 * Task titles carry the task key: «ORC-3 · Заголовок».
 */
export function buildMap(
  projects: readonly MapProject[],
  snapshots: readonly ThreadSnapshot[],
  tasks: readonly TaskRecord[],
  git: ReadonlyMap<string, GitState>,
  now: number,
  openOnly: boolean,
  overlays: ReadonlyMap<string, Overlay> = new Map(),
): MapNode[] {
  const live = snapshots.filter((s) => !s.archived);
  const byId = new Map(live.map((s) => [s.threadId, s]));

  const hidden = (s: ThreadSnapshot): boolean => {
    const o = overlays.get(s.threadId);
    return isDismissed(s, o) || isSnoozed(s, o, now);
  };
  /** Counted as «ждёт тебя»: the same threads the queue badge counts. */
  const waitsForUser = (s: ThreadSnapshot): boolean => {
    const kind = s.classification.kind;
    return isWaitingKind(kind) && kind !== "commit" && !hidden(s);
  };
  // The kind each thread node passes up to its task and project.
  const passedUp = new Map<string, Kind | null>();
  /** The most urgent kind in a subtree; thread nodes pass up their visible kind only. */
  const kindInside = (node: MapNode): Kind | null =>
    mostUrgent([node.type === "thread" ? (passedUp.get(node.id) ?? null) : node.kind, ...node.children.map(kindInside)]);

  const projectNames = new Map<string, string>(projects.map((p) => [p.id, p.name]));
  for (const s of live) if (!projectNames.has(s.projectId)) projectNames.set(s.projectId, s.projectName);

  const shownTasks = tasks.filter(
    (t) => t.bbProjectId !== null && projectNames.has(t.bbProjectId) && !(openOnly && CLOSED.has(t.status)),
  );
  // Thread → the task it is shown under.
  const taskOf = new Map<string, string>();
  for (const t of shownTasks) {
    for (const ref of t.threads) if (byId.has(ref.threadId) && !taskOf.has(ref.threadId)) taskOf.set(ref.threadId, t.id);
  }

  const children = new Map<string, ThreadSnapshot[]>();
  const parentInProject = (s: ThreadSnapshot) => {
    const p = s.parentThreadId ? byId.get(s.parentThreadId) : undefined;
    return p && p.projectId === s.projectId ? p : undefined;
  };
  for (const s of live) {
    const p = parentInProject(s);
    if (p) children.set(p.threadId, [...(children.get(p.threadId) ?? []), s]);
  }

  const threadNode = (s: ThreadSnapshot, taskId: string | null, seen: Set<string>): MapNode | null => {
    if (seen.has(s.threadId)) return null; // a parent cycle
    seen.add(s.threadId);
    const kids = (children.get(s.threadId) ?? [])
      .filter((c) => (taskOf.get(c.threadId) ?? null) === taskId || !taskOf.has(c.threadId))
      .map((c) => threadNode(c, taskId, seen))
      .filter((n): n is MapNode => n !== null)
      .sort(compareThreadNodes);
    const kind = s.classification.kind;
    const parent = s.parentThreadId ? byId.get(s.parentThreadId) : undefined;
    if (openOnly && !isOpenKind(kind) && kids.length === 0) return null;
    passedUp.set(s.threadId, isWaitingKind(kind) && hidden(s) ? null : kind);
    const node: MapNode = {
      type: "thread",
      id: s.threadId,
      title: s.title,
      kind,
      lane: null,
      ageMs: Math.max(0, now - lastActivity(s)),
      // «Ждёт родителя»: only a thread that runs or idles itself (not waiting
      // for the user, not done/unknown) is held up by a parent waiting for the user.
      blockedByThreadId:
        parent && waitsForUser(parent) && !isWaitingKind(kind) && kind !== "done" && kind !== "unknown"
          ? parent.threadId
          : null,
      git: null,
      waiting: 0,
      working: 0,
      open: 0,
      children: kids,
    };
    return withCounts(node, {
      waiting: waitsForUser(s) ? 1 : 0,
      working: kind === "working" ? 1 : 0,
      open: isOpenKind(kind) ? 1 : 0,
    });
  };

  const result: MapNode[] = [];
  for (const [projectId, name] of projectNames) {
    const taskNodes: MapNode[] = [];
    for (const t of shownTasks.filter((x) => x.bbProjectId === projectId)) {
      const attached = t.threads
        .map((ref) => byId.get(ref.threadId))
        .filter((s): s is ThreadSnapshot => !!s && taskOf.get(s.threadId) === t.id);
      const top = attached.filter((s) => {
        const p = parentInProject(s);
        return !p || taskOf.get(p.threadId) !== t.id;
      });
      const kids = top
        .map((s) => threadNode(s, t.id, new Set()))
        .filter((n): n is MapNode => n !== null)
        .sort(compareThreadNodes);
      const activity = Math.max(t.updatedAt, ...t.threads.map((r) => r.lastActivityAt ?? -Infinity));
      const node: MapNode = {
        type: "task",
        id: t.id,
        title: `${t.key} · ${t.title}`,
        kind: mostUrgent(kids.map((k) => kindInside(k))),
        lane: priorityToLane(t.priority),
        ageMs: Math.max(0, now - activity),
        blockedByThreadId: null,
        git: null,
        waiting: 0,
        working: 0,
        open: 0,
        children: kids,
      };
      taskNodes.push(withCounts(node, { waiting: 0, working: 0, open: CLOSED.has(t.status) ? 0 : 1 }));
    }
    taskNodes.sort(compareTaskNodes);

    const roots = live
      .filter((s) => s.projectId === projectId && !taskOf.has(s.threadId) && !parentInProject(s))
      .map((s) => threadNode(s, null, new Set()))
      .filter((n): n is MapNode => n !== null)
      .sort(compareThreadNodes);

    const kids = [...taskNodes, ...roots];
    if (openOnly && kids.length === 0) continue;
    const ages = kids.map((k) => k.ageMs).filter((a): a is number => a !== null);
    result.push(
      withCounts(
        {
          type: "project",
          id: projectId,
          title: name,
          kind: mostUrgent(kids.map((k) => kindInside(k))),
          lane: null,
          ageMs: ages.length > 0 ? Math.min(...ages) : null,
          blockedByThreadId: null,
          git: git.get(projectId) ?? null,
          waiting: 0,
          working: 0,
          open: 0,
          children: kids,
        },
        { waiting: 0, working: 0, open: 0 },
      ),
    );
  }
  return result.sort(
    (a, b) =>
      b.waiting - a.waiting ||
      (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity) ||
      a.title.localeCompare(b.title, "ru"),
  );
}

