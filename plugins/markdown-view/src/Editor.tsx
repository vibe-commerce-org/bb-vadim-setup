// The opened file in Vditor — the engine of the VS Code Office Viewer
// extension — with the same "like Typora" look whether viewing or editing. It
// opens read-only (Vditor disabled: no caret, typing changes nothing, links
// open, the file reloads as it changes on disk) and becomes editable in place
// on "Редактировать": the same instance, so the switch is instant and the
// page stays where it was. A save writes only what was edited (see
// preserve.ts) and never over somebody else's change: each write carries the
// sha256 of the version it was based on. A file changed underneath is taken
// as is when nothing here is unsaved, and reported when something is.
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { readFromDisk, writeToDisk } from "./file-access";
import type { DiskText, FileLocation } from "./file-access";
import { linkBase, previewRoot } from "./links";
import { CheckIcon, EyeIcon, OutlineIcon, PencilIcon, SourceModeIcon, TyporaModeIcon, WordModeIcon } from "./icons";
import { LOOK_CSS } from "./look";
import { HEADINGS_SELECTOR, outlineEntries } from "./outline";
import type { OutlineEntry } from "./outline";
import { OutlineDrawer } from "./OutlineDrawer";
import { tameToolbarTouches } from "./touch-toolbar";
import { textToSave } from "./preserve";
import type { SaveScope } from "./preserve";
import {
  BUTTON,
  ICON_BUTTON,
  ICON_BUTTON_ON,
  pollDelay,
  SMALL_BUTTON,
  SMALL_BUTTON_ON,
  timeOf,
  Toolbar,
  ToolText,
  useCompact,
  useOpenLink,
  usePolling,
} from "./ui";
import { DisplayMenu, displayVariables, useDisplay } from "./display";
import { isDark, loadVditor, roundTrip, VDITOR_CDN, vditorTheme } from "./vditor";
import type { EditMode, VditorEditor } from "./vditor";

const MODES: { mode: EditMode; label: string; title: string; icon: ReactNode }[] = [
  { mode: "ir", label: "Как в Typora", title: "Разметка раскрывается там, где стоит курсор", icon: <TyporaModeIcon /> },
  { mode: "wysiwyg", label: "Как в Word", title: "Только оформленный текст", icon: <WordModeIcon /> },
  { mode: "sv", label: "Исходник", title: "Текст файла как есть, рядом — вид", icon: <SourceModeIcon /> },
];

// Vditor's default minus upload, recording, emoji and fullscreen (the panel is
// the frame), minus its own mode switch (switching here reloads the file in
// the new mode, so each mode starts from the file on disk) and minus its
// outline icon: the labelled "Оглавление" above does that and remembers it.
const TOOLBAR = [
  "headings", "bold", "italic", "strike", "link", "|",
  "list", "ordered-list", "check", "outdent", "indent", "|",
  "quote", "line", "code", "inline-code", "table", "|",
  "undo", "redo",
];

// Vditor draws a table as a block as wide as its content, scrolled sideways;
// here it spans the panel and wraps text in the cells and the header, at
// word boundaries (breaking inside words turns "1 290" into "1 29 0").
// Important (`!`): Vditor's stylesheet is unlayered and would beat any utility
// in Tailwind's layer, whatever the specificity.
const WIDE_TABLES =
  "[&_.vditor-reset_table]:table! [&_.vditor-reset_table]:w-full! [&_.vditor-reset_td]:whitespace-normal! [&_.vditor-reset_td]:break-words! [&_.vditor-reset_th]:whitespace-normal! [&_.vditor-reset_th]:break-words!";

// Typography from "Вид" (display.tsx), onto Vditor's own classes: the text of
// every mode (`.vditor-reset`) and the source mode's text area.
const TYPOGRAPHY =
  "[&_.vditor-reset]:[font-size:var(--mdv-font-size)]! [&_.vditor-reset]:[max-width:var(--mdv-width)]! [&_.vditor-reset]:[font-family:var(--mdv-font)]! [&_.vditor-sv]:[font-size:var(--mdv-font-size)]!";
