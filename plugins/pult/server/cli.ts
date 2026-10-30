// The `bb pult` command — what agents (and the user) use from a shell. argv is
// parsed here; `commands` is the metadata BB renders into help and the
// generated plugin-commands skill. Human output is Russian, starts with a
// summary and is capped at 200 lines; --json prints machine-readable output.
// Wording (kinds, lanes, ages, row marks) comes from lib/format.ts, the same
// module the page uses, so `bb pult` and the page say the same thing.
//
// There is no command that writes into a thread: Pult never sends a message
// on an agent's behalf. Hiding commands refuse what an agent must not hide
// (an approval BB waits on, the calling thread itself) and are logged with
// the calling thread.
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  KIND_SHORT,
  KIND_TITLES,
  LANE_TITLES,
  MARK_LABELS,
  formatAge,
  formatDateTime,
  modelLine,
  tomorrowMorning,
} from "../lib/format.ts";
import { cut, tail } from "../lib/marker.ts";
import { isDismissed, isSnoozed, snoozeUntilProblem } from "../lib/queue.ts";
import {
  WAITING_KINDS,
  type Kind,
  type Lane,
  type LaneTask,
  type Lanes,
  type Overlay,
  type Queue,
  type QueueItem,
  type ThreadSnapshot,
  type WaitingKind,
} from "../lib/types.ts";
import type { LlmRow, SeedRow, StoredInput } from "./store.ts";

const MAX_LINES = 200;
const THREAD_ID = /^thr_[a-z0-9]{6,40}$/;
const TASK_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/** Label for a thread row mark in BB's own thread list (same as the page's). */
export const MARK_LABEL: Record<WaitingKind, string> = MARK_LABELS;

/** What the CLI needs from the backend; server.ts implements it. */
export interface CliDeps {
  queue(): Queue;
  lanes(): Promise<{ tasksAvailable: boolean; lanes: Lanes }>;
  moveLaneByKey(taskKey: string, lane: Lane): Promise<{ key: string; title: string; priority: string }>;
  /** The thread's current kind in Pult, null when Pult has not seen it. */
  kindOf(threadId: string): Kind | null;
  snooze(threadId: string, until: number): void;
  dismiss(threadId: string): void;
  restore(threadId: string): void;
  scan(full: boolean): Promise<{ scanned: number; done: boolean }>;
  importSeed(
    path: string,
    opts: { cwd?: string; asOf?: string; replace?: boolean },
  ): Promise<{ imported: number; asOf: number; reclassified: number; unknown: number }>;
  explain(threadId: string): {
    snapshot: ThreadSnapshot | null;
    input: StoredInput | null;
    seed: SeedRow | null;
    llm: LlmRow | null;
    overlay: Overlay;
  };
}

const USAGE = [
  "bb pult — Пульт: чей ход в тредах BB и приоритеты задач",
  "",
  "Команды:",
  "  bb pult queue [--brief] [--all] [--json]       что ждёт Вадима: сводка, потом список (--brief: по строке на пункт; --all: и застрявшее, и отложенное; --json: без текста ответов)",
  "  bb pult lanes [--json]                         полосы Сейчас / Дальше / Потом поверх BB Tasks",
  "  bb pult lane <TASK-KEY> <now|next|later>       переставить задачу в полосу (меняет приоритет)",
  "  bb pult snooze <thread-id> <2h|tomorrow|3d|1w> отложить тред в очереди (не больше 30 дней)",
  "  bb pult dismiss <thread-id>                    «не нужно»: скрыть, пока агент не напишет снова",
  "  bb pult restore <thread-id>                    вернуть отложенный или скрытый тред",
  "  bb pult scan [--full]                          пересканировать треды (--full: все заново)",
  "  bb pult seed import <path> [--as-of YYYY-MM-DD] [--replace]  загрузить инвентаризацию тредов (по умолчанию — дополнить прежнюю)",
  "  bb pult explain <thread-id> [--json]           почему тред классифицирован так",
  "",
  "Ждущие одобрения треды и собственный тред агента скрыть или отложить нельзя.",
  "В треды Пульт ничего не пишет: ответы уходят только со страницы «Пульт» по клику Вадима.",
].join("\n");

