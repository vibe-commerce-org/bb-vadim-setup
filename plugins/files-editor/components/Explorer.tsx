import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  buildTree,
  rankByName,
  visibleRows,
  type EntryKind,
  type FlatEntry,
  type NameMatch,
  type TreeRow,
  type TreeSort,
} from "@/lib/tree";
import type { ScopeRef } from "@/lib/route";
import { entryMenuGroups, type EntryAction, type MenuEntry } from "@/lib/entry-menu";
import { canDropInto, nameProblem, parentPath, remapPaths, stemLength } from "@/lib/entry-paths";
import { EntryContextMenu, EntryMenuButton } from "./EntryMenu";
import { FileGlyph } from "./FileGlyph";
import { NameResults } from "./NameResults";
import { SearchResults } from "./SearchResults";
import { SortMenu } from "./SortMenu";
import type { ExplorerOperations } from "./use-file-operations";

/** A folder to bring into view; the nonce re-reveals the same folder. */
export interface RevealFolderRequest {
  path: string;
  nonce: number;
}

export interface ExplorerProps {
  entries: readonly FlatEntry[];
  activePath: string | null;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;
  /** BB's remote listing cannot return dotfiles, so the toggle is disabled. */
  hiddenSupported: boolean;
  includeHidden: boolean;
  onToggleHidden: (next: boolean) => void;
  onOpenFile: (path: string) => void;
  /** A hit from the text search: open the file on that line. */
  onOpenMatch: (path: string, line: number) => void;
  onRefresh: () => void;
  onQuickOpen: () => void;
  /** The workspace the text search runs in; null while none is resolved. */
  scope: ScopeRef | null;
  /** Bumped by ⌘⇧F: switch the field to text search, focus it, select what is in it. */
  searchFocusRequest: number;
  /** A folder picked elsewhere (⌘P) to open, scroll to and highlight in the tree. */
  revealFolderRequest?: RevealFolderRequest | null;
  sort: TreeSort;
  onSortChange: (next: TreeSort) => void;
  /** Only a walk of this Mac has modification times. */
  dateSortSupported: boolean;
  /** Whether git can say what is ignored here — a checkout on this Mac. */
  gitignoreSupported: boolean;
  hideIgnored: boolean;
  onToggleHideIgnored: (next: boolean) => void;
  /** Gitignored entries still listed are drawn dimmed. */
  isIgnored: (path: string) => boolean;
  header: React.ReactNode;
  /** Where the tree lies over the file (a phone), a way to put it away: it covers the button that shows it. */
  onClose?: () => void;
  /** Folders open when the tree mounts — BB remounts a panel tab on every visit. */
  initialExpanded?: readonly string[];
  /** Told every time a folder opens or closes, so the surface can keep it. */
  onExpandedChange?: (expanded: readonly string[]) => void;
  /** Whether a secret file's contents may show — shared with the open file's question. */
  isSecretRevealed?: (path: string) => boolean;
  onRevealSecret?: (path: string) => void;
  /** The row menus and file operations; null while no workspace is resolved. */
  operations?: ExplorerOperations | null;
  /** Files dropped from Finder onto a folder ("" is the root); omitted where uploads cannot go. */
  onUploadFiles?: (folder: string, files: File[]) => void;
  /**
   * The tree is read folder by folder (Home): name search covers what has been
   * read so far, and the field says so.
   */
  isLazy?: boolean;
  /** Folders being read right now; their chevron spins. */
  loadingFolders?: ReadonlySet<string>;
  /** Search inside files; off in Home, where it would read the whole home folder. */
  textSearchSupported?: boolean;
}

/** A name being typed in the tree: a rename in place, or a new entry in a folder. */
type NameEdit =
  | { kind: "rename"; path: string; entryKind: EntryKind }
  | { kind: "create"; parent: string; entryKind: EntryKind };

/** Marks a drag as one of this tree's rows, not files dragged in from Finder. */
const DRAG_TYPE = "application/x-files-editor-entry";

const NO_FOLDERS: ReadonlySet<string> = new Set();

/** Files dragged in from outside the page (Finder), not one of the tree's own rows. */
function isFileDrag(event: React.DragEvent): boolean {
  // `types` is always there in a browser; a throw in a drag handler would
  // take the whole panel down, so it is read defensively.
  const types = Array.from((event.dataTransfer as DataTransfer | undefined)?.types ?? []);
  return types.includes("Files") && !types.includes(DRAG_TYPE);
}

