// bb-plugin-pult — backend entry.
//
// «Пульт» answers one question across every BB thread: whose move is it.
// - server/collector.ts reads threads through bb.sdk (full reconcile at load,
//   incremental scan every 5 min, thread events with a 2 s debounce) and
//   classifies them with lib/classify.ts into snapshots in Pult's own SQLite;
// - the user's overlays (snooze / «не нужно» / task link), the inventory seed
//   and the optional LLM triage sit on top;
// - server/tasks.ts maps lanes Now/Next/Later onto BB Tasks priorities;
// - server/git.ts keeps the git state of each project's main checkout.
// Every change publishes PULT_CHANGED { total } so open pages refetch (and the
// badge can take the number straight from the signal).
//
// Safety: text from threads is data only — it is never executed. The backend
// has NO path that writes a message into a thread: plugin RPC and `bb pult`
// are callable by any agent, and a backend threads.send would be recorded as
// The user's own message. Answers are sent by the page itself through the
// browser session (useSdk().threads.send) after an explicit click and
// confirmation by the user.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { buildFeed } from "./lib/feed.ts";
import { buildLanes, threadsToHideOnArchive } from "./lib/lanes.ts";
import { buildMap, type MapProject } from "./lib/map.ts";
import { buildQueue, flatItems, isDismissed, isSnoozed, snoozeUntilProblem } from "./lib/queue.ts";
import type { Queue, QueueItem, ThreadSnapshot, WaitingKind } from "./lib/types.ts";
import { PULT_CHANGED, rpcContract } from "./rpc.ts";
import { MARK_LABEL, registerCli, type CliDeps } from "./server/cli.ts";
import { createCollector } from "./server/collector.ts";
import { createGit } from "./server/git.ts";
import { createLlmTriage, defineLlmSettings } from "./server/llm.ts";
import { importSeedFile } from "./server/seed.ts";
import { createStore, errorText, sleep, timeoutSignal } from "./server/store.ts";
import { createTasks } from "./server/tasks.ts";

/** See the comment at the llm-triage schedule below. */
const LLM_TRIAGE_AVAILABLE = false;
const PUBLISH_DEBOUNCE_MS = 500;
const RPC_SCAN_WAIT_MS = 25_000;
const CLI_SCAN_WAIT_MS = 120_000;

const EMPTY_COUNTS: Record<WaitingKind, number> = {
  approval: 0,
  decision: 0,
  action: 0,
  failed: 0,
  review: 0,
  commit: 0,
};

