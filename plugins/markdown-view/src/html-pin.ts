// Makes HTML_vibecom the opener of `.html` and `.htm` on this client — once
// (the author's choice, 10.11).
//
// The choice lives in each client's localStorage — Settings → Files → File
// openers — so the Mac app and a phone's browser each need it. Explorer_vibecom
// pins BB's own preview there (14.10); that one is taken over too, since BB's
// preview loses the page to the first link clicked. Whatever is picked after
// this pass stays. The key is BB's internals, not the SDK: should BB rename it,
// nothing is pinned and BB keeps its own choice — nothing breaks. An opener
// that is not installed resolves to BB's preview.

/** Where BB keeps Settings → Files → File openers: extension → opener key. */
export const OPENER_PREFERENCE_KEY = "bb.fileOpenerByExtension";
/** This plugin's HTML opener, as BB names it: `<plugin id>:<opener id>`. */
export const HTML_OPENER = "markdown-view:html";
/** "Built-in preview" in that list. */
export const BUILT_IN_PREVIEW = "__builtin__";
export const PINNED_EXTENSIONS: readonly string[] = ["html", "htm"];
/** Set after the first pass, so a choice made later is never put back. */
export const PIN_DONE_KEY = "markdown-view:html-pinned";

type PinStorage = Pick<Storage, "getItem" | "setItem">;

/**
 * Pins HTML_vibecom for each extension with no opener chosen or with BB's
 * preview. Returns the new value when it wrote one — the caller tells BB — and
 * null when there was nothing to do: done before, chosen otherwise already, or
 * the stored value is not the object this expects.
 */
export function pinHtmlOpener(storage: PinStorage): string | null {
  if (storage.getItem(PIN_DONE_KEY) !== null) return null;

  const raw = storage.getItem(OPENER_PREFERENCE_KEY);
  let preferences: unknown = {};
  if (raw !== null) {
    try {
      preferences = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  // Something BB writes differently now: leave it alone, and look again next time.
  if (typeof preferences !== "object" || preferences === null || Array.isArray(preferences)) {
    return null;
  }

  const next: Record<string, unknown> = { ...preferences };
  const taken = PINNED_EXTENSIONS.filter(
    (extension) => !(extension in next) || next[extension] === BUILT_IN_PREVIEW,
  );
  for (const extension of taken) next[extension] = HTML_OPENER;

  storage.setItem(PIN_DONE_KEY, new Date().toISOString());
  if (taken.length === 0) return null;
  const value = JSON.stringify(next);
  storage.setItem(OPENER_PREFERENCE_KEY, value);
  return value;
}

/**
 * Pins in this window's localStorage and tells BB. BB listens for `storage`
 * events on that key, so the open app takes the pin at once, without a reload.
 * Synchronous on purpose: Explorer_vibecom pins the same key on load, and either
 * order ends with this opener.
 */
export function pinHtmlOpenerInWindow(): void {
  try {
    const storage = window.localStorage;
    const oldValue = storage.getItem(OPENER_PREFERENCE_KEY);
    const newValue = pinHtmlOpener(storage);
    if (newValue === null) return;
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: OPENER_PREFERENCE_KEY,
        oldValue,
        newValue,
        storageArea: storage,
        url: window.location.href,
      }),
    );
  } catch {
    // No storage in this webview, or it is full: links keep BB's own choice.
  }
}