const COMMANDS = [
  {
    name: "queue",
    summary: "Что ждёт Вадима: очередь «Ход за тобой» (сводка в начале)",
    usage: "bb pult queue [--brief] [--all] [--json]",
  },
  { name: "lanes", summary: "Полосы Сейчас / Дальше / Потом поверх BB Tasks", usage: "bb pult lanes [--json]" },
  {
    name: "lane",
    summary: "Переставить задачу в полосу (только после явного «да» Вадима)",
    usage: "bb pult lane <TASK-KEY> <now|next|later>",
  },
  {
    name: "snooze",
    summary: "Отложить тред в очереди (только по просьбе Вадима; не больше 30 дней)",
    usage: "bb pult snooze <thread-id> <2h|tomorrow|3d|1w>",
  },
  {
    name: "dismiss",
    summary: "Скрыть тред, пока агент не напишет снова (только по просьбе Вадима)",
    usage: "bb pult dismiss <thread-id>",
  },
  { name: "restore", summary: "Вернуть отложенный или скрытый тред", usage: "bb pult restore <thread-id>" },
  { name: "scan", summary: "Пересканировать треды", usage: "bb pult scan [--full]" },
  {
    name: "seed",
    summary: "Загрузить инвентаризацию тредов (seed import)",
    usage: "bb pult seed import <path> [--as-of YYYY-MM-DD] [--replace]",
  },
  { name: "explain", summary: "Почему тред классифицирован так", usage: "bb pult explain <thread-id> [--json]" },
];

// ── formatting ─────────────────────────────────────────────────────────

function when(at: number | null): string {
  return at === null ? "—" : formatDateTime(at);
}

function oneLine(text: string | null, max = 160): string {
  if (text === null) return "";
  return cut(text.replace(/\s+/g, " ").trim(), max);
}

function capLines(lines: string[], hint: string): string {
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return [...lines.slice(0, MAX_LINES - 1), `… ещё ${lines.length - MAX_LINES + 1} строк. ${hint}`].join("\n");
}

function headLine(item: QueueItem, indent: string): string {
  const mark = indent === "" ? "•" : "↳";
  return `${indent}${mark} ${KIND_SHORT[item.kind]} · ${item.projectName} · «${oneLine(item.title, 80)}» · ${formatAge(item.ageMs)}`;
}

function itemLines(item: QueueItem, brief: boolean, indent = ""): string[] {
  if (brief) {
    const extra = item.nested.length > 0 ? ` · ждут сабтреды: ${item.nested.length}` : "";
    const until = item.snoozedUntil !== null ? ` · отложен до ${when(item.snoozedUntil)}` : "";
    return [
      `${headLine(item, indent)} · ${item.threadId}${until}${extra}`,
      ...item.nested.flatMap((child) => itemLines(child, true, `${indent}    `)),
    ];
  }
  const pad = `${indent}  `;
  const lines = [headLine(item, indent)];
  if (item.ask !== null) lines.push(`${pad}Что нужно: ${oneLine(item.ask, 220)}`);
  if (item.options.length > 0) {
    const options = item.options
      .map((o) => `${o.key} — ${oneLine(o.label, 60)}${o.recommended ? " (рекомендует)" : ""}`)
      .join("; ");
    lines.push(`${pad}Варианты: ${oneLine(options, 240)}`);
  }
  const extra: string[] = [item.threadId];
  if (item.due !== null) extra.push(`срок ${item.due}`);
  if (item.taskKey !== null) extra.push(`задача ${item.taskKey}`);
  if (item.snoozedUntil !== null) extra.push(`отложен до ${when(item.snoozedUntil)}`);
  if (item.openChildren > 0) extra.push(`открытых подтредов: ${item.openChildren}`);
  if (item.nested.length > 0) extra.push(`ждут сабтреды: ${item.nested.length}`);
  lines.push(`${pad}${extra.join(" · ")}`);
  // Waiting subthreads, under their parent's card.
  for (const child of item.nested) lines.push(...itemLines(child, false, `${indent}    `));
  return lines;
}

/** Per-kind counts of the top level, «commit» left out (it is in the header). */
function countsLine(queue: Queue): string {
  return WAITING_KINDS.filter((kind) => kind !== "commit" && queue.counts[kind] > 0)
    .map((kind) => `${KIND_TITLES[kind]}: ${queue.counts[kind]}`)
    .join(" · ");
}

