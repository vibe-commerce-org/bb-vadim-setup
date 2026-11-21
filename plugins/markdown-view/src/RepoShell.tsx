// The document with the repository beside it: "Дерево" shows the repository's
// files with the open one marked, "Копировать путь" puts the file's full path
// on the clipboard. A Markdown file picked in the tree replaces the document
// in this same tab (the editor writes what was left unsaved as it goes); any
// other file goes to BB's own preview. In a wide panel the tree is a column
// beside the document; in a narrow one (a phone) it slides over it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { CopyPathButton } from "./CopyPathButton";
import { Editor } from "./Editor";
import type { FileLocation } from "./file-access";
import { TreeIcon } from "./icons";
import { fileTarget } from "./links";
import { RepoTree } from "./RepoTree";
import { findRepoRoot, isMarkdownName, relativeTo } from "./repo-tree";
import type { TreeEntry } from "./repo-tree";
import { ICON_BUTTON, ICON_BUTTON_ON, TOOL_BUTTON, TOOL_BUTTON_ON, ToolText, useLatest } from "./ui";

/** A panel at least this wide keeps the tree beside the document; a narrower one slides it over. */
const WIDE_PANEL_PX = 720;
const TREE_WIDTH_PX = 260;
const FLAG_KEY = "bb-plugin-markdown-view:tree";
const NOTICE_MS = 4000;

function useIsWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWide(element.clientWidth >= WIDE_PANEL_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return wide;
}

/** Whether a wide panel shows the tree; closed until the reader opens it, then remembered. */
function useTreeWanted(): [boolean, (wanted: boolean) => void] {
  const [wanted, setWanted] = useState(() => {
    try {
      return localStorage.getItem(FLAG_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setWanted(next);
    try {
      localStorage.setItem(FLAG_KEY, next ? "1" : "0");
    } catch {
      // No storage (private mode): the choice lasts until the tab closes.
    }
  };
  return [wanted, set];
}

export function RepoShell({ file, onOriginal }: { file: FileLocation; onOriginal: () => void }) {
  const sdk = useLatest(useSdk());
  const navigate = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useIsWide(rootRef);
  const [wanted, setWanted] = useTreeWanted();
  const [drawer, setDrawer] = useState(false);
  const open = wide ? wanted : drawer;
  // The file on screen: the one BB opened, until a Markdown file is picked in the tree.
  const [active, setActive] = useState(file.path);
  const activeFile = useMemo<FileLocation>(() => ({ ...file, path: active }), [file, active]);
  // For a bare host file: undefined until looked up, null when it sits in no repository.
  const [found, setFound] = useState<string | null | undefined>(undefined);
  const root = file.root ?? found ?? null;
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  // A file BB opened without a checkout: its repository is the nearest folder above it with .git.
  useEffect(() => {
    if (!open || file.root !== null || found !== undefined) return;
    let cancelled = false;
    const hasGit = async (folder: string) => {
      // `.git/HEAD` in a repository, a `.git` file in a worktree.
      for (const marker of [`${folder}/.git/HEAD`, `${folder}/.git`]) {
        try {
          await sdk.current.files.read({ hostId: file.hostId, path: marker });
          return true;
        } catch {
          // Not there: try the next marker, then the next folder up.
        }
      }
      return false;
    };
    void findRepoRoot(file.path, hasGit).then((repository) => {
      if (!cancelled) setFound(repository);
    });
    return () => {
      cancelled = true;
    };
  }, [open, file.root, file.hostId, file.path, found, sdk]);

  const toggleTree = () => (wide ? setWanted(!wanted) : setDrawer(!drawer));

  const openEntry = (entry: TreeEntry) => {
    if (!wide) setDrawer(false);
    if (isMarkdownName(entry.name)) {
      setActive(entry.path);
      return;
    }
    const opened = navigate.experimental_openFilePreview({ target: fileTarget(entry.path, file), location: null });
    if (!opened) {
      setNotice("BB не открыл этот файл здесь");
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
    }
  };

  const leading = (compact: boolean) => (
    <>
      <button
        type="button"
        className={compact ? (open ? ICON_BUTTON_ON : ICON_BUTTON) : open ? TOOL_BUTTON_ON : TOOL_BUTTON}
        aria-pressed={open}
        aria-label="Дерево"
        title="Показать или скрыть дерево файлов репозитория"
        onClick={toggleTree}
      >
        <TreeIcon />
        <ToolText compact={compact}>Дерево</ToolText>
      </button>
      <CopyPathButton path={active} compact={compact} />
    </>
  );

  const tree =
    root !== null ? (
      <RepoTree
        key={root}
        hostId={file.hostId}
        root={root}
        current={active}
        onOpen={openEntry}
        onClose={wide ? undefined : () => setDrawer(false)}
      />
    ) : (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        {found === undefined ? "Ищу репозиторий…" : "Файл вне git-репозитория: дереву не от чего начаться."}
      </div>
    );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 w-full">
      {open && wide && (
        <aside className="h-full min-h-0 flex-none border-r border-border" style={{ width: TREE_WIDTH_PX }}>
          {tree}
        </aside>
      )}
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        <Editor
          key={active}
          file={activeFile}
          onOriginal={active === file.path ? onOriginal : undefined}
          leading={leading}
          location={root === null ? active : (relativeTo(root, active) ?? active)}
        />
        {notice !== null && (
          <div role="status" className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
            <span className="rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground shadow">{notice}</span>
          </div>
        )}
      </div>
      {open && !wide && (
        <>
          <button
            type="button"
            aria-label="Закрыть дерево"
            className="absolute inset-0 z-20 bg-black/40"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 z-30 w-[min(85%,320px)] border-r border-border bg-background shadow-xl">{tree}</aside>
        </>
      )}
    </div>
  );
}
