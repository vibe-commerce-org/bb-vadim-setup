// Tags on the rows of bb's own sidebar thread list.
//
// The Plugin SDK has no slot inside a thread row, so the tag is added to the
// row's DOM. What the code relies on:
// - `a[data-sidebar-thread-id]` — bb's documented DOM contract for thread
//   rows (its keyboard shortcuts find rows by it);
// - `.bb-thread-title` — the title span next to the anchor, inside a wrapper
//   that also holds the model icon. Internal markup of bb's Thread list
//   (bb 0.46): if it changes, rows simply stay without a tag.
// The tag goes into the wrapper, right before the title: after the model icon.
// Nothing of bb's is changed; every node the plugin adds carries TAG_CLASS
// and is removed on stop.
import { HUES, type RepoTag } from "./labels.ts";

export const TAG_CLASS = "vbrt-tag";
export const ROW_SELECTOR = "a[data-sidebar-thread-id]";
const TITLE_CLASS = "bb-thread-title";
const WATCHED = `${ROW_SELECTOR}, .${TITLE_CLASS}`;

export interface TagLengths {
  length: number;
  compactLength: number;
}

/** The span that holds the model icon and the title of the row of `anchor`. */
function titleOf(anchor: Element): Element | null {
  const row = anchor.parentElement;
  if (row === null) return null;
  for (const wrapper of Array.from(row.children)) {
    if (wrapper === anchor) continue;
    for (const child of Array.from(wrapper.children)) {
      if (child.classList.contains(TITLE_CLASS)) return child;
    }
  }
  return null;
}

function setText(element: Element, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setAttribute(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function createTag(doc: Document): HTMLElement {
  const tag = doc.createElement("span");
  tag.className = TAG_CLASS;
  tag.setAttribute("aria-hidden", "true");
  const wide = doc.createElement("span");
  wide.className = `${TAG_CLASS}-wide`;
  const compact = doc.createElement("span");
  compact.className = `${TAG_CLASS}-compact`;
  tag.append(wide, compact);
  return tag;
}

/** Bring one row in line with `tag`; touches the DOM only where it differs. */
function decorateRow(anchor: Element, tag: RepoTag | null, lengths: TagLengths): void {
  const title = titleOf(anchor);
  const wrapper = title?.parentElement ?? null;
  const existing = anchor.parentElement?.querySelector(`.${TAG_CLASS}`) ?? null;

  if (tag === null || title === null || wrapper === null) {
    existing?.remove();
    return;
  }

  const element = (existing as HTMLElement | null) ?? createTag(anchor.ownerDocument);
  if (element.parentElement !== wrapper || element.nextElementSibling !== title) {
    wrapper.insertBefore(element, title);
  }
  setText(element.children[0] as Element, tag.text);
  setText(element.children[1] as Element, tag.compactText);
  setAttribute(
    element,
    "style",
    `--vbrt-h:${HUES[tag.hueIndex] ?? HUES[0]};` +
      `--vbrt-len:${lengths.length};--vbrt-len-compact:${lengths.compactLength}`,
  );
  setAttribute(element, "data-vbrt-name", tag.name);
}

/** Decorate every thread row under `root`. */
export function decorateRows(
  root: ParentNode,
  tagFor: (threadId: string) => RepoTag | null,
  lengths: TagLengths,
): void {
  for (const anchor of Array.from(root.querySelectorAll(ROW_SELECTOR))) {
    const threadId = anchor.getAttribute("data-sidebar-thread-id");
    if (threadId === null || threadId === "") continue;
    decorateRow(anchor, tagFor(threadId), lengths);
  }
}

/** Remove every tag the plugin added. */
export function removeTags(root: ParentNode): void {
  for (const tag of Array.from(root.querySelectorAll(`.${TAG_CLASS}`))) tag.remove();
}

/** True when a mutation may have added or rebuilt a thread row. */
function touchesRows(mutations: readonly MutationRecord[]): boolean {
  for (const mutation of mutations) {
    for (const node of Array.from(mutation.addedNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      if (element.classList.contains(TAG_CLASS)) continue;
      if (element.matches(WATCHED) || element.querySelector(WATCHED) !== null) return true;
    }
  }
  return false;
}

export interface RowWatcher {
  /** Re-decorate all rows on the next frame (data or settings changed). */
  refresh(): void;
  stop(): void;
}

/**
 * Keep the rows of `doc` decorated: once now, again whenever bb mounts or
 * rebuilds rows (the list is virtualized), and on refresh(). Batches work into
 * one pass per animation frame.
 */
export function watchRows(
  doc: Document,
  tagFor: (threadId: string) => RepoTag | null,
  lengths: () => TagLengths,
): RowWatcher {
  const view = doc.defaultView;
  const schedule = view?.requestAnimationFrame?.bind(view) ?? ((run: () => void) => setTimeout(run, 16));
  const cancel = view?.cancelAnimationFrame?.bind(view) ?? ((id: number) => clearTimeout(id));
  let frame: number | null = null;
  let stopped = false;

  const run = () => {
    frame = null;
    if (!stopped) decorateRows(doc, tagFor, lengths());
  };
  const refresh = () => {
    if (stopped || frame !== null) return;
    frame = schedule(run) as unknown as number;
  };

  const observer = new (view?.MutationObserver ?? MutationObserver)((mutations) => {
    if (touchesRows(mutations)) refresh();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  refresh();

  return {
    refresh,
    stop() {
      stopped = true;
      observer.disconnect();
      if (frame !== null) cancel(frame);
      frame = null;
      removeTags(doc);
    },
  };
}