/**
 * The files of a drop, read while the event is live (the list is emptied once
 * the handler returns). Folders are counted, not uploaded: only files go.
 */
function droppedFiles(dataTransfer: DataTransfer): { files: File[]; folders: number } {
  const files: File[] = [];
  let folders = 0;
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry?.isDirectory === true) {
        folders += 1;
        continue;
      }
      const file = item.getAsFile();
      if (file !== null) files.push(file);
    }
    return { files, folders };
  }
  return { files: Array.from(dataTransfer.files ?? []), folders };
}

/**
 * A long press opens the row menu on a touch screen; the tap that ends it must
 * not also open the file. Clicks this soon after the menu opened are ignored.
 */
const AFTER_MENU_CLICK_MS = 700;

/**
 * What the field over the tree looks for. Names by default — files and folders
 * alike, so typing a folder's name finds the folder; the text of every file
 * behind the toggle in the field and ⌘⇧F.
 */
type SearchMode = "names" | "text";

const INDENT_PER_LEVEL_PX = 10;

/** Rows mounted at once. Beyond this the footer says how many were held back. */
const ROW_LIMIT = 600;

/** Name matches listed at once; the ranking puts the useful ones on top. */
const NAME_RESULT_LIMIT = 200;

export function Explorer({
  entries,
  activePath,
  isLoading,
  error,
  truncated,
  hiddenSupported,
  includeHidden,
  onToggleHidden,
  onOpenFile,
  onOpenMatch,
  onRefresh,
  onQuickOpen,
  scope,
  searchFocusRequest,
  revealFolderRequest = null,
  sort,
  onSortChange,
  dateSortSupported,
  gitignoreSupported,
  hideIgnored,
  onToggleHideIgnored,
  isIgnored,
  header,
  onClose,
  initialExpanded,
  onExpandedChange,
  isSecretRevealed = () => false,
  onRevealSecret = () => {},
  operations = null,
  onUploadFiles,
  isLazy = false,
  loadingFolders = NO_FOLDERS,
  textSearchSupported = true,
}: ExplorerProps) {
  const [mode, setMode] = useState<SearchMode>("names");
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [submitNonce, setSubmitNonce] = useState(0);
  // The name result the arrow keys are on; Enter picks it.
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(initialExpanded ?? []),
  );
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  // The folder a name search or ⌘P led to, marked until the next click in the tree.
  const [revealed, setRevealed] = useState<RevealFolderRequest | null>(null);
  const revealedRowRef = useRef<HTMLButtonElement | null>(null);
  const revealNonce = useRef(0);

  // Through a ref: the surface rebuilds the callback every render, and an
  // effect keyed on it would report the same set over and over.
  const onExpandedChangeRef = useRef(onExpandedChange);
  onExpandedChangeRef.current = onExpandedChange;
  useEffect(() => {
    onExpandedChangeRef.current?.([...expanded]);
  }, [expanded]);

  const hasQuery = query.trim() !== "";
  const isTextSearching = mode === "text" && query !== "" && scope !== null;
  const isNameSearching = mode === "names" && hasQuery;

  useEffect(() => {
    if (searchFocusRequest === 0) return;
    // Where text search is not offered, ⌘⇧F still lands in the field.
    if (textSearchSupported) setMode("text");
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocusRequest, textSearchSupported]);

  // A remembered "date" on a machine without dates sorts by name instead.
  const effectiveSort = useMemo<TreeSort>(
    () =>
      sort.key === "modified" && !dateSortSupported
        ? { key: "name", reverse: sort.reverse }
        : { key: sort.key, reverse: sort.reverse },
    [dateSortSupported, sort.key, sort.reverse],
  );
  const tree = useMemo(() => buildTree(entries, effectiveSort), [entries, effectiveSort]);

  const nameResults = useMemo(
    () =>
      isNameSearching
        ? rankByName(entries, query, NAME_RESULT_LIMIT)
        : { matches: [] as NameMatch[], truncated: false },
    [entries, isNameSearching, query],
  );
  useEffect(() => setHighlighted(0), [query, mode]);

  // Reveal the active file by opening every directory above it.
  useEffect(() => {
    if (activePath === null) return;
    setExpanded((current) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of ancestors) next.add(ancestor);
      return next;
    });
  }, [activePath]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activePath, entries.length]);

  /**
   * Show a folder in the tree: the field cleared so the tree is back, the
   * folder and everything above it open, the row scrolled to and marked.
   */
  const revealFolder = useCallback((path: string) => {
    setQuery("");
    setExpanded((current) => {
      const wanted = [...ancestorsOf(path), path];
      if (wanted.every((folder) => current.has(folder))) return current;
      const next = new Set(current);
      for (const folder of wanted) next.add(folder);
      return next;
    });
    revealNonce.current += 1;
    setRevealed({ path, nonce: revealNonce.current });
  }, []);

  // Also on mount: ⌘P can pick a folder while the tree is closed, and the
  // tree that opens for it is a fresh one.
  useEffect(() => {
    if (revealFolderRequest !== null) revealFolder(revealFolderRequest.path);
  }, [revealFolder, revealFolderRequest]);

  // After the render that cleared the field and opened the folders, so the row
  // exists. Focus moves to it too: Enter or a click there folds it again.
  useEffect(() => {
    if (revealed === null) return;
    const row = revealedRowRef.current;
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  }, [revealed]);

  const allRows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  // Expanding a huge directory (or several) can mean tens of thousands of rows.
  // Cap what is mounted rather than building them all synchronously.
  const revealedPath = revealed?.path ?? null;
  const rows = useMemo(() => {
    if (allRows.length <= ROW_LIMIT) return allRows;
    // A blind head slice can cut the row for the file that is open, or for the
    // folder just revealed, leaving nothing to select or scroll to. Keep them,
    // at the cost of as many rows from the head.
    const kept = [activePath, revealedPath]
      .map((path) => (path === null ? -1 : allRows.findIndex((row) => row.node.path === path)))
      .filter((index, position, all) => index >= ROW_LIMIT && all.indexOf(index) === position)
      .sort((left, right) => left - right);
    return [
      ...allRows.slice(0, ROW_LIMIT - kept.length),
      ...kept.map((index) => allRows[index]!),
    ];
  }, [activePath, allRows, revealedPath]);

  const toggle = (path: string) => {
    setRevealed(null);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFromTree = (path: string) => {
    setRevealed(null);
    onOpenFile(path);
  };

  // --- file operations ---------------------------------------------------

  const [edit, setEdit] = useState<NameEdit | null>(null);
  // The folder a dragged row would land in; "" is the root.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragSource = useRef<MenuEntry | null>(null);
  const menuContext = operations?.menuContext ?? null;
  const canDrag = operations !== null && menuContext?.isCoarsePointer === false;

  const expandFolders = useCallback((folders: readonly string[]) => {
    setExpanded((current) => {
      if (folders.every((folder) => current.has(folder))) return current;
      const next = new Set(current);
      for (const folder of folders) next.add(folder);
      return next;
    });
  }, []);

  /** A renamed or moved folder stays open under its new name. */
  const followFolder = useCallback((from: string, to: string) => {
    setExpanded((current) => new Set(remapPaths([...current], from, to)));
  }, []);

  const onMenuAction = (action: EntryAction, entry: MenuEntry | null) => {
    if (operations === null) return;
    if (action === "upload" && entry === null) {
      // The empty space below the rows: into the root.
      operations.run(action, { path: "", kind: "directory" });
      return;
    }
    if (action === "newFile" || action === "newFolder") {
      const parent = entry?.path ?? "";
      if (parent !== "") expandFolders([...ancestorsOf(parent), parent]);
      setQuery("");
      setEdit({ kind: "create", parent, entryKind: action === "newFile" ? "file" : "directory" });
      return;
    }
    if (action === "rename") {
      if (entry !== null) setEdit({ kind: "rename", path: entry.path, entryKind: entry.kind });
      return;
    }
    if (entry !== null) operations.run(action, entry);
  };

  const commitName = async (name: string): Promise<boolean> => {
    if (operations === null || edit === null) return false;
    if (edit.kind === "create") {
      const created = await operations.create(edit.parent, name, edit.entryKind);
      if (created) setEdit(null);
      return created;
    }
    const entry = { path: edit.path, kind: edit.entryKind };
    const renamed = await operations.rename(entry, name);
    if (renamed === null) return false;
    if (entry.kind === "directory") followFolder(entry.path, renamed);
    setEdit(null);
    return true;
  };

  const dropInto = (folder: string) => {
    const source = dragSource.current;
    dragSource.current = null;
    setDropTarget(null);
    if (operations === null || source === null || !canDropInto(source.path, folder)) return;
    void operations.move(source, folder).then((moved) => {
      if (moved === null) return;
      if (folder !== "") expandFolders([...ancestorsOf(folder), folder]);
      if (source.kind === "directory") followFolder(source.path, moved);
    });
  };

  /**
   * Drag handlers for an element that drops into `folder`: a row of the tree
   * (mouse only), or files from Finder to upload there.
   */
  const acceptsFiles = onUploadFiles !== undefined;
  const dropHandlers = (folder: string) =>
    canDrag || acceptsFiles
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (isFileDrag(event)) {
              if (!acceptsFiles) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              if (dropTarget !== folder) setDropTarget(folder);
              return;
            }
            if (!canDrag) return;
            const source = dragSource.current;
            if (source === null || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
            // Claimed even when refused: over a row of its own folder the drag
            // must not fall through to the space behind and offer the root.
            event.stopPropagation();
            if (!canDropInto(source.path, folder)) {
              if (dropTarget !== null) setDropTarget(null);
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dropTarget !== folder) setDropTarget(folder);
          },
          onDrop: (event: React.DragEvent) => {
            if (isFileDrag(event)) {
              if (onUploadFiles === undefined) return;
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(null);
              const { files, folders } = droppedFiles(event.dataTransfer);
              if (folders > 0) {
                toast.warning(folders === 1 ? "A folder is not uploaded" : `${folders} folders are not uploaded`, {
                  description: "Drop the files inside it instead.",
                });
              }
              if (files.length > 0) onUploadFiles(folder, files);
              return;
            }
            if (!canDrag || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            dropInto(folder);
          },
        }
      : {};

  const dragHandlers = (entry: MenuEntry) =>
    canDrag && edit === null
      ? {
          draggable: true,
          onDragStart: (event: React.DragEvent) => {
            dragSource.current = entry;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(DRAG_TYPE, entry.path);
          },
          onDragEnd: () => {
            dragSource.current = null;
            setDropTarget(null);
          },
        }
      : {};

  const pickName = (match: NameMatch) => {
    if (match.kind === "directory") revealFolder(match.path);
    else onOpenFile(match.path);
  };

  const switchMode = (next: SearchMode) => {
    setMode(next);
    inputRef.current?.focus();
  };

  const fileCount = useMemo(
    () => entries.reduce((total, entry) => total + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  const placeholder =
    mode === "text" ? "Search in files" : isLazy ? "Find in opened folders" : "Find files and folders";
  const namesTitle = isLazy
    ? "Finds files and folders by name among the folders opened so far — Home is read folder by folder, not all at once. Enter opens the top one"
    : "Find files and folders by name — Enter opens the top one";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-recessed">
      {/* The actions share the header's row: beside the field they left it too
          narrow to type in once sort and the gitignore toggle joined them. */}
      <div className="flex shrink-0 items-center">
        <div className="min-w-0 flex-1">{header}</div>
        <div className="flex shrink-0 items-center gap-0.5 pt-2 pr-2 pb-1.5">
          <ExplorerAction
            icon="Search"
            label="Go to file or folder by name (⌘P)"
            onClick={onQuickOpen}
          />
          <SortMenu sort={sort} onChange={onSortChange} dateSupported={dateSortSupported} />
          {gitignoreSupported ? (
            <ExplorerAction
              icon="FolderGit"
              label={hideIgnored ? "Show gitignored files" : "Hide gitignored files"}
              isActive={hideIgnored}
              onClick={() => onToggleHideIgnored(!hideIgnored)}
            />
          ) : null}
          {hiddenSupported ? (
            <ExplorerAction
              icon={includeHidden ? "Eye" : "EyeOff"}
              label={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
              isActive={includeHidden}
              onClick={() => onToggleHidden(!includeHidden)}
            />
          ) : null}
          <ExplorerAction
            icon="ArrowReloadHorizontal"
            label="Refresh files"
            isSpinning={isLoading}
            onClick={onRefresh}
          />
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              title="Hide the file explorer"
              aria-label="Hide the file explorer"
              className={cn(
                "ml-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md",
                "text-foreground transition-colors hover:bg-state-hover",
                "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              )}
            >
              <Icon name="X" aria-hidden className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <div className="relative min-w-0">
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
                return;
              }
              if (mode === "names") {
                const count = nameResults.matches.length;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (count === 0) return;
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setHighlighted((current) => (current + step + count) % count);
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  const match = nameResults.matches[highlighted];
                  if (match !== undefined) pickName(match);
                }
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                setSubmitNonce((current) => current + 1);
                return;
              }
              // VS Code's own bindings for the three toggles.
              if (event.altKey && !event.metaKey && !event.ctrlKey) {
                const key = event.code;
                if (key === "KeyC") setMatchCase((value) => !value);
                else if (key === "KeyW") setWholeWord((value) => !value);
                else if (key === "KeyR") setRegex((value) => !value);
                else return;
                event.preventDefault();
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            title={
              mode === "names" ? namesTitle : "Search the text of every file (⌘⇧F)"
            }
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "h-7 w-full min-w-0 rounded-md border border-border bg-background pl-7 text-sm",
              mode === "text" ? "pr-[5.9rem]" : textSearchSupported ? "pr-7" : "pr-2",
              "text-foreground placeholder:text-muted-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-px">
            {mode === "text" ? (
              <>
                <SearchToggle
                  label="Match case (⌥C). Off: smart case — exact only when the query has a capital"
                  glyph="Aa"
                  isOn={matchCase}
                  onToggle={() => setMatchCase((value) => !value)}
                />
                <SearchToggle
                  label="Match whole word (⌥W)"
                  glyph="ab"
                  underline
                  isOn={wholeWord}
                  onToggle={() => setWholeWord((value) => !value)}
                />
                <SearchToggle
                  label="Use regular expression (⌥R)"
                  glyph=".*"
                  isOn={regex}
                  onToggle={() => setRegex((value) => !value)}
                />
              </>
            ) : null}
            {textSearchSupported ? (
              <SearchToggle
                label={
                  mode === "text"
                    ? "Searching inside files — click to find files and folders by name"
                    : "Search inside files instead (⌘⇧F)"
                }
                icon="FileText"
                isOn={mode === "text"}
                onToggle={() => switchMode(mode === "text" ? "names" : "text")}
              />
            ) : null}
          </div>
        </div>
      </div>

      {isTextSearching ? (
        <SearchResults
          scope={scope}
          query={query}
          matchCase={matchCase}
          wholeWord={wholeWord}
          regex={regex}
          includeHidden={hiddenSupported && includeHidden}
          submitNonce={submitNonce}
          activePath={activePath}
          onOpenMatch={onOpenMatch}
          isSecretRevealed={isSecretRevealed}
          onRevealSecret={onRevealSecret}
        />
      ) : isNameSearching ? (
        <NameResults
          query={query}
          matches={nameResults.matches}
          truncated={nameResults.truncated}
          limit={NAME_RESULT_LIMIT}
          highlighted={highlighted}
          activePath={activePath}
          isIgnored={isIgnored}
          onHighlight={setHighlighted}
          onPick={pickName}
        />
      ) : (
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col overflow-auto pb-2",
            dropTarget === "" && "bg-primary/10",
          )}
          {...dropHandlers("")}
          onDragLeave={(event) => {
            // Files from Finder never send a dragend here: clear the mark when
            // the drag leaves the tree for good.
            const next = event.relatedTarget as Node | null;
            if (next === null || !event.currentTarget.contains(next)) setDropTarget(null);
          }}
        >
          {error !== null ? (
            <p className="px-3 py-2 text-xs text-destructive">{error}</p>
          ) : isLoading && entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Reading the workspace…</p>
          ) : (
            <>
              {rows.length === 0 && edit?.kind !== "create" ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  This workspace has no files yet.
                </p>
              ) : (
                <ul role="tree" aria-label="Workspace files" className="min-w-max shrink-0">
                  {withNewEntryRow(rows, edit).map((item) => {
                    if (item.kind === "new") {
                      return (
                        <li key="\u0000new" role="none">
                          <NameField
                            depth={item.depth}
                            entryKind={item.entryKind}
                            initialName=""
                            onCommit={commitName}
                            onCancel={() => setEdit(null)}
                          />
                        </li>
                      );
                    }
                    const { row } = item;
                    const entry: MenuEntry = { path: row.node.path, kind: row.node.kind };
                    const folder =
                      row.node.kind === "directory" ? row.node.path : parentPath(row.node.path);
                    return (
                      <ExplorerRow
                        key={row.node.path}
                        row={row}
                        query=""
                        isActive={row.node.path === activePath}
                        isRevealed={row.node.path === revealedPath}
                        isIgnored={isIgnored(row.node.path)}
                        isDropTarget={dropTarget !== null && dropTarget === row.node.path}
                        isLoadingChildren={loadingFolders.has(row.node.path)}
                        rowRef={
                          row.node.path === activePath
                            ? activeRowRef
                            : row.node.path === revealedPath
                              ? revealedRowRef
                              : undefined
                        }
                        onToggle={toggle}
                        onOpenFile={openFromTree}
                        menu={
                          menuContext === null
                            ? null
                            : {
                                groups: entryMenuGroups(entry, menuContext),
                                onAction: (action) => onMenuAction(action, entry),
                                isTouch: menuContext.isCoarsePointer,
                              }
                        }
                        rename={
                          edit?.kind === "rename" && edit.path === row.node.path
                            ? { onCommit: commitName, onCancel: () => setEdit(null) }
                            : null
                        }
                        onStartRename={
                          operations === null
                            ? undefined
                            : () => setEdit({ kind: "rename", path: entry.path, entryKind: entry.kind })
                        }
                        dragProps={{ ...dragHandlers(entry), ...dropHandlers(folder) }}
                      />
                    );
                  })}
                </ul>
              )}
              {/* The space below the rows: its own menu (new entries at the
                  root), and a drop onto the root. */}
              {menuContext === null ? (
                <div className="min-h-8 flex-1" />
              ) : (
                <EntryContextMenu
                  groups={entryMenuGroups(null, menuContext)}
                  onAction={(action) => onMenuAction(action, null)}
                >
                  <div
                    aria-hidden
                    className="min-h-8 flex-1 [-webkit-touch-callout:none] select-none"
                  />
                </EntryContextMenu>
              )}
            </>
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {isNameSearching
          ? `${nameResults.matches.length.toLocaleString()}${nameResults.truncated ? "+" : ""} ${
              nameResults.matches.length === 1 && !nameResults.truncated ? "match" : "matches"
            }`
          : `${fileCount.toLocaleString()} files${isLazy ? " loaded" : ""}`}
        {!isTextSearching && !isNameSearching && allRows.length > rows.length
          ? ` · showing first ${ROW_LIMIT.toLocaleString()}`
          : ""}
        {truncated ? " · listing truncated" : ""}
      </div>
    </div>
  );
}

type TreeItem =
  | { kind: "row"; row: TreeRow }
  | { kind: "new"; depth: number; entryKind: EntryKind };

/** The rows, with the field for a new entry first inside the folder it goes in. */
function withNewEntryRow(rows: readonly TreeRow[], edit: NameEdit | null): TreeItem[] {
  const items: TreeItem[] = rows.map((row) => ({ kind: "row", row }));
  if (edit?.kind !== "create") return items;
  const parentIndex = edit.parent === "" ? -1 : rows.findIndex((row) => row.node.path === edit.parent);
  // A parent cut off by the row cap gets the field at the top rather than none.
  const parent = parentIndex === -1 ? null : rows[parentIndex]!;
  items.splice(parent === null ? 0 : parentIndex + 1, 0, {
    kind: "new",
    depth: parent === null ? 0 : parent.depth + 1,
    entryKind: edit.entryKind,
  });
  return items;
}

interface RowMenu {
  groups: ReturnType<typeof entryMenuGroups>;
  onAction: (action: EntryAction) => void;
  /** A finger: the "⋯" stays visible, there is no hover to reveal it. */
  isTouch: boolean;
}

function ExplorerRow({
  row,
  query,
  isActive,
  isRevealed,
  isIgnored,
  isDropTarget = false,
  isLoadingChildren = false,
  rowRef,
  onToggle,
  onOpenFile,
  menu = null,
  rename = null,
  onStartRename,
  dragProps,
}: {
  row: TreeRow;
  query: string;
  isActive: boolean;
  /** The folder a name search or ⌘P just led to. */
  isRevealed: boolean;
  /** Gitignored: drawn dimmed, the way an editor greys out what git skips. */
  isIgnored: boolean;
  /** A dragged row would land in this folder. */
  isDropTarget?: boolean;
  /** A folder of a lazily read tree whose contents are on their way. */
  isLoadingChildren?: boolean;
  rowRef?: React.RefObject<HTMLButtonElement | null>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  menu?: RowMenu | null;
  /** Set while this row's name is being edited in place. */
  rename?: { onCommit: (name: string) => Promise<boolean>; onCancel: () => void } | null;
  /** F2, as in VS Code and Windows Explorer. */
  onStartRename?: () => void;
  dragProps?: React.HTMLAttributes<HTMLElement> & { draggable?: boolean };
}) {
  const { node, depth, isExpanded } = row;
  const isDirectory = node.kind === "directory";
  const menuOpenedAt = useRef(0);

  if (rename !== null) {
    return (
      <li role="none">
        <NameField
          depth={depth}
          entryKind={node.kind}
          initialName={node.name}
          isExpanded={isExpanded}
          onCommit={rename.onCommit}
          onCancel={rename.onCancel}
        />
      </li>
    );
  }

  const { draggable, onDragStart, onDragEnd, ...dropProps } = dragProps ?? {};

  const button = (
    <button
      ref={rowRef}
      type="button"
      role="treeitem"
      aria-selected={isActive || isRevealed}
      aria-expanded={isDirectory ? isExpanded : undefined}
      title={isIgnored ? `${node.path} (gitignored)` : node.path}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (Date.now() - menuOpenedAt.current < AFTER_MENU_CLICK_MS) return;
        if (isDirectory) onToggle(node.path);
        else onOpenFile(node.path);
      }}
      onKeyDown={(event) => {
        if (event.key === "F2" && onStartRename !== undefined) {
          event.preventDefault();
          onStartRename();
        }
      }}
      style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
      className={cn(
        "flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-3 text-left text-[13px]",
        // A finger needs a taller target; and a long press must open the menu,
        // not iOS's callout or a text selection.
        "pointer-coarse:h-9 [-webkit-touch-callout:none] select-none",
        isIgnored ? "text-muted-foreground/60" : "text-foreground/90",
        "hover:bg-state-hover",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
        isActive && "bg-surface-selected text-foreground",
        isRevealed && !isActive && "bg-primary/15 text-foreground",
        isDropTarget && "bg-primary/20 text-foreground ring-1 ring-primary/60 ring-inset",
      )}
    >
      {isDirectory ? (
        <Icon
          name={isLoadingChildren ? "Loading" : isExpanded ? "ChevronDown" : "ChevronRight"}
          aria-hidden
          className={cn("size-3 shrink-0 text-muted-foreground", isLoadingChildren && "animate-spin")}
        />
      ) : (
        <span aria-hidden className="w-3 shrink-0" />
      )}
      <FileGlyph
        path={node.path}
        kind={node.kind}
        isExpanded={isExpanded}
        className={isIgnored ? "opacity-60" : undefined}
      />
      <span className="truncate">
        <HighlightedText text={node.name} query={query} />
      </span>
    </button>
  );

  if (menu === null) {
    return (
      <li role="none" className="flex" {...dropProps}>
        {button}
      </li>
    );
  }

  return (
    <li role="none" className="group flex" {...dropProps}>
      <EntryContextMenu
        groups={menu.groups}
        onAction={menu.onAction}
        onOpenChange={(open) => {
          if (open) menuOpenedAt.current = Date.now();
        }}
      >
        {button}
      </EntryContextMenu>
      <EntryMenuButton
        label={`Actions for ${node.name}`}
        groups={menu.groups}
        onAction={menu.onAction}
        className={cn(
          // Pinned to the visible right edge even when a long name scrolls the tree sideways.
          "sticky right-1 h-6 w-6 pointer-coarse:h-9 pointer-coarse:w-9",
          // Shown on hover and focus with a mouse; always with a finger.
          menu.isTouch
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100",
        )}
      />
    </li>
  );
}

/**
 * A name typed in the tree, in place of the row: Enter saves, Escape cancels,
 * and so does leaving the field unchanged. A rename starts with the name
 * selected up to its extension, so typing replaces the name and keeps the type.
 */
function NameField({
  depth,
  entryKind,
  initialName,
  isExpanded = false,
  onCommit,
  onCancel,
}: {
  depth: number;
  entryKind: EntryKind;
  initialName: string;
  isExpanded?: boolean;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isSaving = useRef(false);
  // Saved: the row is about to go, and a blur on the way out must not save again.
  const isDone = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.setSelectionRange(0, entryKind === "file" ? stemLength(initialName) : initialName.length);
  }, [entryKind, initialName]);

  const commit = async (fromBlur: boolean) => {
    if (isSaving.current || isDone.current) return;
    const name = value.trim();
    // Nothing changed, or nothing typed in a new row and the field left: a cancel.
    if (name === initialName || (fromBlur && name === "")) {
      onCancel();
      return;
    }
    const problem = nameProblem(name);
    if (problem !== null) {
      toast.error(problem);
      if (fromBlur) onCancel();
      else inputRef.current?.select();
      return;
    }
    isSaving.current = true;
    const saved = await onCommit(name);
    isSaving.current = false;
    if (saved) {
      isDone.current = true;
      return;
    }
    // Refused (taken, gone): a click away gives up; Enter stays to try another name.
    if (fromBlur) onCancel();
    else inputRef.current?.focus();
  };

  return (
    <div
      style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
      className="flex h-6 items-center gap-1.5 pr-2 pointer-coarse:h-9"
    >
      {entryKind === "directory" ? (
        <Icon
          name={isExpanded ? "ChevronDown" : "ChevronRight"}
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground"
        />
      ) : (
        <span aria-hidden className="w-3 shrink-0" />
      )}
      <FileGlyph path={value === "" ? "x" : value} kind={entryKind} isExpanded={isExpanded} />
      <input
        ref={inputRef}
        type="text"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={
          initialName === ""
            ? entryKind === "file"
              ? "New file name"
              : "New folder name"
            : `Rename ${initialName}`
        }
        placeholder={entryKind === "file" ? "File name" : "Folder name"}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit(false);
            return;
          }
          if (event.key === "Escape") {
            // Here only: the surface's own Escape would close find or ⌘P.
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => void commit(true)}
        className={cn(
          "h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-[13px] text-foreground",
          "placeholder:text-muted-foreground focus-visible:outline-none pointer-coarse:h-7 pointer-coarse:text-sm",
        )}
      />
    </div>
  );
}

