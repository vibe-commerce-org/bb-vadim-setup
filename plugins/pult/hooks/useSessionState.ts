// View state that must survive «Открыть тред» → «назад»: BB unmounts the
// Pult page while a thread is open, so the project filter, unfolded groups,
// «Показать ещё» and the scroll position live in sessionStorage (this tab
// only, gone with it). Every access is guarded: no storage (SSR, tests,
// private mode, quota) just means no memory.
import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

const PREFIX = "pult:";

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function readSession<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(PREFIX + key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage: the view just forgets.
  }
}

/** useState that also lives in sessionStorage under `key`. */
export function useSessionState<T>(key: string, initial: T): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readSession(key, initial));
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === "function" ? (next as (current: T) => T)(current) : next;
        writeSession(key, resolved);
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

// Layout effects warn under server rendering; plain effects are enough there.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** How long a restore may wait for the content to grow tall enough. */
const RESTORE_WINDOW_MS = 4_000;

/**
 * Remembers the scrollTop of `ref` under `key` and puts it back on mount (and
 * when `key` changes): at once if the content is tall enough, else as the
 * content grows, until the user scrolls or the restore window closes.
 */
export function useScrollMemory(ref: RefObject<HTMLElement | null>, key: string): void {
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const storageKey = `scroll:${key}`;
    const saved = readSession<number>(storageKey, 0);
    let restoring = typeof saved === "number" && saved > 0;

    const tryRestore = () => {
      if (!restoring) return;
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = Math.min(saved, Math.max(0, max));
      if (max >= saved) restoring = false;
    };
    const stop = () => {
      restoring = false;
    };

    // The last position the user scrolled to; written on unmount too, without
    // reading the DOM, which may already show another tab's content then.
    let last: number | null = null;
    let frame = 0;
    const onScroll = () => {
      if (restoring) return;
      last = Math.round(element.scrollTop);
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (last !== null) writeSession(storageKey, last);
      });
    };

    tryRestore();
    const observer =
      restoring && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => tryRestore()) : null;
    for (const child of Array.from(element.children)) observer?.observe(child);
    const timer = setTimeout(stop, RESTORE_WINDOW_MS);
    element.addEventListener("scroll", onScroll, { passive: true });
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
      element.addEventListener(type, stop, { passive: true });
    }
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      if (last !== null) writeSession(storageKey, last);
      element.removeEventListener("scroll", onScroll);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"] as const) {
        element.removeEventListener(type, stop);
      }
    };
  }, [ref, key]);
}
