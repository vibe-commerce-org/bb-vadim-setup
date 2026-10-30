// The «Пульт» page and the «Пульт» side-panel tab: one frame — a sticky header
// with the tabs «Лента», «Приоритеты», «Ход за тобой», «Карта» and the scan
// line, then the body of the active tab. «Лента» comes first and opens by
// default (lib/tabs.ts).
// - The page routes its tabs through subPath, so the browser's back button
//   walks them; the scroll position of each tab survives «Открыть тред» →
//   назад (sessionStorage).
// - The side panel (thread and New thread screen) shows the whole plugin the
//   same way, its tab kept in sessionStorage; a thread's panel has one more
//   tab, «Этот тред» (the old panel: this thread's state and its project).
// The queue comes from the window's shared cache, so coming back draws the
// list at once.
import { useRef, type ReactNode } from "react";
import {
  useBbNavigate,
  type PluginNavPanelProps,
  type PluginNewThreadPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import {
  announceLocalChange,
  useGuard,
  useNow,
  usePultRpc,
  useQueue,
  useQueueState,
  type ScanInfo,
} from "@/hooks/usePult";
import { useScrollMemory, useSessionState } from "@/hooks/useSessionState";
import { formatAgo, plural } from "@/lib/format";
import { TAB_ORDER, TAB_SUB_PATH, tabOf, type Tab } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { TAP } from "./bits";
import { FeedView } from "./feed-view";
import { MapView } from "./map-view";
import { PanelView } from "./panel-view";
import { PrioritiesView } from "./priorities-view";
import { QueueView } from "./queue-view";

interface TabItem {
  id: string;
  label: string;
  count: number | null;
}

/** The side panel's extra tab in a thread: what the old «Пульт» panel showed. */
const THREAD_TAB = "thread";

function ScanLine({ scan, onRefresh, busy }: { scan: ScanInfo | null; onRefresh: () => void; busy: boolean }) {
  const now = useNow();
  const scanning = busy || scan?.scanning === true;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        {scan === null
          ? "загружаю…"
          : scanning
            ? "проверяю треды…"
            : scan.scannedAt === null
              ? "треды ещё не проверялись"
              : `обновлено ${formatAgo(scan.scannedAt, now)}`}
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={scanning}
        className="inline-flex cursor-pointer items-center gap-1 text-foreground hover:underline disabled:cursor-default disabled:opacity-50 max-md:pointer-coarse:min-h-10 max-md:pointer-coarse:px-2 max-md:pointer-coarse:text-sm"
      >
        <Icon name="RotateCcw" className={cn("size-3.5", scanning && "animate-spin")} />
        Обновить
      </button>
    </div>
  );
}

/** The four tabs with the queue size on «Ход за тобой». */
function useTabItems(): TabItem[] {
  const total = useQueueState().total;
  const labels: Record<Tab, { label: string; count: number | null }> = {
    feed: { label: "Лента", count: null },
    priorities: { label: "Приоритеты", count: null },
    queue: { label: "Ход за тобой", count: total },
    map: { label: "Карта", count: null },
  };
  return TAB_ORDER.map((id) => ({ id, ...labels[id] }));
}

function TabBody({ tab }: { tab: Tab }) {
  const queue = useQueue();
  switch (tab) {
    case "feed":
      return <FeedView />;
    case "priorities":
      return <PrioritiesView />;
    case "queue":
      return <QueueView live={queue} />;
    case "map":
      return <MapView />;
  }
}

interface FrameProps {
  items: readonly TabItem[];
  active: string;
  onSelect: (id: string) => void;
  /** Key of the remembered scroll position. */
  scrollKey: string;
  /** Tailwind max-width of the content column. */
  maxWidth: string;
  /** Horizontal padding of the content column. */
  padX: string;
  children: ReactNode;
}

