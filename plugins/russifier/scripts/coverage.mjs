#!/usr/bin/env node
// How much of bb's interface the dictionaries cover, and what is new.
//
//   node scripts/coverage.mjs                      report for the newest catalog
//   node scripts/coverage.mjs --todo todo.json     + untranslated strings in scope,
//                                                  ready to hand to a translator
//   node scripts/coverage.mjs --catalog catalog/bb-0.47.0.json --previous catalog/bb-0.46.0.json
//
// Scope = bb's core interface, the server's status texts and the builtin
// plugins listed in catalog/scope.json (the ones switched on).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const catalogs = fs
  .readdirSync(path.join(root, "catalog"))
  .filter((f) => /^bb-\d+\.\d+\.\d+\.json$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const catalogFile = opt("--catalog") ?? (catalogs.length ? path.join(root, "catalog", catalogs.at(-1)) : null);
if (!catalogFile) {
  console.error("No catalog yet: run node scripts/extract-strings.mjs");
  process.exit(1);
}
const previousFile =
  opt("--previous") ?? (catalogs.length > 1 ? path.join(root, "catalog", catalogs.at(-2)) : null);

const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
const scope = JSON.parse(fs.readFileSync(path.join(root, "catalog/scope.json"), "utf8"));
const builtinInScope = new Set(scope.builtin);
const serverNoise = new RegExp(scope.serverNoise, "i");

const dict = {};
for (const f of ["skip.json", "core.json", "builtin.json", "vibecom.json", "extra.json"]) {
  const full = path.join(root, "dict", f);
  if (fs.existsSync(full)) Object.assign(dict, JSON.parse(fs.readFileSync(full, "utf8")));
}
const normalize = (s) => s.replace(/\s+/g, " ").replace(/[’‘]/g, "'").replace(/…/g, "...").trim();
const decided = new Set(Object.keys(dict).map(normalize)); // "" counts as decided: stays English on purpose
const translated = new Set(Object.entries(dict).filter(([, v]) => v.trim()).map(([k]) => normalize(k)));

export function inScope(entry) {
  const sources = entry.sources;
  if (sources.some((s) => s.startsWith("core:"))) return true;
  if (sources.some((s) => s.startsWith("builtin:") && builtinInScope.has(s.slice(8)))) return true;
  if (sources.length === 1 && sources[0] === "server:core") {
    const t = entry.text;
    return t.length <= 70 && !serverNoise.test(t) && /^[A-Z]/.test(t);
  }
  return false;
}

const rows = catalog.entries.filter(inScope);
const group = (e) => (e.sources.some((s) => s.startsWith("core:")) ? "core" : e.sources[0].startsWith("builtin:") ? "builtin" : "server");
const stats = {};
for (const e of rows) {
  const g = group(e);
  stats[g] ??= { total: 0, decided: 0, translated: 0 };
  stats[g].total++;
  if (decided.has(normalize(e.text))) stats[g].decided++;
  if (translated.has(normalize(e.text))) stats[g].translated++;
}

const lines = [`# Русификатор: покрытие bb ${catalog.bbVersion}`, ""];
lines.push("| Часть | Строк | Переведено | Решено (с пустыми) |", "|---|---|---|---|");
for (const [g, s] of Object.entries(stats)) {
  lines.push(`| ${g} | ${s.total} | ${s.translated} (${((100 * s.translated) / s.total).toFixed(1)} %) | ${s.decided} (${((100 * s.decided) / s.total).toFixed(1)} %) |`);
}

if (previousFile && fs.existsSync(previousFile) && path.resolve(previousFile) !== path.resolve(catalogFile)) {
  const prev = JSON.parse(fs.readFileSync(previousFile, "utf8"));
  const before = new Set(prev.entries.filter(inScope).map((e) => e.text));
  const now = new Set(rows.map((e) => e.text));
  const added = [...now].filter((t) => !before.has(t));
  const removed = [...before].filter((t) => !now.has(t));
  lines.push("", `Против bb ${prev.bbVersion}: новых строк ${added.length}, исчезло ${removed.length}.`);
  for (const t of added.slice(0, 40)) lines.push(`- новая: ${t}`);
}

const todo = rows.filter((e) => !decided.has(normalize(e.text)));
lines.push("", `Ждут перевода: ${todo.length}.`);
for (const e of todo.slice(0, 30)) lines.push(`- ${e.text}  ·  ${e.sources[0]}`);
console.log(lines.join("\n"));

const todoFile = opt("--todo");
if (todoFile) {
  const items = todo.map((e) => ({ en: e.text, kind: e.kind, where: e.sources.slice(0, 3).join(", "), ctx: e.ctx.slice(0, 2).join(", ") }));
  fs.writeFileSync(todoFile, JSON.stringify(items, null, 0) + "\n");
  console.log(`\n${items.length} strings → ${todoFile} (translate per GLOSSARY.md, then node scripts/merge.mjs <file>)`);
}
