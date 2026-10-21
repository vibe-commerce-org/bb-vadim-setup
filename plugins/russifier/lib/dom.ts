// Applies the engine to bb's page: text nodes and three attributes, outside
// protected zones (protect.ts), now and as React renders.
//
// Rules that keep bb intact:
// - only a text node's data and the values of aria-label / title / placeholder
//   change; nodes are never added, removed or wrapped, so React's own updates
//   simply overwrite them and the observer translates again;
// - the original of every change is kept, so stop() restores English without
//   a reload;
// - the prompt editor is never written to: its placeholder is a CSS rule, the
//   compact one a CSS variable on the form around it;
// - the observer drops mutations inside protected zones first (an agent's
//   streaming reply lives there), batches the rest and keeps to a time budget.
import type { Engine } from "./engine.ts";
import { ATTRIBUTES_ONLY_SELECTOR, PROTECTED_SELECTOR, isForeignPluginRoot, isInsideProtected } from "./protect.ts";

const ATTRS = ["aria-label", "title", "placeholder"] as const;
const OBSERVED_ATTRS = [...ATTRS, "data-placeholder", "style"];
const COMPACT_VAR = "--promptbox-container-compact-placeholder";
const EDITOR_PLACEHOLDERS = "[data-promptbox-editor-content] [data-placeholder]";
const LATIN = /[A-Za-z]/;
const MAX_TEXT = 300;
/** Nodes handled inside the observer callback, before the browser paints. */
const SYNC_LIMIT = 400;
const CHUNK_MS = 8;
/** Over this many ms of our work in one second → process in slower batches. */
const BUDGET_MS = 50;
const LOOP_WRITES = 20;
const LOOP_WINDOW_MS = 2000;

interface Record_ {
  orig: string;
  tr: string;
}

export interface DomTranslatorHooks {
  /** An interface-looking string with no translation (for the missing log). */
  onMissing?(text: string): void;
  now?(): number;
  /** Diagnostics, e.g. a node that kept being rewritten. */
  warn?(message: string): void;
}

export interface DomTranslatorStats {
  translated: number;
  callbacks: number;
  records: number;
  spentMs: number;
  blocked: number;
  degraded: boolean;
}

function cssString(text: string): string {
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ") + '"';
}

export class DomTranslator {
  private texts = new WeakMap<Text, Record_>();
  private attrs = new WeakMap<Element, Map<string, Record_>>();
  private vars = new WeakMap<HTMLElement, Record_>();
  private writes = new WeakMap<Node, { n: number; since: number }>();
  private blocked = new WeakSet<Node>();
  private observer: MutationObserver | null = null;
  private style: HTMLStyleElement | null = null;
  private placeholderRules = new Map<string, string>();
  private queue: Node[] = [];
  private queued = new Set<Node>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowStart = 0;
  private windowSpent = 0;
  private active = false;
  readonly stats: DomTranslatorStats = { translated: 0, callbacks: 0, records: 0, spentMs: 0, blocked: 0, degraded: false };

  private readonly doc: Document;
  private readonly engine: Engine;
  private readonly hooks: DomTranslatorHooks;

  constructor(doc: Document, engine: Engine, hooks: DomTranslatorHooks = {}) {
    this.doc = doc;
    this.engine = engine;
    this.hooks = hooks;
  }

  get isActive(): boolean {
    return this.active;
  }

