# @vibecommerce/markdown-view

The viewer components of **Markdown_vibecom**, a plugin for [BB](https://getbb.app): Markdown
read-only in a Typora-like look (outline, relative images, refreshed live when the file changes on
disk), and editing in place with [Vditor](https://github.com/Vanessa219/vditor) that saves only the
changed lines. Packaged so that another BB plugin can show Markdown inside its own panel.

The package ships TypeScript sources. It is meant to be compiled by `bb plugin build`, not used on
its own.

```tsx
import { MarkdownOpener } from "@vibecommerce/markdown-view/MarkdownOpener";

// Same props as a BB file opener: { path, source, Original }
<MarkdownOpener path={path} source={source} Original={Original} />
```

`HtmlOpener` (shown as **HTML_vibecom**) opens an `.html` page the way a browser shows it — scripts
run in a sandbox with an opaque origin, relative CSS and images load — and hands the page's links to
BB: a `.md` or any other file (relative or `file://`) opens in a new tab with its own opener, a web
link through BB's browser preference, `#section` scrolls the page — each resolved from the page's own
`<base>` if it has one. Only links the file itself has are followed, at most one a second, right after
a click in the page.

```tsx
import { HtmlOpener } from "@vibecommerce/markdown-view/HtmlOpener";

<HtmlOpener path={path} source={source} Original={Original} />
```

- Optional props: `copyPath` adds a button that copies the file's full path to the clipboard;
  `repoTools` adds that button and the repository tree with the open file marked (for a plugin that has
  no tree of its own). Both are off by default.
- In a panel narrower than 720 px (a phone, BB's side panel) the toolbar shows icons instead of words,
  and the outline is a list of headings over the text instead of Vditor's 250 px column.
- `react` and `@get-bb/plugin-sdk` are optional peer dependencies: BB supplies both at runtime.
- `bb.pluginTailwindContent` in `package.json` lets `bb plugin build` pick up the Tailwind classes
  of these files when the package is a direct dependency of your plugin.
- Both the read-only view and the editor are Vditor, and its script and assets come from the route
  of the Markdown_vibecom plugin server (`/api/v1/plugins/markdown-view/http/vditor`): that plugin
  has to be installed.
- Interface strings are in Russian.

License: MIT.

Last Updated: 2026-11-10 (`HtmlOpener` — HTML_vibecom: `HtmlOpener.tsx`, `html-page.ts`, `html-pin.ts`; locating the file moved from `MarkdownOpener` to `LocatedFile.tsx`; `useOpenLink` returns whether BB opened the link; `pageRoot` in `links.ts`. Earlier 2026-11-08: icon toolbar and outline list in a narrow panel; `copyPath`, `repoTools`)
