// The «Пульт» page: a sticky header with three tabs (routed through subPath,
// so the browser's back button walks them; «Приоритеты» first and by
// default, lib/tabs.ts) and the scan line, then the body
// of the active tab. The scroll position of each tab survives «Открыть тред»
// → назад (sessionStorage), and the queue comes from the window's shared
// cache, so coming back draws the list at once.
import { useRef } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
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
import { useScrollMemory } from "@/hooks/useSessionState";
import { formatAgo, plural } from "@/lib/format";
import { TAB_ORDER, TAB_SUB_PATH, tabOf, type Tab } from "@/lib/tabs";
import { cn } from "@/lib/utils";
import { TAP } from "./bits";
import { MapView } from "./map-view";
import { PrioritiesView } from "./priorities-view";
import { QueueView } from "./queue-view";

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

export function PultPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const rpc = usePultRpc();
  const queue = useQueue();
  const total = useQueueState().total;
  const { busy, run } = useGuard();
  const tab = tabOf(subPath);
  const scroller = useRef<HTMLDivElement>(null);
  useScrollMemory(scroller, tab);

  const labels: Record<Tab, { label: string; count: number | null }> = {
    priorities: { label: "Приоритеты", count: null },
    queue: { label: "Ход за тобой", count: total },
    map: { label: "Карта", count: null },
  };
  const tabs = TAB_ORDER.map((id) => ({ id, ...labels[id] }));

  const refresh = () =>
    void run("scan", async () => {
      const result = await rpc.call("scan.run", {});
      announceLocalChange();
      if (result.scanned > 0) toast(`Проверено тредов: ${result.scanned}`);
    });

  return (
    <div ref={scroller} className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="mx-auto box-border w-full max-w-4xl px-4 pt-2 md:px-5">
          <nav className="-mb-px flex gap-1 overflow-x-auto" aria-label="Разделы Пульта">
            {tabs.map((item) => {
              const active = item.id === tab;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    if (!active) navigate.toPluginPanel("pult", { subPath: TAB_SUB_PATH[item.id] });
                  }}
                  className={cn(
                    "inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-2.5 text-sm",
                    TAP,
                    active
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
        <div className="mx-auto box-border w-full max-w-4xl px-4 py-1.5 md:px-5">
          <ScanLine scan={queue.data?.scan ?? null} onRefresh={refresh} busy={busy === "scan"} />
        </div>
      </div>
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        {tab === "priorities" ? <PrioritiesView /> : null}
        {tab === "queue" ? <QueueView live={queue} /> : null}
        {tab === "map" ? <MapView /> : null}
      </div>
    </div>
  );
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
