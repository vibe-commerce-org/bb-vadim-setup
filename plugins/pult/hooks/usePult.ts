// Data hooks of Pult's UI. Every view reads one RPC call, refetched on the
// backend's PULT_CHANGED signal, on a local mutation, and after the realtime
// connection comes back (signals are not replayed). A signal that lands while
// a request is in flight is kept and answered with one trailing refetch, so a
// burst never gets lost and never storms. The queue is special: the page, the
// title-bar badge and the row-mark bridge share one cache (queueStore), so a
// signal costs one queue.list per window.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginRpcClient,
  type PluginRpcResult,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
// Type-only: the frontend must not bundle zod or the server SDK.
import type * as Rpc from "@/rpc";
import { createQueueStore, type QueueStoreState, type SentReply } from "./queue-store";

export type PultContract = typeof Rpc.rpcContract;
export type RpcOut<M extends keyof PultContract> = PluginRpcResult<PultContract[M]>;

export type QueueList = RpcOut<"queue.list">;
export type QueueItemView = QueueList["queue"]["items"][number];
export type ScanInfo = QueueList["scan"];
export type LanesList = RpcOut<"lanes.list">;
export type LaneTaskView = LanesList["lanes"]["now"][number];
export type MapTree = RpcOut<"map.get">;
export type MapNodeView = MapTree["projects"][number];
export type FeedList = RpcOut<"feed.list">;
export type FeedRowView = FeedList["rows"][number];
export type PanelData = RpcOut<"panel.forThread">;
export type GitStateView = NonNullable<PanelData["git"]>;
export type MarksList = RpcOut<"marks.list">;

/** Mirrors rpc.ts; the annotation fails to compile if the two drift apart. */
export const PULT_CHANGED: typeof Rpc.PULT_CHANGED = "pult:changed";

const localChanges = new EventTarget();

/** Tell every mounted view to refetch now (after a mutation from this window). */
export function announceLocalChange(): void {
  localChanges.dispatchEvent(new Event("change"));
}

export function usePultRpc(): PluginRpcClient<PultContract> {
  return useRpc<PultContract>();
}

export function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return String(cause);
}

export interface Live<T> {
  data: T | null;
  error: string | null;
  /** True while a request runs (first load or refresh). */
  busy: boolean;
  /** Client time (ms) the current data arrived; ages are counted from it. */
  receivedAt: number | null;
  refetch: () => void;
}

/**
 * One live RPC read. `key` names the request with its parameters (e.g.
 * "map:true"): a new key refetches and results of older keys are dropped.
 * `load` may be a fresh closure every render. Pass key null to stay idle.
 */
export function useLive<T>(key: string | null, load: () => Promise<T>): Live<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const keyRef = useRef(key);
  const loadRef = useRef(load);
  keyRef.current = key;
  loadRef.current = load;
  const inflight = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);

  const refetch = useCallback(() => {
    const requestKey = keyRef.current;
    if (requestKey === null) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    setBusy(true);
    loadRef
      .current()
      .then(
        (result) => {
          if (!alive.current || keyRef.current !== requestKey) return;
          setData(result);
          setError(null);
          setReceivedAt(Date.now());
        },
        (cause: unknown) => {
          if (!alive.current || keyRef.current !== requestKey) return;
          setError(errorText(cause));
        },
      )
      .finally(() => {
        inflight.current = false;
        if (!alive.current) return;
        if (again.current || keyRef.current !== requestKey) {
          again.current = false;
          refetch();
          return;
        }
        setBusy(false);
      });
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    refetch();
  }, [key, refetch]);

  useRealtime(PULT_CHANGED, refetch);
  useRefetchTriggers(refetch);

  return { data, error, busy, receivedAt, refetch };
}

/** Local mutations, and every transition into "connected", call `refetch`. */
function useRefetchTriggers(refetch: () => void): void {
  useEffect(() => {
    const onChange = () => refetch();
    localChanges.addEventListener("change", onChange);
    return () => localChanges.removeEventListener("change", onChange);
  }, [refetch]);

  // Signals sent while the socket was down (or before it first came up) are
  // never replayed.
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    const was = previous.current;
    previous.current = connection;
    if (connection === "connected" && was !== "connected") refetch();
  }, [connection, refetch]);
}

