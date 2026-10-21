#!/usr/bin/env node
// Extract interface strings from an installed bb app into catalog/bb-<version>.json.
//
//   node scripts/extract-strings.mjs [--app /Applications/bb.app] [--out catalog/bb-<version>.json]
//
// Sources: the renderer bundle (app/dist/assets/*.js, minus syntax grammars,
// themes and diagram/terminal libraries) and every builtin plugin's
// dist/app.js. A builtin plugin's dist/server.js adds only short labels
// (label, title, displayName, description…) — names of environment kinds and
// the like. String literals and template literals are read with the
// TypeScript parser; a filter keeps what looks like interface text.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ts = require("typescript");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const appPath = opt("--app", "/Applications/bb.app");
const bbApp = path.join(appPath, "Contents/Resources/app.asar.unpacked/node_modules/bb-app");
const version = JSON.parse(fs.readFileSync(path.join(bbApp, "package.json"), "utf8")).version;
const outFile = opt("--out", path.join(here, "..", "catalog", `bb-${version}.json`));

// Renderer chunks that are libraries, not bb's interface.
const VENDOR_CHUNK =
  /^(chunk-[A-Z0-9]{8}|.*Diagram.*|.*-[A-Z0-9]{8}$|mermaid.*|katex|markdown-katex|boot-vendor|cytoscape.*|dagre.*|graphlib|rough\.esm|xterm|addon-.*|sortable\.esm|worker-portable|dist|lib|src|array|ordinal|path|line|init|channel|ccount|space-separated-tokens|zwitch|defaultLocale|wasm|regexp)$/;
const SERVER_LABEL_KEYS = new Set(["label", "title", "displayName", "description", "summary", "name", "placeholder", "return"]);
const UI_KEYS =
  /^(children|label|aria-label|ariaLabel|description|title|message|errorMessage|reason|fallbackMessage|body|rationale|text|placeholder|successMessage|headline|mobileTitle|actionLabel|note|heading|confirmLabel|collapseLabel|drawerLabel|searchPlaceholder|disabledReason|hint|offDescription|openLabel|summary|emptyText|tooltip|subtitle|caption|cancelLabel|submitLabel|buttonLabel|emptyLabel|emptyMessage|pendingLabel|loadingLabel|ariaDescription|alt|displayName|status|detail|details|prefix|suffix|helpText|warning|info|childPillLabel|sectionLabel|tabLabel|menuLabel)$/;
const NOISE =
  /Cannot load "|JSON Schema|Invalid input|bigint|Zod|DocAttrStep|NodeSelection|Parser rule|Unrecognized parsing|mismatched transaction|No node after pos|cross site scripting|expression description|\bscope\b|sequence range|Outbound client|lifecycle event|metadata event|must be (?:an?|the|non|unique|normalized|within|inside|provided|defined)|cannot be represented|Expected |Unexpected |is not a function|React Router|HydrateFallback|QueryClient|mutationFn|Minified React|Suspense Fallback|\bnpm:package\b|globalThis/;

function looksLikeUi(text, ctxKeys) {
  const t = text.trim();
  if (t.length < 2 || t.length > 400) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/[{}<>\\`$]|=>|\n|:\/\//.test(t)) return false;
  if (/^(\.{0,2}\/|#|@|data:|https?|mailto:|--|\[|\()/.test(t)) return false;
  if (/^(var|calc|rgba?|hsla?|translate\w*|scale\w*|rotate\w*|cubic-bezier|url|linear-gradient|radial-gradient|oklch|color-mix)\(/.test(t)) return false;
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(t)) return false; // mime
  if (/^[\w-]+(\.[\w-]+)+$/.test(t)) return false; // dotted keys, file names
  if (NOISE.test(t)) return false;
  const uiPlace = ctxKeys.some((k) => UI_KEYS.test(k) || /^call:.*\.(success|error|loading|info|warning|message)$/.test(k));
  const devOnly = ctxKeys.length > 0 && ctxKeys.every((k) => /^call:(Error|RangeError|TypeError|SyntaxError|console\.\w+|super)$/.test(k));
  if (devOnly) return false;
  if (t === t.toLowerCase() && /[-:[/_=]/.test(t)) return false; // class lists, keys
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) {
    if (/^[A-Z][a-z]+$/.test(t)) return true; // «Archive», «Settings»
    return uiPlace && /^[a-z]{3,20}$/.test(t); // «child», «local» in a label
  }
  if (/^[A-Z0-9_]+( [A-Z0-9_]+)*$/.test(t) && t.length > 3) return false;
  if (/^[A-Z][a-z]|^[A-Z]{2,5}\b|^\d+ [a-z]/.test(t)) return true;
  if (uiPlace && /[a-z]{2,} [a-z]{2,}/.test(t)) return true;
  return false;
}

function templateLooksLikeUi(skeleton, ctxKeys) {
  const words = skeleton.replace(/\{\d+\}/g, " ").trim();
  if (!/[A-Za-z]{3,}/.test(words)) return false;
  if (/[<>\\`$;]|=>|\n|:\/\/|\b(px|rem|ms|vh|vw)\b/.test(skeleton)) return false;
  if (/^[\s{}\d.:/-]*$/.test(words)) return false;
  return looksLikeUi(skeleton.replace(/\{\d+\}/g, "Xx"), ctxKeys);
}

