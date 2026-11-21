// An HTML page in the panel, its links followed by BB. The page runs in a
// sandboxed frame with an opaque origin (no BB cookies, storage, parent page or
// API), loaded from `srcdoc`: a frame loaded from BB's address would follow a
// link itself — a `.md` then shows as text in the wrong encoding, since BB
// serves it without a charset, and `file://` does not open at all. So a small
// script, the bridge, goes into the page: it hands a clicked link to the panel,
// which opens it the way the chat does. Pure functions: `npm test`.

/** Bridge → panel: a link was clicked; `href` is the attribute as written in the file. */
export const LINK_MESSAGE = "html-view:link";
/** Bridge → panel: the bridge runs. Missing, the page's links would leave the frame. */
export const READY_MESSAGE = "html-view:ready";
/** How long after the frame loads the panel waits for READY_MESSAGE. */
export const READY_TIMEOUT_MS = 2000;

/** Links as the bridge and the panel see them: HTML `<a>`, image-map `<area>`, SVG `<a>` with `href` or `xlink:href`. */
export const LINK_SELECTOR = "a[href], area[href], a[*|href]";
const XLINK = "http://www.w3.org/1999/xlink";

/** The link's address as written in the file. */
export const hrefOf = (link: Element) => link.getAttribute("href") ?? link.getAttributeNS(XLINK, "href") ?? "";

/**
 * The bridge. It listens on `window` as the click bubbles up, so the page's
 * own handlers come first: a link the page handled (`preventDefault`, an
 * `onclick` returning false) is left alone, and so is `javascript:`. `#id`
 * moves within the page — `location.hash`, which `<base>` doesn't touch.
 * `composedPath` finds a link inside an open shadow root too.
 */
export function bridgeScript(parentOrigin: string): string {
  return `(function () {
  var ORIGIN = ${JSON.stringify(parentOrigin)};
  var LINKS = ${JSON.stringify(LINK_SELECTOR)};
  function send(message) {
    try { parent.postMessage(message, ORIGIN); } catch (error) {}
  }
  function linkOf(event) {
    var path = event.composedPath ? event.composedPath() : [event.target];
    for (var i = 0; i < path.length; i += 1) {
      var node = path[i];
      if (node && node.matches && node.matches(LINKS)) return node;
    }
    return null;
  }
  addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    var link = linkOf(event);
    if (!link) return;
    var href = link.getAttribute("href");
    if (href === null) href = link.getAttributeNS(${JSON.stringify(XLINK)}, "href") || "";
    var trimmed = href.trim();
    if (trimmed === "" || /^javascript:/i.test(trimmed)) return;
    event.preventDefault();
    if (trimmed.charAt(0) === "#") {
      if (trimmed.length > 1) location.hash = trimmed.slice(1);
      return;
    }
    send({ type: ${JSON.stringify(LINK_MESSAGE)}, href: href });
  });
  send({ type: ${JSON.stringify(READY_MESSAGE)} });
})();`;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const NAMED_REFERENCES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** An attribute value as the browser reads it: `&amp;`, `&#38;`, `&#x26;` → `&`. */
function decodeReferences(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (whole, decimal, hex, name) => {
    if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    return NAMED_REFERENCES[(name as string).toLowerCase()] ?? whole;
  });
}

