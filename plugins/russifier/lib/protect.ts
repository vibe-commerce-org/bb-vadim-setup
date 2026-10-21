// Where the russifier never writes. Checked against bb 0.46 DOM on 2026-10-14
// (the russifier plan, stage 0):
// - [data-markdown-preview] wraps the text of every message (user and agent)
//   and markdown file previews;
// - .bb-thread-title wraps chat titles in the sidebar and the chat header,
//   including their title attribute;
// - [data-plan-step-status] rows are the agent's own plan steps;
// - .ProseMirror / .tiptap is the prompt editor: touching it makes it re-render
//   in a loop, so even its placeholder is translated with CSS (see dom.ts);
// - [role="tree"] lists file and folder names (Explorer, bb's file panels);
// - code, terminals, editors and inputs hold the user's data as is.
// Effort stays in English (the user, 2026-10-21; GLOSSARY.md «Не переводим»).
// Low / Medium / High are also task priorities, which stay Russian, so the
// places that show effort are protected instead (bb 0.46.1 DOM):
// - the «Reasoning» radio group of the model menu (its aria-label stays
//   English because «Reasoning» is not translated);
// - the level next to the model in the composer button: its wrapper's
//   title reads «Claude Code: Opus 5.5 · High reasoning».
export const PROTECTED_SELECTOR = [
  "pre",
  "code",
  "kbd",
  "samp",
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  '[contenteditable]:not([contenteditable="false"])',
  ".ProseMirror",
  ".tiptap",
  ".xterm",
  ".monaco-editor",
  ".cm-editor",
  ".vditor",
  ".textLayer",
  "[data-markdown-preview]",
  ".bb-thread-title",
  "[data-plan-step-status]",
  '[role="tree"]',
  '[role="treeitem"]',
  '[role="radiogroup"][aria-label="Reasoning"]',
  '[title*=" reasoning"] > [data-promptbox-hide-compact]',
  "[data-russifier-skip]",
].join(",");

/**
 * Elements whose own attributes (placeholder, aria-label) are interface text
 * but whose content is the user's: a textarea's text child is its value.
 */
export const ATTRIBUTES_ONLY_SELECTOR = "textarea";

/**
 * Plugins whose interface the dictionary covers: bb's builtin plugins and our
 * own `_vibecom` ones. Anything else under [data-bb-plugin] stays untouched —
 * a third-party plugin may show its user's data in words we would translate.
 * The file viewers (markdown-view, office-preview) are left out on purpose:
 * their interface is Russian already and the rest is the document itself.
 */
export const TRANSLATED_PLUGINS: ReadonlySet<string> = new Set([
  "account-pool",
  "agent-annotations",
  "ask-user-question",
  "automations",
  "bb-account",
  "bb-ai",
  "bb-guide",
  "browser-automation",
  "concurrency-limit",
  "connect",
  "custom-instructions",
  "docs",
  "drafts",
  "environment-git-worktree",
  "environment-modal-sandbox",
  "environment-personal-workspace",
  "environment-project-checkout",
  "github",
  "inline-vis",
  "keep-awake",
  "memory",
  "monaco-editor",
  "pdf-preview",
  "plugin-api-docs",
  "plugin-api-tester",
  "prompt-library",
  "bb--prompt-library",
  "provider-acp",
  "provider-claude-code",
  "provider-codex",
  "provider-pi",
  "provider-retry",
  "provider-usage",
  "bb--provider-usage",
  "push-notifications",
  "scheduled-send",
  "secrets",
  "side-chat",
  "storage-retention",
  "bb--storage-retention",
  "tasks",
  "theme-preview",
  "thread-list",
  "workflows",
  // ours
  "files-editor",
  "floating-terminal",
  "folder-links",
  "pult",
  "russifier",
]);

/** An element that starts a plugin's own subtree we must not touch. */
export function isForeignPluginRoot(el: Element): boolean {
  const id = el.getAttribute("data-bb-plugin");
  return id !== null && !TRANSLATED_PLUGINS.has(id);
}

/** True when `el` or an ancestor is protected (used for mutation targets). */
export function isInsideProtected(el: Element): boolean {
  if (el.closest(PROTECTED_SELECTOR) !== null) return true;
  const plugin = el.closest("[data-bb-plugin]");
  return plugin !== null && isForeignPluginRoot(plugin);
}
