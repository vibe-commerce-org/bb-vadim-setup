// Glue between Pult and BB's app shell, outside any page:
// - the «Gauge» icon (BB 0.46 has no built-in glyph of that name);
// - row marks «ход за тобой» on BB's own thread list: the content script owns
//   the host setter and polls marks.list every 20 s; the app overlay pushes
//   fresh marks on every PULT_CHANGED through the authenticated RPC client.
//   While the Pult page is open, the window's shared queue cache is fresh
//   anyway: the overlay then derives the marks from it, and neither it nor
//   the content script asks marks.list separately;
// - navigation for the sidebar footer button, whose `run` gets no navigator:
//   the overlay lends its useBbNavigate() through a module variable.
import { useEffect, useRef } from "react";
import {
  useBbNavigate,
  type BbNavigate,
  type PluginComposerThreadRowStatus,
  type PluginContentScriptContext,
} from "@get-bb/plugin-sdk/app";
import { deriveMarks } from "@/hooks/queue-store";
import { useMarks, useQueueState, type MarksList } from "@/hooks/usePult";
import type { WaitingKind } from "@/lib/types";

/** A gauge drawn for Pult (24×24, stroke = currentColor, like BB's glyphs). */
export function GaugeGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3.5 17a8.5 8.5 0 0 1 17 0" />
      <path d="M6.6 11.6l.9.7M12 8.5v1.1M17.4 11.6l-.9.7" />
      <path d="M12 17l3.6-4.6" />
      <circle cx="12" cy="17" r="1.3" />
    </svg>
  );
}

// ---------------------------------------------------------------- navigation

let bbNavigate: BbNavigate | null = null;

/** Open the Pult page from places without hooks (the sidebar footer). */
export function openPultPage(): void {
  if (bbNavigate !== null) {
    bbNavigate.toPluginPanel("pult");
    return;
  }
  window.location.assign("/plugins/pult/pult");
}

// ----------------------------------------------------------------- row marks

type Mark = MarksList["marks"][number];
type RowStatusSetter = (threadId: string, status: PluginComposerThreadRowStatus | null) => void;

const MARK_ICONS: Record<WaitingKind, string> = {
  approval: "SecurityCheck",
  decision: "MessageQuestion",
  action: "UserRound",
  failed: "AlertTriangle",
  review: "Eye",
  commit: "CircleCheck",
};

const MARKS_POLL_MS = 20_000;

let setRowStatus: RowStatusSetter | null = null;
/** True while the overlay draws marks from the shared queue cache. */
let marksFromQueue = false;
/** threadId → signature of the mark currently drawn. */
let drawn = new Map<string, string>();
/** Marks that arrived before the content script mounted. */
let pendingMarks: readonly Mark[] | null = null;

function safeSet(threadId: string, status: PluginComposerThreadRowStatus | null): void {
  try {
    setRowStatus?.(threadId, status);
  } catch {
    // An experimental host surface: a refusal must not break the poll loop.
  }
}

/** Draw `marks` and clear rows that left the queue. Idempotent. */
export function applyMarks(marks: readonly Mark[]): void {
  if (setRowStatus === null) {
    pendingMarks = marks;
    return;
  }
  const next = new Map<string, string>();
  for (const mark of marks) {
    const signature = `${mark.kind}|${mark.label}`;
    next.set(mark.threadId, signature);
    if (drawn.get(mark.threadId) === signature) continue;
    safeSet(mark.threadId, {
      icon: MARK_ICONS[mark.kind] ?? "MessageQuestion",
      label: mark.label,
      tone: "error",
    });
  }
  for (const threadId of drawn.keys()) {
    if (!next.has(threadId)) safeSet(threadId, null);
  }
  drawn = next;
}

function parseMarks(body: unknown): readonly Mark[] | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as { ok?: unknown; result?: { marks?: unknown } };
  if (envelope.ok !== true || !Array.isArray(envelope.result?.marks)) return null;
  return (envelope.result.marks as unknown[]).filter(
    (mark): mark is Mark =>
      typeof mark === "object" &&
      mark !== null &&
      typeof (mark as Mark).threadId === "string" &&
      typeof (mark as Mark).kind === "string" &&
      typeof (mark as Mark).label === "string",
  );
}

/** contentScripts.register({ id: "row-marks", mount: mountRowMarks }). */
export function mountRowMarks({ signal, experimental_setThreadRowStatus }: PluginContentScriptContext): void {
  if (experimental_setThreadRowStatus === undefined) return;
  setRowStatus = experimental_setThreadRowStatus;
  drawn = new Map();
  if (pendingMarks !== null) {
    const marks = pendingMarks;
    pendingMarks = null;
    applyMarks(marks);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      // The overlay keeps the marks in step with the page's queue meanwhile;
      // a second source would only make the labels flap.
      if (marksFromQueue) return;
      const response = await fetch("/api/v1/plugins/pult/rpc/marks.list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
        signal,
      });
      if (response.ok) {
        const marks = parseMarks(await response.json());
        if (marks !== null && !signal.aborted) applyMarks(marks);
      }
    } catch {
      // Offline, aborted or not authorized here: the overlay path still works.
    } finally {
      if (!signal.aborted) timer = setTimeout(() => void poll(), MARKS_POLL_MS);
    }
  };
  void poll();

  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      for (const threadId of drawn.keys()) safeSet(threadId, null);
      drawn = new Map();
      pendingMarks = null;
      setRowStatus = null;
    },
    { once: true },
  );
}

// -------------------------------------------------------------- app overlay

/** Mounted once per window; renders nothing. */
export function PultBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    bbNavigate = navigate;
    return () => {
      if (bbNavigate === navigate) bbNavigate = null;
    };
  }, [navigate]);

  // A view that keeps the shared queue fresh is mounted: draw from it.
  const queue = useQueueState();
  const fromQueue = queue.retainers > 0 && queue.data !== null;
  const marks = useMarks(!fromQueue);
  // When the page closes, the last marks.list answer is old: wait for the
  // one the switch triggers before drawing from it again.
  const switchedAt = useRef(0);
  useEffect(() => {
    marksFromQueue = fromQueue;
    if (!fromQueue) switchedAt.current = Date.now();
    return () => {
      marksFromQueue = false;
    };
  }, [fromQueue]);

  useEffect(() => {
    if (fromQueue && queue.data !== null) applyMarks(deriveMarks(queue.data.queue));
  }, [fromQueue, queue.data]);
  useEffect(() => {
    if (fromQueue || marks.data === null || (marks.receivedAt ?? 0) < switchedAt.current) return;
    applyMarks(marks.data.marks);
  }, [fromQueue, marks.data, marks.receivedAt]);
  return null;
}