/** Comments, CDATA and elements whose content is not markup (in a frame that runs scripts, `<noscript>` too). */
const NOT_MARKUP =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(script|style|textarea|title|noscript|xmp|iframe|noembed|noframes|template)\b(?:"[^"]*"|'[^']*'|[^"'>])*>[\s\S]*?(?:<\/\1\s*>|$)/gi;
const START_TAG = /<[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^"'>])*>/gi;
const QUOTED = /"[^"]*"|'[^']*'/g;
const BASE_TAG = /<base(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'>])*>/i;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * The page with what is not a tag blanked out at the same length — comments,
 * CDATA, the text of script-like elements, the inside of quoted attribute
 * values — so a `<base` found here is a real tag at the same index in the page.
 */
function tagsOnly(html: string): string {
  const blank = (text: string) => " ".repeat(text.length);
  return html
    .replace(NOT_MARKUP, blank)
    .replace(START_TAG, (tag) => tag.replace(QUOTED, (quoted) => `${quoted[0]}${blank(quoted.slice(2))}${quoted[0]}`));
}

/** The `href` of the page's own first `<base>`, decoded; null when it has none. */
export function ownBaseHref(html: string): string | null {
  const found = BASE_TAG.exec(tagsOnly(html));
  if (found === null) return null;
  const tag = html.slice(found.index + "<base".length, found.index + found[0].length - 1);
  for (const [, name, double, single, bare] of tag.matchAll(ATTRIBUTE)) {
    if (name.toLowerCase() === "href") return decodeReferences(double ?? single ?? bare ?? "");
  }
  return null;
}

/** Leading byte-order mark, blanks and comments, then the doctype: what must stay ahead of anything inserted. */
const PROLOGUE = /^(?:﻿|\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;

/**
 * The page with `<base>` and the bridge right after the doctype — the parser
 * moves both into `<head>`, and the page's own `<html>` attributes still
 * apply; before the doctype they would switch the page to quirks mode.
 * Ours is the first `<base>`, so the document's base is the page's own one,
 * made absolute from `folderHref` (the file's folder as BB serves it), or the
 * folder itself. `folderHref` must be absolute: a frame from `srcdoc` has no
 * address of its own to resolve a path against. Returns the page and its base.
 */
export function withBridge(
  html: string,
  { folderHref, parentOrigin }: { folderHref: string; parentOrigin: string },
): { srcdoc: string; base: string } {
  const own = ownBaseHref(html);
  let base = folderHref;
  if (own !== null) {
    try {
      base = new URL(own.trim(), folderHref).href;
    } catch {
      // An address the browser can't read either: the folder stays the base.
    }
  }
  const inserted = `<base href="${escapeAttribute(base)}"><script>${bridgeScript(parentOrigin)}</script>`;
  const end = PROLOGUE.exec(html)?.[0].length ?? 0;
  return { srcdoc: `${html.slice(0, end)}${inserted}${html.slice(end)}`, base };
}

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/**
 * What the panel opens for a link of the page: the address the page itself
 * means, from its base. Inside the folder BB serves (`servedAt`, an absolute
 * URL ending in `/`, for the folder `root` on disk) — the file's absolute path;
 * a site elsewhere — its address; anything else (`file://`, `mailto:`, a path
 * above the served folder) — the link as written, resolved later from the
 * file's own folder.
 */
export function hrefToOpen(href: string, { base, servedAt, root }: { base: string; servedAt: string; root: string }): string {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return href;
  }
  const served = new URL(servedAt);
  if (url.origin === served.origin && url.pathname.startsWith(served.pathname)) {
    return `${root.replace(/\/+$/, "")}/${safeDecode(url.pathname.slice(served.pathname.length))}`;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== served.origin) return url.href;
  return href;
}

/**
 * Whether every document the frame loaded announced the bridge. The frame's
 * `load` and the bridge's READY_MESSAGE come in either order (the message is
 * delivered asynchronously), so they are counted, not paired: a document that
 * left the page past the bridge leaves one load without its READY.
 */
export function createBridgeWatch() {
  let loads = 0;
  let readies = 0;
  return {
    reset() {
      loads = 0;
      readies = 0;
    },
    /** A document loaded; returns its number, for `missing` once READY_TIMEOUT_MS has passed. */
    loaded() {
      loads += 1;
      return loads;
    },
    ready() {
      readies += 1;
    },
    /** True when fewer READY messages came than documents up to `load`. */
    missing(load: number) {
      return readies < load;
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const isReadyMessage = (data: unknown) => isObject(data) && data.type === READY_MESSAGE;

export const isLinkMessage = (data: unknown): data is { type: typeof LINK_MESSAGE; href: string } =>
  isObject(data) && data.type === LINK_MESSAGE && typeof data.href === "string";

/** What the gate decided: the link to follow, or why not. */
export type GateResult = { href: string } | { refused: "not-a-link" | "not-in-file" | "too-soon" };

/**
 * Which link messages the panel follows. The page's own scripts share the
 * frame with the bridge and can post the same message, so a link is followed
 * only if the file itself has it (`links`: the addresses of its links, see
 * LINK_SELECTOR), at most once a second, and the same link at most once in two.
 */
export function createLinkGate(
  links: ReadonlySet<string>,
  { minGapMs = 1000, sameLinkGapMs = 2000 }: { minGapMs?: number; sameLinkGapMs?: number } = {},
): (data: unknown, now: number) => GateResult {
  let lastAt = Number.NEGATIVE_INFINITY;
  const lastByHref = new Map<string, number>();
  return (data, now) => {
    if (!isLinkMessage(data)) return { refused: "not-a-link" };
    const href = data.href;
    if (!links.has(href)) return { refused: "not-in-file" };
    if (now - lastAt < minGapMs) return { refused: "too-soon" };
    if (now - (lastByHref.get(href) ?? Number.NEGATIVE_INFINITY) < sameLinkGapMs) return { refused: "too-soon" };
    lastAt = now;
    lastByHref.set(href, now);
    return { href };
  };
}
