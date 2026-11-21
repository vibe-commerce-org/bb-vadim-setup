// The outline of a narrow panel (a phone): the document's headings in a list
// that slides over the text. Vditor's own outline is a 250 px column beside
// the text, which on a phone would leave the text 140 px. A tap on a heading
// goes to it and puts the list away; so does the × and a tap on the dimmed text.
import { CloseIcon } from "./icons";
import { outlineDepths } from "./outline";
import type { OutlineEntry } from "./outline";
import { ICON_BUTTON } from "./ui";

export function OutlineDrawer({
  entries,
  onPick,
  onClose,
}: {
  entries: readonly OutlineEntry[];
  onPick: (entry: OutlineEntry) => void;
  onClose: () => void;
}) {
  const depths = outlineDepths(entries);
  return (
    <>
      <button type="button" aria-label="Закрыть оглавление" className="absolute inset-0 z-20 bg-black/40" onClick={onClose} />
      <nav
        aria-label="Оглавление"
        className="absolute inset-y-0 left-0 z-30 flex w-[min(85%,320px)] min-h-0 flex-col border-r border-border bg-background shadow-xl"
      >
        <div className="flex min-h-10 flex-none items-center gap-1 border-b border-border pl-3 pr-1">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">Оглавление</span>
          <button type="button" className={`${ICON_BUTTON} border-0`} title="Закрыть оглавление" aria-label="Закрыть оглавление" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
          {entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">В документе нет заголовков.</p>
          ) : (
            entries.map((entry, position) => (
              <button
                key={entry.index}
                type="button"
                title={entry.text}
                className="flex min-h-9 w-full items-center pr-3 text-left text-sm text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                style={{ paddingLeft: 12 + depths[position] * 14 }}
                onClick={() => onPick(entry)}
              >
                <span className={`min-w-0 flex-1 truncate ${entry.level <= 2 ? "font-semibold" : ""}`}>{entry.text}</span>
              </button>
            ))
          )}
        </div>
      </nav>
    </>
  );
}
