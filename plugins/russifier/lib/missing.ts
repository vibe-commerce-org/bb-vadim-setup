// Interface strings seen without a translation. Kept on this bb server only
// (the plugin's own database, `bb russifier missing`), to grow the dictionary
// from what is actually on screen. Protected zones never reach here; the
// filter below drops what looks like data rather than a label.
const MAX_DISTINCT = 1500;
const MAX_PER_REPORT = 200;
const FLUSH_MS = 30_000;

/** True for strings worth logging: short English labels, not names or paths. */
export function looksLikeLabel(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (/[А-Яа-яЁё]/.test(t)) return false;
  if (/^\d/.test(t)) return false;
  if (/[_/\\@#<>{}=|]|https?:|\.[a-z0-9]{1,5}$|^v?\d+\.\d+/i.test(t)) return false;
  if (/^[A-Z][A-Za-z'’]*(\s+[A-Za-z'’,.:!?()&-]+)*[.:!?…]?$/.test(t)) return true;
  return /^[a-z]+( [a-z]+){0,3}$/.test(t);
}

export type Reporter = (items: { text: string; count: number }[]) => Promise<void>;

export class MissingLog {
  private counts = new Map<string, number>();
  private seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  enabled = true;

  private readonly report: Reporter;

  constructor(report: Reporter) {
    this.report = report;
  }

  add(text: string): void {
    if (!this.enabled) return;
    const t = text.trim().replace(/\s+/g, " ");
    if (!looksLikeLabel(t)) return;
    if (!this.seen.has(t)) {
      if (this.seen.size >= MAX_DISTINCT) return;
      this.seen.add(t);
    }
    this.counts.set(t, (this.counts.get(t) ?? 0) + 1);
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.counts.size === 0) return;
    const items = [...this.counts].slice(0, MAX_PER_REPORT).map(([text, count]) => ({ text, count }));
    for (const item of items) this.counts.delete(item.text);
    try {
      await this.report(items);
    } catch {
      // Offline or not authorised here: the strings come back next time.
    }
  }
}
