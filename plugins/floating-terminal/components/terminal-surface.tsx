// The terminal itself, shared by both places it can live.
//
// The floating window and the side-panel tab are only frames: they decide
// where the box sits and how big it is. Everything inside — the tab strip and
// its server sync, one TerminalView per shell, find, the "Latest" pill, the
// directory picker, and the on-screen key bar with its paste — lives here, so
// both frames behave the same and a fix lands in one place.
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ShellPicker } from "@/components/shell-picker";
import type { ScopeOption } from "@/lib/scopes";
import { FindBar } from "@/components/find-bar";
import { KeyToolbar } from "@/components/key-toolbar";
import { TabBar } from "@/components/tab-bar";
import { TerminalView } from "@/components/terminal-view";
import type { TerminalPump } from "@/lib/pump";
import {
  arrowSequence,
  isTabCycleKey,
  tabCycleDirection,
  type ToolbarKey,
} from "@/lib/keys";
import { createRpcClient } from "@/lib/rpc";
import { emptyTabs, tabsReducer, type TabStatus } from "@/lib/tabs";
import type { rpcContract } from "../server";

const PLUGIN_ID = "floating-terminal";

/** Long enough that a per-prompt title setter costs one rename, not dozens. */
const TITLE_RENAME_DEBOUNCE_MS = 500;

/** Geometry for openTab before any pump exists; the first fit corrects it. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** How long a refused clipboard read waits for iOS's own paste to land. */
const NATIVE_PASTE_GRACE_MS = 500;

/**
 * The surface with nothing in it. Its job is to get you into a shell in one
 * click and to answer the one question that changes how you use it — whether
 * closing the frame kills your work. Everything else stays quiet.
 */
function EmptyState({
  hint,
  scopes,
  recentScopeKeys,
  showHosts,
  onPick,
}: {
  hint: string;
  scopes: ScopeOption[];
  recentScopeKeys: string[];
  showHosts: boolean;
  onPick: (scopeKey: string) => void;
}) {
  return (
    // A column, not a row: `items-center` on a row container sizes the child
    // from its content, so a long directory list grew past the window and got
    // centre-clipped — the heading scrolled off the top edge and the list could
    // not scroll. As a column with `min-h-0` the child shrinks to the available
    // height instead, and the list inside it scrolls.
    <div className="flex size-full min-h-0 flex-col items-center justify-center overflow-hidden p-4">
      {/* Centred while it fits, filling and scrolling once it does not. */}
      <div className="flex min-h-0 w-full min-w-0 max-w-md flex-col gap-3">
        <div className="flex shrink-0 flex-col gap-1 px-1">
          <h2 className="text-sm font-medium text-foreground">Start a shell</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
        <ShellPicker
          scopes={scopes}
          recentScopeKeys={recentScopeKeys}
          showHosts={showHosts}
          onPick={onPick}
          fill
          className="min-h-0 flex-1 rounded-lg border border-border bg-background/40"
        />
      </div>
    </div>
  );
}

export interface TerminalSurfaceProps {
  /**
   * The frame is showing and owns the shells: drives server sync, polling,
   * sizing, and focus. A hidden window, or a panel tab under an open window,
   * is inactive — its pumps stop, and nothing resizes the shared PTYs.
   */
  active: boolean;
  /** Below bb's compact breakpoint: the on-screen key bar appears. */
  compact: boolean;
  /** Bumped by the frame when the box changed size; the visible pump refits. */
  fitVersion: number;
  /** Bumped when the caret should go back to the active prompt. */
  focusVersion: number;
  /** Shown under "Start a shell": what happens to shells when the frame goes away. */
  emptyHint: string;
  /** Window mode only; a sheet or a panel already fills its box. */
  maximize: { on: boolean; toggle: () => void } | null;
  /** Window only. A side-panel tab is closed by bb's own tab strip. */
  onHide: (() => void) | null;
  /** Spread on the tab strip's wrapper: the window makes it the drag handle. */
  headerProps?: HTMLAttributes<HTMLDivElement> & {
    ref?: Ref<HTMLDivElement>;
    "data-bb-ft-handle"?: "";
  };
}