/**
 * The summary first — it must survive the 200-line cap:
 *   «Ход за тобой: N (+ коммит ждёт «да»: K)» — N is the badge (Queue.total:
 *   top-level items + stale without «commit»), K the top-level commit prompts;
 *   per-kind counts; «Застряло (14+ дней): S · отложено: Z».
 * Then fresh moves, the commit prompts as their own group and, with `all`,
 * the stale and snoozed items. Waiting subthreads are printed indented under
 * their parent. `brief` prints one line per item.
 */
export function formatQueue(queue: Queue, all: boolean, opts: { brief?: boolean } = {}): string {
  const brief = opts.brief === true;
  const lines = [`Ход за тобой: ${queue.total} (+ коммит ждёт «да»: ${queue.counts.commit})`];
  const counts = countsLine(queue);
  if (counts !== "") lines.push(counts);
  if (queue.stale.length > 0 || queue.snoozed.length > 0) {
    const more = `Застряло (14+ дней): ${queue.stale.length} · отложено: ${queue.snoozed.length}`;
    lines.push(all ? more : `${more} — показать: bb pult queue --all`);
  }
  const moves = queue.items.filter((item) => item.kind !== "commit");
  const commits = queue.items.filter((item) => item.kind === "commit");
  lines.push("");
  if (moves.length === 0) lines.push("Свежих тредов, которые ждут Вадима, нет.");
  for (const item of moves) lines.push(...itemLines(item, brief));
  if (commits.length > 0) {
    lines.push("", `Коммит ждёт «да»: ${commits.length}`);
    for (const item of commits) lines.push(...itemLines(item, brief));
  }
  if (all) {
    if (queue.stale.length > 0) {
      lines.push("", `Застряло (14+ дней): ${queue.stale.length}`);
      for (const item of queue.stale) lines.push(...itemLines(item, brief));
    }
    if (queue.snoozed.length > 0) {
      lines.push("", `Отложено: ${queue.snoozed.length}`);
      for (const item of queue.snoozed) lines.push(...itemLines(item, brief));
    }
  }
  return capLines(lines, "Сводка — в начале; по строке на пункт: bb pult queue --brief");
}

/** The queue for --json: everything but the agents' text (excerpt). */
export function queueForJson(queue: Queue): unknown {
  const strip = ({ excerpt: _excerpt, nested, ...rest }: QueueItem) => ({
    ...rest,
    nested: nested.map(({ excerpt: _nestedExcerpt, ...child }) => child),
  });
  return { ...queue, items: queue.items.map(strip), stale: queue.stale.map(strip), snoozed: queue.snoozed.map(strip) };
}

function laneTaskLine(task: LaneTask): string {
  const parts = [`  ${task.key}  ${oneLine(task.title, 90)}`, `с ${when(task.laneSince)}${task.laneSinceApprox ? "≈" : ""}`];
  if (task.dueDate !== null) parts.push(`срок ${task.dueDate}`);
  if (task.waitingOnYou) parts.push("ждёт тебя");
  if (task.stale) parts.push("застряло");
  return parts.join(" · ");
}

export function formatLanes(result: { tasksAvailable: boolean; lanes: Lanes }): string {
  if (!result.tasksAvailable) return "BB Tasks не отвечает — полосы недоступны.";
  const { lanes } = result;
  const lines: string[] = [];
  const nowTitle = `${LANE_TITLES.now} (${lanes.now.length}/${lanes.wipLimit})${lanes.wipExceeded ? " — больше лимита" : ""}`;
  for (const [title, tasks] of [
    [nowTitle, lanes.now],
    [`${LANE_TITLES.next} (${lanes.next.length})`, lanes.next],
    [`${LANE_TITLES.later} (${lanes.later.length})`, lanes.later],
  ] as const) {
    if (lines.length > 0) lines.push("");
    lines.push(title);
    if (tasks.length === 0) lines.push("  —");
    for (const task of tasks) lines.push(laneTaskLine(task));
  }
  return capLines(lines, "Полностью — bb pult lanes --json");
}

