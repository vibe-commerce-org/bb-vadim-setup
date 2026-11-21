// How documents look, in both the viewer and the editor — the typography part
// of Office Viewer's settings panel: text size, line height, page width, font,
// and whether the outline is shown. Kept in localStorage and shared by every
// open Markdown tab; nothing of it goes into the file.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { TextSizeIcon } from "./icons";
import { ICON_BUTTON, ICON_BUTTON_ON, SMALL_BUTTON, SMALL_BUTTON_ON } from "./ui";

export interface Display {
  /** Text size relative to the renderer's own, 1 = as is. */
  scale: number;
  /** Line height; null keeps the renderer's own. */
  lineHeight: number | null;
  width: keyof typeof PAGE_WIDTHS;
  font: keyof typeof FONTS;
  outline: boolean;
}

export const PAGE_WIDTHS = {
  full: { label: "Вся ширина", css: "none" },
  "960": { label: "960 px", css: "960px" },
  "768": { label: "768 px", css: "768px" },
  a4: { label: "A4", css: "210mm" },
} as const;

// Each with Cyrillic, and a fallback that has it too.
export const FONTS = {
  default: { label: "Обычный", css: "inherit" },
  serif: { label: "С засечками", css: "Georgia, 'PT Serif', 'Times New Roman', serif" },
  mono: { label: "Моноширинный", css: "ui-monospace, 'SF Mono', Menlo, monospace" },
} as const;

const DEFAULT: Display = { scale: 1, lineHeight: null, width: "full", font: "default", outline: true };
const STORAGE_KEY = "bb-plugin-markdown-view:display";

function load(): Display {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Display>;
    return {
      scale: typeof saved.scale === "number" ? saved.scale : DEFAULT.scale,
      lineHeight: typeof saved.lineHeight === "number" ? saved.lineHeight : null,
      width: saved.width && saved.width in PAGE_WIDTHS ? saved.width : DEFAULT.width,
      font: saved.font && saved.font in FONTS ? saved.font : DEFAULT.font,
      outline: typeof saved.outline === "boolean" ? saved.outline : DEFAULT.outline,
    };
  } catch {
    return DEFAULT;
  }
}

let current = load();
const listeners = new Set<() => void>();

/** A patch, or a function of the current setting — so two quick clicks count twice. */
type DisplayUpdate = Partial<Display> | ((display: Display) => Partial<Display>);

function update(change: DisplayUpdate): void {
  current = { ...current, ...(typeof change === "function" ? change(current) : change) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Private mode or a full quota: the setting still applies until reload.
  }
  for (const listener of listeners) listener();
}

export function useDisplay(): [Display, (change: DisplayUpdate) => void] {
  const display = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  return [display, update];
}

/** CSS variables the viewer and the editor read their typography from. */
export function displayVariables(display: Display): CSSProperties {
  return {
    "--mdv-scale": String(display.scale),
    "--mdv-font-size": `${Math.round(16 * display.scale)}px`,
    "--mdv-line-height": display.lineHeight === null ? "normal" : String(display.lineHeight),
    "--mdv-width": PAGE_WIDTHS[display.width].css,
    "--mdv-font": FONTS[display.font].css,
  } as CSSProperties;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

function Stepper({ label, value, onStep }: { label: string; value: string; onStep: (direction: -1 | 1) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <div className="flex items-center gap-1">
        <button type="button" className={SMALL_BUTTON} aria-label={`${label}: меньше`} onClick={() => onStep(-1)}>
          −
        </button>
        <span className="w-14 text-center tabular-nums">{value}</span>
        <button type="button" className={SMALL_BUTTON} aria-label={`${label}: больше`} onClick={() => onStep(1)}>
          +
        </button>
      </div>
    </div>
  );
}

function Choice<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Record<K, { label: string }>;
  value: K;
  onChange: (value: K) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <select
        className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        value={value}
        onChange={(event) => onChange(event.target.value as K)}
      >
        {(Object.keys(options) as K[]).map((key) => (
          <option key={key} value={key}>
            {options[key].label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The "Вид" button and its panel: text size, line height, page width, font. */
/** `compact`: the icon alone, where a wide panel has the word. */
export function DisplayMenu({ compact = false }: { compact?: boolean }) {
  const [display, setDisplay] = useDisplay();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={compact ? (open ? ICON_BUTTON_ON : ICON_BUTTON) : open ? SMALL_BUTTON_ON : SMALL_BUTTON}
        aria-expanded={open}
        aria-label="Вид документа"
        title="Размер текста, интервал, ширина страницы, шрифт"
        onClick={() => setOpen(!open)}
      >
        {compact ? <TextSizeIcon /> : "Вид"}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Вид документа"
          className="absolute right-0 top-full z-20 mt-1 w-72 space-y-3 rounded-md border border-border bg-background p-3 text-xs text-foreground shadow-lg"
        >
          <Stepper
            label="Размер текста"
            value={`${Math.round(display.scale * 100)}%`}
            onStep={(direction) => setDisplay((d) => ({ scale: round1(clamp(d.scale + direction * 0.1, 0.7, 2)) }))}
          />
          <Stepper
            label="Интервал"
            value={display.lineHeight === null ? "авто" : display.lineHeight.toFixed(1)}
            onStep={(direction) =>
              setDisplay((d) => ({ lineHeight: round1(clamp((d.lineHeight ?? 1.6) + direction * 0.1, 1, 2.4)) }))
            }
          />
          <Choice label="Ширина страницы" options={PAGE_WIDTHS} value={display.width} onChange={(width) => setDisplay({ width })} />
          <Choice label="Шрифт" options={FONTS} value={display.font} onChange={(font) => setDisplay({ font })} />
          <button
            type="button"
            className={`${SMALL_BUTTON} w-full`}
            onClick={() => setDisplay({ scale: DEFAULT.scale, lineHeight: null, width: DEFAULT.width, font: DEFAULT.font })}
          >
            Как было
          </button>
        </div>
      )}
    </div>
  );
}