const LINE_HEIGHT =
  "[&_.vditor-reset]:[line-height:var(--mdv-line-height)]! [&_.vditor-reset_p]:[line-height:inherit]! [&_.vditor-reset_li]:[line-height:inherit]!";

/** Autosave this long after the last keystroke; a save of a big file blocks the panel for a second. */
const saveDelay = (textLength: number) => (textLength > 256 * 1024 ? 5000 : 1000);

/** Vditor's content stylesheets; the document's colours come from look.ts, these only fill gaps. */
const CONTENT_THEMES = `${VDITOR_CDN}/dist/css/content-theme`;

/** BB keeps a file preview alive at most an hour; relative images load through it. */
const PREVIEW_TTL_MS = 60 * 60 * 1000;

type SaveState =
  | { kind: "saved"; at: Date | null; scope: SaveScope | null }
  | { kind: "unsaved" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

interface ImageBase {
  base: string;
  expiresAtMs: number;
}

interface Session {
  editor: VditorEditor;
  /** The file as last read or written by this editor. */
  disk: DiskText;
  /** The editor's text for `disk` before any edit; null until the editor has rendered it. */
  baseline: string | null;
  /** Edits since the last save. */
  dirty: boolean;
  saving: Promise<void> | null;
  timer: number | undefined;
  /** Where relative images load from; null when BB gave no preview of the folder. */
  images: ImageBase | null;
}

type Outcome = { kind: "written"; scope: SaveScope } | { kind: "unchanged" } | { kind: "conflict" };

/**
 * Whether the editor holds anything unsaved. Vditor reports input with a
 * delay, so a keystroke from a moment ago may not have set `dirty` yet; the
 * text itself is the final word.
 */
const hasEdits = (session: Session) =>
  session.dirty || (session.baseline !== null && session.editor.getValue() !== session.baseline);

/**
 * Writes `edited` over `session.disk`, keeping the file's own formatting
 * outside the edits. `overSha256` overrides the version the write expects,
 * which is how "keep mine" overwrites a change made elsewhere.
 */
async function persist(
  sdk: PluginBrowserBbSdk,
  file: FileLocation,
  session: Session,
  edited: string,
  normalize: (markdown: string) => string,
  overSha256?: string,
): Promise<Outcome> {
  const baseline = session.baseline ?? normalize(session.disk.text);
  const { text, scope, loaded } = textToSave(session.disk.text, baseline, edited, normalize);
  if (text === session.disk.text && overSha256 === undefined) return { kind: "unchanged" };
  const result = await writeToDisk(sdk, file, text, overSha256 ?? session.disk.sha256);
  if (!result.written) return { kind: "conflict" };
  session.disk = { text, sha256: result.sha256 };
  session.baseline = loaded;
  return { kind: "written", scope };
}

/** A short-lived address BB serves the file's folder at, so `![](chart.png)` shows. */
async function openImageBase(sdk: PluginBrowserBbSdk, file: FileLocation): Promise<ImageBase> {
  const preview = await sdk.files.createPreview({ hostId: file.hostId, rootPath: previewRoot(file), ttlMs: PREVIEW_TTL_MS });
  return { base: linkBase(file, preview.baseUrl), expiresAtMs: preview.expiresAtMs };
}

/** The element the text is typed into in the current mode. */
function editableOf(editor: VditorEditor): HTMLElement {
  const { vditor } = editor;
  const area = vditor.currentMode === "sv" ? vditor.sv : vditor.currentMode === "wysiwyg" ? vditor.wysiwyg : vditor.ir;
  return area?.element ?? vditor.element;
}

/** The element that scrolls the document: the editable itself or the nearest ancestor that overflows. */
function scrollerOf(editor: VditorEditor): HTMLElement {
  const editable = editableOf(editor);
  for (let node: HTMLElement | null = editable; node && node !== editor.vditor.element; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return editable;
}

/**
 * Puts the caret at the start of the first line on screen, without
 * scrolling: entering editing keeps the page where the reader left it.
 */
function placeCaretAtTop(editable: HTMLElement, scroller: HTMLElement): void {
  const top = Math.max(scroller.getBoundingClientRect().top, editable.getBoundingClientRect().top);
  const box = editable.getBoundingClientRect();
  const x = box.left + (parseFloat(getComputedStyle(editable).paddingLeft) || 0) + 1;
  let range: Range | null = null;
  for (let y = top + 4; !range && y < Math.min(box.bottom, top + 240); y += 6) {
    const candidate = document.caretRangeFromPoint?.(x, y) ?? null;
    if (candidate?.startContainer.nodeType === Node.TEXT_NODE && editable.contains(candidate.startContainer)) {
      range = candidate;
    }
  }
  if (!range) {
    // Nothing under the left edge (a table, an image): the first visible text below the top.
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && !range; node = walker.nextNode()) {
      const rects = node.parentElement?.getClientRects();
      if (!node.textContent?.trim() || !rects?.length || rects[rects.length - 1].bottom <= top) continue;
      range = document.createRange();
      range.setStart(node, 0);
    }
  }
  editable.focus({ preventScroll: true });
  if (!range) return;
  range.collapse(true);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Back to reading: no caret, no unfolded markup, no current-paragraph mark. */
function settleForViewing(editor: VditorEditor): void {
  const editable = editableOf(editor);
  for (const node of editable.querySelectorAll(".vditor-ir__node--expand")) node.classList.remove("vditor-ir__node--expand");
  for (const node of editable.querySelectorAll("[data-mdv-current]")) node.removeAttribute("data-mdv-current");
  editor.disabled();
  const selection = getSelection();
  if (selection?.anchorNode && editable.contains(selection.anchorNode)) selection.removeAllRanges();
  editable.blur();
}

/** The paragraph, item, heading or cell holding the caret — what gets the faint highlight. */
const CURRENT_BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, th, [data-block]";

const slug = (text: string) => text.replace(/^#+\s*/, "").trim().toLowerCase().replace(/\s+/g, "-");

export function Editor({
  file,
  onOriginal,
  leading,
  location,
}: {
  file: FileLocation;
  /** BB's own preview of the file; absent when the file on screen is not the one BB opened. */
  onOriginal?: () => void;
  /** Tools at the start of the toolbar, in viewing and in editing; told whether the panel is narrow. */
  leading?: (compact: boolean) => ReactNode;
  /** Where the file sits, shown in the viewing toolbar instead of the word "Markdown". */
  location?: string;
}) {
  const sdk = useSdk();
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const [mode, setMode] = useState<EditMode>("ir");
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<{ kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string }>({
    kind: "loading",
  });
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: null, scope: null });
  const [conflict, setConflict] = useState(false);
  const [reloadedAt, setReloadedAt] = useState<Date | null>(null);
  const [display, setDisplay] = useDisplay();
  const outlineWanted = useRef(display.outline);
  outlineWanted.current = display.outline;
  const [outlineShown, setOutlineShown] = useState(false);
  // A narrow panel (a phone): icons for words, and the outline as a list over the text.
  const compact = useCompact(rootRef);
  const [outlineList, setOutlineList] = useState<OutlineEntry[] | null>(null);
  const conflictRef = useRef(false);
  conflictRef.current = conflict;

  const toAnchor = (id: string) => {
    const current = session.current;
    if (!current) return;
    const headings = editableOf(current.editor).querySelectorAll<HTMLElement>(HEADINGS_SELECTOR);
    const wanted = id.toLowerCase();
    [...headings].find((heading) => heading.id === id || slug(heading.textContent ?? "") === wanted)?.scrollIntoView({ block: "start" });
  };
  const openLink = useOpenLink(file, toAnchor);
  const openLinkRef = useRef(openLink);
  openLinkRef.current = openLink;

  const saveNow = async (): Promise<void> => {
    const current = session.current;
    if (!current) return;
    window.clearTimeout(current.timer);
    if (current.saving) await current.saving;
    if (conflictRef.current || session.current !== current || !hasEdits(current)) return;
    const run = (async () => {
      const edited = current.editor.getValue();
      current.dirty = false;
      setSave({ kind: "saving" });
      try {
        const outcome = await persist(sdk, file, current, edited, roundTrip(current.editor));
        if (outcome.kind === "conflict") {
          current.dirty = true;
          setConflict(true);
          setSave({ kind: "unsaved" });
        } else {
          setSave(
            current.dirty
              ? { kind: "unsaved" }
              : { kind: "saved", at: new Date(), scope: outcome.kind === "written" ? outcome.scope : null },
          );
        }
      } catch (error) {
        current.dirty = true;
        setSave({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    current.saving = run;
    try {
      await run;
    } finally {
      if (current.saving === run) current.saving = null;
    }
  };
  const saveRef = useRef(saveNow);
  saveRef.current = saveNow;

  useEffect(() => {
    let cancelled = false;
    // Detaches the iPhone toolbar fix (touch-toolbar.ts) when the editor goes.
    let untameToolbar: (() => void) | null = null;
    const controller = new AbortController();
    setPhase({ kind: "loading" });
    const look = vditorTheme(isDark());

    Promise.all([
      loadVditor(),
      readFromDisk(sdk, file, controller.signal),
      // Without a preview the document still opens; only relative images are missing.
      openImageBase(sdk, file).catch(() => null),
    ])
      .then(([Vditor, disk, images]) => {
        if (cancelled || !hostRef.current) return;
        const editor = new Vditor(hostRef.current, {
          mode,
          value: disk.text,
          cdn: VDITOR_CDN,
          lang: "ru_RU",
          height: "100%",
          width: "100%",
          theme: look.theme,
          icon: "ant",
          cache: { enable: false },
          toolbar: TOOLBAR,
          outline: { enable: outlineWanted.current && (rootRef.current?.clientWidth ?? 0) >= 700, position: "left" },
          preview: {
            // Vditor centres text in an 800 px column; the panel is the column here.
            maxWidth: 100_000,
            theme: { current: look.content, path: CONTENT_THEMES },
            hljs: { style: look.code },
            // Lute prefixes relative image paths with it on screen only: the text keeps them as written.
            markdown: { linkBase: images?.base ?? "" },
            actions: [],
          },
          link: {
            isOpen: false,
            // While editing: an <a> in the side preview, or the IR marker span whose text is the URL.
            click: (element) => openLinkRef.current(element.getAttribute("href") ?? element.textContent ?? ""),
          },
          input: () => {
            const current = session.current;
            if (!current || current.editor !== editor) return;
            current.dirty = true;
            setSave({ kind: "unsaved" });
            window.clearTimeout(current.timer);
            current.timer = window.setTimeout(() => void saveRef.current(), saveDelay(current.disk.text.length));
          },
          after: () => {
            if (cancelled) return;
            const toolbar = editor.vditor.toolbar?.element;
            if (toolbar !== undefined) untameToolbar = tameToolbarTouches(toolbar);
            if (session.current?.editor === editor) session.current.baseline = editor.getValue();
            if (!editingRef.current) settleForViewing(editor);
            setOutlineShown(getComputedStyle(editor.vditor.outline.element).display !== "none");
            setPhase({ kind: "ready" });
          },
        });
        session.current = { editor, disk, baseline: null, dirty: false, saving: null, timer: undefined, images };

        // While viewing, a click follows a link and nothing else: Vditor's own
        // handler would unfold the markup under the pointer as if to edit it.
        const guard = (event: MouseEvent) => {
          if (editingRef.current || !(event.target instanceof Element)) return;
          if (!editableOf(editor).contains(event.target)) return;
          event.stopPropagation();
          if (event.type !== "click" || event.button !== 0) return;
          const node = event.target.closest('[data-type="a"]');
          const href =
            node?.querySelector(":scope > .vditor-ir__marker--link")?.textContent ??
            event.target.closest("a[href]")?.getAttribute("href");
          if (!href) return;
          event.preventDefault();
          openLinkRef.current(href);
        };
        const area = editableOf(editor).parentElement;
        area?.addEventListener("click", guard, true);
        area?.addEventListener("dblclick", guard, true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      controller.abort();
      const current = session.current;
      session.current = null;
      if (!current) return;
      window.clearTimeout(current.timer);
      if (!conflictRef.current && hasEdits(current)) {
        // Leaving with unsaved edits (mode switch, closing the tab): read them
        // now, write after the editor is gone.
        const edited = current.editor.getValue();
        const normalize = roundTrip(current.editor);
        void (current.saving ?? Promise.resolve()).then(() => persist(sdk, file, current, edited, normalize));
      }
      untameToolbar?.();
      current.editor.destroy();
    };
    // Not `sdk`: a new but equal SDK object from BB must not restart the editor.
  }, [mode, file, attempt]);

  usePolling(
    rootRef,
    async () => {
      const current = session.current;
      if (!current || current.saving || conflictRef.current) return;
      if (current.images && Date.now() > current.images.expiresAtMs - 60_000) {
        const images = await openImageBase(sdk, file).catch(() => null);
        if (images && session.current === current) {
          current.images = images;
          current.editor.vditor.lute.SetLinkBase(images.base);
        }
      }
      const disk = await readFromDisk(sdk, file);
      if (session.current !== current || current.saving || disk.sha256 === current.disk.sha256) return;
      if (hasEdits(current)) {
        setConflict(true);
        return;
      }
      const scroller = scrollerOf(current.editor);
      const top = scroller.scrollTop;
      current.editor.setValue(disk.text, true);
      if (!editingRef.current) settleForViewing(current.editor);
      scroller.scrollTop = top;
      current.disk = disk;
      current.baseline = current.editor.getValue();
      setReloadedAt(new Date());
    },
    () => pollDelay(session.current?.disk.text.length ?? 0),
    phase.kind === "ready",
  );

  // BB's theme switched with the document open: Vditor's panel, toolbar and
  // code highlighting follow (the text and tables already do, through look.ts).
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const follow = () => {
      const editor = session.current?.editor;
      const look = vditorTheme(isDark());
      if (!editor || editor.vditor.options.theme === look.theme) return;
      editor.setTheme(look.theme, look.content, look.code, CONTENT_THEMES);
    };
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [phase.kind, mode]);

  // The faint highlight of the paragraph holding the caret, while editing.
  useEffect(() => {
    if (!editing || phase.kind !== "ready") return;
    const editable = session.current ? editableOf(session.current.editor) : null;
    if (!editable) return;
    const mark = () => {
      const anchor = getSelection()?.anchorNode ?? null;
      const element = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      const block = element && element !== editable && editable.contains(element) ? element.closest(CURRENT_BLOCK) : null;
      for (const node of editable.querySelectorAll("[data-mdv-current]")) {
        if (node !== block) node.removeAttribute("data-mdv-current");
      }
      block?.setAttribute("data-mdv-current", "");
    };
    mark();
    document.addEventListener("selectionchange", mark);
    return () => {
      document.removeEventListener("selectionchange", mark);
      for (const node of editable.querySelectorAll("[data-mdv-current]")) node.removeAttribute("data-mdv-current");
    };
  }, [editing, mode, phase.kind]);

  const startEditing = () => {
    const current = session.current;
    if (!current || phase.kind !== "ready") return;
    const scroller = scrollerOf(current.editor);
    const top = scroller.scrollTop;
    // Before the re-render: a reload from disk in between must not disable it again.
    editingRef.current = true;
    current.editor.enable();
    placeCaretAtTop(editableOf(current.editor), scroller);
    scroller.scrollTop = top;
    setEditing(true);
  };

  const finishEditing = async () => {
    await saveRef.current();
    if (conflictRef.current) return;
    setEditing(false);
    editingRef.current = false;
    // Another mode reopens the file read-only in "like Typora".
    if (mode !== "ir") {
      setMode("ir");
      return;
    }
    const current = session.current;
    if (!current) return;
    const scroller = scrollerOf(current.editor);
    const top = scroller.scrollTop;
    settleForViewing(current.editor);
    scroller.scrollTop = top;
  };

  const takeDisk = async () => {
    const current = session.current;
    if (!current) return;
    const disk = await readFromDisk(sdk, file);
    current.editor.setValue(disk.text, true);
    current.disk = disk;
    current.baseline = current.editor.getValue();
    current.dirty = false;
    setConflict(false);
    setSave({ kind: "saved", at: null, scope: null });
  };

  const keepMine = async () => {
    const current = session.current;
    if (!current) return;
    const { sha256 } = await readFromDisk(sdk, file);
    const outcome = await persist(sdk, file, current, current.editor.getValue(), roundTrip(current.editor), sha256);
    if (outcome.kind === "conflict") return; // Changed yet again; the banner stays.
    current.dirty = false;
    setConflict(false);
    setSave({ kind: "saved", at: new Date(), scope: outcome.kind === "written" ? outcome.scope : null });
  };

  const switchMode = async (next: EditMode) => {
    if (next === mode) return;
    await saveRef.current();
    if (!conflictRef.current) setMode(next);
  };

  const toggleOutline = () => {
    const current = session.current;
    if (!current) return;
    if (compact) {
      // The list of a narrow panel is read from the page each time it opens: the file may have changed.
      setOutlineList((open) =>
        open !== null
          ? null
          : outlineEntries(
              [...editableOf(current.editor).querySelectorAll<HTMLElement>(HEADINGS_SELECTOR)].map((heading) => ({
                tag: heading.tagName,
                text: heading.textContent ?? "",
              })),
            ),
      );
      return;
    }
    // Computed, not inline: the panel Vditor did not open at the start has no inline `display`,
    // and reading that as "shown" made the first press hide what was not there.
    const outline = current.editor.vditor.outline.element;
    const show = getComputedStyle(outline).display === "none";
    current.editor.vditor.outline.toggle(current.editor.vditor, show, false);
    setOutlineShown(show);
    setDisplay({ outline: show });
  };

  const pickHeading = (entry: OutlineEntry) => {
    setOutlineList(null);
    const current = session.current;
    if (!current) return;
    editableOf(current.editor).querySelectorAll<HTMLElement>(HEADINGS_SELECTOR)[entry.index]?.scrollIntoView({ block: "start" });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void saveRef.current();
    }
  };

  const outlineOpen = compact ? outlineList !== null : outlineShown;
  const outlineButton = (
    <button
      type="button"
      className={compact ? (outlineOpen ? ICON_BUTTON_ON : ICON_BUTTON) : outlineOpen ? SMALL_BUTTON_ON : SMALL_BUTTON}
      aria-pressed={outlineOpen}
      aria-label="Оглавление"
      title={compact ? "Оглавление: список заголовков" : "Показать или скрыть оглавление слева"}
      disabled={phase.kind !== "ready"}
      onClick={toggleOutline}
    >
      {compact ? <OutlineIcon /> : "Оглавление"}
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`flex h-full min-h-0 flex-col ${editing ? "mdv-editing" : "mdv-viewing"}`}
      onKeyDownCapture={onKeyDown}
    >
      <style>{LOOK_CSS}</style>
      {editing ? (
        <Toolbar
          trailing={
            <>
              <DisplayMenu compact={compact} />
              {/* No separate "Save": it saves by itself a second after typing stops, on Cmd+S and on "Готово". */}
              <button
                type="button"
                className={compact ? "mdv-primary mdv-primary--icon" : "mdv-primary"}
                onClick={() => void finishEditing()}
                title="Сохранить и вернуться к просмотру (сохраняет и само, и по Cmd+S)"
              >
                <CheckIcon />
                <ToolText compact={compact}>Готово</ToolText>
              </button>
            </>
          }
        >
          {leading?.(compact)}
          {outlineButton}
          <span className="mdv-badge" title={location}>
            Правка
          </span>
          <div className="flex flex-none items-center gap-1" role="group" aria-label="Режим редактора">
            {MODES.map((item) => (
              <button
                key={item.mode}
                type="button"
                className={
                  compact
                    ? item.mode === mode
                      ? ICON_BUTTON_ON
                      : ICON_BUTTON
                    : item.mode === mode
                      ? SMALL_BUTTON_ON
                      : SMALL_BUTTON
                }
                aria-pressed={item.mode === mode}
                aria-label={item.label}
                title={compact ? `${item.label}: ${item.title}` : item.title}
                onClick={() => void switchMode(item.mode)}
              >
                {compact ? item.icon : item.label}
              </button>
            ))}
          </div>
          <div className="whitespace-nowrap" aria-live="polite">
            <SaveStatus save={save} reloadedAt={reloadedAt} />
          </div>
        </Toolbar>
      ) : (
        <Toolbar
          trailing={
            <>
              <DisplayMenu compact={compact} />
              <button
                type="button"
                className={compact ? "mdv-primary mdv-primary--icon" : "mdv-primary"}
                disabled={phase.kind !== "ready"}
                onClick={startEditing}
                title="Править файл здесь же, в Vditor"
              >
                <PencilIcon />
                <ToolText compact={compact}>Редактировать</ToolText>
              </button>
            </>
          }
        >
          {leading?.(compact)}
          {outlineButton}
          {onOriginal && (
            <button
              type="button"
              className={compact ? ICON_BUTTON : SMALL_BUTTON}
              aria-label="Стандартный просмотр"
              onClick={onOriginal}
              title="Встроенный просмотр BB"
            >
              {compact ? <EyeIcon /> : "Стандартный просмотр"}
            </button>
          )}
          <div className="flex items-center gap-2 whitespace-nowrap" aria-live="polite">
            <span title={file.path}>{location ?? "Markdown"}</span>
            {reloadedAt && <span title="Файл изменился на диске">· обновлено {timeOf(reloadedAt)}</span>}
          </div>
        </Toolbar>
      )}
      {conflict && (
        <div role="alert" className="flex flex-none flex-wrap items-center gap-2 border-b border-border bg-state-hover px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">Файл изменили на диске, пока вы правили. Чью версию оставить?</span>
          <button type="button" className={BUTTON} onClick={() => void takeDisk()}>
            Взять с диска
          </button>
          <button type="button" className={BUTTON} onClick={() => void keepMine()}>
            Записать мою поверх
          </button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {phase.kind === "loading" && (
          <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-sm text-muted-foreground">
            <span className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" aria-hidden />
            {editing ? "Загружаю редактор…" : "Открываю Markdown…"}
          </div>
        )}
        {phase.kind === "error" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6 text-center text-sm text-muted-foreground">
            <div className="space-y-3">
              <p role="alert">{phase.message}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" className={BUTTON} onClick={() => setAttempt((n) => n + 1)}>
                  Повторить
                </button>
                {onOriginal && (
                  <button type="button" className={BUTTON} onClick={onOriginal}>
                    Стандартный просмотр
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {compact && outlineList !== null && (
          <OutlineDrawer entries={outlineList} onPick={pickHeading} onClose={() => setOutlineList(null)} />
        )}
        <div className="mdv-frame">
          <div
            ref={hostRef}
            key={`${mode}:${attempt}`}
            className={`absolute inset-0 ${WIDE_TABLES} ${TYPOGRAPHY} ${display.lineHeight === null ? "" : LINE_HEIGHT}`}
            style={displayVariables(display)}
          />
        </div>
      </div>
    </div>
  );
}

function SaveStatus({ save, reloadedAt }: { save: SaveState; reloadedAt: Date | null }) {
  switch (save.kind) {
    case "saving":
      return <>Сохраняю…</>;
    case "unsaved":
      return <>Есть несохранённые правки</>;
    case "error":
      return <span className="text-destructive">Не сохранено: {save.message}</span>;
    case "saved":
      if (reloadedAt && (save.at === null || reloadedAt > save.at)) return <>Обновлено с диска в {timeOf(reloadedAt)}</>;
      if (save.at === null) return null;
      return (
        <span title={save.scope === "whole" ? "Проверка не прошла: файл записан так, как его отдал Vditor" : undefined}>
          Сохранено в {timeOf(save.at)}
          {save.scope === "whole" && " · файл переформатирован целиком"}
        </span>
      );
  }
}
