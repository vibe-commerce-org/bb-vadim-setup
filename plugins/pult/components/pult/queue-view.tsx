// «Ход за тобой»: waiting threads grouped by kind in queue order, a project
// filter, and three folded sections — «Застряло (14+ дн.)», «Коммит ждёт «да»»
// and «Отложено». Commit-only items are not moves: they live in their own
// folded group and are left out of the counters (Queue.total excludes them).
// Waiting subthreads come nested inside their parent's card (item.nested).
// Long groups show 20 cards at a time. The project filter, unfolded groups and
// «Показать ещё» live in sessionStorage: they survive «Открыть тред» → назад.
import { useMemo, type ReactNode } from "react";
import type { Live, QueueItemView, QueueList } from "@/hooks/usePult";
import { useSessionState } from "@/hooks/useSessionState";
import { KIND_TITLES } from "@/lib/format";
import { WAITING_KINDS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Collapsible, EmptyState, ErrorLine, TAP, TapButton } from "./bits";
import { QueueCard, SnoozedCard } from "./queue-card";

/** Cards per «Показать ещё» step. */
export const PAGE_SIZE = 20;

/** The first `limit` items (at least one page) of a group, then «Показать ещё». */
function Paged({
  items,
  storageKey,
  render,
}: {
  items: readonly QueueItemView[];
  storageKey: string;
  render: (item: QueueItemView) => ReactNode;
}) {
  const [limit, setLimit] = useSessionState(`limit:${storageKey}`, PAGE_SIZE);
  const shown = items.slice(0, Math.max(PAGE_SIZE, limit));
  const rest = items.length - shown.length;
  return (
    <div className="space-y-3">
      {shown.map(render)}
      {rest > 0 ? (
        <TapButton variant="outline" className="w-full" onClick={() => setLimit(shown.length + PAGE_SIZE)}>
          Показать ещё {Math.min(PAGE_SIZE, rest)} из {rest}
        </TapButton>
      ) : null}
    </div>
  );
}

function ProjectFilter({
  items,
  selected,
  onSelect,
}: {
  items: readonly QueueItemView[];
  selected: string | null;
  onSelect: (projectId: string | null) => void;
}) {
  // Counts top-level items only: nested subthreads ride inside their parent.
  const projects = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; count: number }>();
    for (const item of items) {
      const entry = byId.get(item.projectId);
      if (entry === undefined) byId.set(item.projectId, { id: item.projectId, name: item.projectName, count: 1 });
      else entry.count += 1;
    }
    return [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));
  }, [items]);
  if (projects.length < 2) return null;
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-7 max-w-[14rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs",
      TAP,
      active
        ? "border-foreground bg-foreground text-background"
        : "border-border text-muted-foreground hover:text-foreground",
    );
  return (
    // Narrow screens: one row that scrolls sideways (no visible scrollbar),
    // bled to the page edges; from md up the chips wrap.
    <div
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-x-visible md:px-0 [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label="Фильтр по проектам"
    >
      <button type="button" aria-pressed={selected === null} className={chip(selected === null)} onClick={() => onSelect(null)}>
        Все <span className="tabular-nums">{items.length}</span>
      </button>
      {projects.map((project) => (
        <button
          key={project.id}
          type="button"
          aria-pressed={selected === project.id}
          className={chip(selected === project.id)}
          onClick={() => onSelect(selected === project.id ? null : project.id)}
          title={project.name}
        >
          <span className="truncate">{project.name}</span>
          <span className="tabular-nums">{project.count}</span>
        </button>
      ))}
    </div>
  );
}

export function QueueView({ live }: { live: Live<QueueList> }) {
  const [projectId, setProjectId] = useSessionState<string | null>("queue:project", null);
  const { data, error, receivedAt } = live;

  if (data === null) {
    return error === null ? (
      <EmptyState>Загружаю очередь…</EmptyState>
    ) : (
      <ErrorLine error={error} onRetry={live.refetch} />
    );
  }

  const { queue, scan } = data;
  const at = receivedAt ?? Date.now();
  // Older backends send no seedAsOf: the source line then says «из инвентаризации».
  const seedAsOf = scan.seedAsOf ?? null;
  const card = (item: QueueItemView) => (
    <QueueCard key={item.threadId} item={item} receivedAt={at} seedAsOf={seedAsOf} />
  );
  const isCommit = (item: QueueItemView) => item.kind === "commit";
  // Top-level moves: what the badge counts (queue.total).
  const moves = [...queue.items, ...queue.stale].filter((item) => !isCommit(item));
  // A filter on a project that has left the queue shows everything again.
  const filter = projectId !== null && moves.some((item) => item.projectId === projectId) ? projectId : null;
  const pick = (items: readonly QueueItemView[]) =>
    filter === null ? items : items.filter((item) => item.projectId === filter);
  const items = pick(queue.items.filter((item) => !isCommit(item)));
  const stale = pick(queue.stale.filter((item) => !isCommit(item)));
  const commits = pick([...queue.items, ...queue.stale].filter(isCommit));
  const snoozed = pick(queue.snoozed);
  const dismissed = pick(queue.dismissed);

  return (
    <div className="space-y-4">
      {error === null ? null : <ErrorLine error={error} onRetry={live.refetch} />}
      <ProjectFilter items={moves} selected={filter} onSelect={setProjectId} />

      {moves.length === 0 ? (
        <EmptyState>
          {scan.scannedAt === null
            ? "Пульт ещё не просматривал треды. Нажми «Обновить» вверху."
            : "Ход ни в одном треде не за тобой."}
        </EmptyState>
      ) : null}

      {WAITING_KINDS.filter((kind) => kind !== "commit").map((kind) => {
        const group = items.filter((item) => item.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-labelledby={`pult-kind-${kind}`}>
            <h2 id={`pult-kind-${kind}`} className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
              {KIND_TITLES[kind]}
              <span className="font-normal tabular-nums text-muted-foreground">{group.length}</span>
            </h2>
            <Paged items={group} storageKey={`kind:${kind}`} render={card} />
          </section>
        );
      })}

      {stale.length === 0 ? null : (
        <Collapsible title="Застряло (14+ дн.)" count={stale.length} storageKey="queue:stale">
          <Paged items={stale} storageKey="stale" render={card} />
        </Collapsible>
      )}

      {commits.length === 0 ? null : (
        <Collapsible title={KIND_TITLES.commit} count={commits.length} storageKey="queue:commit">
          <Paged items={commits} storageKey="commit" render={card} />
        </Collapsible>
      )}

      {snoozed.length === 0 ? null : (
        <Collapsible title="Отложено" count={snoozed.length} storageKey="queue:snoozed">
          <Paged
            items={snoozed}
            storageKey="snoozed"
            render={(item) => <SnoozedCard key={item.threadId} item={item} receivedAt={at} />}
          />
        </Collapsible>
      )}

      {dismissed.length === 0 ? null : (
        <Collapsible title="Скрыто «Не нужно»" count={dismissed.length} storageKey="queue:dismissed">
          <Paged
            items={dismissed}
            storageKey="dismissed"
            render={(item) => <SnoozedCard key={item.threadId} item={item} receivedAt={at} />}
          />
        </Collapsible>
      )}
    </div>
  );
}
