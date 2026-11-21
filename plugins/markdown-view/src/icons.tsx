// The toolbar's icons: Lucide's shapes, drawn inline so the panel needs no icon
// font. In a narrow panel (a phone, BB's side panel) they replace the words;
// the word stays as the button's title and screen-reader label.
import type { ReactNode } from "react";

function Svg({ strokeWidth = 2, children }: { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4 flex-none"
    >
      {children}
    </svg>
  );
}

/** The repository's files. */
export const TreeIcon = () => (
  <Svg>
    <path d="M21 12h-8" />
    <path d="M21 6H8" />
    <path d="M21 18h-8" />
    <path d="M3 6v4c0 1.1.9 2 2 2h3" />
    <path d="M3 10v6c0 1.1.9 2 2 2h3" />
  </Svg>
);

/** Headings of the document. */
export const OutlineIcon = () => (
  <Svg>
    <path d="M16 12H3" />
    <path d="M16 18H3" />
    <path d="M16 6H3" />
    <path d="M21 12h.01" />
    <path d="M21 18h.01" />
    <path d="M21 6h.01" />
  </Svg>
);

export const CopyIcon = () => (
  <Svg>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </Svg>
);

export const CheckIcon = () => (
  <Svg strokeWidth={2.5}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const CloseIcon = () => (
  <Svg>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);

/** BB's own preview. */
export const EyeIcon = () => (
  <Svg>
    <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** How the document looks: text size, line height, width, font. */
export const TextSizeIcon = () => (
  <Svg>
    <path d="M21 14h-5" />
    <path d="M16 16v-3.5a2.5 2.5 0 0 1 5 0V16" />
    <path d="M4.5 13h6" />
    <path d="m3 16 4.5-9 4.5 9" />
  </Svg>
);

export const PencilIcon = () => (
  <Svg>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Svg>
);

/** "Like Typora": markup opens where the caret is. */
export const TyporaModeIcon = () => (
  <Svg>
    <path d="M12 20h9" />
    <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
  </Svg>
);

/** "Like Word": formatted text only. */
export const WordModeIcon = () => (
  <Svg>
    <path d="M4 7V4h16v3" />
    <path d="M9 20h6" />
    <path d="M12 4v16" />
  </Svg>
);

/** "Source": the file's text as it is. */
export const SourceModeIcon = () => (
  <Svg>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </Svg>
);
