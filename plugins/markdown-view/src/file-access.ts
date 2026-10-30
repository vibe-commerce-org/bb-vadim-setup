// How the panel reaches the opened file.
//
// Everything goes through BB's files API (`sdk.files`), the path BB documents
// for file openers: it needs the file's host and absolute path, works for
// files on any connected host, and gives sha256 for conflict-safe writes.
// BB's internal file URLs changed in 0.45 and broke every read; the SDK is
// the contract that outlives them.
import type { PluginBrowserBbSdk, PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";

function decodeBase64(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** BB serves plugins files up to 25 MiB; larger ones get HTTP 413 `file_too_large`. */
export class FileTooLargeError extends Error {
  constructor() {
    super("Файл больше 25 МиБ: BB не отдаёт плагинам файлы такого размера.");
    this.name = "FileTooLargeError";
  }
}

/** The SDK's request errors carry the HTTP status and BB's error code. */
const isTooLarge = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  ((error as { status?: unknown }).status === 413 || (error as { code?: unknown }).code === "file_too_large");

/** Where the file sits on disk, for the files API. */
export interface FileLocation {
  hostId: string;
  /** Absolute path on that host. */
  path: string;
  /** For project files: the checkout it belongs to, which relative links resolve against. */
  checkout: { environmentId: string; rootPath: string } | null;
}

const joinPath = (root: string, relative: string) => `${root.replace(/\/+$/, "")}/${relative.replace(/^\/+/, "")}`;

/** Resolves where the opened file lives; null for sources BB left incomplete. */
export async function locateFile(
  sdk: PluginBrowserBbSdk,
  path: string,
  source: PluginFileOpenerSource,
  signal: AbortSignal,
): Promise<FileLocation | null> {
  if (source.kind === "thread-storage") {
    if (source.threadId === null) return null;
    const storage = await sdk.threads.storageLocation({ threadId: source.threadId, signal });
    return { hostId: storage.hostId, path: joinPath(storage.storageRootPath, path), checkout: null };
  }

  // Opened outside any thread (Files page, Pult), BB names the host and nothing else.
  if (source.kind === "host" && source.experimental_hostId) {
    return { hostId: source.experimental_hostId, path, checkout: null };
  }

  let environmentId = source.environmentId;
  if (environmentId === null && source.threadId !== null) {
    environmentId = (await sdk.threads.get({ threadId: source.threadId, signal })).environmentId;
  }

  if (source.kind === "host") {
    if (environmentId === null) return null;
    const environment = await sdk.environments.get({ environmentId, signal });
    return { hostId: environment.hostId, path, checkout: null };
  }

  const environment =
    environmentId !== null
      ? await sdk.environments.get({ environmentId, signal })
      : source.projectId !== null
        ? // A project file opened without a thread lives in the project's own checkout.
          (await sdk.environments.list({ projectId: source.projectId, signal })).find(
            (candidate) =>
              !candidate.isWorktree &&
              candidate.path !== null &&
              (!source.experimental_hostId || candidate.hostId === source.experimental_hostId),
          )
        : undefined;
  if (!environment?.path) return null;
  return {
    hostId: source.experimental_hostId ?? environment.hostId,
    path: joinPath(environment.path, path),
    checkout: { environmentId: environment.id, rootPath: environment.path },
  };
}

export interface DiskText {
  text: string;
  sha256: string;
}

export async function readFromDisk(sdk: PluginBrowserBbSdk, file: FileLocation, signal?: AbortSignal): Promise<DiskText> {
  let result;
  try {
    result = await sdk.files.read({ hostId: file.hostId, path: file.path, signal });
  } catch (error) {
    throw isTooLarge(error) ? new FileTooLargeError() : error;
  }
  return {
    text: result.contentEncoding === "base64" ? decodeBase64(result.content) : result.content,
    sha256: result.sha256,
  };
}

/** Writes only if the file on disk is still `expectedSha256`; otherwise reports the conflict. */
export async function writeToDisk(
  sdk: PluginBrowserBbSdk,
  file: FileLocation,
  text: string,
  expectedSha256: string,
): Promise<{ written: true; sha256: string } | { written: false }> {
  const result = await sdk.files.write({
    hostId: file.hostId,
    path: file.path,
    content: text,
    contentEncoding: "utf8",
    expectedSha256,
  });
  return result.outcome === "written" ? { written: true, sha256: result.sha256 } : { written: false };
}
