import { useEffect, useState, type ComponentType } from "react";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
// The viewers of the sibling plugins, compiled into this bundle. BB has no way
// to render another plugin's file opener inside a panel, so the panel imports
// their components instead — one source, no copies. Their src/ folders are the
// @vibecommerce/* packages, installed from vendor/*.tgz (`npm run pack-viewers`;
// `npm run link-viewers` links the sibling folders while developing). Each
// declares `bb.pluginTailwindContent`, which is how their Tailwind classes get
// built here.
import { MarkdownOpener } from "@vibecommerce/markdown-view/MarkdownOpener";
import { FileOpener } from "@vibecommerce/office-preview/opener-ui";
import {
  PowerPointOpener,
  SpreadsheetOpener,
  WordOpener,
} from "@vibecommerce/office-preview/openers";
import type { DocumentViewer } from "@/lib/open-with";
import { PdfPages, prefersDrawnPdf } from "./PdfPages";

/** A file as the borrowed viewers address it: relative in a checkout, absolute on a host. */
export interface ViewerTarget {
  path: string;
  source: PluginFileOpenerSource;
}

const passBytes = async (bytes: Uint8Array) => bytes;

/**
 * A document shown inside the panel. `Original` is what a viewer falls back
 * to when it cannot read the file — here, the panel's own stub with its ways
 * out — and what formats no viewer reads get straight away.
 */
export function DocumentView({
  target,
  viewer,
  Original,
}: {
  target: ViewerTarget;
  viewer: DocumentViewer;
  Original: ComponentType;
}) {
  const props = { path: target.path, source: target.source, Original };
  return (
    // Keyed by path: each viewer loads in an effect, and a reused instance
    // would show the previous document until the next one arrived.
    <div key={target.path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {viewer === "pdf" ? (
        <FileOpener {...props} loadingLabel="Opening PDF…" load={passBytes}>
          {(bytes) =>
            prefersDrawnPdf() ? (
              <PdfPages bytes={bytes} title={target.path} />
            ) : (
              <PdfFrame bytes={bytes} title={target.path} />
            )
          }
        </FileOpener>
      ) : viewer === "spreadsheet" ? (
        <SpreadsheetOpener {...props} />
      ) : viewer === "word" ? (
        <WordOpener {...props} />
      ) : viewer === "presentation" ? (
        <PowerPointOpener {...props} />
      ) : (
        <Original />
      )}
    </div>
  );
}

/** Markdown through markdown-view: its reading view and its editor. */
export function MarkdownDocument({ target, Original }: { target: ViewerTarget; Original: ComponentType }) {
  return (
    <div key={target.path} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <MarkdownOpener path={target.path} source={target.source} Original={Original} copyPath />
    </div>
  );
}

/** The browser's own PDF viewer, as BB's builtin pdf-preview shows it — on a desktop. */
function PdfFrame({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  if (url === null) return null;
  return <iframe src={url} title={title} className="min-h-0 w-full flex-1 border-0 bg-background" />;
}