  private now(): number {
    return this.hooks.now?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  start(): void {
    if (this.active || !this.doc.body) return;
    this.active = true;
    this.style = this.doc.createElement("style");
    this.style.setAttribute("data-russifier", "");
    (this.doc.head ?? this.doc.body).appendChild(this.style);
    const t0 = this.now();
    this.walk(this.doc.body);
    this.syncPlaceholders(this.doc);
    this.account(t0);
    const View = this.doc.defaultView;
    const Observer = View?.MutationObserver ?? (typeof MutationObserver !== "undefined" ? MutationObserver : undefined);
    if (!Observer) return;
    this.observer = new Observer((records) => this.onRecords(records));
    this.observer.observe(this.doc.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.queued.clear();
    this.restore(this.doc.body);
    this.style?.remove();
    this.style = null;
    this.placeholderRules.clear();
  }

  // ------------------------------------------------------------- observer

  private onRecords(records: MutationRecord[]): void {
    const t0 = this.now();
    this.stats.callbacks++;
    this.stats.records += records.length;
    for (const record of records) {
      if (record.type === "childList") {
        record.addedNodes.forEach((node) => this.enqueue(node));
      } else if (record.type === "characterData") {
        this.enqueue(record.target);
      } else {
        const el = record.target as Element;
        const name = record.attributeName ?? "";
        if (name === "style") {
          if (el.hasAttribute("data-promptbox")) this.translateCompactVar(el as HTMLElement);
        } else if (name === "data-placeholder") {
          const value = el.getAttribute("data-placeholder");
          if (value) this.ensurePlaceholderRule(value);
        } else if (!isInsideProtected(el)) {
          this.translateAttr(el, name);
        }
      }
    }
    if (this.stats.degraded) this.schedule(250);
    else this.drain(SYNC_LIMIT);
    this.account(t0);
  }

  private enqueue(node: Node): void {
    if (this.queued.has(node)) return;
    this.queued.add(node);
    this.queue.push(node);
  }

  /** Process up to `limit` queued nodes; the rest goes to timed chunks. */
  private drain(limit: number): void {
    let done = 0;
    while (this.queue.length > 0 && done < limit) {
      const node = this.queue.shift()!;
      this.queued.delete(node);
      this.processNode(node);
      done++;
    }
    if (this.queue.length > 0) this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active) return;
      const t0 = this.now();
      while (this.queue.length > 0 && this.now() - t0 < CHUNK_MS) {
        const node = this.queue.shift()!;
        this.queued.delete(node);
        this.processNode(node);
      }
      this.account(t0);
      if (this.queue.length > 0) this.schedule(this.stats.degraded ? 250 : 0);
    }, delay);
  }

  /** Time budget per second: past it, work moves to slower batches. */
  private account(t0: number): void {
    const t1 = this.now();
    const spent = t1 - t0;
    this.stats.spentMs += spent;
    if (t1 - this.windowStart > 1000) {
      this.windowStart = t1;
      this.windowSpent = 0;
      this.stats.degraded = false;
    }
    this.windowSpent += spent;
    if (this.windowSpent > BUDGET_MS) this.stats.degraded = true;
  }

  private processNode(node: Node): void {
    if (!node.isConnected) return;
    if (node.nodeType === 3) {
      const parent = (node as Text).parentElement;
      if (parent && !isInsideProtected(parent) && parent.closest(ATTRIBUTES_ONLY_SELECTOR) === null) this.translateText(node as Text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isInsideProtected(el)) return;
    this.walk(el);
    if (el.querySelector?.("[data-placeholder]")) this.syncPlaceholders(el);
  }

  // ---------------------------------------------------------------- walk

  /** Translate `root` and its subtree, skipping protected branches whole. */
  private walk(root: Element): void {
    this.translateElement(root);
    if (root.matches(ATTRIBUTES_ONLY_SELECTOR)) return;
    const self = this;
    const walker = this.doc.createTreeWalker(root, 0x1 | 0x4, {
      acceptNode(node: Node): number {
        if (node.nodeType === 3) {
          self.translateText(node as Text);
          return 3; // FILTER_SKIP
        }
        const el = node as Element;
        if (el.matches(PROTECTED_SELECTOR) || isForeignPluginRoot(el)) return 2; // FILTER_REJECT
        self.translateElement(el);
        return el.matches(ATTRIBUTES_ONLY_SELECTOR) ? 2 : 3;
      },
    });
    while (walker.nextNode()) {
      // every node is handled in acceptNode
    }
  }

  private translateElement(el: Element): void {
    for (const name of ATTRS) {
      if (el.hasAttribute(name)) this.translateAttr(el, name);
    }
    if (el.hasAttribute("data-promptbox")) this.translateCompactVar(el as HTMLElement);
  }

  private allowWrite(node: Node): boolean {
    if (this.blocked.has(node)) return false;
    const t = this.now();
    const w = this.writes.get(node);
    if (!w || t - w.since > LOOP_WINDOW_MS) {
      this.writes.set(node, { n: 1, since: t });
      return true;
    }
    w.n++;
    if (w.n <= LOOP_WRITES) return true;
    this.blocked.add(node);
    this.stats.blocked++;
    this.hooks.warn?.("a node kept being rewritten; it is left in English until reload");
    return false;
  }

  private translateText(node: Text): void {
    const value = node.data;
    if (value.length < 2 || value.length > MAX_TEXT || !LATIN.test(value)) return;
    const rec = this.texts.get(node);
    if (rec && rec.tr === value) return;
    const tr = this.engine.translate(value);
    if (tr === null) {
      this.hooks.onMissing?.(value);
      return;
    }
    if (tr === value || !this.allowWrite(node)) return;
    this.texts.set(node, { orig: value, tr });
    node.data = tr;
    this.stats.translated++;
  }

  private translateAttr(el: Element, name: string): void {
    const value = el.getAttribute(name);
    if (!value || value.length > MAX_TEXT || !LATIN.test(value)) return;
    let map = this.attrs.get(el);
    const rec = map?.get(name);
    if (rec && rec.tr === value) return;
    const tr = this.engine.translate(value);
    if (tr === null) {
      this.hooks.onMissing?.(value);
      return;
    }
    if (tr === value || !this.allowWrite(el)) return;
    if (!map) {
      map = new Map();
      this.attrs.set(el, map);
    }
    map.set(name, { orig: value, tr });
    el.setAttribute(name, tr);
    this.stats.translated++;
  }

  // ----------------------------------------------------- prompt editor

  /** The compact composer shows a CSS variable set on its form. */
  private translateCompactVar(el: HTMLElement): void {
    const raw = el.style?.getPropertyValue(COMPACT_VAR);
    if (!raw) return;
    const rec = this.vars.get(el);
    if (rec && rec.tr === raw) return;
    let text: unknown;
    try {
      text = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof text !== "string") return;
    const tr = this.engine.translate(text);
    if (tr === null || tr === text) return;
    const value = JSON.stringify(tr);
    this.vars.set(el, { orig: raw, tr: value });
    el.style.setProperty(COMPACT_VAR, value);
  }

  private syncPlaceholders(root: ParentNode): void {
    root.querySelectorAll(EDITOR_PLACEHOLDERS).forEach((el) => {
      const value = el.getAttribute("data-placeholder");
      if (value) this.ensurePlaceholderRule(value);
    });
  }

  /**
   * bb draws the editor placeholder with `content: attr(data-placeholder)`.
   * A more specific rule per known placeholder replaces the text without
   * touching the editor; the compact composer's own rule stays stronger.
   */
  private ensurePlaceholderRule(value: string): void {
    if (!this.style || this.placeholderRules.has(value)) return;
    const tr = this.engine.translate(value);
    if (tr === null || tr === value) return;
    const rule =
      `[data-promptbox-editor-content] .ProseMirror p.is-editor-empty:first-child[data-placeholder=${cssString(value)}]::before` +
      `{content:${cssString(tr)}}`;
    this.placeholderRules.set(value, rule);
    this.style.textContent = [...this.placeholderRules.values()].join("\n");
  }

  // -------------------------------------------------------------- restore

  private restore(root: Element): void {
    const restoreElement = (el: Element) => {
      const map = this.attrs.get(el);
      if (map) {
        for (const [name, rec] of map) {
          if (el.getAttribute(name) === rec.tr) el.setAttribute(name, rec.orig);
        }
        this.attrs.delete(el);
      }
      const v = this.vars.get(el as HTMLElement);
      if (v) {
        if ((el as HTMLElement).style.getPropertyValue(COMPACT_VAR) === v.tr) (el as HTMLElement).style.setProperty(COMPACT_VAR, v.orig);
        this.vars.delete(el as HTMLElement);
      }
    };
    restoreElement(root);
    const walker = this.doc.createTreeWalker(root, 0x1 | 0x4);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) {
        const text = node as Text;
        const rec = this.texts.get(text);
        if (rec) {
          if (text.data === rec.tr) text.data = rec.orig;
          this.texts.delete(text);
        }
      } else {
        restoreElement(node as Element);
      }
    }
  }
}
