// The look of the two modes, as plain CSS rendered in a <style> by the
// document (Tailwind utilities can't reach into Vditor's own markup or tell
// BB's light theme from its dark one). Colours come from BB's theme tokens:
// --primary is the accent, --border the quiet edge, --foreground and
// --background the text and the page.
//
// Contrast, measured on BB's Atom One themes: the primary button is white on
// the accent darkened by 20% in the light theme (#4078f2 itself gives white
// only 4.05:1), and the dark theme's own pair, --primary-foreground on
// --primary, in the dark one (white on #61afef would be 2.4:1).

export const LOOK_CSS = `
.mdv-primary {
  display: inline-flex; flex: none; align-items: center; gap: 6px;
  height: 28px; padding: 0 12px; border: 0; border-radius: 6px;
  font: inherit; font-size: 12px; font-weight: 600; line-height: 1;
  color: #fff; background-color: color-mix(in srgb, var(--primary) 80%, black);
  cursor: pointer;
}
.mdv-primary:hover { background-color: color-mix(in srgb, var(--primary) 70%, black); }
.mdv-primary:active { background-color: color-mix(in srgb, var(--primary) 60%, black); }
.mdv-primary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.mdv-primary:disabled { opacity: 0.5; cursor: default; }
.mdv-primary svg { width: 14px; height: 14px; flex: none; }
/* In a narrow panel the word is gone and the button is a square the size of its neighbours. */
.mdv-primary--icon { width: 32px; height: 32px; padding: 0; justify-content: center; }
.dark .mdv-primary { color: var(--primary-foreground); background-color: var(--primary); }
.dark .mdv-primary:hover { background-color: color-mix(in srgb, var(--primary) 85%, white); }
.dark .mdv-primary:active { background-color: color-mix(in srgb, var(--primary) 85%, black); }

.mdv-badge {
  display: inline-flex; flex: none; align-items: center; height: 20px; padding: 0 8px;
  border: 1px solid currentColor; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: color-mix(in srgb, var(--primary) 80%, black);
}
.dark .mdv-badge { color: var(--primary); }

/* The document area. The frame is there in both modes, so entering editing moves nothing. */
.mdv-frame { position: absolute; inset: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; }
.mdv-frame .vditor { border: 0; border-radius: 0; }
.mdv-editing .mdv-frame { border-color: var(--border); }
.mdv-editing .mdv-frame:focus-within { border-color: var(--primary); }
.mdv-editing .vditor-reset { caret-color: var(--primary); }
.mdv-editing .vditor-reset [data-mdv-current] {
  background-color: color-mix(in srgb, var(--primary) 7%, transparent);
  border-radius: 3px;
}

/*
 * The document's colours, from BB's theme rather than Vditor's light and dark
 * content stylesheets: those share selectors with Vditor's own light defaults,
 * so the order the files load in decided the colours — and once decided wrong
 * (dark text on a dark page, white tables). Under .mdv-frame these outrank all
 * of them whatever the order. Links 20% darker in the light theme: --primary
 * itself gives text only 3.9:1 on its background there.
 */
.mdv-frame { --mdv-link: color-mix(in srgb, var(--primary) 80%, black); }
.dark .mdv-frame { --mdv-link: var(--primary); }
.mdv-frame .vditor-reset,
.mdv-frame .vditor-reset h1, .mdv-frame .vditor-reset h2, .mdv-frame .vditor-reset h3,
.mdv-frame .vditor-reset h4, .mdv-frame .vditor-reset h5, .mdv-frame .vditor-reset h6 { color: var(--foreground); }
.mdv-frame .vditor-ir pre.vditor-reset, .mdv-frame .vditor-ir pre.vditor-reset:focus,
.mdv-frame .vditor-wysiwyg pre.vditor-reset, .mdv-frame .vditor-wysiwyg pre.vditor-reset:focus,
.mdv-frame .vditor-outline { background-color: var(--background); }
.mdv-frame .vditor-reset h1, .mdv-frame .vditor-reset h2 { border-bottom-color: var(--border); }
.mdv-frame .vditor-reset hr { background-color: var(--border); }
.mdv-frame .vditor-reset blockquote { color: var(--muted-foreground); border-left-color: var(--border); }
.mdv-frame .vditor-reset table tr { background-color: var(--background); border-top-color: var(--border); }
.mdv-frame .vditor-reset table tbody tr:nth-child(2n) { background-color: color-mix(in srgb, var(--foreground) 5%, var(--background)); }
.mdv-frame .vditor-reset table th { background-color: color-mix(in srgb, var(--foreground) 9%, var(--background)); }
.mdv-frame .vditor-reset table td, .mdv-frame .vditor-reset table th { border-color: var(--border); }
.mdv-frame .vditor-reset a, .mdv-frame .vditor-ir__link { color: var(--mdv-link); }
.mdv-frame .vditor-reset code:not(.hljs):not(.highlight-chroma) {
  color: var(--foreground);
  background-color: color-mix(in srgb, var(--primary) 12%, var(--background));
}

/* Viewing: Vditor fades a disabled editor and shows "not allowed"; here it is simply the document. */
.mdv-viewing .vditor-ir pre.vditor-reset[contenteditable="false"] { opacity: 1; cursor: auto; }
.mdv-viewing .vditor-toolbar { display: none; }

/* Editing: Vditor's tools in one row that scrolls sideways under a finger —
   wrapped, they took three rows of a phone screen above the text. */
.mdv-editing .vditor-toolbar {
  display: flex; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;
  overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.mdv-editing .vditor-toolbar::-webkit-scrollbar { display: none; }
.mdv-editing .vditor-toolbar > * { flex: none; }
/* The headings menu hangs below its "H" button, and a scrolling row clips it:
   while it is open (Vditor sets display: block inline) the row stops scrolling.
   "H" is the first tool, so the row is at its start anyway. */
.mdv-editing .vditor-toolbar:has(.vditor-hint[style*="block"]) { overflow: visible; }
.mdv-viewing .vditor-ir__preview { cursor: auto; }
.mdv-viewing .vditor-ir__node[data-type="a"] { cursor: pointer; }
`;
