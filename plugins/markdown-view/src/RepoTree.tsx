// The repository tree: a folder is listed when it is opened, the file on
// screen is marked and brought into view. Listing goes through BB's host
// directory API (`sdk.hosts.directory`), which works on any connected host and
// does not return hidden files and folders (`.claude`, `.github`).
import { useCallback, useEffect, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { folderChain, visibleEntries } from "./repo-tree";
import type { TreeEntry } from "./repo-tree";
import { useLatest } from "./ui";

interface Folder {
  /** Null until the first listing arrives; kept while a refresh is under way. */
  entries: TreeEntry[] | null;
  loading: boolean;
  error: string | null;
}

type Row =
  | { type: "entry"; entry: TreeEntry; depth: number }
  | { type: "note"; key: string; depth: number; text: string; retry?: string };

// The marked row: the accent, faint across the row and strong on its left edge.
const TREE_CSS = `
.mdv-tree-row[aria-current="true"] {
  background-color: color-mix(in srgb, var(--primary) 14%, transparent);
  box-shadow: inset 3px 0 0 var(--primary);
  color: var(--foreground);
  font-weight: 600;
}
`;

const ROW =
  "mdv-tree-row flex min-h-9 w-full items-center gap-1.5 pr-2 text-left text-sm text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const ICON_BUTTON =
  "inline-flex size-8 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "/";

export function RepoTree({
  hostId,
  root,
  current,
  onOpen,
  onClose,
}: {
  hostId: string;
  root: string;
  /** Absolute path of the file on screen; marked, and its folders opened. */
  current: string;
  onOpen: (entry: TreeEntry) => void;
  /** Where the tree covers the document (a phone), a way to put it away. */
  onClose?: () => void;
}) {
  const sdk = useLatest(useSdk());
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(folderChain(root, current)));
  const requested = useRef(new Set<string>());
  const lifetime = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const centeredOn = useRef<string | null>(null);

  // First among the effects: the loads below take their signal from it.
  useEffect(() => {
    lifetime.current = new AbortController();
    const asked = requested.current;
    return () => {
      lifetime.current?.abort();
      asked.clear();
    };
  }, []);

  const load = useCallback(
    (folder: string, force = false) => {
      if (!force && requested.current.has(folder)) return;
      requested.current.add(folder);
      const signal = lifetime.current?.signal;
      const settle = (next: (before: Folder | undefined) => Folder) => {
        if (!signal?.aborted) setFolders((all) => ({ ...all, [folder]: next(all[folder]) }));
      };
      settle((before) => ({ entries: before?.entries ?? null, loading: true, error: null }));
      sdk.current.hosts.directory({ hostId, path: folder, signal }).then(
        (listing) => settle(() => ({ entries: visibleEntries(listing.entries), loading: false, error: null })),
        (error: unknown) => {
          requested.current.delete(folder);
          settle((before) => ({
            entries: before?.entries ?? null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        },
      );
    },
    [hostId, sdk],
  );

  // The root and every folder on the way to the file on screen: opened and listed.
  useEffect(() => {
    const chain = folderChain(root, current);
    setExpanded((before) => (chain.every((folder) => before.has(folder)) ? before : new Set([...before, ...chain])));
    for (const folder of chain.length > 0 ? chain : [root]) load(folder);
  }, [root, current, load]);

  // Once its row exists, bring the file on screen into view — once per file, so opening a folder
  // elsewhere does not pull the list back.
  useEffect(() => {
    if (centeredOn.current === current) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !row) return;
    centeredOn.current = current;
    const visible = row.offsetTop >= list.scrollTop && row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight;
    if (!visible) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
  });

  const toggle = (folder: string) => {
    const wasOpen = expanded.has(folder);
    setExpanded((before) => {
      const next = new Set(before);
      if (wasOpen) next.delete(folder);
      else next.add(folder);
      return next;
    });
    if (!wasOpen) load(folder);
  };

  const refresh = () => {
    for (const folder of Object.keys(folders)) load(folder, true);
  };

  const rows: Row[] = [];
  const addFolder = (folder: string, depth: number) => {
    const state = folders[folder];
    if (state?.error && state.entries === null) {
      rows.push({ type: "note", key: `${folder}:error`, depth, text: `Не удалось открыть папку: ${state.error}`, retry: folder });
      return;
    }
    if (!state || state.entries === null) {
      rows.push({ type: "note", key: `${folder}:loading`, depth, text: "Загружаю…" });
      return;
    }
    if (state.entries.length === 0) rows.push({ type: "note", key: `${folder}:empty`, depth, text: "Пусто" });
    for (const entry of state.entries) {
      rows.push({ type: "entry", entry, depth });
      if (entry.kind === "directory" && expanded.has(entry.path)) addFolder(entry.path, depth + 1);
    }
  };
  addFolder(root, 0);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <style>{TREE_CSS}</style>
      <div className="flex min-h-10 flex-none items-center gap-1 border-b border-border pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground" title={root}>
          {basename(root)}
        </span>
        <button type="button" className={ICON_BUTTON} title="Обновить дерево" aria-label="Обновить дерево" onClick={refresh}>
          <RefreshIcon />
        </button>
        {onClose && (
          <button type="button" className={ICON_BUTTON} title="Закрыть дерево" aria-label="Закрыть дерево" onClick={onClose}>
            <CloseIcon />
          </button>
        )}
      </div>
      <div ref={listRef} role="tree" aria-label="Файлы репозитория" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
        {rows.map((row) => {
          const indent = { paddingLeft: 8 + row.depth * 14 };
          if (row.type === "note") {
            return (
              <div key={row.key} className="flex min-h-8 items-center gap-2 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: indent.paddingLeft + 22 }}>
                <span className="min-w-0 break-words">{row.text}</span>
                {row.retry !== undefined && (
                  <button type="button" className="flex-none underline" onClick={() => load(row.retry!, true)}>
                    Повторить
                  </button>
                )}
              </div>
            );
          }
          const { entry } = row;
          const isDirectory = entry.kind === "directory";
          const isOpen = isDirectory && expanded.has(entry.path);
          const isCurrent = entry.path === current;
          return (
            <button
              key={entry.path}
              type="button"
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={isDirectory ? isOpen : undefined}
              aria-selected={isCurrent}
              aria-current={isCurrent ? "true" : undefined}
              title={entry.name}
              className={ROW}
              style={indent}
              onClick={() => (isDirectory ? toggle(entry.path) : onOpen(entry))}
            >
              {isDirectory ? <ChevronIcon open={isOpen} /> : <span className="size-4 flex-none" aria-hidden />}
              {isDirectory ? <FolderIcon /> : <FileIcon />}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const ICON = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg {...ICON} className={`size-4 flex-none text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg {...ICON} className="size-4 flex-none text-muted-foreground">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg {...ICON} className="size-4 flex-none text-muted-foreground">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg {...ICON} className="size-4">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...ICON} className="size-4">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