export default function plugin(bb: BbPluginApi): void {
  const store = createStore(bb);
  store.migrate();

  // ── realtime: one debounced signal for every change ──────────────────
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  function notify(): void {
    if (publishTimer !== null) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      let total = 0;
      try {
        total = currentQueue().total;
      } catch (error) {
        bb.log.warn(`queue build failed: ${errorText(error)}`);
      }
      bb.realtime.publish(PULT_CHANGED, { total });
    }, PUBLISH_DEBOUNCE_MS);
  }

  function currentQueue(now = Date.now()): Queue {
    // Archived snapshots go in too: nesting walks through archived ancestors
    // (buildQueue itself never shows an archived thread).
    return buildQueue(store.listSnapshots({ includeArchived: true }), store.getOverlays(), now);
  }

  function emptyQueue(): Queue {
    return { items: [], stale: [], snoozed: [], dismissed: [], counts: { ...EMPTY_COUNTS }, total: 0 };
  }

  /** Waiting kinds of every thread the queue shows (items, stale, nested subthreads). */
  function visibleWaiting(): Map<string, WaitingKind> {
    return new Map(flatItems(currentQueue()).map((item) => [item.threadId, item.kind]));
  }

  // ── services ─────────────────────────────────────────────────────────
  const settings = defineLlmSettings(bb);
  let llmEnabled = false;
  void settings
    .get()
    .then((values) => {
      llmEnabled = LLM_TRIAGE_AVAILABLE && values.llmTriage;
    })
    .catch(() => undefined);
  settings.onChange((next) => {
    llmEnabled = LLM_TRIAGE_AVAILABLE && next.llmTriage;
    notify();
  });

  const collector = createCollector(bb, store, { onChange: notify });
  const git = createGit(bb, store, { onChange: notify });
  const tasks = createTasks(bb, store, {
    visibleWaiting,
    snapshot: (threadId) => store.getSnapshot(threadId),
    onChange: notify,
  });
  const llm = createLlmTriage(bb, store, settings, collector);

  // ── actions shared by RPC and CLI ────────────────────────────────────
  /** An approval is never hidden (lib/queue.ts); say so instead of a silent no-op. */
  function refuseHidingApproval(threadId: string): void {
    if (store.getSnapshot(threadId)?.classification.kind === "approval") {
      throw new Error("Одобрение нельзя отложить или скрыть: ответьте в треде");
    }
  }

  function snooze(threadId: string, until: number): void {
    store.patchOverlay(threadId, { snoozedUntil: until, snoozedAt: Date.now(), dismissedAt: null });
    notify();
  }
  function dismiss(threadId: string): void {
    store.patchOverlay(threadId, { dismissedAt: Date.now(), snoozedUntil: null, snoozedAt: null });
    notify();
  }
  function restore(threadId: string): void {
    store.patchOverlay(threadId, { dismissedAt: null, snoozedUntil: null, snoozedAt: null });
    notify();
  }

  async function lanes() {
    const now = Date.now();
    const open = await tasks.listOpenTasks();
    const built = buildLanes(open.tasks, store.getLaneMemory(), now);
    // Only a real answer of BB Tasks lists every open task: then memory of
    // the others (closed, deleted) is dropped.
    if (open.available) store.saveLaneMemory(built.memory, { prune: true });
    return { tasksAvailable: open.available, lanes: built.lanes };
  }

  /**
   * After «В архив»: the archived task's waiting threads (and the subthreads
   * in their cards) are dismissed — listed under «Скрыто», back on the
   * agent's next turn. Snoozed ones too, or they would come back when the
   * snooze ends. Only on a real answer of BB Tasks: a thread another open
   * task holds must stay.
   */
  async function hideThreadsOfArchived(taskId: string, threadIds: readonly string[]): Promise<number> {
    if (threadIds.length === 0) return 0;
    const open = await tasks.listOpenTasks();
    if (!open.available) return 0;
    const held = new Set(
      open.tasks.filter((task) => task.id !== taskId).flatMap((task) => task.threads.map((ref) => ref.threadId)),
    );
    const queue = currentQueue();
    const waiting = new Map([...flatItems(queue), ...queue.snoozed].map((item) => [item.threadId, item.kind]));
    const parentOf = new Map(
      store.listSnapshots({ includeArchived: true }).map((s) => [s.threadId, s.parentThreadId]),
    );
    const hide = threadsToHideOnArchive(threadIds, waiting, parentOf, held);
    for (const threadId of hide) dismiss(threadId);
    return hide.length;
  }

  async function projectsForMap(): Promise<MapProject[]> {
    const names = await collector.projectNames();
    return [...names].map(([id, name]) => ({ id, name }));
  }

  /** Top-level cards (items + stale); their nested subthreads ride inside. */
  function cardsOf(queue: Queue): QueueItem[] {
    return [...queue.items, ...queue.stale];
  }

  // ── RPC ──────────────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    "queue.list": () => {
      const status = collector.status();
      return {
        queue: currentQueue(),
        scan: { ...status, llmEnabled, seedAsOf: store.seedAsOf() },
      };
    },

    "queue.snooze": ({ threadId, until }) => {
      const problem = snoozeUntilProblem(until, Date.now());
      if (problem !== null) throw new Error(problem);
      refuseHidingApproval(threadId);
      snooze(threadId, until);
      return { ok: true as const };
    },

    "queue.dismiss": ({ threadId }) => {
      refuseHidingApproval(threadId);
      dismiss(threadId);
      return { ok: true as const };
    },

    "queue.restore": ({ threadId }) => {
      restore(threadId);
      return { ok: true as const };
    },

    "queue.toTask": async ({ threadId, lane, title }) => {
      const taskKey = await tasks.fileThread(threadId, lane, title);
      return { taskKey };
    },

    "scan.run": async ({ full }) => {
      const result = await collector.scanWithin(full === true, RPC_SCAN_WAIT_MS);
      return { scanned: result.scanned };
    },

    "lanes.list": async () => {
      const result = await lanes();
      return { tasksAvailable: result.tasksAvailable, lanes: result.lanes };
    },

    "lanes.move": async ({ taskId, lane }) => {
      await tasks.moveLane(taskId, lane);
      return { ok: true as const };
    },

    "lanes.done": async ({ taskId }) => {
      await tasks.markDone(taskId);
      return { ok: true as const };
    },

    "lanes.archive": async ({ taskId }) => {
      const { threadIds } = await tasks.archive(taskId);
      return { hidden: await hideThreadsOfArchived(taskId, threadIds) };
    },

    "map.get": async ({ openOnly }) => {
      git.refreshInBackground();
      const [projects, open] = await Promise.all([projectsForMap(), tasks.listOpenTasks()]);
      const states = git.states();
      let gitCheckedAt: number | null = null;
      for (const state of states.values()) gitCheckedAt = Math.max(gitCheckedAt ?? 0, state.checkedAt);
      return {
        projects: buildMap(projects, store.listSnapshots(), open.tasks, states, Date.now(), openOnly, store.getOverlays()),
        gitCheckedAt,
      };
    },

    "feed.list": () => {
      const now = Date.now();
      const overlays = store.getOverlays();
      const hidden = (s: ThreadSnapshot): boolean => {
        const o = overlays.get(s.threadId);
        return isDismissed(s, o) || isSnoozed(s, o, now);
      };
      // Archived snapshots go in too: they only name a subthread's parent.
      return { rows: buildFeed(store.listSnapshots({ includeArchived: true }), hidden) };
    },

    "marks.list": () => {
      let queue: Queue;
      try {
        queue = currentQueue();
      } catch (error) {
        bb.log.warn(`marks: queue build failed: ${errorText(error)}`);
        queue = emptyQueue();
      }
      return {
        // Every waiting thread gets its mark, subthreads nested in a card too.
        marks: flatItems(queue).map((item) => ({
          threadId: item.threadId,
          kind: item.kind,
          label: MARK_LABEL[item.kind],
        })),
      };
    },

    "panel.forThread": async ({ threadId }) => {
      const snapshot = store.getSnapshot(threadId);
      let projectId = snapshot?.projectId ?? null;
      let projectName = snapshot?.projectName ?? null;
      if (projectId === null) {
        try {
          const thread = await bb.sdk.threads.get({ threadId, signal: timeoutSignal(10_000) });
          projectId = thread.projectId;
          projectName = (await collector.projectNames()).get(thread.projectId) ?? null;
        } catch (error) {
          bb.log.warn(`panel: threads.get ${threadId} failed: ${errorText(error)}`);
        }
        collector.schedule(threadId, { delayMs: 0 });
      }
      git.refreshInBackground();
      // This thread's own item first (it carries options and the reply
      // template), then the rest of the project's queue.
      const items =
        projectId === null
          ? []
          : cardsOf(currentQueue())
              .filter((item) => item.projectId === projectId)
              .sort((a, b) => Number(b.threadId === threadId) - Number(a.threadId === threadId));
      const c = snapshot?.classification ?? null;
      return {
        projectId,
        projectName,
        thisThread:
          c === null ? null : { kind: c.kind, ask: c.ask, source: c.source, confidence: c.confidence },
        items,
        git: projectId === null ? null : (git.states().get(projectId) ?? null),
      };
    },
  });

  // ── CLI ──────────────────────────────────────────────────────────────
  const cliDeps: CliDeps = {
    queue: () => currentQueue(),
    lanes,
    async moveLaneByKey(taskKey, lane) {
      const task = await tasks.getTaskByKey(taskKey);
      if (task === null) throw new Error(`Задача ${taskKey} не найдена. Список: bb pult lanes`);
      const moved = await tasks.moveLane(task.id, lane);
      return { key: moved.key, title: moved.title, priority: moved.priority };
    },
    kindOf: (threadId) => store.getSnapshot(threadId)?.classification.kind ?? null,
    snooze,
    dismiss,
    restore,
    scan: (full) => collector.scanWithin(full, CLI_SCAN_WAIT_MS),
    importSeed: (path, opts) => importSeedFile(store, collector, path, opts),
    explain: (threadId) => {
      const snapshot = store.getSnapshot(threadId);
      const input = store.getStoredInput(threadId);
      // An archived thread's text is not handed out: the user may have archived
      // it for what the agent printed.
      const archived = snapshot?.archived === true;
      return {
        snapshot: snapshot !== null && archived ? { ...snapshot, excerpt: null } : snapshot,
        input:
          input !== null && archived
            ? { ...input, lastAgentText: null, pending: input.pending === null ? null : { ...input.pending, prompt: null } }
            : input,
        seed: store.getSeed(threadId),
        llm: store.getLlm(threadId),
        overlay: store.getOverlay(threadId),
      };
    },
  };
  registerCli(bb, cliDeps);

  // ── events, background, schedules ────────────────────────────────────
  collector.listen();

  bb.background.service("initial-scan", {
    async start(signal) {
      // Rules may have changed since the last load: re-classify what is
      // stored first (no I/O), then reconcile with BB.
      collector.reclassify();
      try {
        await collector.scan({ signal });
      } catch (error) {
        if (!signal.aborted) bb.log.warn(`initial scan failed: ${errorText(error)}`);
      }
      if (!signal.aborted) await git.refresh(false);
      // Stay up until reload so the host does not restart the service.
      while (!signal.aborted) await sleep(60 * 60_000, signal);
    },
  });

  bb.background.schedule("scan", "*/5 * * * *", async () => {
    await collector.scan();
    git.refreshInBackground();
  });

  // LLM triage is compiled out of this build (LLM_TRIAGE_AVAILABLE = false):
  // its hidden claude-code thread inherits the user's Claude Code settings
  // (Read, WebFetch, browser tools allowed), so text injected into another
  // thread could make it read and send out files, and any agent can flip the
  // `llmTriage` setting. Re-enable only after the user decides question 3 of the
  // plan and the worker runs without tools.
  if (LLM_TRIAGE_AVAILABLE) {
    bb.background.schedule("llm-triage", "*/30 * * * *", async () => {
      if (!llmEnabled) return;
      await llm.run();
    });
  }

  bb.onDispose(() => {
    if (publishTimer !== null) clearTimeout(publishTimer);
    collector.dispose();
    git.dispose();
  });
}
