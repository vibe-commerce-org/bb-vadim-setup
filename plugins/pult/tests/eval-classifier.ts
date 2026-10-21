// Offline evaluation of the text classifier against the private inventory of
// threads (tests/fixtures-private/classifier-eval.json, gitignored). Not a
// test: prints aggregates only — a confusion matrix, recall of «ждёт» and the
// share of false «ждёт» among «не ждёт».
//   node tests/eval-classifier.ts            aggregates
//   node tests/eval-classifier.ts --errors   + reasons of every miss (local use only)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "../lib/classify.ts";
import { isWaitingKind, type Kind, type LastTurn } from "../lib/types.ts";

interface Row {
  threadId: string;
  label: string;
  isChild: boolean;
  status: string;
  lastTurn: LastTurn;
  lastAgentAt: number | null;
  lastHumanAt: number | null;
  lastAgentText: string | null;
}

const WAITS = new Set(["WAITING_VADIM", "BLOCKED", "IN_PROGRESS", "ABANDONED"]);
const NOT_WAITS = new Set(["DONE", "CHILD_DONE"]);
const NOW = Date.parse("2026-10-10T12:50:00+03:00");

const here = dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(
  readFileSync(join(here, "fixtures-private", "classifier-eval.json"), "utf8"),
) as Row[];
const showErrors = process.argv.includes("--errors");

const kinds: Kind[] = ["approval", "decision", "action", "failed", "review", "commit", "working", "done", "unknown"];
const labels = Array.from(new Set(rows.map((r) => r.label))).sort();
const matrix = new Map<string, Map<Kind, number>>();
for (const l of labels) matrix.set(l, new Map(kinds.map((k) => [k, 0])));

let waitTotal = 0;
let waitHit = 0;
let waitHitWithCommit = 0;
let notTotal = 0;
let notFalse = 0;
let notFalseWithCommit = 0;
const commitBy = { waits: 0, notWaits: 0 };
const falseBySource = new Map<string, number>();
const errors: string[] = [];

for (const row of rows) {
  const c = classify({
    threadId: row.threadId,
    status: "idle",
    runtimeStatus: null,
    hasPendingInteraction: false,
    pending: null,
    lastTurn: row.lastTurn,
    lastAgentText: row.lastAgentText,
    lastAgentAt: row.lastAgentAt,
    lastHumanAt: row.lastHumanAt,
    lastErrorText: null,
    isChild: row.isChild,
    now: NOW,
  });
  const m = matrix.get(row.label)!;
  m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  // Strict: «commit» counts as «не ждёт» — the inventory files a thread whose
  // only open point is «закоммитить? скажи да» as DONE. Queue: any waiting
  // kind, as the plugin's queue shows it.
  const waits = isWaitingKind(c.kind) && c.kind !== "commit";
  const waitsWithCommit = isWaitingKind(c.kind);
  if (WAITS.has(row.label)) {
    waitTotal++;
    if (waits) waitHit++;
    if (waitsWithCommit) waitHitWithCommit++;
    if (c.kind === "commit") commitBy.waits++;
    if (!waits) errors.push(`MISS  ${row.label.padEnd(13)} child=${row.isChild ? 1 : 0} → ${c.kind} [${c.reasons.join(", ")}]`);
  } else if (NOT_WAITS.has(row.label)) {
    notTotal++;
    if (waits) notFalse++;
    if (waitsWithCommit) notFalseWithCommit++;
    if (c.kind === "commit") commitBy.notWaits++;
    if (waitsWithCommit) falseBySource.set(c.source, (falseBySource.get(c.source) ?? 0) + 1);
    if (waits) errors.push(`FALSE ${row.label.padEnd(13)} child=${row.isChild ? 1 : 0} → ${c.kind} [${c.reasons.join(", ")}]`);
  }
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`Threads: ${rows.length} (ждёт ${waitTotal}, не ждёт ${notTotal})\n`);
console.log("label".padEnd(14) + kinds.map((k) => pad(k.slice(0, 8), 9)).join(""));
for (const l of labels) {
  const m = matrix.get(l)!;
  console.log(l.padEnd(14) + kinds.map((k) => pad(m.get(k) ?? 0, 9)).join(""));
}
const f = (x: number) => x.toFixed(3);
console.log(`\nqueue  (any waiting kind):   recall «ждёт» ${f(waitHitWithCommit / waitTotal)} (${waitHitWithCommit}/${waitTotal}),  false «ждёт» ${f(notFalseWithCommit / notTotal)} (${notFalseWithCommit}/${notTotal})`);
console.log(`strict (commit = не ждёт):   recall «ждёт» ${f(waitHit / waitTotal)} (${waitHit}/${waitTotal}),  false «ждёт» ${f(notFalse / notTotal)} (${notFalse}/${notTotal})`);
console.log(`classified as commit: ${commitBy.waits} of «ждёт», ${commitBy.notWaits} of «не ждёт»`);
console.log(`false «ждёт» by source: ${[...falseBySource].map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (showErrors) {
  console.log("\n" + errors.join("\n"));
}