/** The one queue.list cache of this window (see hooks/queue-store.ts). */
export const queueStore = createQueueStore<QueueList>();

/** Reads the shared queue state without keeping it fresh (the bridge, cards). */
export function useQueueState(): QueueStoreState<QueueList> {
  return useSyncExternalStore(queueStore.subscribe, queueStore.getState, queueStore.getState);
}

/** The local record of a reply sent to this thread from this window, if any. */
export function useSentReply(threadId: string): SentReply | undefined {
  const read = () => queueStore.getState().sent.get(threadId);
  return useSyncExternalStore(queueStore.subscribe, read, read);
}

/**
 * The «Ход за тобой» queue, kept fresh while the calling view is mounted.
 * Every caller shares one cache and one request per signal.
 */
export function useQueue(): Live<QueueList> {
  const rpc = usePultRpc();
  const loadRef = useRef(() => rpc.call("queue.list"));
  loadRef.current = () => rpc.call("queue.list");
  useEffect(() => queueStore.retain(() => loadRef.current()), []);
  useRealtime(PULT_CHANGED, queueStore.signal);
  useRefetchTriggers(queueStore.refetch);
  const state = useQueueState();
  return {
    data: state.data,
    error: state.error,
    busy: state.busy,
    receivedAt: state.receivedAt,
    refetch: queueStore.refetch,
  };
}

export function useLanes(): Live<LanesList> {
  const rpc = usePultRpc();
  return useLive("lanes", () => rpc.call("lanes.list"));
}

export function useMapTree(openOnly: boolean): Live<MapTree> {
  const rpc = usePultRpc();
  return useLive(`map:${openOnly}`, () => rpc.call("map.get", { openOnly }));
}

export function useFeed(): Live<FeedList> {
  const rpc = usePultRpc();
  return useLive("feed", () => rpc.call("feed.list"));
}

export function usePanel(threadId: string): Live<PanelData> {
  const rpc = usePultRpc();
  return useLive(`panel:${threadId}`, () => rpc.call("panel.forThread", { threadId }));
}

/** marks.list; idle while `enabled` is false. */
export function useMarks(enabled = true): Live<MarksList> {
  const rpc = usePultRpc();
  return useLive(enabled ? "marks" : null, () => rpc.call("marks.list"));
}

// One ticking clock per interval for the whole window: every age chip reads
// it, so a tick re-renders the small chips and nothing else.
interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}
const clocks = new Map<number, Clock>();

function clockOf(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (clock === undefined) {
    clock = { now: Date.now(), listeners: new Set(), timer: null };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/** Current time, re-read every `intervalMs` so ages and "N мин назад" move. */
export function useNow(intervalMs = 30_000): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      const clock = clockOf(intervalMs);
      clock.listeners.add(listener);
      if (clock.timer === null) {
        clock.now = Date.now();
        clock.timer = setInterval(() => {
          clock.now = Date.now();
          for (const notify of [...clock.listeners]) notify();
        }, intervalMs);
      }
      return () => {
        clock.listeners.delete(listener);
        if (clock.listeners.size === 0 && clock.timer !== null) {
          clearInterval(clock.timer);
          clock.timer = null;
        }
      };
    },
    [intervalMs],
  );
  const read = () => clockOf(intervalMs).now;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Double-tap guard for actions: while one action of this owner runs, every
 * other call is ignored. Errors become a toast; the result is undefined then.
 */
export function useGuard(): {
  busy: string | null;
  run: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
} {
  const busyRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, action: () => Promise<T>) => {
    if (busyRef.current !== null) return undefined;
    busyRef.current = key;
    setBusy(key);
    try {
      return await action();
    } catch (cause) {
      toast.error(`Не получилось: ${errorText(cause)}`);
      return undefined;
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  }, []);
  return { busy, run };
}
