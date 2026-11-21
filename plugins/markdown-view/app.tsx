// Markdown view — opens .md files in BB's file panel read-only, in Vditor's
// "like Typora" look, with an outline and live refresh; "Редактировать" edits
// them in place, saving only the lines that were changed. Also HTML_vibecom:
// .html as a page whose links BB opens, instead of the page following them.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app come from the BB app at load time (never bundled);
// Vditor is loaded on the first open from the plugin server (see server.ts).
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { HtmlOpener } from "./src/HtmlOpener";
import { pinHtmlOpenerInWindow } from "./src/html-pin";
import { MarkdownOpener } from "./src/MarkdownOpener";

// This plugin's own opener adds the repository tree and "Копировать путь";
// Explorer_vibecom embeds MarkdownOpener without them.
const RepoMarkdownOpener = (props: PluginFileOpenerProps) => <MarkdownOpener {...props} repoTools />;

export default definePluginApp((bb) => {
  // A link to an HTML file opens HTML_vibecom on this client, once (src/html-pin.ts).
  pinHtmlOpenerInWindow();

  bb.slots.fileOpener({
    id: "markdown",
    title: "Markdown (как в Typora, правка)",
    extensions: ["md", "mdx", "markdown"],
    component: RepoMarkdownOpener,
  });
  bb.slots.fileOpener({
    id: "html",
    title: "HTML_vibecom",
    extensions: ["html", "htm"],
    component: HtmlOpener,
  });
});
