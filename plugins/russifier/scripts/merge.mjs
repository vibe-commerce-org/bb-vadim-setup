#!/usr/bin/env node
// Put translated strings ({ "English": "Русский" } files) into the right
// dictionary: core.json for bb's own interface and server texts, builtin.json
// for builtin plugins, vibecom.json for our _vibecom plugins, extra.json for
// strings seen on screen but missing from the catalog. An empty translation
// («stays English on purpose») goes to skip.json, which the app never loads. Existing translations
// are replaced only with --overwrite. Keys are written sorted.
//
//   node scripts/merge.mjs translations.json [more.json …] [--overwrite]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const overwrite = args.includes("--overwrite");
const inputs = args.filter((a) => !a.startsWith("--"));
if (inputs.length === 0) {
  console.error("usage: node scripts/merge.mjs translations.json [--overwrite]");
  process.exit(1);
}

const catalogs = fs.readdirSync(path.join(root, "catalog")).filter((f) => /^bb-\d+\.\d+\.\d+\.json$/.test(f));
const source = new Map();
for (const f of catalogs) {
  for (const e of JSON.parse(fs.readFileSync(path.join(root, "catalog", f), "utf8")).entries) {
    const prev = source.get(e.text) ?? [];
    source.set(e.text, [...prev, ...e.sources]);
  }
}

const target = (en) => {
  const sources = source.get(en);
  if (!sources) return "extra.json";
  if (sources.some((s) => s.startsWith("core:") || s.startsWith("server:"))) return "core.json";
  if (sources.some((s) => s.startsWith("builtin:"))) return "builtin.json";
  if (sources.some((s) => s.startsWith("vibecom:"))) return "vibecom.json";
  return "extra.json";
};

const dicts = {};
const load = (f) => {
  const full = path.join(root, "dict", f);
  return (dicts[f] ??= fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : {});
};
let added = 0;
let replaced = 0;
let kept = 0;
for (const input of inputs) {
  const data = JSON.parse(fs.readFileSync(input, "utf8"));
  for (const [en, ru] of Object.entries(data)) {
    if (typeof ru !== "string") continue;
    const file = ru.trim() === "" ? "skip.json" : target(en);
    if (file !== "skip.json") {
      const skip = load("skip.json");
      if (en in skip && overwrite) delete skip[en];
    }
    const dict = load(file);
    if (!(en in dict)) {
      dict[en] = ru;
      added++;
    } else if (dict[en] !== ru && (overwrite || dict[en] === "")) {
      dict[en] = ru;
      replaced++;
    } else kept++;
  }
}
for (const [f, dict] of Object.entries(dicts)) {
  const sorted = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  fs.writeFileSync(path.join(root, "dict", f), JSON.stringify(sorted, null, 1) + "\n");
}
console.log(`merged: ${added} added, ${replaced} replaced, ${kept} kept as they were (${Object.keys(dicts).join(", ")})`);