export function TerminalSurface({
  active,
  compact,
  fitVersion,
  focusVersion,
  emptyHint,
  maximize,
  onHide,
  headerProps,
}: TerminalSurfaceProps) {
  const rpcRef = useRef(createRpcClient<typeof rpcContract>(PLUGIN_ID));
  const rpc = rpcRef.current;

  const [state, dispatch] = useReducer(tabsReducer, emptyTabs);
  const [scopes, setScopes] = useState<ScopeOption[]>([]);
  const [recentScopeKeys, setRecentScopeKeys] = useState<string[]>([]);
  const [fontSize, setFontSize] = useState(13);
  const [themeVersion, setThemeVersion] = useState(0);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  /** Whether the active tab sits at the newest output; drives the pill. */
  const [atBottom, setAtBottom] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const [findResults, setFindResults] = useState<{ index: number; count: number } | null>(null);

  const pumps = useRef(new Map<string, TerminalPump>());
  /**
   * Restarts already in flight. The restart button and the Enter-at-a-dead-
   * prompt path can both fire for the same tab, and each extra call creates a
   * PTY that no tab strip will ever show.
   */
  const restarting = useRef(new Set<string>());

  // ------------------------------------------------------------- server io

  // Mirrored into a ref so the stable useCallbacks below read the *current*
  // active tab rather than whichever render created them — otherwise a new
  // shell is always seeded at the 80x24 default instead of the frame's real
  // size, and briefly mis-wraps until the first resize lands.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = state.activeId;

  const geometry = useCallback(() => {
    const activeId = activeIdRef.current;
    const pump = activeId === null ? null : pumps.current.get(activeId);
    return pump === undefined || pump === null
      ? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
      : { cols: pump.cols(), rows: pump.rows() };
  }, []);

  /**
   * Pull the server's view of the world. Its tab list is the only thing that
   * evicts a ghost — a tab whose shell died while the frame was away, or that
   * another bb client closed. Ordering is handled by the snapshot's revision,
   * so a slow reply simply loses to a newer one.
   */
  const sync = useCallback(async () => {
    try {
      const result = await rpc.call("init");
      setScopes(result.scopes);
      setRecentScopeKeys(result.recentScopeKeys);
      setFontSize(result.prefs.fontSize);
      dispatch({ type: "synced", snapshot: result.snapshot });
    } catch {
      toast.error("Floating Terminal could not reach its backend.");
    }
  }, [rpc]);

  const openTab = useCallback(
    async (scopeKey: string) => {
      try {
        const result = await rpc.call("openTab", { scopeKey, ...geometry() });
        dispatch({
          type: "synced",
          snapshot: result.snapshot,
          focusId: result.opened.terminalId,
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not start a shell",
        );
        void sync();
      }
    },
    [rpc, sync, geometry],
  );

  const closeTab = useCallback(
    async (terminalId: string) => {
      try {
        const result = await rpc.call("closeTab", { terminalId });
        dispatch({ type: "synced", snapshot: result.snapshot });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not close the shell",
        );
        void sync();
      }
    },
    [rpc, sync],
  );

  const restartTab = useCallback(
    async (terminalId: string) => {
      if (restarting.current.has(terminalId)) return;
      restarting.current.add(terminalId);
      try {
        const result = await rpc.call("restartTab", {
          terminalId,
          ...geometry(),
        });
        dispatch({
          type: "synced",
          snapshot: result.snapshot,
          focusId: result.restarted.terminalId,
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Could not restart the shell",
        );
        // The tab is unrecoverable if the server no longer knows it; a resync
        // removes it rather than leaving a dead row the user cannot revive.
        void sync();
      } finally {
        restarting.current.delete(terminalId);
      }
    },
    [rpc, sync, geometry],
  );

  useEffect(() => {
    setCtrlArmed(false);
  }, [state.activeId]);

  const selectTab = useCallback(
    (terminalId: string) => {
      dispatch({ type: "activated", terminalId });
      void rpc.call("setActiveTab", { terminalId }).catch(() => {
        // Persistence only; the client already switched.
      });
    },
    [rpc],
  );

  /**
   * Cmd/Ctrl+Shift+[ and ] step through the strip with wrap-around. Handled on
   * the surface rather than in the pump so it also works with a tab, the
   * picker, or the find bar focused; the pump only declines to eat the key.
   */
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;
  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      const tabs = tabsRef.current;
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.terminalId === activeIdRef.current);
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next !== undefined) selectTab(next.terminalId);
    },
    [selectTab],
  );

  const onSurfaceKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isTabCycleKey(event)) return;
      event.preventDefault();
      const direction = tabCycleDirection(event);
      if (direction !== null) cycleTab(direction);
    },
    [cycleTab],
  );

  // Every activation re-syncs: directories change, and a shell can die while
  // the frame is away.
  useEffect(() => {
    if (!active) return;
    void sync();
  }, [active, sync]);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeVersion((version) => version + 1),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // --------------------------------------------------------------- render

  const onStatus = useCallback(
    (terminalId: string, status: TabStatus, detail: string | null) => {
      dispatch({ type: "status", terminalId, status, detail });
    },
    [],
  );

  const onPumpReady = useCallback((terminalId: string, pump: TerminalPump) => {
    pumps.current.set(terminalId, pump);
  }, []);

  const onPumpGone = useCallback((terminalId: string) => {
    pumps.current.delete(terminalId);
  }, []);

  const onRequestRestart = useCallback(
    (terminalId: string) => void restartTab(terminalId),
    [restartTab],
  );

  // A shell that sets its title on every prompt would otherwise put a rename
  // round trip behind every command, so coalesce and drop no-ops. Keyed by
  // terminal so two busy tabs cannot cancel each other's pending rename.
  const titleTimers = useRef(new Map<string, number>());
  const lastTitles = useRef(new Map<string, string | null>());

  const onTitle = useCallback(
    (terminalId: string, title: string | null) => {
      if (lastTitles.current.get(terminalId) === title) return;
      lastTitles.current.set(terminalId, title);
      const pending = titleTimers.current.get(terminalId);
      if (pending !== undefined) window.clearTimeout(pending);
      titleTimers.current.set(
        terminalId,
        window.setTimeout(() => {
          titleTimers.current.delete(terminalId);
          void rpc
            .call("renameTab", { terminalId, title })
            .then((result) =>
              dispatch({ type: "synced", snapshot: result.snapshot }),
            )
            .catch(() => {
              // A name is cosmetic; let the next snapshot settle it.
            });
        }, TITLE_RENAME_DEBOUNCE_MS),
      );
    },
    [rpc],
  );

  useEffect(
    () => () => {
      for (const timer of titleTimers.current.values()) {
        window.clearTimeout(timer);
      }
    },
    [],
  );

  const activePump = useCallback((): TerminalPump | null => {
    const activeId = activeIdRef.current;
    if (activeId === null) return null;
    return pumps.current.get(activeId) ?? null;
  }, []);

  // The panel asks for the caret after bb's Ctrl+` command re-focused its tab.
  useEffect(() => {
    if (focusVersion === 0 || !active) return;
    activePump()?.focus();
  }, [focusVersion, active, activePump]);

  // ----------------------------------------------------------- find in tab
  const [findQuery, setFindQuery] = useState("");
  const findQueryRef = useRef("");
  findQueryRef.current = findQuery;

  const openFind = useCallback(() => {
    if (activePump()?.searchAvailable() !== true) return;
    setFindOpen(true);
  }, [activePump]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResults(null);
    const pump = activePump();
    pump?.clearSearch();
    pump?.focus();
  }, [activePump]);

  const onFindQueryChange = useCallback(
    (query: string) => {
      setFindQuery(query);
      const pump = activePump();
      if (pump === null) return;
      if (query === "") {
        pump.clearSearch();
        setFindResults(null);
        return;
      }
      pump.findNext(query, true);
    },
    [activePump],
  );

  const onFindNext = useCallback(() => {
    activePump()?.findNext(findQueryRef.current);
  }, [activePump]);

  const onFindPrevious = useCallback(() => {
    activePump()?.findPrevious(findQueryRef.current);
  }, [activePump]);

  const onSearchResults = useCallback(
    (_terminalId: string, results: { index: number; count: number } | null) => {
      setFindResults(results);
    },
    [],
  );

  // A search belongs to the buffer it ran in; switching tabs closes it rather
  // than replaying a stale query over a different shell.
  const lastActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastActiveRef.current;
    lastActiveRef.current = state.activeId;
    if (previous !== null && previous !== state.activeId) {
      pumps.current.get(previous)?.clearSearch();
      setFindOpen(false);
      setFindResults(null);
    }
  }, [state.activeId]);

  const onScrollState = useCallback(
    (terminalId: string, tabAtBottom: boolean) => {
      if (terminalId === activeIdRef.current) setAtBottom(tabAtBottom);
    },
    [],
  );

  // Switching tabs: the pill state belongs to the new tab, and until its pump
  // reports otherwise the safe assumption is "at the prompt".
  useEffect(() => {
    setAtBottom(true);
  }, [state.activeId]);

  const onToolbarKey = useCallback(
    (key: ToolbarKey) => {
      const pump = activePump();
      if (pump === null) return;
      switch (key.kind) {
        case "send":
          pump.send(key.send ?? "");
          return;
        case "arrow":
          pump.send(
            arrowSequence(key.direction ?? "up", pump.applicationCursorKeys()),
          );
          return;
        case "modifier":
          pump.setCtrlArmed(!ctrlArmed);
          return;
        case "action":
          if (key.id === "dismiss") {
            pump.blur();
            return;
          }
          if (key.id === "find") {
            openFind();
            return;
          }
          if (key.id === "paste") {
            // Through xterm's paste, not raw bytes: newlines become Enter and,
            // under bracketed paste, a multi-line paste waits at the prompt
            // instead of running line by line (see TerminalPump.paste).
            //
            // On iOS readText() raises a "Paste" bubble, and WebKit can carry
            // out a tap on it as an ordinary paste into the focused element
            // while still refusing the read (WKContentView pasteForWebView).
            // xterm takes that paste itself, so a refusal counts only when no
            // native paste followed it, and a read that did resolve is dropped
            // if one arrived, so the text never lands twice.
            const requestedAt = performance.now();
            void navigator.clipboard
              ?.readText()
              .then((text) => {
                if (text !== "" && !pump.pastedNativelySince(requestedAt)) {
                  pump.paste(text);
                }
              })
              .catch((error: unknown) => {
                window.setTimeout(() => {
                  if (pump.pastedNativelySince(requestedAt)) return;
                  toast.error("Clipboard is not available here.", {
                    description:
                      error instanceof Error ? error.name : String(error),
                  });
                }, NATIVE_PASTE_GRACE_MS);
              });
          }
          return;
      }
    },
    [activePump, ctrlArmed, openFind],
  );

  const onCtrlArmed = useCallback((armed: boolean) => setCtrlArmed(armed), []);

  // A bare ~ means nothing once there is more than one machine.
  const showHosts = new Set(scopes.map((scope) => scope.hostName)).size > 1;

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={onSurfaceKeyDown}
      >
        <div {...headerProps}>
          <TabBar
            tabs={state.tabs}
            activeId={state.activeId}
            scopes={scopes}
            recentScopeKeys={recentScopeKeys}
            showHosts={showHosts}
            maximize={maximize}
            onSelect={selectTab}
            onClose={(terminalId) => void closeTab(terminalId)}
            onNewTab={(scopeKey) => void openTab(scopeKey)}
            onRestart={() => {
              if (state.activeId !== null) void restartTab(state.activeId);
            }}
            onHide={onHide}
          />
        </div>

        <div className="relative min-h-0 flex-1 bg-card px-2 pb-1 pt-2">
          {state.tabs.map((tab) => (
            <TerminalView
              key={tab.terminalId}
              rpc={rpc}
              terminalId={tab.terminalId}
              visible={active && tab.terminalId === state.activeId}
              fontSize={fontSize}
              themeVersion={themeVersion}
              fitVersion={fitVersion}
              onStatus={onStatus}
              onTitle={onTitle}
              onCtrlArmed={onCtrlArmed}
              onFindRequested={openFind}
              onScrollState={onScrollState}
              onSearchResults={onSearchResults}
              onRequestRestart={onRequestRestart}
              onPumpReady={onPumpReady}
              onPumpGone={onPumpGone}
            />
          ))}
          {findOpen && state.tabs.length > 0 ? (
            <FindBar
              query={findQuery}
              results={findResults}
              onQueryChange={onFindQueryChange}
              onNext={onFindNext}
              onPrevious={onFindPrevious}
              onClose={closeFind}
            />
          ) : null}

          {/* Parked in history while output may still be arriving below. */}
          {!atBottom && state.tabs.length > 0 ? (
            <button
              type="button"
              className="bb-ft-pill"
              onClick={() => {
                activePump()?.scrollToBottom();
                activePump()?.focus();
              }}
            >
              <Icon name="ChevronsDown" className="size-3.5" aria-hidden="true" />
              Latest
            </button>
          ) : null}

          {state.tabs.length === 0 ? (
            <EmptyState
              hint={emptyHint}
              scopes={scopes}
              recentScopeKeys={recentScopeKeys}
              showHosts={showHosts}
              onPick={(scopeKey) => void openTab(scopeKey)}
            />
          ) : null}
        </div>

        {/* Only where the keys are actually missing, and only once there is a
            shell to send them to. */}
        {compact && state.tabs.length > 0 ? (
          <KeyToolbar ctrlArmed={ctrlArmed} onKey={onToolbarKey} />
        ) : null}
      </div>
    </TooltipProvider>
  );
}
