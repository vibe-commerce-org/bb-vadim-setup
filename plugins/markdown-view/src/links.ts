// Where a link in the document leads, decided without touching the page: the
// web through BB's browser preference, mail and phone to the OS, a heading of
// this document, or another file — relative paths from this file's folder, the
// way the chat resolves them. Also the base address relative images load from.
import type { ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import type { FileLocation } from "./file-access";

export type LinkAction =
  | { kind: "web"; url: string }
  | { kind: "system"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "file"; target: ExperimentalLiveFileTarget };

const dirname = (path: string) => path.replace(/\/[^/]*$/, "") || "/";
const trimSlash = (path: string) => path.replace(/\/+$/, "") || "/";

/** `/a/b/../c/./d` → `/a/c/d`; null when `..` climbs above the root. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** What clicking `href` in `file` should do; null for what it should ignore (javascript:, app schemes). */
export function resolveLink(href: string, file: FileLocation): LinkAction | null {
  const url = href.trim();
  if (url === "") return null;
  if (url.startsWith("#")) return url.length > 1 ? { kind: "anchor", id: decode(url.slice(1)) } : null;
  if (/^https?:/i.test(url)) return { kind: "web", url };
  if (/^(mailto|tel):/i.test(url)) return { kind: "system", url };

  let raw = url;
  if (/^file:/i.test(url)) raw = url.replace(/^file:(\/\/(localhost)?)?/i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;

  const path = decode(raw.split(/[?#]/, 1)[0] ?? "");
  if (path === "") return null;
  const absolute = normalize(path.startsWith("/") ? path : `${dirname(file.path)}/${path}`);
  if (absolute === null) return null;

  return { kind: "file", target: fileTarget(absolute, file) };
}

/**
 * How BB is asked to open `absolute`: as a workspace file when it sits in the
 * checkout `file` belongs to, otherwise as a host file.
 */
export function fileTarget(absolute: string, file: FileLocation): ExperimentalLiveFileTarget {
  if (file.checkout) {
    const root = trimSlash(file.checkout.rootPath);
    if (absolute.startsWith(`${root}/`)) {
      return { kind: "workspace", environmentId: file.checkout.environmentId, path: absolute.slice(root.length + 1) };
    }
  }
  return { kind: "host", hostId: file.hostId, path: absolute };
}

/**
 * The folder BB serves to the page so relative images show: the checkout for
 * a project file (so `../img.png` works), otherwise the file's own folder.
 */
export const previewRoot = (file: FileLocation) => trimSlash(file.checkout?.rootPath ?? dirname(file.path));

/**
 * The folder BB serves to an HTML page: the checkout, else the thread's
 * storage (so `../assets/x.png` works there, as in BB's own preview), else the
 * page's own folder.
 */
export const pageRoot = (file: FileLocation) => trimSlash(file.checkout?.rootPath ?? file.root ?? dirname(file.path));

/** `baseUrl` of a preview of `root` → the prefix a relative path from the file's folder is appended to. */
export function linkBase(file: FileLocation, baseUrl: string, root: string = previewRoot(file)): string {
  const folder = dirname(file.path);
  const relative = folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : "";
  const segments = relative === "" ? [] : relative.split("/").map(encodeURIComponent);
  return `${[baseUrl.replace(/\/+$/, ""), ...segments].join("/")}/`;
}
