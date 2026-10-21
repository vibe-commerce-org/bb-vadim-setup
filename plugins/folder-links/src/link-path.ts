// The absolute path a chat link points at, read from its `href` the way BB
// reads it. Knows nothing about the platform: a Windows path on a Mac server
// is simply not inside the home folder there, and the server says so.
//
// Kept free of imports, so the tests run it under plain Node.

/** `C:\…` or `C:/…`: an absolute Windows path with a drive letter. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
/** `file:///C:/…` gives the URL path `/C:/…`; the leading slash is not part of the path. */
const URL_DRIVE_PATH = /^\/[A-Za-z]:[\\/]/u;

/**
 * An absolute path in either spelling: `/…` or `C:\…`. `//…` counts too, as it
 * always did: `file:////Users/me` gives it, and the server reads it as `/Users/me`.
 */
export function isAbsoluteLinkPath(path: string): boolean {
  return path.startsWith("/") || DRIVE_PATH.test(path);
}

/**
 * A path the way BB takes it for a file on a host. BB's own file links on
 * Windows carry `C:/Users/…`, forward slashes, and its host-file address is
 * made from the path the same way, so the tree hands a Windows path over in
 * that form. A Mac or Linux path is left as it is.
 */
export function hostFilePath(path: string): string {
  return DRIVE_PATH.test(path) ? path.replace(/\\/gu, "/") : path;
}

/** The folder's name for a tab title: the last segment; a path with a drive letter is split by `\` as well. */
export function folderTitle(path: string): string {
  const drive = DRIVE_PATH.test(path);
  const segments = path.split(drive ? /[\\/]+/u : /\/+/u).filter((segment) => segment !== "");
  const name = segments.pop();
  if (name === undefined) return "/";
  return drive && segments.length === 0 ? `${name}\\` : name;
}

function decoded(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * The absolute path a link points at: `file:///…`, `/…`, `C:\…` or `C:/…`.
 * Anything else is not ours — including UNC paths (`\\server\share`,
 * `file://server/share`), which BB does not open as files either.
 */
export function linkPath(href: string): string | null {
  let path: string | null;
  if (href.startsWith("file:")) {
    try {
      const url = new URL(href);
      if (url.host !== "" || url.search !== "") return null;
      path = decoded(url.pathname);
    } catch {
      return null;
    }
  } else if (href.startsWith("/") || DRIVE_PATH.test(href) || /^[A-Za-z]:%5C/iu.test(href)) {
    if (href.startsWith("//") || href.includes("?")) return null;
    const [beforeHash = ""] = href.split("#");
    path = decoded(beforeHash);
  } else {
    return null;
  }
  if (path === null) return null;
  return URL_DRIVE_PATH.test(path) ? path.slice(1) : path;
}
