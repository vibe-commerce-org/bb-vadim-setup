// Small pieces shared by the panel: buttons, the loading and notice screens,
// polling while the tab is on screen, and following links.
import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { FileLocation } from "./file-access";
import { resolveLink } from "./links";

export const BUTTON =
  "inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
export const SMALL_BUTTON =
  "inline-flex h-7 flex-none items-center justify-center rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
export const SMALL_BUTTON_ON = `${SMALL_BUTTON} bg-state-hover`;

// The tools a finger reaches for are 32 px tall, unlike the 28 px text buttons of a wide panel.
const TOOL_BASE =
  "inline-flex h-8 flex-none items-center justify-center rounded-md border border-border bg-background text-xs font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
/** An icon and a word. */
export const TOOL_BUTTON = `${TOOL_BASE} gap-1.5 px-2.5`;
export const TOOL_BUTTON_ON = `${TOOL_BUTTON} bg-state-hover`;
/** An icon alone, square. */
export const ICON_BUTTON = `${TOOL_BASE} w-8`;
export const ICON_BUTTON_ON = `${ICON_BUTTON} bg-state-hover`;

/** A panel narrower than this (a phone, BB's side panel) shows icons where a wide one shows words. */
export const COMPACT_PX = 720;

/** Whether the element is narrower than COMPACT_PX, kept up to date as it is resized. */
export function useCompact(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setCompact(element.clientWidth < COMPACT_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return compact;
}

/** The word of a button, beside its icon or, in a narrow panel, for screen readers only. */
export function ToolText({ compact, children }: { compact: boolean; children: ReactNode }) {
  return compact ? <span className="sr-only">{children}</span> : <>{children}</>;
}

export function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex h-full min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground">
      <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" aria-hidden />
      {label}
    </div>
  );
}

/** A message in the middle of the panel with the ways out that apply. */
export function Notice({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <div className="max-w-md space-y-3 text-center">
        <p role="alert" className="text-sm text-muted-foreground">
          {message}
        </p>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * Scrolls what it holds. BB's own preview grows to the document's length and
 * leaves scrolling to its container, while the opener's slot clips
 * (`overflow-hidden`): without this frame the end of a long file is cut off.
 */
export function ScrollFrame({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** One row of controls; in a panel too narrow for them it wraps instead of cutting off the last. */
/**
 * One row, never wrapped: on a phone the buttons used to stack into three rows
 * above the text. What does not fit scrolls sideways under a finger; `trailing`
 * stays pinned at the right, outside the scroll — the main action is always in
 * reach, and "Вид" keeps a panel that a scrolling row would clip.
 */
export function Toolbar({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-10 flex-none items-center gap-2 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:flex-none">
        {children}
      </div>
      {trailing === undefined ? null : <div className="flex flex-none items-center gap-2">{trailing}</div>}
    </div>
  );
}

export const timeOf = (date: Date) => date.toLocaleTimeString("ru-RU");

/** The latest value, for effects that must not restart when BB hands over a new but equal object. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A file source as a string, so effects restart only when the source really changes. */
export const sourceKey = (source: PluginFileOpenerSource) =>
  JSON.stringify([source.kind, source.threadId, source.environmentId, source.projectId, source.experimental_hostId ?? null]);

/** Re-reading a big file every 1.5 s would load BB's daemon for nothing. */
export const pollDelay = (textLength: number) => (textLength > 256 * 1024 ? 5000 : 1500);

/** On screen: the window is visible and the tab isn't hidden behind another one. */
const isShown = (element: HTMLElement | null) =>
  document.visibilityState === "visible" && element !== null && element.getClientRects().length > 0;

/**
 * Calls `tick` every `delay()` ms while `rootRef` is on screen, and at once
 * when the window comes back into focus. A failed tick keeps what's shown.
 */
export function usePolling(
  rootRef: RefObject<HTMLElement | null>,
  tick: () => Promise<void>,
  delay: () => number,
  enabled: boolean,
): void {
  const tickRef = useRef(tick);
  const delayRef = useRef(delay);
  tickRef.current = tick;
  delayRef.current = delay;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let running = false;
    let timer: number | undefined;
    const run = async () => {
      if (stopped || running) return;
      if (isShown(rootRef.current)) {
        running = true;
        try {
          await tickRef.current();
        } catch {
          // A file mid-write or a daemon hiccup; the next tick tries again.
        } finally {
          running = false;
        }
      }
      if (!stopped) {
        window.clearTimeout(timer);
        timer = window.setTimeout(run, delayRef.current());
      }
    };
    const now = () => {
      window.clearTimeout(timer);
      void run();
    };
    timer = window.setTimeout(run, delayRef.current());
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [enabled, rootRef]);
}

/**
 * Follows a link from the document: http(s) as BB's chat does, mailto/tel to
 * the OS, a file in BB's panel (relative paths from `file`'s folder), `#id` to
 * `toAnchor`. Anything else (javascript:, app schemes) is ignored. Returns
 * false when the link was ignored or BB declined to open it.
 */
export function useOpenLink(file: FileLocation, toAnchor: (id: string) => void): (href: string) => boolean {
  const navigate = useBbNavigate();
  return (href) => {
    const action = resolveLink(href, file);
    switch (action?.kind) {
      case "web":
        return navigate.openUrl(action.url);
      case "system": {
        const anchor = document.createElement("a");
        anchor.href = action.url;
        anchor.rel = "noopener noreferrer";
        anchor.click();
        return true;
      }
      case "anchor":
        toAnchor(action.id);
        return true;
      case "file":
        return navigate.experimental_openFilePreview({ target: action.target, location: null });
      default:
        return false;
    }
  };
}