function SearchToggle({
  label,
  glyph,
  icon,
  underline,
  isOn,
  onToggle,
}: {
  label: string;
  glyph?: string;
  /** An icon in place of the glyph text. */
  icon?: React.ComponentProps<typeof Icon>["name"];
  underline?: boolean;
  isOn: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isOn}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-5 w-[1.35rem] cursor-pointer items-center justify-center rounded font-mono text-[10.5px] leading-none",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isOn
          ? "bg-primary/20 text-foreground ring-1 ring-primary/50"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {icon === undefined ? (
        <span className={underline === true ? "underline underline-offset-2" : undefined}>
          {glyph}
        </span>
      ) : (
        <Icon name={icon} aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

function ExplorerAction({
  icon,
  label,
  onClick,
  isActive,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
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
 * Marks the query's characters inside a name. The explorer filter is a
 * subsequence match, so matched characters can be scattered — but they are
 * emitted as contiguous runs rather than one element per character, which is
 * what keeps a filtered list of a large checkout cheap to mount.
 */
export function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const chunks = useMemo(() => highlightChunks(text, query), [text, query]);
  if (chunks === null) return <>{text}</>;

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.isMatch ? (
          <mark
            // eslint-disable-next-line react/no-array-index-key -- position IS the chunk's identity
            key={index}
            className="bg-transparent font-semibold text-primary"
          >
            {chunk.text}
          </mark>
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <span key={index}>{chunk.text}</span>
        ),
      )}
    </>
  );
}

interface HighlightChunk {
  text: string;
  isMatch: boolean;
}

/** Null when the query is empty or does not match, so the caller can bail. */
export function highlightChunks(
  text: string,
  query: string,
): HighlightChunk[] | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return null;

  // Compare and slice by code point: indexing the raw string would put the
  // mark on the wrong character in any name containing an emoji or other
  // astral character.
  const characters = [...text];
  const lowered = characters.map((character) => character.toLowerCase());
  const matched = new Set<number>();
  let cursor = 0;

  for (const needle of trimmed) {
    if (needle === " ") continue;
    const index = lowered.indexOf(needle, cursor);
    if (index === -1) return null;
    matched.add(index);
    cursor = index + 1;
  }

  const chunks: HighlightChunk[] = [];
  for (const [index, character] of characters.entries()) {
    const isMatch = matched.has(index);
    const last = chunks.at(-1);
    if (last !== undefined && last.isMatch === isMatch) last.text += character;
    else chunks.push({ text: character, isMatch });
  }
  return chunks;
}
