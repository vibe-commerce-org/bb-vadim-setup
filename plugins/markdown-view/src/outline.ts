// The document's headings as a flat list for the outline drawer of a narrow
// panel, decided without touching the page.

export interface OutlineEntry {
  /** Position among all the headings of the document, to find it again when tapped. */
  index: number;
  /** 1 for h1 … 6 for h6. */
  level: number;
  text: string;
}

/** The query that finds every heading in the editor's text. */
export const HEADINGS_SELECTOR = "h1, h2, h3, h4, h5, h6";

/** Vditor keeps the `#` marks of a heading in its text; the outline shows the words only. */
export const headingText = (text: string) => text.replace(/^\s*#+\s*/, "").replace(/\s+#+\s*$/, "").trim();

/** Headings with no words (an empty `#`) are left out; the rest keep their position and level. */
export function outlineEntries(headings: readonly { tag: string; text: string }[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  headings.forEach(({ tag, text }, index) => {
    const level = Number(tag.slice(1));
    const words = headingText(text);
    if (words !== "" && level >= 1 && level <= 6) entries.push({ index, level, text: words });
  });
  return entries;
}

/** How far a heading is pushed in: the shallowest level in the document sits at the edge. */
export const outlineDepths = (entries: readonly OutlineEntry[]): number[] => {
  const shallowest = Math.min(...entries.map((entry) => entry.level));
  return entries.map((entry) => entry.level - shallowest);
};
