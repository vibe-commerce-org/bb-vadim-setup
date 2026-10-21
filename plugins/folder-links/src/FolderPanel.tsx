// The folder tab in the thread's side panel: the folder from the chat link as
// the root of a tree. Subfolders expand in place, "Выше" moves the root one
// level up (no higher than the home folder), and a file opens through BB's own
// file preview — so a .md goes to whatever opener BB picks for .md. When the
// link named a folder that does not exist, the tab shows its nearest existing
// folder with a note saying so.
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "../rpc";
import type { FolderEntry } from "./folders";
import { folderTabOf, folderTitle } from "./folder-tab";
import { hostFilePath } from "./link-path";

type Listing =
  | { status: "loading" }
  | { status: "ok"; path: string; entries: FolderEntry[]; parent: string | null; truncated: boolean }
  | { status: "error"; message: string };

const SMALL_BUTTON =
  "inline-flex h-7 flex-none items-center justify-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
const ROW =
  "flex w-full min-w-0 items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-sm text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 16}px` });

export function FolderPanel({ params }: PluginThreadPanelProps) {
  const tab = folderTabOf(params);
  if (tab === null) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Здесь открывается папка из чата: кликните по ссылке на папку в сообщении.
      </p>
    );
  }
  return <FolderTree key={`${tab.path}\n${tab.missing ?? ""}`} start={tab.path} missing={tab.missing} />;
}

function FolderTree({ start, missing }: { start: string; missing: string | null }) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [root, setRoot] = useState(start);
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hostId, setHostId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const put = (path: string, listing: Listing) => {
    if (mounted.current) setListings((previous) => new Map(previous).set(path, listing));
  };

  const load = useCallback(
    async (path: string) => {
      setListings((previous) => (previous.get(path)?.status === "ok" ? previous : new Map(previous).set(path, { status: "loading" })));
      try {
        const result = await rpc.call("list", { path });
        if (!result.ok) return put(path, { status: "error", message: result.message });
        if (mounted.current) setHostId(result.hostId);
        put(path, { status: "ok", path: result.path, entries: result.entries, parent: result.parent, truncated: result.truncated });
      } catch (cause) {
        put(path, { status: "error", message: `Сервер плагина не ответил: ${cause instanceof Error ? cause.message : String(cause)}` });
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!listings.has(root)) void load(root);
  }, [root, listings, load]);

  const refresh = () => {
    for (const path of [root, ...expanded]) void load(path);
  };

  const toggle = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening && listings.get(path)?.status !== "ok") void load(path);
  };

  const openFile = (path: string) => {
    setOpenError(null);
    const opened =
      hostId !== null &&
      navigate.experimental_openFilePreview({ target: { kind: "host", hostId, path: hostFilePath(path) }, location: null });
    if (!opened) setOpenError(`BB не открыл файл ${path}`);
  };

  const rootListing = listings.get(root);
  const parent = rootListing?.status === "ok" ? rootListing.parent : null;
  // The folder as the server spells it: `C:\Users\Имя\repo` for a link written `c:/users/Имя/repo`.
  const rootShown = rootListing?.status === "ok" ? rootListing.path : root;

  const renderListing = (path: string, depth: number) => {
    const listing = listings.get(path);
    if (listing === undefined || listing.status === "loading") {
      return (
        <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>
          Загружаю…
        </p>
      );
    }
    if (listing.status === "error") {
      return (
        <p role="alert" className="py-1 text-xs text-muted-foreground" style={indent(depth)}>
          {listing.message}
        </p>
      );
    }
    if (listing.entries.length === 0) {
      return (
        <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>
          Пусто
        </p>
      );
    }
    return (
      <>
        {listing.entries.map((entry) => renderEntry(entry, depth))}
        {listing.truncated ? (
          <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>
            Показаны первые {listing.entries.length} элементов.
          </p>
        ) : null}
      </>
    );
  };

  const renderEntry = (entry: FolderEntry, depth: number) => {
    const muted = entry.muted ? " opacity-60" : "";
    if (entry.outside) {
      return (
        <div key={entry.path} className={`${ROW} cursor-not-allowed opacity-40`} style={indent(depth)} title="Ссылка за пределы разрешённых папок">
          <span className="size-3.5 flex-none" />
          <Icon name={entry.kind === "directory" ? "Folder" : "File"} className="size-4 flex-none" aria-hidden />
          <span className="truncate">{entry.name}</span>
        </div>
      );
    }
    if (entry.kind === "file") {
      return (
        <button key={entry.path} type="button" className={ROW + muted} style={indent(depth)} title={entry.path} onClick={() => openFile(entry.path)}>
          <span className="size-3.5 flex-none" />
          <Icon name="File" className="size-4 flex-none text-muted-foreground" aria-hidden />
          <span className="truncate">{entry.name}</span>
        </button>
      );
    }
    const open = expanded.has(entry.path);
    return (
      <div key={entry.path}>
        <button type="button" className={ROW + muted} style={indent(depth)} title={entry.path} aria-expanded={open} onClick={() => toggle(entry.path)}>
          <Icon name="ChevronRight" className={`size-3.5 flex-none text-muted-foreground transition-transform${open ? " rotate-90" : ""}`} aria-hidden />
          <Icon name="Folder" className="size-4 flex-none text-muted-foreground" aria-hidden />
          <span className="truncate">{entry.name}</span>
        </button>
        {open ? renderListing(entry.path, depth + 1) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-border px-2 text-xs text-muted-foreground">
        <button type="button" className={SMALL_BUTTON} disabled={parent === null} onClick={() => parent !== null && setRoot(parent)} title="Подняться на уровень выше">
          <Icon name="ArrowUp" className="size-3.5" aria-hidden />
          Выше
        </button>
        <span className="min-w-0 flex-1 truncate" title={rootShown} dir="rtl">
          <bdi>{rootShown}</bdi>
        </span>
        <button type="button" className={SMALL_BUTTON} onClick={refresh}>
          Обновить
        </button>
      </div>
      {missing !== null && root === start ? (
        <p role="note" className="flex-none border-b border-border bg-state-hover px-3 py-2 text-xs text-foreground" title={missing}>
          Папки «{folderTitle(missing)}» нет — показана «{folderTitle(start)}».
        </p>
      ) : null}
      {openError !== null ? (
        <p role="alert" className="flex-none border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {openError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-1">{renderListing(root, 0)}</div>
    </div>
  );
}
