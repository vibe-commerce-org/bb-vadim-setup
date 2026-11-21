// HTML_vibecom: an HTML file as a browser shows it, with its links opened by
// BB — a `.md` in the Markdown opener, `file://` in BB's panel, the web through
// BB's browser preference — while the page stays put. How and why: html-page.ts.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SyntheticEvent } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { FileTooLargeError, readFromDisk } from "./file-access";
import type { FileLocation } from "./file-access";
import { createBridgeWatch, createLinkGate, hrefOf, hrefToOpen, isLinkMessage, isReadyMessage, LINK_SELECTOR, READY_TIMEOUT_MS, withBridge } from "./html-page";
import { linkBase, pageRoot } from "./links";
import { LocatedFile } from "./LocatedFile";
import { BUTTON, Loading, Notice, Toolbar, TOOL_BUTTON, useLatest, useOpenLink } from "./ui";

/** The longest BB grants; "Обновить" asks for a new address. */
const PREVIEW_TTL_MS = 60 * 60 * 1000;
const NOTICE_MS = 5000;

export function HtmlOpener(props: PluginFileOpenerProps) {
  return (
    <LocatedFile {...props} loadingLabel="Открываю страницу…">
      {(file, showOriginal) => <HtmlPage key={file.path} file={file} onOriginal={showOriginal} />}
    </LocatedFile>
  );
}

type Page =
  | { status: "loading" }
  | {
      status: "ready";
      srcdoc: string;
      links: ReadonlySet<string>;
      /** What links resolve against: see `hrefToOpen`. */
      where: { base: string; servedAt: string; root: string };
    }
  | { status: "error"; message: string };

/** The `href` of every link the file has, as written — templates included: the only ones the panel follows. */
function linksOf(html: string): Set<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const links = new Set<string>();
  const collect = (root: ParentNode) => {
    for (const link of root.querySelectorAll(LINK_SELECTOR)) links.add(hrefOf(link));
    for (const template of root.querySelectorAll("template")) collect(template.content);
  };
  collect(doc);
  return links;
}

function HtmlPage({ file, onOriginal }: { file: FileLocation; onOriginal: () => void }) {
  const sdk = useLatest(useSdk());
  const openLink = useLatest(useOpenLink(file, () => {}));
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const readyTimer = useRef<number | undefined>(undefined);
  const watch = useRef(createBridgeWatch());
  const noticeTimer = useRef<number | undefined>(undefined);
  const [load, setLoad] = useState(0);
  const [page, setPage] = useState<Page>({ status: "loading" });
  const [bridge, setBridge] = useState<"waiting" | "ready" | "missing">("waiting");
  const [notice, setNotice] = useState<string | null>(null);

  const showNotice = (text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  };
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  useEffect(() => {
    const controller = new AbortController();
    window.clearTimeout(readyTimer.current);
    watch.current.reset();
    setPage({ status: "loading" });
    setBridge("waiting");
    const root = pageRoot(file);
    Promise.all([
      readFromDisk(sdk.current, file, controller.signal),
      sdk.current.files.createPreview({ hostId: file.hostId, rootPath: root, ttlMs: PREVIEW_TTL_MS, signal: controller.signal }),
    ]).then(
      ([disk, preview]) => {
        if (controller.signal.aborted) return;
        const origin = window.location.origin;
        const folderHref = new URL(linkBase(file, preview.baseUrl, root), origin).href;
        const servedAt = new URL(`${preview.baseUrl.replace(/\/+$/, "")}/`, origin).href;
        const { srcdoc, base } = withBridge(disk.text, { folderHref, parentOrigin: origin === "null" ? "*" : origin });
        setPage({ status: "ready", srcdoc, links: linksOf(disk.text), where: { base, servedAt, root } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setPage({
          status: "error",
          message:
            error instanceof FileTooLargeError
              ? error.message
              : `Не удалось открыть страницу: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
    return () => {
      controller.abort();
      window.clearTimeout(readyTimer.current);
    };
  }, [sdk, file, load]);

  // Before the frame's first script can post: a layout effect runs before the browser loads `srcdoc`.
  useLayoutEffect(() => {
    if (page.status !== "ready") return;
    const gate = createLinkGate(page.links);
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      if (isReadyMessage(event.data)) {
        watch.current.ready();
        setBridge("ready");
        return;
      }
      if (!isLinkMessage(event.data)) return;
      // A click in the page moves focus into the frame and activates BB's window. This refuses a
      // page script posting on its own or after a click elsewhere in BB; it can't tell a link click
      // from a script posting right after any click in the page — the gate below is the real limit.
      const clicked =
        document.activeElement === frame && (navigator.userActivation === undefined || navigator.userActivation.isActive);
      if (!clicked) {
        showNotice("BB не увидел клика по странице — ссылка не открыта");
        return;
      }
      const result = gate(event.data, Date.now());
      if ("href" in result) {
        if (!openLink.current(hrefToOpen(result.href, page.where))) showNotice("BB не открыл эту ссылку здесь");
      } else if (result.refused === "not-in-file") {
        showNotice("Этой ссылки нет в файле (её добавил скрипт страницы) — не открыта");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [page, openLink]);

  // Each document the frame loads must announce the bridge: one that doesn't is the page
  // gone off by a script the bridge missed, or a page whose CSP stopped it.
  const onFrameLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    if (event.currentTarget !== frameRef.current) return;
    const load = watch.current.loaded();
    window.clearTimeout(readyTimer.current);
    readyTimer.current = window.setTimeout(() => {
      if (watch.current.missing(load)) setBridge("missing");
    }, READY_TIMEOUT_MS);
  };
  // A new frame element starts its own count: an old one's messages no longer pass the source check.
  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    if (element !== null && element !== frameRef.current) watch.current.reset();
    frameRef.current = element;
  }, []);

  const reload = () => setLoad((n) => n + 1);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <button type="button" className={TOOL_BUTTON} onClick={reload}>
          Обновить
        </button>
        <button type="button" className={TOOL_BUTTON} onClick={onOriginal}>
          Стандартный просмотр
        </button>
        {notice === null ? null : (
          <span role="status" className="text-xs text-muted-foreground">
            {notice}
          </span>
        )}
      </Toolbar>
      {bridge === "missing" ? (
        <div role="alert" className="flex flex-none items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Ссылки со страницы не перехватываются: клик по ним покажет файл прямо здесь, возможно нечитаемым.
            «Обновить» вернёт страницу.
          </span>
          <button type="button" className={TOOL_BUTTON} onClick={onOriginal}>
            Стандартный просмотр
          </button>
        </div>
      ) : null}
      {page.status === "loading" ? (
        <Loading label="Открываю страницу…" />
      ) : page.status === "error" ? (
        <Notice message={page.message}>
          <button type="button" className={BUTTON} onClick={reload}>
            Повторить
          </button>
          <button type="button" className={BUTTON} onClick={onOriginal}>
            Стандартный просмотр
          </button>
        </Notice>
      ) : (
        <iframe
          key={load}
          ref={attachFrame}
          srcDoc={page.srcdoc}
          title={file.path}
          // Scripts run, with an opaque origin: no BB cookies, storage, parent page or API.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={onFrameLoad}
          // White, as a browser draws a page that sets no background of its own.
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
