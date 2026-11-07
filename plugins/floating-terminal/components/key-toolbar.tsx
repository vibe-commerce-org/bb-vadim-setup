// The keys a software keyboard does not have.
//
// Sits at the bottom of the sheet, which is where the iOS keyboard pushes it —
// so it lands directly above the keys, the way every native terminal app on the
// platform puts it. Rendered only in sheet mode; a desktop keyboard has all of
// these already.
//
// Ctrl is a latch rather than a chord: there is no way to hold two keys at once
// on a touch screen, so tapping it arms the modifier and the next character
// typed on the software keyboard becomes its control code.
import { useRef } from "react";
import { TOOLBAR_KEYS, type ToolbarKey } from "@/lib/keys";
import { cn } from "@/lib/utils";

export interface KeyToolbarProps {
  ctrlArmed: boolean;
  onKey: (key: ToolbarKey) => void;
}

export function KeyToolbar({ ctrlArmed, onKey }: KeyToolbarProps) {
  // The pointer that went down on a key, so a key fires only for the press that
  // started on it.
  const pressed = useRef<{ id: string; pointerId: number } | null>(null);
  return (
    <div
      className="bb-ft-keybar flex shrink-0 items-center gap-1 border-t border-border bg-muted/40"
      role="toolbar"
      aria-label="Terminal keys"
      data-no-drag=""
      // iOS moves focus on the click a tap synthesizes after touchend, which
      // preventDefault on pointerdown does not cancel: every key blurred the
      // terminal and the keyboard went down. For paste that also lost the text:
      // iOS delivers the bubble's Paste to whatever holds focus, and by then it
      // was the button. Cancelling touchend drops that click. The keys fire on
      // pointer events, so none of them needs it, and a touch that scrolled the
      // bar ends uncancelable and is left alone. (Upstream a5c85c3, v0.7.0.)
      onTouchEnd={(event) => {
        if (event.cancelable) event.preventDefault();
      }}
    >
      {TOOLBAR_KEYS.map((key) => {
        const armed = key.id === "ctrl" && ctrlArmed;
        return (
          <button
            key={key.id}
            type="button"
            title={key.title}
            aria-label={key.title}
            aria-pressed={key.kind === "modifier" ? armed : undefined}
            // Pointer events, not click: a tap that lands on a button steals
            // focus from the terminal, and on iOS losing focus dismisses the
            // keyboard. Preventing the default keeps focus where it is, so the
            // bar can be used mid-command without the keyboard flapping.
            //
            // Every key fires on the lift, never on the touch. The bar is wider
            // than a phone, so reaching paste means swiping across ^C and ^D,
            // and a key fired on pointerdown sent them on the swipe's first
            // touch: a password prompt was interrupted before anything was
            // tapped. A swipe ends in pointercancel instead of pointerup and
            // fires nothing. Paste needs the lift anyway: iOS counts pointerup
            // as user activation for navigator.clipboard.readText(), and a
            // touch pointerdown not.
            onPointerDown={(event) => {
              event.preventDefault();
              pressed.current = { id: key.id, pointerId: event.pointerId };
            }}
            onPointerUp={(event) => {
              const press = pressed.current;
              if (press?.id !== key.id || press.pointerId !== event.pointerId) return;
              pressed.current = null;
              onKey(key);
            }}
            onPointerCancel={() => {
              pressed.current = null;
            }}
            onPointerLeave={() => {
              pressed.current = null;
            }}
            className={cn(
              "bb-ft-key",
              key.emphasis ? "bb-ft-key-strong" : null,
              armed ? "bb-ft-key-armed" : null,
            )}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}