/** "2h", "3d", "1w", "tomorrow"/"завтра" (09:00 local) → until (ms). */
export function parseSnooze(value: string, now: number): number | null {
  const v = value.trim().toLowerCase();
  if (v === "tomorrow" || v === "завтра") return tomorrowMorning(now);
  const m = /^(\d{1,3})\s*(m|min|h|d|w|м|ч|д|н)$/.exec(v);
  if (m === null) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = m[2];
  const ms =
    unit === "m" || unit === "min" || unit === "м"
      ? 60_000
      : unit === "h" || unit === "ч"
        ? 3_600_000
        : unit === "d" || unit === "д"
          ? 86_400_000
          : 7 * 86_400_000;
  return now + n * ms;
}

/**
 * Why the CLI refuses to hide (dismiss / snooze) a thread, or null. An
 * approval is never hidden: BB holds the agent on it. A thread never hides
 * itself: an agent must not take its own question off the user's queue.
 */
export function hideRefusal(threadId: string, kind: Kind | null, callerThreadId: string | undefined): string | null {
  if (callerThreadId !== undefined && callerThreadId === threadId) {
    return "Тред не может скрыть или отложить сам себя: это решает Вадим на странице «Пульт».";
  }
  if (kind === "approval") {
    return "Тред ждёт одобрения в BB — такие не скрываются и не откладываются.";
  }
  return null;
}

/** Why an overlay that is stored no longer hides the thread. */
function lapseReason(s: ThreadSnapshot, at: number | null): string {
  if (s.classification.kind === "approval") return "не действует: BB ждёт одобрения";
  if (at !== null && s.lastHumanAt !== null && s.lastHumanAt > at) return "вернулось: Вадим написал в тред";
  return "вернулось после ответа агента";
}

/** Pult's own marks on a thread as they act now, not as they were stored. */
export function overlayNotes(s: ThreadSnapshot, o: Overlay, now: number): string[] {
  const notes: string[] = [];
  if (o.dismissedAt !== null) {
    notes.push(
      isDismissed(s, o)
        ? `скрыт («не нужно» с ${when(o.dismissedAt)}), пока агент не напишет снова`
        : `было скрыто («не нужно» с ${when(o.dismissedAt)}), ${lapseReason(s, o.dismissedAt)}`,
    );
  }
  if (o.snoozedUntil !== null) {
    notes.push(
      isSnoozed(s, o, now)
        ? `отложен до ${when(o.snoozedUntil)}`
        : `был отложен до ${when(o.snoozedUntil)}, ${o.snoozedUntil <= now ? "срок вышел" : lapseReason(s, o.snoozedAt)}`,
    );
  }
  if (o.taskKey !== null) notes.push(`задача ${o.taskKey}`);
  return notes;
}

/** The top-level card a waiting subthread is shown in, or null. */
export function hostCardOf(queue: Queue, threadId: string): string | null {
  for (const item of [...queue.items, ...queue.stale]) {
    if (item.nested.some((child) => child.threadId === threadId)) return item.threadId;
  }
  return null;
}

