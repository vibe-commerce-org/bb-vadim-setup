// «Карта»: project → tasks → threads, plus threads without a task as
// families (parent → children). Projects fold like an accordion; the ones
// that wait for the user come first and start unfolded.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { useMapTree, useNow, type Live, type MapNodeView, type MapTree } from "@/hooks/usePult";
import { KIND_SHORT, LANE_TITLES, formatAge } from "@/lib/format";
import { isWaitingKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Chip, EmptyState, ErrorLine, GitBadge, KindDot } from "./bits";

/** Indentation per family level, capped so deep trees still fit 360px. */
const INDENT_PX = 14;
const MAX_DEPTH = 4;

function ThreadRow({
  node,
  depth,
  extraAgeMs,
  titles,
}: {
  node: MapNodeView;
  depth: number;
  extraAgeMs: number;
  titles: ReadonlyMap<string, string>;
}) {
  const navigate = useBbNavigate();
  const waiting = node.kind !== null && isWaitingKind(node.kind);
  const blockedBy = node.blockedByThreadId === null ? null : titles.get(node.blockedByThreadId) ?? null;
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate.toThread(node.id)}
        style={{ paddingLeft: 4 + Math.min(depth, MAX_DEPTH) * INDENT_PX }}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded py-1.5 pr-1 text-left text-sm hover:bg-state-hover max-md:pointer-coarse:py-2.5"
      >
        {depth > 0 ? (
          <Icon name="CornerDownRight" className="size-3 shrink-0 text-muted-foreground" />
        ) : null}
        <KindDot kind={node.kind} />
        <span className={cn("min-w-0 flex-1 truncate", waiting ? "font-medium text-foreground" : "text-foreground")}>
          {node.title}
        </span>
        {node.blockedByThreadId === null ? null : (
          <Chip
            className="hidden shrink-0 text-muted-foreground sm:inline-flex"
            title={blockedBy === null ? undefined : `Ждёт родителя: ${blockedBy}`}
          >
            ждёт родителя
          </Chip>
        )}
        {node.kind === null || node.kind === "unknown" ? null : (
          <span className={cn("shrink-0 text-xs", waiting ? "text-destructive" : "text-muted-foreground")}>
            {KIND_SHORT[node.kind]}
          </span>
        )}
        {node.ageMs === null ? null : (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatAge(node.ageMs + extraAgeMs)}
          </span>
        )}
      </button>
      {node.blockedByThreadId === null ? null : (
        <p
          className="text-xs text-muted-foreground sm:hidden"
          style={{ paddingLeft: 4 + Math.min(depth, MAX_DEPTH) * INDENT_PX + 20 }}
        >
          ждёт родителя
        </p>
      )}
      {node.children.length === 0 ? null : (
        <ul>
          {node.children.map((child) => (
            <ThreadRow key={child.id} node={child} depth={depth + 1} extraAgeMs={extraAgeMs} titles={titles} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskBlock({
  node,
  extraAgeMs,
  titles,
}: {
  node: MapNodeView;
  extraAgeMs: number;
  titles: ReadonlyMap<string, string>;
}) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {node.lane === null ? null : (
          <Chip className={cn(node.lane === "now" ? "border-foreground text-foreground" : "text-muted-foreground")}>
            {LANE_TITLES[node.lane]}
          </Chip>
        )}
        <KindDot kind={node.kind} />
        <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">{node.title}</span>
      </div>
      {node.children.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Тредов нет</p>
      ) : (
        <ul className="mt-1">
          {node.children.map((child) => (
            <ThreadRow key={child.id} node={child} depth={0} extraAgeMs={extraAgeMs} titles={titles} />
          ))}
        </ul>
      )}
    </div>
  );
}

function summary(node: MapNodeView): string {
  return `ждут тебя ${node.waiting} · работают ${node.working} · открыто ${node.open}`;
}

function ProjectSection({
  node,
  open,
  onToggle,
  extraAgeMs,
}: {
  node: MapNodeView;
  open: boolean;
  onToggle: () => void;
  extraAgeMs: number;
}) {
  const tasks = node.children.filter((child) => child.type === "task");
  const threads = node.children.filter((child) => child.type === "thread");
  const titles = new Map<string, string>();
  const collect = (items: readonly MapNodeView[]) => {
    for (const item of items) {
      if (item.type === "thread") titles.set(item.id, item.title);
      collect(item.children);
    }
  };
  if (open) collect(node.children);
  const bodyId = `pult-map-${node.id}`;
  return (
    <section className="rounded-lg border border-border bg-card text-card-foreground">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-lg p-3 text-left hover:bg-state-hover"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <KindDot kind={node.waiting > 0 ? node.kind : null} />
            <span className="truncate text-sm font-semibold text-foreground">{node.title}</span>
          </span>
          <span className={cn("mt-0.5 block text-xs", node.waiting > 0 ? "text-destructive" : "text-muted-foreground")}>
            {summary(node)}
          </span>
          <GitBadge git={node.git} className="mt-1.5" />
        </span>
      </button>
      {open ? (
        <div id={bodyId} className="space-y-3 border-t border-border p-3">
          {tasks.length === 0 ? null : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <TaskBlock key={task.id} node={task} extraAgeMs={extraAgeMs} titles={titles} />
              ))}
            </div>
          )}
          {threads.length === 0 ? null : (
            <div>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Треды без задачи
              </h3>
              <ul>
                {threads.map((thread) => (
                  <ThreadRow key={thread.id} node={thread} depth={0} extraAgeMs={extraAgeMs} titles={titles} />
                ))}
              </ul>
            </div>
          )}
          {tasks.length === 0 && threads.length === 0 ? (
            <p className="text-sm text-muted-foreground">Пусто</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function MapView() {
  const now = useNow();
  const [openOnly, setOpenOnly] = useState(true);
  const live = useMapTree(openOnly);
  return <MapBody live={live} now={now} openOnly={openOnly} onOpenOnlyChange={setOpenOnly} />;
}

export function MapBody({
  live,
  now,
  openOnly,
  onOpenOnlyChange,
}: {
  live: Live<MapTree>;
  now: number;
  openOnly: boolean;
  onOpenOnlyChange: (openOnly: boolean) => void;
}) {
  // null = default (projects that wait for the user are unfolded).
  const [unfolded, setUnfolded] = useState<ReadonlySet<string> | null>(null);
  const { data, error, receivedAt } = live;
  const extraAgeMs = Math.max(0, now - (receivedAt ?? now));

  const projects = data?.projects ?? [];
  const effective =
    unfolded ?? new Set(projects.filter((project) => project.waiting > 0).map((project) => project.id));
  const toggle = (id: string) => {
    const next = new Set(effective);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setUnfolded(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground max-md:pointer-coarse:py-2">
          <Checkbox checked={openOnly} onCheckedChange={(checked) => onOpenOnlyChange(checked === true)} />
          Только открытые
        </label>
        {projects.length === 0 ? null : (
          <button
            type="button"
            className="cursor-pointer text-xs text-muted-foreground hover:text-foreground max-md:pointer-coarse:py-2 max-md:pointer-coarse:text-sm"
            onClick={() =>
              setUnfolded(effective.size > 0 ? new Set() : new Set(projects.map((project) => project.id)))
            }
          >
            {effective.size > 0 ? "Свернуть все" : "Развернуть все"}
          </button>
        )}
      </div>
      {error === null ? null : <ErrorLine error={error} onRetry={live.refetch} />}
      {data === null ? (
        error === null ? <EmptyState>Загружаю карту…</EmptyState> : null
      ) : projects.length === 0 ? (
        <EmptyState>{openOnly ? "Открытых тредов и задач нет." : "Тредов пока нет."}</EmptyState>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <ProjectSection
              key={project.id}
              node={project}
              open={effective.has(project.id)}
              onToggle={() => toggle(project.id)}
              extraAgeMs={extraAgeMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
