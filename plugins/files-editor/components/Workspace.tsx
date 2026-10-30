import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
  type ExperimentalLiveFileTarget,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import { parseTreeSort, type FlatEntry, type TreeSort } from "@/lib/tree";
import { createIgnoreMatcher } from "@/lib/gitignore";
import type { ScopeRef } from "@/lib/route";
import { sameScope } from "@/lib/route";
import { hasPreview, isHtmlPath, isMarkdownPath } from "@/lib/markdown";
import { focusIfFree } from "@/lib/focus";
import {
  OPEN_DOCUMENTS_SETTING,
  documentOpenWith,
  documentViewer,
  isDocumentPath,
  type OpenWith,
} from "@/lib/open-with";
import { isSensitivePath } from "@/lib/secrets";
import {
  EMPTY_PANEL_STATE,
  panelStateKey,
  pushRecent,
  readPanelState,
  sessionStore,
  writePanelState,
  type PanelRoot,
  type PanelState,
} from "@/lib/panel-state";
import { foldersToLoad, mergeListing, pruneListed } from "@/lib/lazy-tree";
import {
  absolutePathFor,
  dropPathsUnder,
  isSameOrInside,
  remapPath,
  remapPaths,
} from "@/lib/entry-paths";
import type { ResolvedScope, rpcContract } from "../server.js";
import { DocumentView, MarkdownDocument, type ViewerTarget } from "./DocumentView";
import { HtmlPage } from "./HtmlPage";
import { Explorer, type RevealFolderRequest } from "./Explorer";
import { FileView, HandOffStub, fileMetaLabel } from "./FileView";
import { RecentMenu } from "./RecentMenu";
import { QuickOpen } from "./QuickOpen";
import { RootSwitcher } from "./RootSwitcher";
import { useTransfers } from "./use-transfers";
import { WorkspacePicker } from "./WorkspacePicker";
import { useCoarsePointer, useFileOperations } from "./use-file-operations";
import {
  canPreview,
  isDirty,
  useFileTabs,
  type FileViewMode,
} from "./use-file-tabs";

interface TreeState {
  status: "idle" | "loading" | "ready" | "error";
  scope: ResolvedScope | null;
  entries: FlatEntry[];
  truncated: boolean;
  listing: "local" | "remote";
  excluded: string[];
  /** What git ignores in a checkout on this Mac; empty anywhere else. */
  ignored: string[];
  /**
   * Home: the folders read so far ("" is the top); every other folder is read
   * when it is opened. Null for a workspace, which arrives whole.
   */
  listed: string[] | null;
  error: string | null;
}

const EMPTY_TREE: TreeState = {
  status: "idle",
  scope: null,
  entries: [],
  truncated: false,
  listing: "local",
  excluded: [],
  ignored: [],
  listed: null,
  error: null,
};

const NO_FOLDERS: ReadonlySet<string> = new Set();

const MIN_EXPLORER_PX = 180;
const MAX_EXPLORER_PX = 560;
const DEFAULT_EXPLORER_PX = 260;

const WIDTH_STORAGE_KEY = "files-editor:explorer-width";
const HIDDEN_STORAGE_KEY = "files-editor:include-hidden";
const EXPLORER_OPEN_STORAGE_KEY = "files-editor:explorer-open";
const SORT_STORAGE_KEY = "files-editor:sort";
const HIDE_IGNORED_STORAGE_KEY = "files-editor:hide-gitignored";

/** Narrower than this the tree and the file do not fit side by side: a phone, a slim panel. */
const NARROW_SURFACE_PX = 560;

const HAND_OFF_FAILED: Readonly<Record<OpenWith, string>> = {
  viewer: "This surface has no file preview panel.",
  external: "This BB client cannot open files in a Mac app.",
};

export interface WorkspaceProps {
  scope: ScopeRef | null;
  filePath: string | null;
  /** Called when the open file changes, so a routed surface can mirror it. */
  onOpenPath: (path: string | null) => void;
  /** Omit to pin the surface to one workspace (the thread panel does). */
  onChangeScope?: (scope: ScopeRef) => void;
  variant: "page" | "panel";
  /**
   * Where this surface keeps its session state. Defaults to one slot per
   * workspace; a tab opened on one file (from the chat, or "Open in new tab")
   * gets its own, so it does not take over the plain tab's file.
   */
  stateKey?: string;
  /** A line to bring into view when the file named by `filePath` first opens. */
  initialLine?: number | null;
  /** Opens a file in a new panel tab of its own; omitted where there is no side panel. */
  onOpenInNewTab?: (path: string) => void;
  /** A thread's tab: what it is rooted at, and the "Project / Home" switch over the tree. */
  root?: PanelRoot;
  onChangeRoot?: (next: PanelRoot) => void;
}