export function explainText(
  data: ReturnType<CliDeps["explain"]>,
  threadId: string,
  now: number,
  hostCard: string | null,
): string {
  const { snapshot, input, seed, llm, overlay } = data;
  if (snapshot === null) return `Пульт ещё не видел тред ${threadId}. Запустите bb pult scan.`;
  const c = snapshot.classification;
  const lines = [
    `${snapshot.threadId} — «${oneLine(snapshot.title, 100)}» (${snapshot.projectName})`,
    `BB: статус ${snapshot.status}${snapshot.archived ? ", в архиве" : ""}; ход: ${input?.lastTurn ?? "—"}; агент: ${when(snapshot.lastAgentAt)}; Вадим: ${when(snapshot.lastHumanAt)}`,
    `Модель: ${modelLine(snapshot.modelLabel, snapshot.effort, false) ?? "—"}${
      snapshot.model === null ? "" : ` (${snapshot.model}${snapshot.effort === null ? "" : `, эффорт ${snapshot.effort}`})`
    }`,
    `Классификация: ${KIND_SHORT[c.kind]} (${c.kind}; источник ${c.source}; уверенность ${c.confidence.toFixed(2)}; ${when(snapshot.classifiedAt)})`,
  ];
  if (c.ask !== null) lines.push(`Что нужно: ${oneLine(c.ask, 400)}`);
  if (c.options.length > 0) {
    lines.push(`Варианты: ${c.options.map((o) => `${o.key} — ${o.label}${o.recommended ? " (рек.)" : ""}`).join("; ")}`);
  }
  if (c.multi) lines.push("Несколько вопросов сразу.");
  if (c.replyTemplate !== null) lines.push(`Готовый ответ: ${oneLine(c.replyTemplate, 200)}`);
  if (c.due !== null) lines.push(`Срок: ${c.due}`);
  lines.push(`Причины: ${c.reasons.length === 0 ? "—" : c.reasons.join(", ")}`);
  if (input !== null) {
    if (input.pending !== null) {
      lines.push(`Ожидает в BB: ${input.pending.kind}${input.pending.subjectKind ? `/${input.pending.subjectKind}` : ""} — ${oneLine(input.pending.prompt, 200)}`);
    }
    if (input.lastErrorText !== null) lines.push(`Ошибка: ${oneLine(input.lastErrorText, 200)}`);
  }
  if (seed !== null) {
    lines.push(`Инвентаризация: ${seed.status} на ${when(seed.asOf)}${seed.ask ? ` — ${oneLine(seed.ask, 200)}` : ""}`);
  }
  if (llm !== null) {
    lines.push(`Разбор моделью: ${llm.classification === null ? "без ответа" : llm.classification.kind} (${when(llm.triagedAt)})`);
  }
  const marks = overlayNotes(snapshot, overlay, now);
  if (marks.length > 0) lines.push(`Пульт: ${marks.join("; ")}`);
  if (hostCard !== null) lines.push(`В очереди: в карточке родителя ${hostCard}`);
  if (snapshot.excerpt !== null) lines.push("", "Конец последнего ответа агента:", oneLine(tail(snapshot.excerpt, 600), 600));
  return capLines(lines, "Полностью — bb pult explain <thread-id> --json");
}

// ── registration ───────────────────────────────────────────────────────

function ok(stdout: string): PluginCliResult {
  return { exitCode: 0, stdout };
}

function fail(stderr: string): PluginCliResult {
  return { exitCode: 1, stderr };
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value;
}

const FLAGS = new Set(["--json", "--all", "--full", "--brief", "--replace"]);