function PultFrame({ items, active, onSelect, scrollKey, maxWidth, padX, children }: FrameProps) {
  const rpc = usePultRpc();
  const queue = useQueue();
  const { busy, run } = useGuard();
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, scrollKey);

  const refresh = () =>
    void run("scan", async () => {
      const result = await rpc.call("scan.run", {});
      announceLocalChange();
      if (result.scanned > 0) toast(`Проверено тредов: ${result.scanned}`);
    });

  return (
    <div ref={scroller} className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-border bg-background">
        <div className={cn("mx-auto box-border w-full pt-2", maxWidth, padX)}>
          <nav className="-mb-px flex gap-0.5 overflow-x-auto md:gap-1" aria-label="Разделы Пульта">
            {items.map((item) => {
              const isActive = item.id === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    if (!isActive) onSelect(item.id);
                  }}
                  className={cn(
                    "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2 text-sm md:px-2.5",
                    TAP,
                    isActive
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                  {item.count === null ? null : (
                    <span
                      className={cn(
                        "rounded-full px-1.5 text-xs tabular-nums",
                        item.count > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
        <div className={cn("mx-auto box-border w-full py-1.5", maxWidth, padX)}>
          <ScanLine scan={queue.data?.scan ?? null} onRefresh={refresh} busy={busy === "scan"} />
        </div>
      </div>
      <div className={cn("mx-auto box-border w-full pb-8 pt-3 md:pt-4", maxWidth, padX)}>{children}</div>
    </div>
  );
}

export function PultPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const items = useTabItems();
  const tab = tabOf(subPath);
  return (
    <PultFrame
      items={items}
      active={tab}
      onSelect={(id) => navigate.toPluginPanel("pult", { subPath: TAB_SUB_PATH[id as Tab] })}
      scrollKey={tab}
      // The feed is a table: it gets the room (the other tabs read better as a narrow column).
      maxWidth={tab === "feed" ? "max-w-6xl" : "max-w-4xl"}
      // A phone gets the whole width (the user, 30.10): 8px, not 16, so a thread's title has room.
      padX="px-2 md:px-5"
    >
      <TabBody tab={tab} />
    </PultFrame>
  );
}

/** The whole plugin in a side panel; «Лента» opens first. `threadId` null on the New thread screen. */
function PanelFrame({ threadId }: { threadId: string | null }) {
  const [saved, setTab] = useSessionState<string>("panel:tab", "feed");
  const base = useTabItems();
  const items = threadId === null ? base : [...base, { id: THREAD_TAB, label: "Этот тред", count: null }];
  const active = items.some((item) => item.id === saved) ? saved : "feed";
  return (
    <PultFrame
      items={items}
      active={active}
      onSelect={setTab}
      scrollKey={`panel:${active}`}
      maxWidth="max-w-none"
      padX="px-3"
    >
      {active === THREAD_TAB && threadId !== null ? <PanelView threadId={threadId} /> : <TabBody tab={active as Tab} />}
    </PultFrame>
  );
}

export function PultThreadPanel({ threadId }: PluginThreadPanelProps) {
  return <PanelFrame threadId={threadId} />;
}

export function PultNewThreadPanel(_props: PluginNewThreadPanelProps) {
  return <PanelFrame threadId={null} />;
}

/**
 * Right side of BB's title bar on the Pult page: the queue size. Shares the
 * page's queue cache; the number also follows PULT_CHANGED payloads at once.
 */
export function QueueBadge(_props: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  useQueue();
  const total = useQueueState().total;
  if (total === null) return null;
  return (
    <button
      type="button"
      onClick={() => navigate.toPluginPanel("pult", { subPath: TAB_SUB_PATH.queue })}
      aria-label={`Ход за тобой: ${total}`}
      title={total === 0 ? "Никто тебя не ждёт" : `Ход за тобой в ${total} ${plural(total, "треде", "тредах", "тредах")}`}
      className={cn(
        "inline-flex h-6 cursor-pointer items-center justify-center gap-1 rounded-full px-2 text-xs tabular-nums max-md:pointer-coarse:h-10 max-md:pointer-coarse:min-w-10 max-md:pointer-coarse:px-3 max-md:pointer-coarse:text-sm",
        total > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      <span className="hidden sm:inline" aria-hidden="true">
        ход за тобой
      </span>
      <span aria-hidden="true">{total}</span>
    </button>
  );
}
