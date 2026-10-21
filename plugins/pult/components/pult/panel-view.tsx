// «Пульт» tab in a thread's side panel: whose move it is in this thread, who
// else waits for the user in the same project, and the project's git state.
import { useBbNavigate, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { usePanel, useQueueState, type Live, type PanelData } from "@/hooks/usePult";
import { KIND_TITLES, sourceLabel } from "@/lib/format";
import { isWaitingKind, type Kind, type WaitingKind } from "@/lib/types";
import { ClampedText, EmptyState, ErrorLine, GitBadge, KindChip, TapButton } from "./bits";
import { CompactQueueCard } from "./queue-card";

const NOT_YOURS: Record<Exclude<Kind, WaitingKind>, string> = {
  working: "Ход не за тобой: агент работает.",
  done: "Ход не за тобой: агент закончил, вопросов нет.",
  unknown: "Ход не за тобой — по крайней мере, Пульт не нашёл, чего агент ждёт.",
};

export function PanelView({ threadId }: PluginThreadPanelProps) {
  return <PanelBody threadId={threadId} live={usePanel(threadId)} />;
}

export function PanelBody({ threadId, live }: { threadId: string; live: Live<PanelData> }) {
  const navigate = useBbNavigate();
  const { data, error, receivedAt } = live;
  // The inventory date, when this window has the queue cached (the panel
  // itself does not load the heavy queue.list for it).
  const seedAsOf = useQueueState().data?.scan.seedAsOf ?? null;

  if (data === null) {
    return error === null ? (
      <EmptyState>Загружаю…</EmptyState>
    ) : (
      <ErrorLine error={error} onRetry={live.refetch} />
    );
  }

  const self = data.thisThread;
  // Subthreads may come nested inside their parent's item: list them flat
  // here, keeping only this project's ones.
  const others = data.items
    .flatMap((item) => [
      item,
      ...item.nested.filter((child) => data.projectId === null || child.projectId === data.projectId),
    ])
    .filter((item) => item.threadId !== threadId);
  const at = receivedAt ?? Date.now();

  return (
    <div className="space-y-5 text-sm">
      {error === null ? null : <ErrorLine error={error} onRetry={live.refetch} />}

      <section aria-labelledby="pult-panel-this">
        <h2 id="pult-panel-this" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Этот тред
        </h2>
        {self === null ? (
          <p className="text-muted-foreground">Пульт ещё не разбирал этот тред.</p>
        ) : isWaitingKind(self.kind) ? (
          <div className="space-y-1.5 rounded-md border border-border bg-card p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <KindChip kind={self.kind} />
              <span className="font-medium text-foreground">{KIND_TITLES[self.kind]}</span>
            </div>
            {self.ask === null || self.ask.trim() === "" ? null : <ClampedText text={self.ask} />}
            <p className="text-xs text-muted-foreground">{sourceLabel(self.source, self.confidence, seedAsOf)}</p>
          </div>
        ) : (
          <p className="text-muted-foreground">{NOT_YOURS[self.kind]}</p>
        )}
      </section>

      <section aria-labelledby="pult-panel-project">
        <h2 id="pult-panel-project" className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Ждут тебя в этом проекте{others.length > 0 ? ` · ${others.length}` : ""}
        </h2>
        {data.projectName === null ? null : (
          <p className="mb-2 truncate text-foreground" title={data.projectName}>
            {data.projectName}
          </p>
        )}
        <GitBadge git={data.git} className="mb-2" />
        {others.length === 0 ? (
          <p className="text-muted-foreground">Больше никто.</p>
        ) : (
          <div className="space-y-2">
            {others.map((item) => (
              <CompactQueueCard key={item.threadId} item={item} receivedAt={at} />
            ))}
          </div>
        )}
      </section>

      <TapButton variant="outline" onClick={() => navigate.toPluginPanel("pult")}>
        <Icon name="Gauge" className="size-4" />
        Открыть Пульт
      </TapButton>
    </div>
  );
}