export function Workspace({
  scope,
  filePath,
  onOpenPath,
  onChangeScope,
  variant,
  stateKey,
  initialLine = null,
  onOpenInNewTab,
  root = "project",
  onChangeRoot,
}: WorkspaceProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const settings = useSettings();
  // One file at a time: a click replaces it, and Recent brings the last ones back.
  const tabs = useFileTabs(scope, 1);
  const openDocumentsWith = documentOpenWith(settings.values?.[OPEN_DOCUMENTS_SETTING]);

  const [tree, setTree] = useState<TreeState>(EMPTY_TREE);
  const [includeHidden, setIncludeHidden] = useState(readStoredHidden);
  const [sort, setSort] = useState<TreeSort>(() => parseTreeSort(safeRead(SORT_STORAGE_KEY)));
  // Off by default: every file shows, the gitignored ones dimmed.
  const [hideIgnored, setHideIgnored] = useState(
    () => safeRead(HIDE_IGNORED_STORAGE_KEY) === "true",
  );
  // A folder picked in ⌘P, for the tree to open and scroll to. Tagged with the
  // workspace it was picked in, so a switch never reveals it in another one.
  const [revealFolder, setRevealFolder] = useState<
    (RevealFolderRequest & { scopeKey: string | null }) | null
  >(null);
  const revealFolderNonce = useRef(0);
  const [explorerWidth, setExplorerWidth] = useState(readStoredWidth);
  // Open unless it was hidden last time. A narrow surface lays the tree over
  // the file instead of beside it, and closes it once a file is picked.
  const [isExplorerOpen, setIsExplorerOpen] = useState(readStoredExplorerOpen);
  const [isNarrow, setIsNarrow] = useState(false);
  const isNarrowRef = useRef(isNarrow);
  isNarrowRef.current = isNarrow;
  const hasFileRef = useRef(false);
  hasFileRef.current = tabs.activePath !== null;
  // What this workspace looked like when the panel was last on screen, tagged
  // with the workspace it belongs to so a switch never files one under another.
  const scopeKey = scope === null ? null : (stateKey ?? panelStateKey(scope));
  const [panel, setPanel] = useState<{ key: string | null; state: PanelState }>(() => ({
    key: scopeKey,
    state: scopeKey === null ? EMPTY_PANEL_STATE : readPanelState(sessionStore(), scopeKey),
  }));
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  // A counter, not a flag: pressing ⌘F again with the bar already open has to
  // re-focus and reselect the field, which an unchanged boolean cannot signal.
  const [findRequest, setFindRequest] = useState(0);
  // ⌘⇧F focuses the explorer's text search, VS Code's binding for "search in files".
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  // A search hit to reveal: the file it is in, the line, and a nonce so opening
  // the same hit twice scrolls to it again.
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(
    null,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  // Home is read folder by folder: a reload reads the open ones again, so it
  // needs them as they are now — for the workspace being loaded, not the last.
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const expandedRef = useRef({ key: panel.key, expanded: panel.state.expanded });
  expandedRef.current = { key: panel.key, expanded: panel.state.expanded };
  const [loadingFolders, setLoadingFolders] = useState<ReadonlySet<string>>(NO_FOLDERS);
  // Folders that would not open (privacy, gone): not asked again until a reload.
  const failedFolders = useRef(new Set<string>());
  // A toast action outlives the render that created it; navigation has to be
  // read live rather than captured.
  const onOpenPathRef = useRef(onOpenPath);
  onOpenPathRef.current = onOpenPath;
  // Closing navigates away, but the route arrives back as a prop a render
  // later. In that gap the route still names the file that was just closed,
  // and the effect below would helpfully reopen it. This remembers the value
  // to ignore until the route catches up.
  const staleRouteFile = useRef<string | null>(null);

  // Not over a field typed into elsewhere: the surface also mounts by itself
  // (⌘J, a file link from the chat, a reload), and the caret must stay put.
  useEffect(() => {
    focusIfFree(rootRef.current, { preventScroll: true });
  }, []);

  // Width of the surface, not of the window: a right panel can be narrow on a
  // wide screen, and on a phone BB shows it as a full-width drawer.
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const narrow = entry.contentRect.width < NARROW_SURFACE_PX;
      // The first measure comes after a file named by the route is already open:
      // on a phone the tree would lie over that very file and take its touches.
      if (narrow && !isNarrowRef.current && hasFileRef.current) setIsExplorerOpen(false);
      setIsNarrow(narrow);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /** Return the keyboard to the surface when a child that held focus is gone. */
  const restoreFocus = useCallback(() => {
    const root = rootRef.current;
    if (root === null) return;
    if (root.contains(document.activeElement)) return;
    focusIfFree(root, { preventScroll: true });
  }, []);

  const loadTree = useCallback(
    (target: ScopeRef | null, hidden: boolean) => {
      if (target === null) {
        setTree(EMPTY_TREE);
        return;
      }
      const generation = (requestRef.current += 1);
      setTree((current) => ({ ...current, status: "loading", error: null }));
      failedFolders.current = new Set();
      setLoadingFolders(NO_FOLDERS);

      const key = scopeKeyRef.current;
      const open = expandedRef.current;
      const folders =
        target.kind !== "home" || key === null
          ? undefined
          : open.key === key
            ? open.expanded
            : readPanelState(sessionStore(), key).expanded;

      void rpc
        .call("tree", {
          scope: target,
          includeHidden: hidden,
          // The contract's cap; the server reads at most a few hundred anyway.
          ...(folders === undefined ? {} : { folders: folders.slice(0, 1000) }),
        })
        .then((result) => {
          if (requestRef.current !== generation) return;
          for (const folder of result.unreadable) failedFolders.current.add(folder);
          setTree({
            status: "ready",
            scope: result.scope,
            entries: result.entries,
            truncated: result.truncated,
            listing: result.listing,
            excluded: result.excluded,
            ignored: result.ignored,
            listed: result.listed,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (requestRef.current !== generation) return;
          setTree({
            ...EMPTY_TREE,
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Could not read this workspace.",
          });
        });
    },
    [rpc],
  );

  // Keyed on the scope's VALUE, not the object: callers build the ref during
  // render, so a fresh identity every render would re-walk the whole workspace
  // on every keystroke and every file click.
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope?.id ?? null;
  useEffect(() => {
    loadTree(
      scopeKind === null || scopeId === null ? null : { kind: scopeKind, id: scopeId },
      includeHidden,
    );
  }, [includeHidden, loadTree, scopeId, scopeKind]);

  // Home: read each folder as it is opened — and, on arrival, the ones that
  // were open last time and did not come with the first listing.
  const isLazy = tree.listed !== null;
  useEffect(() => {
    if (tree.status !== "ready" || tree.listed === null || scopeKind === null || scopeId === null) return;
    // Between a switch and the restore, the open folders are still the last workspace's.
    if (panel.key !== scopeKey) return;
    const wanted = foldersToLoad({
      expanded: panel.state.expanded,
      entries: tree.entries,
      listed: new Set(tree.listed),
      loading: loadingFolders,
      failed: failedFolders.current,
    });
    if (wanted.length === 0) return;
    const generation = requestRef.current;
    setLoadingFolders((current) => new Set([...current, ...wanted]));
    for (const folder of wanted) {
      void rpc
        .call("listDir", { scope: { kind: scopeKind, id: scopeId }, path: folder, includeHidden })
        .then((result) => {
          if (requestRef.current !== generation) return;
          if (!result.ok) {
            failedFolders.current.add(folder);
            toast.error(result.reason);
            return;
          }
          setTree((current) => {
            if (current.listed === null) return current;
            const entries = mergeListing(current.entries, folder, result.entries);
            return {
              ...current,
              entries,
              listed: pruneListed([...new Set([...current.listed, folder])], entries),
              truncated: current.truncated || result.truncated,
            };
          });
        })
        .catch((error: unknown) => {
          if (requestRef.current !== generation) return;
          failedFolders.current.add(folder);
          toast.error(error instanceof Error ? error.message : `Could not open ${folder}.`);
        })
        .finally(() =>
          setLoadingFolders((current) => {
            if (!current.has(folder)) return current;
            const next = new Set(current);
            next.delete(folder);
            return next;
          }),
        );
    }
  }, [includeHidden, loadingFolders, panel.key, panel.state.expanded, rpc, scopeId, scopeKey, scopeKind, tree]);

  // Open the file named by the route: on arrival, when the route moves to
  // another file, and after a scope change cleared the tabs out from under it.
  const hasRoutedTab = tabs.tabs.some((tab) => tab.path === filePath);
  useEffect(() => {
    if (staleRouteFile.current !== null) {
      if (filePath === staleRouteFile.current) return;
      staleRouteFile.current = null;
    }
    if (filePath === null) return;
    if (tabs.activePath === filePath || hasRoutedTab) return;
    tabs.open(filePath);
    // As after a pick in the tree: a narrow surface puts the tree away.
    if (isNarrowRef.current) setIsExplorerOpen(false);
    // A tab opened on a file — from the chat, or "Open in new tab" — starts
    // its Recent with that file, like any file opened by a click.
    setPanel((current) => ({
      ...current,
      state: { ...current.state, file: filePath, recent: pushRecent(current.state.recent, filePath) },
    }));
    // `tabs` is rebuilt every render; the open is keyed on the route value and
    // on whether this surface already holds that file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, hasRoutedTab, scopeId, scopeKind]);

  useRealtime("files-editor/changed", (payload) => {
    const change = payload as { scope?: ScopeRef; path?: string; sha256?: string };
    if (typeof change.path !== "string") return;
    if (!sameScope(change.scope ?? null, scope)) return;
    const tab = tabs.tabs.find((candidate) => candidate.path === change.path);
    if (tab === undefined || isDirty(tab)) return;
    if (tab.sha256 === change.sha256) return;
    tabs.reload(change.path);
  });

  /**
   * Hand a file to BB's preview panel or to the app macOS opens it with. False,
   * after a toast saying why, when that plainly did not happen: the Files page
   * in the sidebar has no preview panel, and not every client reaches a Mac app.
   * A workspace on this Mac asks the server to `open` the file, which answers
   * later, so a refusal there arrives through `onFailure` instead.
   */
  const handOff = useCallback(
    (path: string, how: OpenWith, onFailure?: () => void): boolean => {
      const resolvedScope = tree.scope;
      if (resolvedScope === null) return false;
      if (how === "external" && resolvedScope.isLocal) {
        const fail = (reason: string) => {
          toast.error(reason);
          onFailure?.();
        };
        void rpc
          .call("openInMacApp", { scope: resolvedScope.ref, path })
          .then((result) => {
            if (!result.ok) fail(result.reason);
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error.message : HAND_OFF_FAILED.external),
          );
        return true;
      }
      const options = { target: liveTargetFor(resolvedScope, path), location: null };
      const opened =
        how === "viewer"
          ? navigate.experimental_openFilePreview(options)
          : navigate.experimental_openFileExternally(options);
      if (!opened) toast.error(HAND_OFF_FAILED[how]);
      return opened;
    },
    [navigate, rpc, tree.scope],
  );

  const openInTab = useCallback(
    (path: string) => {
      staleRouteFile.current = null;
      setReveal(null);
      // A folder reveal is done once a file is picked; left set, a tree that
      // remounts later (hidden and shown again) would jump back to it.
      setRevealFolder(null);
      tabs.open(path);
      onOpenPath(path);
      setFindRequest(0);
      setPanel((current) => ({
        ...current,
        state: { ...current.state, file: path, recent: pushRecent(current.state.recent, path) },
      }));
      // A narrow surface lays the tree over the file: once a file is picked,
      // the tree has done its job. Beside the file it stays put.
      if (isNarrowRef.current) setIsExplorerOpen(false);
      // The element that held focus is routinely the one the open destroys —
      // the empty state's button, or the previous file's textarea. Recover it,
      // or the root's ⌘P / ⌘S handlers stop receiving keys.
      requestAnimationFrame(restoreFocus);
    },
    [onOpenPath, restoreFocus, tabs],
  );
  // Toast actions and server answers arrive renders later; they open through this.
  const openInTabRef = useRef(openInTab);
  openInTabRef.current = openInTab;

  /** Returns whether the file opened here rather than being handed on or held back. */
  const openFile = useCallback(
    (path: string): boolean => {
      // A document shows here unless the setting hands it to BB's viewer or the
      // Mac app. Only when that fails does it open here after all, on the stub
      // that offers both ways out.
      const fallBack = () => openInTabRef.current(path);
      if (
        isDocumentPath(path) &&
        openDocumentsWith !== "panel" &&
        // A secret never leaves by itself: it opens here, behind the question.
        !isSensitivePath(path) &&
        handOff(path, openDocumentsWith, fallBack)
      ) {
        return false;
      }
      // One file at a time, so opening another would drop unsaved edits — and
      // that never happens silently.
      const current = tabs.activeTab;
      if (current !== null && current.path !== path && isDirty(current)) {
        toast.warning(`${current.path} has unsaved changes`, {
          description: "Save them with ⌘S first, or open the other file without saving.",
          // Stays until answered: a decision about losing edits must not time out.
          duration: Number.POSITIVE_INFINITY,
          cancel: { label: "Keep editing", onClick: () => {} },
          action: {
            label: "Open without saving",
            onClick: () => {
              tabs.close(current.path);
              openInTabRef.current(path);
            },
          },
        });
        return false;
      }
      openInTab(path);
      return true;
    },
    [handOff, openDocumentsWith, openInTab, tabs],
  );

  // On arrival, and when the surface moves to another workspace: bring back
  // what that workspace showed last. A file named by the route wins.
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (scope === null || scopeKey === null || restoredFor.current === scopeKey) return;
    restoredFor.current = scopeKey;
    const remembered = panel.key === scopeKey ? panel.state : readPanelState(sessionStore(), scopeKey);
    if (panel.key !== scopeKey) setPanel({ key: scopeKey, state: remembered });
    if (filePath === null && remembered.file !== null) openInTabRef.current(remembered.file);
    // Keyed on the workspace alone; the rest is read as it is at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    if (scopeKey === null || panel.key !== scopeKey) return;
    writePanelState(sessionStore(), scopeKey, panel.state);
  }, [panel, scopeKey]);

  // A link that names a line: once its file is open, show that line in the source.
  const initialLineShown = useRef(false);
  useEffect(() => {
    if (initialLineShown.current || initialLine === null || filePath === null) return;
    if (tabs.activePath !== filePath) return;
    initialLineShown.current = true;
    tabs.showSource(filePath);
    revealNonce.current += 1;
    setReveal({ path: filePath, line: initialLine, nonce: revealNonce.current });
    // Runs until the routed file is the active one, then never again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.activePath, filePath, initialLine]);

  const onExpandedChange = useCallback((expanded: readonly string[]) => {
    setPanel((current) => ({ ...current, state: { ...current.state, expanded: [...expanded] } }));
  }, []);

  // A ref, not derived from the previous state: openFile resets the reveal to
  // null in the same batch, so an updater would always see null and every hit
  // would get the same nonce — and clicking one twice would not scroll again.
  const revealNonce = useRef(0);
  const openMatch = useCallback(
    (path: string, line: number) => {
      if (!openFile(path)) return;
      // A markdown file opens in Preview, which renders the document and has no
      // lines to scroll to. A search hit names a line, so show the source —
      // the same reason ⌘F flips a preview to Read.
      tabs.showSource(path);
      revealNonce.current += 1;
      setReveal({ path, line, nonce: revealNonce.current });
    },
    [openFile, tabs],
  );

  const closeFile = useCallback(
    (path: string) => {
      staleRouteFile.current = filePath;
      const tab = tabs.tabs.find((candidate) => candidate.path === path);
      const close = () => {
        setPanel((current) => ({ ...current, state: { ...current.state, file: null } }));
        // Through the ref: the action can be clicked many renders later, and the
        // captured `onOpenPath` would navigate using the route as it was then.
        onOpenPathRef.current(tabs.close(path));
      };
      if (tab !== undefined && isDirty(tab)) {
        toast.warning(`${path} has unsaved changes`, {
          duration: Number.POSITIVE_INFINITY,
          cancel: { label: "Keep editing", onClick: () => {} },
          action: { label: "Close anyway", onClick: close },
        });
        return;
      }
      close();
    },
    [filePath, tabs],
  );

  const activeTab = tabs.activeTab;
  const resolved = tree.scope;

  // git is asked only about a checkout on this Mac; elsewhere the list is
  // empty and the toggle is not offered. Home is no checkout.
  const gitignoreSupported = resolved?.isLocal === true && !isLazy;
  const isIgnored = useMemo(() => createIgnoreMatcher(tree.ignored), [tree.ignored]);
  // The tree, the name search and ⌘P all read this, so a hidden entry cannot
  // be found by name and then fail to show in the tree.
  const visibleEntries = useMemo(
    () =>
      hideIgnored && gitignoreSupported
        ? tree.entries.filter((entry) => !isIgnored(entry.path))
        : tree.entries,
    [gitignoreSupported, hideIgnored, isIgnored, tree.entries],
  );

  // --- file operations (menus in the tree) ---------------------------------

  const isCoarsePointer = useCoarsePointer();

  /** A renamed or moved entry: the open file, Recent and the session follow it. */
  const followEntry = (from: string, to: string) => {
    setPanel((current) => ({
      ...current,
      state: {
        ...current.state,
        file:
          current.state.file === null
            ? null
            : (remapPath(current.state.file, from, to) ?? current.state.file),
        recent: remapPaths(current.state.recent, from, to),
      },
    }));
    const active = tabs.activePath;
    const next = active === null ? null : remapPath(active, from, to);
    if (active === null || next === null) return;
    // As in closeFile: the route still names the old path for a render, and
    // the route effect would reopen it.
    staleRouteFile.current = filePath;
    tabs.close(active);
    tabs.open(next);
    onOpenPathRef.current(next);
  };

  /** A trashed or deleted entry: its file closes and it leaves Recent. */
  const forgetEntry = (removed: string) => {
    setPanel((current) => ({
      ...current,
      state: {
        ...current.state,
        file:
          current.state.file !== null && isSameOrInside(current.state.file, removed)
            ? null
            : current.state.file,
        recent: dropPathsUnder(current.state.recent, removed),
      },
    }));
    const active = tabs.activePath;
    if (active === null || !isSameOrInside(active, removed)) return;
    staleRouteFile.current = filePath;
    onOpenPathRef.current(tabs.close(active));
  };

  const transfers = useTransfers({
    scope: resolved,
    reloadTree: () => loadTree(scope, includeHidden),
  });

  const fileOperations = useFileOperations({
    scope: resolved,
    entries: tree.entries,
    isCoarsePointer,
    reloadTree: () => loadTree(scope, includeHidden),
    openFile,
    openInNewTab: onOpenInNewTab,
    openInMacApp: (path) => handOff(path, "external"),
    dirtyPath: activeTab !== null && isDirty(activeTab) ? activeTab.path : null,
    onMoved: followEntry,
    onRemoved: forgetEntry,
    transfers,
  });

  const revealFolderInTree = useCallback(
    (path: string) => {
      revealFolderNonce.current += 1;
      setRevealFolder({ path, nonce: revealFolderNonce.current, scopeKey });
      // Like ⌘⇧F: the tree has to be on screen to show the folder.
      setIsExplorerOpen(true);
    },
    [scopeKey],
  );

  // Find searches the file's text, and reveals a hit by highlighting its line
  // in the source viewer — the rendered pane has no lines and its text is not
  // the text being searched. So opening find on a preview tab first shows it
  // the source it is about to search.
  const openFind = () => {
    if (activeTab === null) return;
    tabs.showSource(activeTab.path);
    setFindRequest((current) => current + 1);
  };

  // Find has no bar over a rendered pane, so a tab that enters Preview — from
  // the segment, by activating it, or by closing the tab in front of it — ends
  // the find session rather than hiding it. Set during render, not in an
  // effect, so the pane never draws a bar for the frame in between.
  if (findRequest > 0 && activeTab?.mode === "preview") setFindRequest(0);
  const isFindShowing = findRequest > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const isAccel = event.metaKey || event.ctrlKey;
    if (isAccel && event.key.toLowerCase() === "p" && !event.shiftKey) {
      event.preventDefault();
      setIsQuickOpen(true);
      return;
    }
    if (isAccel && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setIsExplorerOpen(true);
      setSearchFocusRequest((current) => current + 1);
      return;
    }
    if (isAccel && event.key.toLowerCase() === "f" && !event.shiftKey) {
      // Claims the browser's own find, which cannot see a virtualized tree or
      // the textarea's unrendered lines anyway.
      event.preventDefault();
      if (activeTab?.file?.kind === "text") openFind();
      return;
    }
    if (isAccel && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (
        activeTab !== null &&
        isDirty(activeTab) &&
        activeTab.save.kind !== "saving"
      ) {
        tabs.save();
      }
      return;
    }
    if (event.key === "Escape" && isQuickOpen) {
      event.preventDefault();
      setIsQuickOpen(false);
      return;
    }
    if (event.key === "Escape" && isFindShowing) {
      event.preventDefault();
      setFindRequest(0);
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      setExplorerWidth(clampWidth(startWidth + moveEvent.clientX - startX));
    };
    const stop = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      setExplorerWidth((width) => {
        storeWidth(width);
        return width;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  };

  const explorerHeader = useMemo(
    () => (
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
        {onChangeScope === undefined && onChangeRoot !== undefined ? (
          <RootSwitcher
            root={root}
            resolved={resolved}
            onChange={(next) => {
              setIsQuickOpen(false);
              onChangeRoot(next);
            }}
          />
        ) : onChangeScope === undefined ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-xs">
            <Icon
              name={resolved?.environmentId === null ? "Folder" : "GitBranch"}
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium text-foreground">
              {resolved?.label ?? "Workspace"}
            </span>
            <span className="truncate text-muted-foreground">
              {resolved?.sublabel ?? ""}
            </span>
          </div>
        ) : (
          <WorkspacePicker
            current={resolved}
            onSelect={(next) => {
              onChangeScope(next);
              setIsQuickOpen(false);
            }}
          />
        )}
      </div>
    ),
    [onChangeRoot, onChangeScope, resolved, root],
  );

  // Documents show through the sibling plugins' viewers, which address a file
  // by checkout and relative path.
  const activeViewer = activeTab === null ? null : documentViewer(activeTab.path);
  const viewerTarget =
    activeTab === null || resolved === null
      ? null
      : viewerTargetFor(resolved, activeTab.path, context.threadId);

  // What a viewer falls back to when it cannot read the file, and what formats
  // no viewer reads get: the way out to BB's viewer or the Mac app. Memoised by
  // file, because a new component identity would remount the viewer around it.
  const activePath = activeTab?.path ?? null;
  const { confirmSecret } = fileOperations;
  /** Every button that sends the open file elsewhere asks first when it is a secret. */
  const handOffChecked = useCallback(
    (path: string, how: OpenWith): boolean => {
      void confirmSecret(path, how === "viewer" ? "Open in BB viewer" : "Open in Mac app").then((go) => {
        if (go) handOff(path, how);
      });
      return true;
    },
    [confirmSecret, handOff],
  );

  // A secret file's contents wait for a yes, once per file for as long as the
  // panel is on screen. Reset with the workspace: the same relative path in
  // another one is another file.
  const [revealedSecrets, setRevealedSecrets] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => setRevealedSecrets(new Set()), [scopeKey]);
  const isSecretHidden =
    activePath !== null && isSensitivePath(activePath) && !revealedSecrets.has(activePath);

  const HandOffFallback = useMemo(
    () =>
      function HandOffFallback() {
        return (
          <HandOffStub
            message="This file cannot be shown here."
            onHandOff={activePath === null ? null : (how) => handOffChecked(activePath, how)}
          />
        );
      },
    [activePath, handOffChecked],
  );

  const explorer = (
    <Explorer
      // Remounted per workspace so each one restores its own expanded folders.
      key={scopeKey ?? "none"}
      entries={visibleEntries}
      activePath={tabs.activePath}
      isLoading={tree.status === "loading"}
      error={tree.error}
      truncated={tree.truncated}
      hiddenSupported={tree.listing === "local"}
      includeHidden={includeHidden}
      onToggleHidden={(next) => {
        setIncludeHidden(next);
        storeHidden(next);
      }}
      onOpenFile={openFile}
      onOpenMatch={openMatch}
      onRefresh={() => loadTree(scope, includeHidden)}
      onQuickOpen={() => setIsQuickOpen(true)}
      scope={scope}
      searchFocusRequest={searchFocusRequest}
      revealFolderRequest={revealFolder?.scopeKey === scopeKey ? revealFolder : null}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        safeWrite(SORT_STORAGE_KEY, JSON.stringify(next));
      }}
      dateSortSupported={tree.listing === "local"}
      gitignoreSupported={gitignoreSupported}
      hideIgnored={hideIgnored}
      onToggleHideIgnored={(next) => {
        setHideIgnored(next);
        safeWrite(HIDE_IGNORED_STORAGE_KEY, next ? "true" : "false");
      }}
      isIgnored={isIgnored}
      header={explorerHeader}
      initialExpanded={panel.key === scopeKey ? panel.state.expanded : undefined}
      onExpandedChange={onExpandedChange}
      isSecretRevealed={(path) => revealedSecrets.has(path)}
      onRevealSecret={(path) => setRevealedSecrets((current) => new Set(current).add(path))}
      operations={fileOperations.operations}
      onUploadFiles={transfers.canUpload ? transfers.upload : undefined}
      isLazy={isLazy}
      loadingFolders={loadingFolders}
      textSearchSupported={!isLazy}
    />
  );

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      // Focusable and focused on mount so ⌘P and ⌘S work before anything inside
      // has been clicked, and again after a child that had focus unmounts —
      // unless a field outside is being typed into (lib/focus.ts).
      tabIndex={-1}
      data-explorer-root=""
      // `h-full` as well as `flex-1`: flex-1 only sizes this when the host
      // hands the surface a flex column. A thread panel tab is a definite-height
      // box, where flex-1 does nothing, the root takes its content's height, and
      // nothing inside it — the tree least of all — can ever scroll.
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background focus:outline-none"
    >
      {isExplorerOpen && isNarrow ? (
        <>
          {/* The tree lies over the file; a tap beside it puts it away. */}
          <button
            type="button"
            aria-label="Hide the file explorer"
            onClick={() => setIsExplorerOpen(false)}
            className="absolute inset-0 z-20 cursor-default bg-black/40"
          />
          <div className="absolute inset-y-0 left-0 z-30 flex w-[85%] max-w-[360px] min-h-0 flex-col overflow-hidden border-r border-border bg-background shadow-lg">
            {explorer}
          </div>
        </>
      ) : isExplorerOpen ? (
        <>
          <div
            style={{ width: explorerWidth }}
            className="flex min-h-0 shrink-0 flex-col overflow-hidden"
          >
            {explorer}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the file explorer"
            onPointerDown={startResize}
            onDoubleClick={() => {
              setExplorerWidth(DEFAULT_EXPLORER_PX);
              storeWidth(DEFAULT_EXPLORER_PX);
            }}
            className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring"
          />
        </>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* A container: labels and path parts come and go with the width of this
            row, not of the window — a side panel is narrow on any screen. */}
        <div className="@container flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <button
            type="button"
            onClick={() =>
              setIsExplorerOpen((open) => {
                // Remembered only beside the file: over it, the tree closes itself.
                if (!isNarrowRef.current) storeExplorerOpen(!open);
                return !open;
              })
            }
            aria-label={isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            title={isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
              "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              isExplorerOpen && "text-foreground",
            )}
          >
            <Icon name="PanelLeft" aria-hidden className="size-3.5" />
          </button>

          <Breadcrumb
            root={resolved?.root ?? null}
            path={activeTab?.path ?? null}
            hostName={resolved?.hostName ?? null}
            isLocal={resolved?.isLocal ?? true}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            {activeTab?.file?.kind === "text" && activeViewer === null ? (
              <>
                <span className="hidden px-2 text-[11px] text-muted-foreground @[46rem]:inline">
                  {fileMetaLabel(activeTab)}
                </span>
                <ModeToggle
                  mode={activeTab.mode}
                  hasPreview={hasPreview(activeTab.path)}
                  canPreview={canPreview(activeTab)}
                  previewOffReason={
                    isHtmlPath(activeTab.path)
                      ? "Save (⌘S) to see the page with your edits"
                      : "This file is too large to preview"
                  }
                  canEdit={activeTab.file.editable}
                  onChange={(next) => {
                    // Preview is markdown-view, which saves edits itself: leaving
                    // it rereads the file so Read and Edit do not show the old text.
                    if (activeTab.mode === "preview" && next !== "preview" && !isDirty(activeTab)) {
                      tabs.reload(activeTab.path);
                    }
                    tabs.setMode(activeTab.path, next);
                  }}
                />
                <ToolbarButton
                  icon="Search"
                  label="Find in file (⌘F)"
                  isActive={isFindShowing}
                  onClick={() =>
                    isFindShowing ? setFindRequest(0) : openFind()
                  }
                />
                <ToolbarButton
                  icon="Check"
                  label={
                    activeTab.save.kind === "saving"
                      ? "Saving…"
                      : "Save (⌘S)"
                  }
                  isDisabled={!isDirty(activeTab) || activeTab.save.kind === "saving"}
                  isSpinning={activeTab.save.kind === "saving"}
                  onClick={tabs.save}
                />
              </>
            ) : null}
            <RecentMenu
              recent={panel.state.recent.filter((path) => path !== activeTab?.path)}
              onOpen={openFile}
            />
            {activeTab !== null && resolved !== null ? (
              <>
                <ToolbarButton
                  icon="ExternalLink"
                  label="Open in BB's file preview"
                  onClick={() => handOffChecked(activeTab.path, "viewer")}
                />
                <ToolbarButton
                  icon="Laptop"
                  label="Open in Mac app"
                  onClick={() => handOffChecked(activeTab.path, "external")}
                />
              </>
            ) : null}
            {activeTab !== null ? (
              <ToolbarButton
                icon="X"
                label="Close the file"
                onClick={() => closeFile(activeTab.path)}
              />
            ) : null}
          </div>
        </div>

        {activeTab === null ? (
          <EmptyEditor
            hasWorkspace={resolved !== null}
            error={tree.error}
            listing={tree.listing}
            truncated={tree.truncated}
            excluded={tree.excluded}
            isLazy={isLazy}
            onQuickOpen={() => setIsQuickOpen(true)}
          />
        ) : isSecretHidden ? (
          <SecretGate
            path={activeTab.path}
            onShow={() => setRevealedSecrets((current) => new Set(current).add(activeTab.path))}
            onClose={() => closeFile(activeTab.path)}
          />
        ) : activeViewer !== null && viewerTarget !== null ? (
          <DocumentView target={viewerTarget} viewer={activeViewer} Original={HandOffFallback} />
        ) : (
          <FileView
            tab={activeTab}
            onChangeDraft={tabs.setDraft}
            onSave={tabs.save}
            onReload={() => tabs.reload()}
            onOverwrite={tabs.overwrite}
            onRetry={tabs.retry}
            onHandOff={
              resolved === null ? null : (how) => handOffChecked(activeTab.path, how)
            }
            renderPreview={
              viewerTarget !== null && isMarkdownPath(activeTab.path)
                ? () => <MarkdownDocument target={viewerTarget} Original={HandOffFallback} />
                : resolved !== null && isHtmlPath(activeTab.path)
                  ? () => (
                      <HtmlPage
                        hostId={resolved.hostId}
                        root={resolved.root}
                        path={activeTab.path}
                        wholeWorkspace={resolved.ref.kind !== "home"}
                        revision={activeTab.sha256}
                      />
                    )
                  : null
            }
            revealLine={
              reveal !== null && reveal.path === activeTab.path
                ? { line: reveal.line, nonce: reveal.nonce }
                : null
            }
            findRequest={findRequest}
            onCloseFind={() => {
              setFindRequest(0);
              restoreFocus();
            }}
          />
        )}
      </div>

      {fileOperations.dialog}
      {transfers.input}

      {isQuickOpen ? (
        <QuickOpen
          entries={visibleEntries}
          onOpenFile={openFile}
          onRevealFolder={revealFolderInTree}
          onClose={() => setIsQuickOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Breadcrumb({
  root,
  path,
  hostName,
  isLocal,
}: {
  root: string | null;
  path: string | null;
  hostName: string | null;
  isLocal: boolean;
}) {
  if (root === null) {
    return <span className="truncate text-xs text-muted-foreground">No workspace</span>;
  }
  const segments = path === null ? [] : path.split("/");
  const name = segments.at(-1) ?? "";
  const parent = segments.slice(0, -1).join("/");
  const rootLabel = formatHomePathForDisplay(root).split(/[/\\]/).filter(Boolean).at(-1) ?? root;

  return (
    <nav
      aria-label="File location"
      title={path === null ? root : `${root}/${path}`}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-xs"
    >
      {isLocal ? null : (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <Icon name="Laptop" aria-hidden className="size-3" />
          {hostName}
          <Icon name="ChevronRight" aria-hidden className="size-3" />
        </span>
      )}
      {/* Three parts, not one span per folder: in a narrow panel every folder
          shrank to nothing and left a row of bare chevrons. The file name keeps
          its room; the folders above it give theirs up first. */}
      <span className="hidden max-w-[35%] min-w-0 shrink-0 truncate text-muted-foreground @[30rem]:block">
        {rootLabel}
      </span>
      {parent !== "" ? (
        <span className="hidden min-w-0 shrink items-center gap-1 @[44rem]:flex">
          <Icon name="ChevronRight" aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">{parent}</span>
        </span>
      ) : null}
      {name !== "" ? (
        <>
          <Icon
            name="ChevronRight"
            aria-hidden
            className="hidden size-3 shrink-0 text-muted-foreground @[30rem]:block"
          />
          <span className="min-w-0 truncate text-foreground">{name}</span>
        </>
      ) : null}
    </nav>
  );
}

/** In place of a secret file's contents until the user says to show them. */
function SecretGate({ path, onShow, onClose }: { path: string; onShow: () => void; onClose: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
      <Icon name="Lock" aria-hidden className="size-6 text-muted-foreground" />
      <p className="max-w-sm text-foreground">This looks like a secret file — keys, tokens or passwords.</p>
      <p className="max-w-sm break-all text-xs text-muted-foreground">{path}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onShow}
          className="h-8 cursor-pointer rounded-md border border-border px-3 text-xs font-medium text-foreground hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          Show contents
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md px-3 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          Close
        </button>
      </div>
    </div>
  );
}

function EmptyEditor({
  hasWorkspace,
  error,
  listing,
  truncated,
  excluded,
  isLazy,
  onQuickOpen,
}: {
  hasWorkspace: boolean;
  error: string | null;
  listing: "local" | "remote";
  truncated: boolean;
  excluded: readonly string[];
  /** Home: read a folder at a time, as folders are opened. */
  isLazy: boolean;
  onQuickOpen: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon name="Code" aria-hidden className="size-8 text-muted-foreground/60" />
      {error !== null ? (
        <p className="max-w-sm text-sm text-destructive-text">{error}</p>
      ) : !hasWorkspace ? (
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a workspace to browse its files.
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Select a file to open it, or{" "}
            <button
              type="button"
              onClick={onQuickOpen}
              className="cursor-pointer font-medium text-foreground underline underline-offset-2"
            >
              go to file
            </button>
            .
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            {isLazy
              ? "The home folder is read one folder at a time, as you open them; finding by name covers the folders opened so far. "
              : ""}
            {listing === "remote"
              ? "This workspace is on another machine, so BB lists it — dotfiles are not included."
              : excluded.length === 0
                ? "Every file in the workspace is listed."
                : `Excluding ${excluded.join(", ")}.`}
            {truncated ? " The listing hit its size limit." : ""}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Preview / Read / Edit as labelled segments rather than one icon that swaps
 * meaning. An icon-only toggle has to be read twice — once for the glyph, once
 * to work out whether it shows the current mode or the one it switches to.
 */
function ModeToggle({
  mode,
  hasPreview,
  canPreview,
  previewOffReason,
  canEdit,
  onChange,
}: {
  mode: FileViewMode;
  /** Only markdown and HTML have a rendered form; every other file gets two segments. */
  hasPreview: boolean;
  canPreview: boolean;
  /** Why Preview is off, shown on the segment when it is. */
  previewOffReason: string;
  canEdit: boolean;
  onChange: (mode: FileViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="File mode"
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {hasPreview ? (
        <ModeSegment
          icon="FileText"
          label="Preview"
          isSelected={mode === "preview"}
          // Markdown renders in one synchronous pass over the whole document,
          // so a huge one would freeze the surface; a page shows the file on
          // disk, not unsaved edits. The segment says why it is off.
          isDisabled={!canPreview}
          title={canPreview ? undefined : previewOffReason}
          onClick={() => onChange("preview")}
        />
      ) : null}
      <ModeSegment
        icon="Eye"
        label="Read"
        isSelected={mode === "read"}
        onClick={() => onChange("read")}
      />
      <ModeSegment
        icon="Edit"
        label="Edit"
        isSelected={mode === "edit"}
        // A file too large to edit stays readable; the segment says why.
        isDisabled={!canEdit && mode !== "edit"}
        title={canEdit ? undefined : "This file is too large to edit"}
        onClick={() => onChange("edit")}
      />
    </div>
  );
}

function ModeSegment({
  icon,
  label,
  isSelected,
  isDisabled,
  title,
  onClick,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-pressed={isSelected}
      title={title ?? label}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default text-muted-foreground opacity-40"
          : isSelected
            ? "cursor-pointer bg-state-active text-foreground"
            : "cursor-pointer text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3" />
      <span className="hidden @[40rem]:inline">{label}</span>
    </button>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  isActive,
  isDisabled,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isDisabled?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true
          ? "cursor-default opacity-40"
          : "cursor-pointer hover:bg-state-hover hover:text-foreground",
        isActive === true && "text-foreground",
      )}
    >
      <Icon
        name={icon}
        aria-hidden
        className={cn("size-3.5", isSpinning === true && "animate-spin")}
      />
    </button>
  );
}

/**
 * The file as BB's navigation API names it: through its checkout when the
 * workspace is one, so BB keeps it tied to that worktree; otherwise by host and
 * absolute path.
 */
function liveTargetFor(scope: ResolvedScope, path: string): ExperimentalLiveFileTarget {
  return scope.environmentId === null
    ? { kind: "host", hostId: scope.hostId, path: absolutePathFor(scope.root, path) }
    : { kind: "workspace", environmentId: scope.environmentId, path };
}

/**
 * The file as the embedded viewers address it: by checkout, relative to it.
 * Home is no checkout, so a Home file goes by host and absolute path; the
 * viewers place a host file through an environment — the thread's, or, on the
 * Files page where there is no thread, any one on this Mac the server named.
 */
function viewerTargetFor(scope: ResolvedScope, path: string, threadId: string | null): ViewerTarget {
  if (scope.ref.kind === "home") {
    return {
      path: absolutePathFor(scope.root, path),
      source: {
        kind: "host",
        threadId,
        environmentId: scope.anchorEnvironmentId ?? null,
        projectId: null,
        experimental_hostId: scope.hostId,
      },
    };
  }
  return {
    path,
    source: {
      kind: "workspace",
      threadId: null,
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      // A project checkout has no environment of its own; the host picks it.
      ...(scope.environmentId === null ? { experimental_hostId: scope.hostId } : {}),
    },
  };
}

function clampWidth(value: number): number {
  return Math.min(MAX_EXPLORER_PX, Math.max(MIN_EXPLORER_PX, Math.round(value)));
}

function readStoredWidth(): number {
  const stored = safeRead(WIDTH_STORAGE_KEY);
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_EXPLORER_PX;
}

function storeWidth(value: number): void {
  safeWrite(WIDTH_STORAGE_KEY, String(value));
}

function readStoredExplorerOpen(): boolean {
  return safeRead(EXPLORER_OPEN_STORAGE_KEY) !== "false";
}

function storeExplorerOpen(value: boolean): void {
  safeWrite(EXPLORER_OPEN_STORAGE_KEY, value ? "true" : "false");
}

function readStoredHidden(): boolean {
  return safeRead(HIDDEN_STORAGE_KEY) !== "false";
}

function storeHidden(value: boolean): void {
  safeWrite(HIDDEN_STORAGE_KEY, value ? "true" : "false");
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, embedded webview); the
    // preference simply does not persist.
  }
}