function contextOf(node) {
  let cur = node;
  let parent = node.parent;
  for (let i = 0; i < 4 && parent; i++) {
    if (ts.isPropertyAssignment(parent) && parent.initializer === cur) {
      const n = parent.name;
      return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText();
    }
    if (ts.isReturnStatement(parent)) return "return";
    if (ts.isJsxAttribute(parent)) return parent.name.getText();
    if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent)) return parent.parent.name.getText();
    if (ts.isCallExpression(parent) && parent.arguments.includes(cur)) {
      const callee = parent.expression.getText();
      return "call:" + (callee.length > 40 ? callee.slice(0, 40) : callee);
    }
    if (!(ts.isArrayLiteralExpression(parent) || ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent) || ts.isParenthesizedExpression(parent))) return null;
    cur = parent;
    parent = parent.parent;
  }
  return null;
}

function isNonUiPosition(node) {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken || k === ts.SyntaxKind.InKeyword) return true;
  }
  if (ts.isCaseClause(p) && p.expression === node) return true;
  return false;
}

const catalog = new Map(); // text → {kind, sources:Set, ctx:Set}
function add(kind, text, source, ctx) {
  let rec = catalog.get(text);
  if (!rec) {
    rec = { text, kind, sources: new Set(), ctx: new Set() };
    catalog.set(text, rec);
  }
  rec.sources.add(source);
  if (ctx) rec.ctx.add(ctx);
}

function scan(file, source, { serverLabelsOnly = false } = {}) {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path.basename(file), text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    switch (node.kind) {
      case ts.SyntaxKind.JsxText: {
        const t = node.text.replace(/\s+/g, " ").trim();
        if (t) found.push(["static", t, "children"]);
        return;
      }
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        if (!isNonUiPosition(node)) found.push(["static", node.text, contextOf(node)]);
        return;
      case ts.SyntaxKind.TemplateExpression: {
        let s = node.head.text;
        node.templateSpans.forEach((sp, i) => {
          s += `{${i}}` + sp.literal.text;
        });
        found.push(["template", s, contextOf(node)]);
        node.templateSpans.forEach((sp) => visit(sp.expression));
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // Group contexts per text within this file, then filter.
  const byText = new Map();
  for (const [kind, t, ctx] of found) {
    const key = kind + "\0" + t;
    if (!byText.has(key)) byText.set(key, { kind, t, ctx: [] });
    if (ctx) byText.get(key).ctx.push(ctx);
  }
  for (const { kind, t, ctx } of byText.values()) {
    if (serverLabelsOnly && !ctx.some((k) => SERVER_LABEL_KEYS.has(k))) continue;
    const ok = kind === "static" ? looksLikeUi(t, ctx) : templateLooksLikeUi(t, ctx);
    if (!ok) continue;
    const text = t.trim().replace(/\s+/g, " ");
    add(kind, text, source, ctx.find((k) => UI_KEYS.test(k)) ?? ctx[0] ?? null);
  }
}

const assets = path.join(bbApp, "app/dist/assets");
let rendererFiles = 0;
for (const f of fs.readdirSync(assets).filter((f) => f.endsWith(".js"))) {
  const base = f.replace(/-[A-Za-z0-9_-]{8}\.js$/, "");
  if (VENDOR_CHUNK.test(base)) continue;
  const head = fs.readFileSync(path.join(assets, f), "utf8").slice(0, 4000);
  if (/scopeName|tokenColors/.test(head)) continue;
  scan(path.join(assets, f), `core:${base}`);
  rendererFiles++;
}

const serverBundle = path.join(bbApp, "server/dist/start-server.js");
if (fs.existsSync(serverBundle)) scan(serverBundle, "server:core", { serverLabelsOnly: true });

const builtinDir = path.join(bbApp, "server/dist/builtin-plugins");
let pluginFiles = 0;
for (const id of fs.readdirSync(builtinDir)) {
  const dist = path.join(builtinDir, id, "dist");
  if (!fs.existsSync(dist)) continue;
  if (fs.existsSync(path.join(dist, "app.js"))) {
    scan(path.join(dist, "app.js"), `builtin:${id}`);
    pluginFiles++;
  }
  if (fs.existsSync(path.join(dist, "server.js"))) scan(path.join(dist, "server.js"), `builtin:${id}`, { serverLabelsOnly: true });
  const pkgFile = path.join(builtinDir, id, "package.json");
  if (fs.existsSync(pkgFile)) {
    const bb = JSON.parse(fs.readFileSync(pkgFile, "utf8")).bb ?? {};
    for (const [key, value] of [["displayName", bb.name], ["description", bb.description]]) {
      if (typeof value === "string" && looksLikeUi(value, [key])) add("static", value.trim().replace(/\s+/g, " "), `builtin:${id}`, key);
    }
  }
}

// Our own English plugins (decision 23: translated by this dictionary).
const siblings = path.join(here, "..", "..");
for (const id of ["files-editor", "floating-terminal"]) {
  const dir = path.join(siblings, id);
  if (!fs.existsSync(dir)) continue;
  const files = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      if (["node_modules", "dist", "tests", "scratch", "vendor", "docs", "types"].includes(name)) continue;
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) files.push(full);
    }
  };
  walk(dir);
  for (const f of files) scan(f, `vibecom:${id}`);
}

const entries = [...catalog.values()]
  .map((r) => ({ text: r.text, kind: r.kind, sources: [...r.sources].sort(), ctx: [...r.ctx].sort() }))
  .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ bbVersion: version, extractedAt: new Date().toISOString().slice(0, 10), entries }, null, 1) + "\n");

const core = entries.filter((e) => e.sources.some((s) => s.startsWith("core:"))).length;
const templates = entries.filter((e) => e.kind === "template").length;
console.log(`bb ${version}: ${entries.length} strings (${templates} templates), core ${core}, renderer files ${rendererFiles}, builtin plugin bundles ${pluginFiles} → ${path.relative(process.cwd(), outFile)}`);