export function registerCli(bb: BbPluginApi, deps: CliDeps): void {
  async function run(argv: string[], ctx: PluginCliContext): Promise<PluginCliResult> {
    const json = argv.includes("--json");
    const all = argv.includes("--all");
    const full = argv.includes("--full");
    const brief = argv.includes("--brief");
    const replace = argv.includes("--replace");
    const args = argv.filter((arg) => !FLAGS.has(arg));
    const asOf = readOption(args, "--as-of");
    const [command, ...rest] = args;
    const now = Date.now();
    const caller = ctx.threadId ?? "shell";

    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return ok(USAGE);

      case "queue": {
        const queue = deps.queue();
        // --json: the queue as the backend builds it (items, stale, snoozed,
        // nested subthreads, counts, total) without the agents' text.
        if (json) return ok(JSON.stringify(queueForJson(queue)));
        return ok(formatQueue(queue, all, { brief }));
      }

      case "lanes": {
        const result = await deps.lanes();
        return ok(json ? JSON.stringify(result) : formatLanes(result));
      }

      case "lane": {
        const [key, lane] = rest;
        if (key === undefined || !TASK_KEY.test(key) || (lane !== "now" && lane !== "next" && lane !== "later")) {
          return fail("Использование: bb pult lane <TASK-KEY> <now|next|later>, например bb pult lane ORC-3 now");
        }
        const moved = await deps.moveLaneByKey(key.toUpperCase(), lane);
        bb.log.info(`cli lane ${moved.key} → ${lane} by ${caller}`);
        if (json) return ok(JSON.stringify({ ...moved, lane }));
        return ok(`${moved.key} «${oneLine(moved.title, 80)}» → ${LANE_TITLES[lane]} (приоритет ${moved.priority})`);
      }

      case "snooze": {
        const [threadId, period] = rest;
        if (threadId === undefined || !THREAD_ID.test(threadId) || period === undefined) {
          return fail("Использование: bb pult snooze <thread-id> <2h|tomorrow|3d|1w>");
        }
        const until = parseSnooze(period, now);
        if (until === null) return fail(`Не понял срок «${period}»: 2h, tomorrow, 3d, 1w`);
        const problem = snoozeUntilProblem(until, now);
        if (problem !== null) return fail(problem);
        const refusal = hideRefusal(threadId, deps.kindOf(threadId), ctx.threadId);
        if (refusal !== null) {
          bb.log.warn(`cli snooze ${threadId} refused for ${caller}`);
          return fail(refusal);
        }
        deps.snooze(threadId, until);
        bb.log.info(`cli snooze ${threadId} until ${new Date(until).toISOString()} by ${caller}`);
        return ok(json ? JSON.stringify({ threadId, until }) : `${threadId} отложен до ${when(until)}`);
      }

      case "dismiss":
      case "restore": {
        const [threadId] = rest;
        if (threadId === undefined || !THREAD_ID.test(threadId)) return fail(`Использование: bb pult ${command} <thread-id>`);
        if (command === "dismiss") {
          const refusal = hideRefusal(threadId, deps.kindOf(threadId), ctx.threadId);
          if (refusal !== null) {
            bb.log.warn(`cli dismiss ${threadId} refused for ${caller}`);
            return fail(refusal);
          }
          deps.dismiss(threadId);
        } else {
          deps.restore(threadId);
        }
        bb.log.info(`cli ${command} ${threadId} by ${caller}`);
        if (json) return ok(JSON.stringify({ threadId, ok: true }));
        return ok(command === "dismiss" ? `${threadId} скрыт, пока агент не напишет снова` : `${threadId} возвращён в очередь`);
      }

      case "scan": {
        const result = await deps.scan(full);
        if (json) return ok(JSON.stringify(result));
        return ok(
          result.done
            ? `Пересканировано тредов: ${result.scanned}`
            : `Скан идёт в фоне, уже пересканировано: ${result.scanned}`,
        );
      }

      case "seed": {
        const [sub, path] = rest;
        if (sub !== "import" || path === undefined) {
          return fail("Использование: bb pult seed import <path> [--as-of YYYY-MM-DD] [--replace]");
        }
        const result = await deps.importSeed(path, { cwd: ctx.cwd, asOf, replace });
        bb.log.info(`cli seed import (${replace ? "replace" : "merge"}, ${result.imported} rows) by ${caller}`);
        if (json) return ok(JSON.stringify(result));
        return ok(
          [
            `Загружено записей инвентаризации: ${result.imported} (на ${when(result.asOf)}; ${replace ? "прежняя инвентаризация заменена" : "дополнила прежнюю"})`,
            `Классификация изменилась у тредов: ${result.reclassified}`,
            result.unknown > 0 ? `Ещё не сканированы: ${result.unknown} — получат инвентаризацию при скане` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      case "explain": {
        const [threadId] = rest;
        if (threadId === undefined || !THREAD_ID.test(threadId)) return fail("Использование: bb pult explain <thread-id> [--json]");
        const data = deps.explain(threadId);
        const hostCard = hostCardOf(deps.queue(), threadId);
        if (json) {
          const input =
            data.input === null
              ? null
              : { ...data.input, lastAgentText: data.input.lastAgentText === null ? null : tail(data.input.lastAgentText, 4000) };
          const active =
            data.snapshot === null
              ? null
              : { dismissed: isDismissed(data.snapshot, data.overlay), snoozed: isSnoozed(data.snapshot, data.overlay, now) };
          return ok(JSON.stringify({ ...data, input, overlayActive: active, inCardOf: hostCard }));
        }
        return ok(explainText(data, threadId, now, hostCard));
      }
    }
    return fail(`Неизвестная команда: ${command}\n\n${USAGE}`);
  }

  bb.cli.register({
    name: "pult",
    summary: "Пульт: что ждёт Вадима в тредах BB, приоритеты Сейчас/Дальше/Потом",
    commands: COMMANDS,
    async run(argv, ctx) {
      try {
        return await run(argv, ctx);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
