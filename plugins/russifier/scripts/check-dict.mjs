#!/usr/bin/env node
// Check the dictionaries in dict/: valid JSON, every {N} of a template kept,
// glossary words (GLOSSARY.md) not replaced by the rejected ones, labels not
// much longer than the English. Exit code 1 on errors; warnings are printed.
//
//   node scripts/check-dict.mjs [--quiet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const files = ["core.json", "builtin.json", "vibecom.json", "extra.json", "skip.json"];

// Rejected words: the user's decisions of 2026-10-13/14 (GLOSSARY.md).
const REJECTED = [
  [/тред/i, "thread → «чат»"],
  [/сайдбар/i, "sidebar → «боковая панель»"],
  [/одобр/i, "approval → «подтверждение»"],
  [/дифф/i, "diff → «изменения»"],
  [/воркфло/i, "workflow → «сценарий»"],
  [/рабоч\S* дерев/i, "worktree → «отдельная копия»"],
  [/навык/i, "skill → «скилл»"],
  [/маркетплейс/i, "marketplace → «каталог плагинов»"],
  [/\bхост/i, "host → «компьютер»"],
  [/\bмашин[аеуыой]/i, "machine → «компьютер»"],
  [/\bслить\b|\bслито\b|\bсмерж/i, "merge → «влить»"],
  [/пожалуйста/i, "без «Пожалуйста»"],
  [/воркспейс|рабоч\S* пространств/i, "workspace → «рабочая папка»"],
  [/чекаут/i, "checkout → «основная копия»"],
];

const errors = [];
const warnings = [];
const seen = new Map();
let total = 0;
let filled = 0;

for (const file of files) {
  const full = path.join(root, "dict", file);
  if (!fs.existsSync(full)) continue;
  let dict;
  try {
    dict = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    errors.push(`${file}: invalid JSON — ${error.message}`);
    continue;
  }
  for (const [en, ru] of Object.entries(dict)) {
    total++;
    if (typeof ru !== "string") {
      errors.push(`${file}: «${en}» → not a string`);
      continue;
    }
    if (ru.trim() === "") continue;
    filled++;
    if (seen.has(en) && seen.get(en) !== ru) warnings.push(`${file}: «${en}» differs from ${seen.get(en) === undefined ? "?" : "an earlier file"}`);
    seen.set(en, ru);

    const keyArgs = new Set([...en.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));
    const gluedArgs = new Set([...en.matchAll(/[A-Za-z]\{(\d+)\}/g)].map((m) => m[1]));
    const valueArgs = new Set([...ru.matchAll(/\{\s*(\d+)\s*[},]/g)].map((m) => m[1]));
    // A dropped placeholder is usually an English word bb picks by count
    // («{0} child {1}» → «thread|threads»), replaced by a Russian plural: warn.
    for (const a of keyArgs) {
      if (!valueArgs.has(a) && !gluedArgs.has(a)) warnings.push(`${file}: «${en}» → «${ru}»: dropped {${a}} — check it is only an English word`);
    }
    for (const a of valueArgs) {
      if (!keyArgs.has(a)) errors.push(`${file}: «${en}» → «${ru}»: unknown {${a}}`);
    }
    if ((ru.match(/\{/g) ?? []).length !== (ru.match(/\}/g) ?? []).length) errors.push(`${file}: «${en}» → «${ru}»: unbalanced braces`);

    for (const [re, rule] of REJECTED) {
      if (re.test(ru)) warnings.push(`${file}: «${en}» → «${ru}»: ${rule}`);
    }
    if (en.length <= 16 && !keyArgs.size && ru.length > Math.max(en.length * 2, en.length + 12)) {
      warnings.push(`${file}: long label «${en}» → «${ru}» (${en.length} → ${ru.length})`);
    }
  }
}

console.log(`dict: ${filled} translations of ${total} keys; ${errors.length} errors, ${warnings.length} warnings`);
if (!quiet) {
  for (const e of errors) console.log("ERROR " + e);
  for (const w of warnings.slice(0, 60)) console.log("warn  " + w);
  if (warnings.length > 60) console.log(`… ${warnings.length - 60} more warnings (--all to list)`);
}
process.exit(errors.length ? 1 : 0);
