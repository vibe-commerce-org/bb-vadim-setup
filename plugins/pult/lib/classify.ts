// Pure classifier: whose move it is in one thread. No SDK, no I/O — runs under
// plain `node --test`. Relative imports keep the .ts extension for Node.
//
// The text rules are generic features of how agents end a turn in Russian
// (and English): a question at the end, «жду «делай»», «Что от тебя:», an
// imperative addressed to the user, options «А — …», «скажи «да» — закоммичу».
// They never look at thread ids or project names.
import type {
  AnswerOption,
  Classification,
  ClassificationSource,
  ClassifyInput,
  Kind,
} from "./types.ts";
import {
  ASK_MAX,
  NA,
  NB,
  OPTION_KEYS,
  clip,
  initialFence,
  isOptionSequence,
  normalizeOptionKey,
  parseDue,
  parseMarker,
  parseOptionLine,
  stripMarkdown,
} from "./marker.ts";

/**
 * Classify one thread. Order of evidence:
 * 1. native BB signals (pending interaction → approval; running → working;
 *    failed / interrupted turn without a later human message → failed;
 *    thread status error → failed, whoever wrote last);
 * 2. the agent's «⏸ Ход за Вадимом» marker (lib/marker.ts);
 * 3. text rules over the last agent message (decision / action / review /
 *    commit / done), with ask, options, replyTemplate and due extracted.
 *    Optional offers («могу …», «напиши — поищу»), advice in the middle of
 *    a report, states in table cells, parked points and a subthread's «нужно
 *    от тебя» are weakened; a closing «жду окончания прогона / ответа
 *    сабтреда» (the agent waits for itself) gives unknown; a message that is
 *    only a provider error gives failed.
 * A human message newer than the agent's last turn means the move is not
 * the user's (→ working when running, otherwise unknown).
 */
export function classify(input: ClassifyInput): Classification {
  const humanAfter =
    input.lastHumanAt !== null &&
    (input.lastAgentAt === null || input.lastHumanAt > input.lastAgentAt);

  // 1. Native signals.
  if (input.hasPendingInteraction || input.pending) {
    const p = input.pending;
    return result("approval", "native", 0.97, ["native:pending-interaction"], {
      ask: p?.prompt ? clip(collapse(p.prompt), ASK_MAX) : "BB ждёт ответа в треде",
      options: (p?.options ?? []).slice(0, OPTION_KEYS.length).map((o, i) => ({
        key: OPTION_KEYS[i]!,
        label: clip(o.label, 140),
        recommended: false,
      })),
    });
  }
  if (RUNNING_STATUSES.has(input.status) || input.lastTurn === "running") {
    return result("working", "native", 0.95, ["native:running"]);
  }
  if (!humanAfter) {
    if (input.lastTurn === "failed") {
      return result("failed", "native", 0.9, ["native:turn-failed"], {
        ask: shortError(input.lastErrorText) ?? "Ход упал",
      });
    }
    if (input.lastTurn === "interrupted") {
      return result("failed", "native", 0.85, ["native:turn-interrupted"], {
        ask: "Остановлен вручную, ответа нет",
      });
    }
  }
  // A thread in `error` waits for the user even when his message is the latest:
  // a turn that fails at dispatch or on start leaves no turn/completed, so
  // his own request is newer than the agent's last turn.
  if (input.status === "error") {
    return result("failed", "native", 0.85, ["native:status-error"], {
      ask: shortError(input.lastErrorText) ?? "Ход упал",
    });
  }

  // 2. the user wrote after the agent's last turn: the move is not his.
  if (humanAfter) {
    return result("unknown", "rules", 0.5, ["human-after-agent"]);
  }

  const text = input.lastAgentText;
  if (!text || text.trim() === "") {
    return result(input.lastTurn === "completed" ? "done" : "unknown", "rules", 0.3, [
      "no-agent-text",
    ]);
  }
  // The whole «answer» is a provider/runtime error line: the turn failed.
  if (text.trim().length <= ERROR_TEXT_MAX && ERROR_TEXT_RE.test(text.trim())) {
    return result("failed", "rules", 0.6, ["error-text"], { ask: shortError(text) ?? "Ход упал" });
  }

  // 3. The agent's own marker.
  const marker = parseMarker(text, input.now);
  if (marker) {
    return result(marker.kind, "marker", 0.92, ["marker"], {
      ask: marker.ask,
      options: marker.options,
      due: marker.due,
    });
  }

  // 4. Text rules.
  return classifyText(text, input.isChild, input.now);
}

// BB thread statuses in which the agent runs (or is about to).
const RUNNING_STATUSES = new Set(["active", "starting", "pending"]);

// A message that is only an error printed by the provider or the runtime.
const ERROR_TEXT_MAX = 400;
const ERROR_TEXT_RE =
  /^(?:API Error\b|Unable to connect\b|Failed to (?:authenticate|connect|fetch|send)\b|Request (?:failed|rejected|timed out)\b|Connection (?:error|refused|reset)\b|Prompt is too long\b|Error: |Internal server error\b|Overloaded\b)/iu;

interface Extra {
  ask?: string | null;
  options?: AnswerOption[];
  multi?: boolean;
  replyTemplate?: string | null;
  due?: string | null;
}

function result(
  kind: Kind,
  source: ClassificationSource,
  confidence: number,
  reasons: string[],
  extra: Extra = {},
): Classification {
  return {
    kind,
    ask: extra.ask ?? null,
    options: extra.options ?? [],
    multi: extra.multi ?? false,
    replyTemplate: extra.replyTemplate ?? null,
    due: extra.due ?? null,
    confidence,
    source,
    reasons,
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function shortError(text: string | null): string | null {
  if (!text) return null;
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return first ? clip(first, 200) : null;
}

// ---------------------------------------------------------------------------
// Text model: the message split into units (paragraphs, list items, table
// rows, headings) outside code blocks and quotes.

type UnitType = "para" | "item" | "row" | "heading" | "quote";

interface Unit {
  type: UnitType;
  /** Block number: a paragraph, a whole list, a table. */
  block: number;
  /** Display text: markdown stripped, line breaks kept. */
  display: string;
  /** Probe text for rules: inline code, URLs and long quotes masked. */
  probe: string;
  /** Item number for numbered list items ("1." → 1). */
  num: number | null;
  /** Leading indentation of the item (nested items are deeper). */
  indent: number;
  /** A code block follows right after this unit. */
  codeAfter: string | null;
}

const LIST_ITEM_RE = /^(\s*)([-*+•]|\d{1,2}[.)])\s+(.*)$/u;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/u;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/u;

function maskProbe(line: string): string {
  return line
    .replace(/`[^`\n]*`/g, " ‹код› ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1 ‹ссылка›")
    .replace(/\bhttps?:\/\/\S+/g, " ‹ссылка› ")
    .replace(/(?:^|\s)(?:~|\.{0,2})?\/[\w.@~-]+(?:\/[\w.@~-]*)+/g, " ‹путь› ")
    .replace(/«[^«»\n]{50,}»/gu, " ‹цитата› ")
    .replace(/"[^"\n]{50,}"/g, " ‹цитата› ")
    .replace(/\*\*|__/g, "")
    .replace(/[ \t]+/g, " ");
}

function parseUnits(text: string): Unit[] {
  const units: Unit[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let block = 0;
  let fence: string | null = initialFence(lines);
  let codeBuf: string[] = [];
  let cur: { type: UnitType; lines: string[]; num: number | null; indent: number } | null = null;
  let curBlockType: "para" | "list" | "table" | "quote" | null = null;

  const flushUnit = () => {
    if (!cur) return;
    const display = cur.lines.map((l) => stripMarkdown(l).trim()).join("\n").trim();
    if (display !== "") {
      units.push({
        type: cur.type,
        block,
        display,
        probe: cur.lines.map(maskProbe).join(" ").replace(/\s+/g, " ").trim(),
        num: cur.num,
        indent: cur.indent,
        codeAfter: null,
      });
    }
    cur = null;
  };
  const endBlock = () => {
    flushUnit();
    if (curBlockType !== null) block++;
    curBlockType = null;
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (fence === null) {
        // An indented fence inside a list belongs to the current item.
        if (curBlockType === "list" && /^\s{2,}/.test(line)) flushUnit();
        else endBlock();
        fence = f[1]![0]!;
        codeBuf = [];
      } else if (f[1]![0] === fence) {
        fence = null;
        const last = units[units.length - 1];
        if (last && last.codeAfter === null) last.codeAfter = codeBuf.join("\n").trim();
      }
      continue;
    }
    if (fence !== null) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim() === "") {
      if (curBlockType === "list") {
        // A loose list goes on after a blank line only with another item or
        // an indented continuation; anything else starts a new block.
        let next = li + 1;
        while (next < lines.length && lines[next]!.trim() === "") next++;
        const peek = lines[next] ?? "";
        if (LIST_ITEM_RE.test(peek) || /^(?: {2,}|\t)\S/.test(peek)) {
          flushUnit();
          continue;
        }
      }
      endBlock();
      continue;
    }
    if (HR_RE.test(line)) {
      endBlock();
      continue;
    }
    const h = line.match(HEADING_RE);
    if (h) {
      endBlock();
      cur = { type: "heading", lines: [h[1]!], num: null, indent: 0 };
      curBlockType = "para";
      endBlock();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (curBlockType !== "table") endBlock();
      curBlockType = "table";
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-")) continue; // separator row
      flushUnit();
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      cur = { type: "row", lines: [cells.join(" | ")], num: null, indent: 0 };
      flushUnit();
      continue;
    }
    if (/^\s*>/.test(line)) {
      if (curBlockType !== "quote") endBlock();
      curBlockType = "quote";
      if (!cur) cur = { type: "quote", lines: [], num: null, indent: 0 };
      cur.lines.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }
    const item = line.match(LIST_ITEM_RE);
    if (item) {
      if (curBlockType !== "list") endBlock();
      curBlockType = "list";
      flushUnit();
      const numMatch = item[2]!.match(/^(\d{1,2})[.)]$/);
      cur = {
        type: "item",
        lines: [item[3]!],
        num: numMatch ? Number(numMatch[1]) : null,
        indent: item[1]!.replace(/\t/g, "    ").length,
      };
      continue;
    }
    if (curBlockType === "list") {
      // Continuation of the current item (indented or lazy).
      if (!cur) cur = { type: "item", lines: [], num: null, indent: 2 };
      cur.lines.push(line.trim());
      continue;
    }
    if (curBlockType !== "para" || (cur && cur.type !== "para")) endBlock();
    curBlockType = "para";
    if (!cur) cur = { type: "para", lines: [], num: null, indent: 0 };
    cur.lines.push(line.trim());
  }
  endBlock();
  return units;
}

/** Sentences of a probe text; keeps the end punctuation. */
function sentences(probe: string): string[] {
  return probe
    .split(/(?<=[.!?…])\s+(?=[«"(‹]?[\p{Lu}\d])|(?<=[?!])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// ---------------------------------------------------------------------------
// Rules. Each match is a signal with a kind and a weight; the strongest
// signal (ties → the more urgent kind, then later in the text) wins when it
// clears THRESHOLD. Weights are calibrated so that one descriptive mention
// («песочница не пустила…», «вручную») never wins on its own.

type RuleKind = "decision" | "action" | "review" | "commit";

interface Signal {
  kind: RuleKind;
  weight: number;
  reason: string;
  unit: number;
  /** The sentence that matched (debug only). */
  text?: string;
}

/**
 * Debug/tuning aid: the signals the text rules found in a message, strongest
 * first. Not used by the plugin itself.
 */
export function explainText(
  text: string,
  isChild: boolean,
  now: number,
): { kind: string; weight: number; reason: string; text: string | null }[] {
  const sink: Signal[] = [];
  classifyText(text, isChild, now, sink);
  return sink
    .map((s) => ({ kind: s.kind, weight: Number(s.weight.toFixed(2)), reason: s.reason, text: s.text ?? null }))
    .sort((a, b) => b.weight - a.weight);
}

/** Imperative forms of the stems: «выполни» → выполни|выполните, «-ся» → -ся|-тесь. */
const V = (stems: string[]) =>
  stems.map((s) => (s.endsWith("ся") ? `${s.slice(0, -2)}(?:ся|тесь)` : `${s}(?:те)?`)).join("|");

// Things only the user can do and the agent waits for.
const ACTION_STRONG = V([
  "выполни", "запусти", "оплати", "отправь", "введи", "залогинься", "авторизуйся",
  "зарегистрируйся", "пришли", "скинь", "перешли", "напиши", "позвони", "купи", "закажи",
  "подпиши", "заполни", "прими", "переведи", "запушь", "задеплой", "выдай", "продли", "пополни",
  "передай", "присылай", "скидывай", "кидай",
]);
// How-to steps: often a tip inside a report, weak alone.
const ACTION_WEAK = V([
  "перезапусти", "нажми", "войди", "зайди", "установи", "поставь", "скачай", "скопируй", "вставь",
  "создай", "добавь", "подключи", "включи", "выключи", "разреши", "дай", "обнови", "смени", "удали",
  "закоммить", "пропиши", "сделай", "перенеси", "подними", "верни", "положи", "загрузи", "залей",
  "активируй", "открой", "вбей", "убери", "почини", "настрой", "прокрути", "жми",
]);
const REVIEW_VERBS = V([
  "проверь", "посмотри", "послушай", "глянь", "оцени", "попробуй", "протестируй", "потыкай",
  "прочитай", "прочти", "вычитай", "сравни",
]);
const DECISION_VERBS = V([
  "выбери", "реши", "подтверди", "согласуй", "утверди", "одобри", "ответь", "определись", "скажи",
  "дай знать", "дай отмашку", "дай добро", "пиши", "отвечай", "подтверждай", "выбирай", "решай",
]);

// Words that may precede an imperative at the start of a sentence.
const LEAD =
  "(?:(?:и|а|но|теперь|сейчас|потом|затем|пожалуйста|только|просто|сначала|дальше|также|ещё|еще|лучше|сегодня|завтра|утром|вечером|после\\s+этого|для\\s+этого|тогда)\\s*,?\\s+)*";
// A list item may start with a short label: «1. Диск — выбери …».
const ITEM_LEAD = "^(?:[\\p{L}\\d .\\-«»\"]{0,40}[:—–]\\s+)?";

const imperative = (verbs: string) => ({
  start: new RegExp(`^${LEAD}(?:${verbs})${NB}`, "iu"),
  item: new RegExp(`${ITEM_LEAD}${LEAD}(?:${verbs})${NB}`, "iu"),
  after: new RegExp(`(?:[,:—–]|${NA}и)\\s+${LEAD}(?:${verbs})${NB}(?!\\s+к\\s)`, "iu"),
});
const IMP_ACTION_STRONG = imperative(ACTION_STRONG);
const IMP_ACTION_WEAK = imperative(ACTION_WEAK);
const IMP_REVIEW = imperative(REVIEW_VERBS);
const IMP_DECISION = imperative(DECISION_VERBS);

const r = (src: string) => new RegExp(src, "iu");
const YOU = "(?:тебя|вас|Вадима)";
const YOU_DAT = "(?:тебе|вам|Вадиму)";
const YOU_INS = "(?:тобой|вами|Вадимом)";
const POSS = "(?:тво\\p{L}+\\s+|ваш\\p{L}+\\s+)?";

// Conditional offers («если нужно — скажи», «могу …»): not a request.
const OFFER_RE = r(
  `^(?:‹[^›]*›\\s*)?(?:если|когда|when|if|при\\s+желании|по\\s+желанию|могу|можно\\s+(?:ещё|еще|также|дополнительно|отдельно)|хочешь|хотите|давай\\s+я|если\\s+что)${NB}`,
);
// «Скажи «да» — сделаю», «Напиши, о чём речь, — поищу»: an offer of more
// work, not a request.
const SAY_AND_I_DO_RE = r(
  `^${LEAD}(?:скажи|скажите|напиши|напишите)\\s*(?:[«"“]\\s*да\\s*[»"”])?\\s*(?:[—–-]|,\\s*и)\\s*(?:и\\s+)?(?:я\\s+)?\\p{L}+(?:у|ю)${NB}` +
    `|^${LEAD}(?:скажи|скажите|напиши|напишите|уточни|уточните)\\s*,?\\s*(?:о\\s+ч[её]м|что|какой|какая|какие|где|как|куда|кого|чего)${NB}[^.?!]{0,80}?(?:[—–-]|,\\s*(?:и|тогда))\\s*(?:и\\s+|тогда\\s+)?(?:я\\s+)?\\p{L}+(?:у|ю)${NB}`,
);
// The agent waits for its own background work or a subthread, not for the user:
// «жду окончания прогона», «жду ответа сабтреда», «жду, пока сборка
// закончится», «запущу и вернусь».
const WORKER = `(?:сабтред|субагент|агент|тред|исполнител|воркер|прогон|сборк|деплой|скан|тест|ci${NB}|джоб|job|процесс|скрипт|сервер|модел)\\p{L}*`;
const SELF_WAIT_RE = r(
  `${NA}(?:жду|ждём|ждем|ожидаю|дожидаюсь|подожду|дождусь)\\s+(?:окончани|завершени|результат|итог|отчёт|отчет|ответ|конц)\\p{L}*\\s+(?:от\\s+)?${WORKER}` +
    `|${NA}(?:жду|ждём|ждем|ожидаю|дожидаюсь|подожду|дождусь)\\s+(?:окончани|завершени|конц)\\p{L}*${NB}` +
    `|${NA}(?:жду|ждём|ждем|подожду|дождусь)\\s+${WORKER}` +
    `|${NA}(?:жду|ждём|ждем|подожду),?\\s+пока\\s+(?!(?:ты|вы)${NB})[^.?!]{0,60}?(?:законч|заверш|отработа|пройд|собер|доед|выполн|ответ|верн)\\p{L}*` +
    `|${NA}(?:запущу|запускаю|запустил\\p{L}*)${NB}[^.?!]{0,80}?вернусь${NB}` +
    `|${NA}вернусь\\s+(?:с\\s+(?:результат|итог|отчёт|отчет)|когда\\s+(?!(?:ты|вы)${NB})|после\\s+(?:прогон|сборк|деплой|теста|тестов|окончани|завершени)|как\\s+только\\s+(?!(?:ты|вы)${NB}))`,
);
// …but «жду, когда ты проверишь», «жду твоего результата» are the user's.
const YOUR_RE = r(`${NA}(?:ты|вы|тебя|вас|тво\\p{L}+|ваш\\p{L}*|Вадим\\p{L}*)${NB}`);
// A unit that parks its point for later: «когда вернёмся к теме», «по желанию».
const DEFER_RE = r(
  `${NA}(?:когда\\s+верн[её]мся|верн[её]мся\\s+к\\s+(?:этому|этой|нему|ней|теме)|на\\s+потом|не\\s+срочно|в\\s+следующ\\p{L}+\\s+(?:раз|сесси\\p{L}*))${NB}` +
    // «По желанию: …», «3. Пилот — по желанию»: a unit labeled optional.
    `|^(?:[\\p{L}\\d .«»"-]{0,60}[:—–]\\s*)?по\\s+желанию${NB}`,
);
// A choice inside a question («А или Б?», «какой берём?») is asked even
// after an offer.
const CHOICE_RE = r(`${NA}(?:или|какой|какую|какие|какое|который|которую|что\\s+из)${NB}`);
// Advice about answering somebody else, in a hypothetical: «если кто-то
// напишет …, ответьте ему …».
const HYPOTHETICAL_RE = r(
  `${NA}(?:если|когда)\\s+(?:вдруг\\s+)?(?:кто-то|кто-нибудь|кто-либо|кто|клиент\\p{L}*|покупател\\p{L}*|участник\\p{L}*|пользовател\\p{L}*)${NB}`,
);
// A sentence that opens a conditional the next sentence continues.
const COND_LEAD_RE = r(`^(?:‹[^›]*›\\s*)?(?:если|when|if)${NB}`);
// A question that offers more work rather than asks: «Могу …— делать?».
const OFFER_Q_RE = r(
  `^(?:‹[^›]*›\\s*)?(?:могу|можно\\s+(?:ещё|еще|также|дополнительно|отдельно)|хочешь|хотите|давай\\s+я|если\\s+(?:нужно|надо|хочешь|хотите|интересно)|нужно\\s+ли\\s+(?:ещё|еще)|при\\s+желании)${NB}`,
);
// «Чем займёмся?», «Что дальше?» — an idle prompt, not a question about the work.
const IDLE_Q_RE = r(
  `^(?:чем\\s+(?:займёмся|займемся|ещё|еще|могу)|что\\s+(?:дальше|ещё|еще|будем\\s+делать)|какие\\s+(?:ещё\\s+|еще\\s+)?(?:задачи|планы)|anything\\s+else|what(?:'s|\\s+is)\\s+next)`,
);
const NO_NEED_RE = r(
  `(?:отвечать|ответ|делать|действий|ничего|подтверждени\\p{L}*)\\s+(?:от\\s+${YOU}\\s+)?(?:сейчас\\s+)?(?:не\\s+нужн|не\\s+требу)|${NA}от\\s+${YOU}\\s+(?:сейчас\\s+)?ничего\\s+(?:не\\s+)?(?:нужно|требуется|не\\s+надо)|ничего\\s+делать\\s+не\\s+(?:нужно|надо)|действий\\s+не\\s+требуется|no\\s+action\\s+(?:is\\s+)?(?:needed|required)`,
);
// Phrases where the action words describe what was or was not needed.
const NEGATED_NEED_RE = r(`(?:вручную|руками|ручн\\p{L}*)[^.?!]{0,40}не\\s+(?:нужн|требу|надо)`);
// A conditional clause anywhere in the sentence weakens an imperative.
const CONDITIONAL_RE = r(`${NA}(?:если|when|if)${NB}`);
// Markers that a step is manual, i.e. The user's.
const MANUAL_HINT_RE = r(`${NA}(?:вручную|руками|у\\s+себя|в\\s+(?:своём\\s+|своем\\s+)?терминале|вне\\s+песочниц\\p{L}*)${NB}`);
// Labels that introduce what is asked of the user.
const ASK_LABEL_RE = r(
  `(?:от\\s+(?:тебя|вас|Вадима)|за\\s+(?:тобой|вами|Вадимом)|вопрос|решени|выбор|что\\s+нужно|ждут|жд[её]т|осталось|остаётся|остается|на\\s+согласовани|${YOU_DAT}\\s+(?:нужно|надо|осталось))`,
);
// Labels of a source list: its items are titles, not requests.
const SOURCES_LABEL_RE = r(`^(?:источники|sources|ссылки|литература|references|что\\s+почитать)\\s*:?\\s*$`);
// A pronoun-addressed request that is really a choice.
const DECISION_WORDS_RE = r(
  `(?:решени|выбор|выбрать|вопрос|ответ|[«"“]\\s*(?:да|делай|go|ок)\\s*[»"”]|${NA}go${NB}|согласова|утверд|какой|какую|\\?)`,
);

// Infinitives of steps that are the user's when «нужно / лучше …» precedes them.
const SHOULD_INF = [
  "написать", "оплатить", "отправить", "запустить", "выполнить", "ввести", "залогиниться",
  "прислать", "переслать", "позвонить", "купить", "заказать", "подписать", "принять", "перевести",
  "выбрать", "решить", "послушать", "согласовать", "утвердить", "ответить", "получить",
].join("|");

const PRONOUN_RULES = new Set([
  "need-from-you", "you-need", "on-you", "waits-for-you", "questions-to-you", "decision-is-yours", "need-your-decision",
]);

interface Rule {
  kind: RuleKind;
  weight: number;
  reason: string;
  re: RegExp;
}

const WAIT_WORDS = `(?:делай|go|ок|ok|да|поехали|добро|отмашк|ответ|решени|выбор|подтвержд|согласова|сигнал|команд|апрув|approve|исполняй|готово)`;

// Patterns matched against every sentence (body sentences get a penalty).
const PHRASE_RULES: Rule[] = [
  // Decision.
  { kind: "decision", weight: 0.85, reason: "wait-go", re: r(`(?<!«)${NA}(?:жду|ждём|ожидаю)\\s+(?:от\\s+${YOU}\\s+)?(?:[\\p{L}-]+\\s+){0,3}?[«"“]?\\s*${WAIT_WORDS}`) },
  { kind: "decision", weight: 0.85, reason: "say-go", re: r(`${NA}(?:скажи|скажите|напиши|напишите|ответь|ответьте|дай|дайте)\\s+[«"“]\\s*(?:делай|go|поехали|ок|ok|да|добро|катим|запускай|исполняй)`) },
  { kind: "decision", weight: 0.8, reason: "answer-one-line", re: r(`${NA}(?:ответь(?:те)?|ответы\\s+можно\\s+дать|ответить\\s+можно)\\s+(?:одной\\s+строкой|одним\\s+словом|буквой|буквами|цифрой|цифрами|номером|номерами|коротко|по\\s+пунктам)`) },
  { kind: "decision", weight: 0.85, reason: "questions-to-you", re: r(`${NA}вопрос(?:ы)?\\s+(?:к|для)\\s+(?:тебе|тебя|вам|вас|Вадиму|Вадима)${NB}`) },
  { kind: "decision", weight: 0.85, reason: "decision-is-yours", re: r(`${NA}(?:решени[ея]|выбор|слово)\\s+за\\s+${YOU_INS}|${NA}решать\\s+${YOU_DAT}|${NA}(?:решите|решишь|решаете|решаешь|выберете|выберешь|выбираете|выбираешь)\\s+(?:вы|ты)${NB}|${NA}на\\s+(?:твоё|твое|ваше)\\s+(?:усмотрение|решение|выбор)${NB}`) },
  { kind: "decision", weight: 0.8, reason: "need-your-decision", re: r(`${NA}(?:нужн[оаы]?|нужен|требуется)\\s+(?:тво[её]|ваше|твой|ваш|твоя|ваша)\\s+(?:решени|выбор|ответ|подтвержд|согласи|одобрени|go|«go»|окей|ок)`) },
  { kind: "decision", weight: 0.45, reason: "which-option", re: r(`${NA}(?:какой|какую|какие|который)\\s+(?:вариант|из\\s+вариантов|путь|подход|выбираешь|выбираете|берём|берем|оставляем)`) },
  { kind: "decision", weight: 0.75, reason: "approval-wait", re: r(`(?<!«)${NA}(?:на\\s+согласовани|ожида\\p{L}*\\s+${POSS}(?:согласовани|подтверждени|решени|одобрени|go|«go»)|жд[её]т\\s+${POSS}(?:согласовани|подтверждени|решени|одобрени|«делай»|«go»|ответа))`) },
  { kind: "decision", weight: 0.8, reason: "go-prod", re: r(`${NA}[«"]?go[»"]?\\s+на\\s+(?:prod|прод|dev|дев)${NB}|^(?:так\\s+|ну\\s+что,?\\s+)?(?:деплоим|выкатываем|катим|публикуем|запускаем|делаем|поехали|продолжаем|мерджим|мержим|отправляем)\\s*\\?`) },
  { kind: "decision", weight: 0.7, reason: "approve-plan", re: r(`${NA}(?:план|бриф|спек\\p{L}*)[^.?!]{0,60}(?:жд[её]т|на)\\s+${POSS}(?:«делай»|согласовани|одобрени|утверждени|go|«go»|ревью)`) },
  { kind: "decision", weight: 0.7, reason: "how-to-answer", re: r(`^как\\s+ответить${NB}`) },
  { kind: "decision", weight: 0.7, reason: "your-call", re: r(`(?:your\\s+call|let\\s+me\\s+know\\s+which|which\\s+(?:option|one)\\s+do\\s+you|should\\s+i\\s+(?:proceed|go\\s+ahead)|waiting\\s+for\\s+your\\s+(?:go|decision|answer|approval)|please\\s+(?:confirm|approve|choose))`) },
  // Action.
  { kind: "action", weight: 0.85, reason: "on-you", re: r(`(?<![«\\p{L}])(?:ход|дело|очередь|шаг)\\s+за\\s+${YOU_INS}${NB}|(?<![«\\p{L}])за\\s+${YOU_INS}${NB}(?!\\s+(?:не|никто|ничего)${NB})`) },
  { kind: "action", weight: 0.8, reason: "you-need", re: r(`${NA}${YOU_DAT}\\s+(?:нужно|надо|осталось|остаётся|остается|предстоит|придётся|придется|необходимо)\\s+(?!не${NB})`) },
  { kind: "action", weight: 0.8, reason: "need-from-you", re: r(`${NA}(?:от\\s+${YOU}\\s+(?:нужно|нужен|нужна|нужны|требуется|потребуется|понадобится|жду)|(?:что|чего)\\s+(?:нужно\\s+|жду\\s+|ждём\\s+)?от\\s+${YOU}${NB}|нужно\\s+от\\s+${YOU}${NB}|(?:жду|ждём|ждем|ожидаю)\\s+(?:ещё\\s+|еще\\s+|только\\s+)?от\\s+${YOU}${NB})`) },
  { kind: "action", weight: 0.8, reason: "waits-for-you", re: r(`(?<!«)${NA}(?:жд[её]т|ждут)\\s+(?:только\\s+|ещё\\s+|еще\\s+|теперь\\s+|по-прежнему\\s+)?${YOU}${NB}|${NA}${YOU}\\s+(?:жд[её]т|ждут)${NB}`) },
  { kind: "action", weight: 0.8, reason: "wait-when", re: r(`${NA}(?:жду|ждём|ждем),?\\s+(?:когда|пока)\\s+(?:(?:ты|вы)${NB}|[^.?!]{0,30}?\\p{L}+(?:ешь|ёшь|ишь|ете|ёте|ите)${NB})`) },
  { kind: "action", weight: 0.56, reason: "should-do", re: r(`${NA}(?:нужно|надо|стоит|лучше|следует|необходимо|осталось|остаётся|остается)\\s+(?:(?:бы|всё-таки|все-таки|всё\\s+же|ещё|еще|только|сначала|сейчас|теперь|им|ему|ей)\\s+){0,3}(?:${SHOULD_INF})${NB}|${NA}(?:${SHOULD_INF})\\s+(?:[\\p{L}-]+\\s+){0,3}?(?:всё-таки\\s+|все-таки\\s+)?(?:нужно|надо)${NB}`) },
  { kind: "action", weight: 0.7, reason: "ask-you", re: r(`${NA}(?:прошу|попросил\\p{L}*|просьба\\s+к)\\s+${YOU}${NB}`) },
  { kind: "action", weight: 0.35, reason: "sandbox-blocked", re: r(`${NA}(?:авто-?режим\\p{L}*|классификатор\\p{L}*|песочниц\\p{L}*|sandbox|auto[- ]?mode)[^.?!]{0,40}(?:не\\s+(?:пропустил|пустил|дал|разрешил|позволил|пропускает|пускает|даёт|дает)|заблокир|отклонил|режет|срезал|запретил|blocked|denied)`) },
  { kind: "action", weight: 0.35, reason: "manual-step", re: r(`${NA}(?:вручную|руками|ручн(?:ой|ая|ое|ые)\\s+(?:шаг|действи|запуск|команд))${NB}`) },
  { kind: "action", weight: 0.75, reason: "pin-login", re: r(`${NA}(?:ПИН|PIN|пин-?код\\p{L}*|2fa|код\\s+из\\s+(?:смс|sms|приложения))${NB}`) },
  { kind: "action", weight: 0.4, reason: "run-in-terminal", re: r(`${NA}(?:в\\s+(?:своём\\s+|своем\\s+)?терминал[еу]|вне\\s+песочниц\\p{L}*|у\\s+себя\\s+на\\s+(?:маке|mac)|одной\\s+командой)${NB}`) },
  { kind: "action", weight: 0.7, reason: "please-do", re: r(`(?:please\\s+(?:run|execute|log\\s+in|pay|send|click|push)|you\\s+(?:need|have)\\s+to|on\\s+your\\s+side)`) },
  // Review.
  { kind: "review", weight: 0.8, reason: "review-live", re: r(`${NA}(?:проверь|проверьте|посмотри|посмотрите|глянь|гляньте|потыкай|потыкайте|попробуй|попробуйте)\\s+(?:сам\\p{L}*\\s+|сама\\s+)?(?:в\\s+приложени|вживую|глазами|на\\s+телефоне|в\\s+браузере|на\\s+(?:dev|деве|проде|prod)${NB}|руками|сам|сама|как\\s+(?:выглядит|работает|звучит)|и\\s+скажи|и\\s+дай\\s+знать|результат)`) },
  { kind: "review", weight: 0.8, reason: "listen", re: r(`${NA}послушай(?:те)?${NB}`) },
  { kind: "review", weight: 0.75, reason: "awaits-review", re: r(`(?<!«)${NA}(?:жд[её]т|ожида\\p{L}*)\\s+${POSS}(?:проверки|ревью|приёмки|приемки|оценки)|${NA}на\\s+${POSS}(?:проверку|приёмку|приемку)${NB}`) },
];

// A commit/backup prompt: set aside, it wins only when nothing else is asked.
const COMMIT_RE = r(
  `(?:бэкап|backup|закоммит\\p{L}*|коммит\\p{L}*|commit|запуш\\p{L}*|push\\p{L}*|пуш\\p{L}*)[^?]{0,160}\\?|${NA}(?:скажи|скажите|напиши|напишите)\\s+[«"“]?\\s*да\\s*[»"”]?[^.?!]{0,80}(?:закоммич|коммит|запуш|бэкап|push|commit)|(?:коммит|commit|бэкап|push|пуш)\\p{L}*\\s+(?:ждёт|ждет|ожидает)\\s+[«"“]?\\s*да|[«"“]\\s*да\\s*[»"”]\\s+на\\s+(?:коммит|commit|бэкап|push|пуш)` +
    // «Скажете — закоммичу», «Не коммитил …, решать вам».
    `|${NA}(?:скажи|скажите|скажешь|скажете)\\s*[—–-]\\s*(?:и\\s+)?(?:я\\s+)?(?:закоммич|запуш|сделаю\\s+(?:коммит|бэкап|push))` +
    `|${NA}(?:за)?(?:коммитил|пушил)\\p{L}*[^.?!]{0,80}(?:решать\\s+(?:вам|тебе)|на\\s+(?:тво[её]|ваше)\\s+усмотрение)`,
);
// …unless it also ships something: then it is a go/no-go decision.
const DEPLOY_RE = r(`${NA}(?:деплой\\p{L}*|deploy\\p{L}*|выкат\\p{L}*|прод${NB}|prod${NB}|релиз\\p{L}*|публик\\p{L}*|merge|мерж\\p{L}*|мердж\\p{L}*)`);
const RECOMMEND_KEY_RE = new RegExp(
  `(?:рекомендую|рекомендация\\s*[:—–-]?|моя\\s+рекомендация\\s*[:—–-]?|советую|я\\s+бы\\s+(?:выбрал|взял|оставил)\\p{L}*|recommend(?:ed|ation)?\\s*:?)\\s*(?:вариант\\s+|option\\s+)?[«"“]?([АБВГДABCDE])${NB}`,
  "iu",
);
const SIGN_OFF_RE = r(
  `^(?:на\\s+этом\\s+(?:сабтред|тред|задача|работа)\\s+(?:закончен|завершен|завершён|выполнен)|понятность\\s*:|уверенность\\s*:|роль\\s*:|источники\\s*:?$|sources\\s*:?$)`,
);

const TAIL_CHARS = 1600;
const THRESHOLD = 0.55;
const SELF_WAIT_OVERRIDE = 0.8;

// Rules that describe a state («ждёт согласования») rather than ask.
const STATUS_RULES = new Set(["approval-wait", "approve-plan", "awaits-review", "waits-for-you"]);

/** «Жду окончания прогона», unless what is awaited is the user's («твоей проверки»). */
function isSelfWait(s: string): boolean {
  const m = SELF_WAIT_RE.exec(s);
  if (!m) return false;
  return !YOUR_RE.test(s.slice(m.index, m.index + m[0].length + 30));
}

const SAY_YES_RE = r(`^${LEAD}(?:скажи|скажите|напиши|напишите|ответь|ответьте)\\s*[«"“]?\\s*да${NB}`);

function isCommitSentence(s: string): boolean {
  return COMMIT_RE.test(s) && !DEPLOY_RE.test(s);
}

function classifyText(text: string, isChild: boolean, now: number, sink?: Signal[]): Classification {
  const units = parseUnits(text).filter((u) => u.type !== "quote");
  if (units.length === 0) return result("done", "rules", 0.4, ["empty-prose"]);

  const unitSentences = units.map((u) => (u.type === "heading" ? [u.probe] : sentences(u.probe)));
  // Commit prompts: the sentence itself plus a «Скажи «да»» right next to it.
  const commitSentences: string[] = [];
  const commitUnits = new Set<number>();
  const commitSet = new Set<string>();
  unitSentences.forEach((sents, i) => {
    const marks = sents.map(isCommitSentence);
    sents.forEach((s, si) => {
      if (!marks[si] && SAY_YES_RE.test(s) && (marks[si - 1] || marks[si + 1])) marks[si] = true;
    });
    const count = marks.filter(Boolean).length;
    sents.forEach((s, si) => marks[si] && commitSet.add(`${i}:${si}`));
    if (count > 0) commitSentences.push(units[i]!.display);
    if (count > 0 && count >= sents.length - 1) commitUnits.add(i);
  });

  // Items under «Источники:» are titles of links, not requests.
  const sourceBlocks = new Set<number>();
  units.forEach((u, i) => {
    const next = units[i + 1];
    if (SOURCES_LABEL_RE.test(u.probe) && next && next.type === "item") sourceBlocks.add(next.block);
  });
  const skipped = (u: Unit) => sourceBlocks.has(u.block) || isSourceLine(u) || SOURCES_LABEL_RE.test(u.probe);

  // Trailing sign-offs, source lists and commit prompts are not «the last paragraph».
  let last = units.length - 1;
  while (last > 0 && (commitUnits.has(last) || SIGN_OFF_RE.test(units[last]!.probe) || skipped(units[last]!))) {
    last--;
  }

  // The tail: the last ~TAIL_CHARS of prose, whole units, at least two.
  let tailStart = last;
  let chars = units[last]!.probe.length;
  while (tailStart > 0 && (chars < TAIL_CHARS || last - tailStart < 1)) {
    tailStart--;
    chars += units[tailStart]!.probe.length;
  }

  const russian = (text.match(/[а-яё]/giu)?.length ?? 0) > (text.match(/[a-z]/giu)?.length ?? 0) / 2;
  const signals: Signal[] = [];
  let noNeed = false;
  let selfWaitUnit = -1;
  let tailQuestions = 0;
  const lastBlock = units[last]!.block;

  for (let i = 0; i < units.length; i++) {
    const u = units[i]!;
    if (skipped(u)) continue;
    const inTail = i >= tailStart && i <= last;
    const isLast = u.block === lastBlock && i <= last;
    const posBonus = isLast ? 0.06 : inTail ? 0 : -0.25;
    const sents = unitSentences[i]!;
    // A point parked for later («когда вернёмся к теме», «по желанию»).
    const deferred = DEFER_RE.test(u.probe) ? 0.3 : 0;
    // «Могу переотправить. Для этого нужно … Переотправить?» — once a unit
    // opens with an offer, what follows in it belongs to the offer.
    let offerCtx = false;
    // «Если вы имели в виду X, это не он. Напишите, о чём речь» — the
    // conditional of one sentence carries over to the next one.
    let condCtx = false;

    sents.forEach((s, si) => {
      const prevOffer = offerCtx;
      const prevCond = condCtx;
      offerCtx ||= OFFER_Q_RE.test(s);
      condCtx = COND_LEAD_RE.test(s);
      if (commitSet.has(`${i}:${si}`)) return;
      // The agent waits for its own run or subthread: not the user's move.
      if (isSelfWait(s)) {
        if (inTail) selfWaitUnit = i;
        return;
      }
      if (inTail && NO_NEED_RE.test(s)) noNeed = true;
      const ownOffer = OFFER_RE.test(s) || SAY_AND_I_DO_RE.test(s);
      const inOffer = prevOffer && !CHOICE_RE.test(s);
      const offer = inOffer || ownOffer;
      const negated = NEGATED_NEED_RE.test(s) || NO_NEED_RE.test(s);
      const add = (kind: RuleKind, weight: number, reason: string) =>
        signals.push({ kind, weight: weight - deferred, reason, unit: i, text: s });

      for (const rule of PHRASE_RULES) {
        if (!rule.re.test(s)) continue;
        if (negated && rule.kind !== "decision") continue;
        let kind = rule.kind;
        if (kind === "action" && rule.weight >= 0.7 && DECISION_WORDS_RE.test(s)) kind = "decision";
        // Table cells usually describe a plan, not ask; a status in a cell
        // («ждёт согласования») is about the row's object.
        const rowPenalty = u.type === "row" ? (STATUS_RULES.has(rule.reason) ? 0.3 : 0.15) : 0;
        // A subthread's «ты» is often its parent agent, not the user; «нужно
        // от тебя» in a subthread's report is addressed to the parent.
        const childPenalty =
          isChild && PRONOUN_RULES.has(rule.reason) && !/Вадим/u.test(s) ? (rule.reason === "need-from-you" ? 0.3 : 0.1) : 0;
        // An explicit «скажи «делай»» after an offer still asks for the go.
        const offerPenalty =
          rule.reason.startsWith("wait") || (rule.reason === "say-go" && !ownOffer) ? 0 : offer ? 0.4 : 0;
        const w = rule.weight + posBonus - rowPenalty - childPenalty - offerPenalty;
        add(kind, w, rule.reason);
      }
      if (!inTail || u.type === "heading" || u.type === "row") return;

      // Imperatives addressed to the user.
      if (!offer && !negated) {
        const first = si === 0 && u.type === "item";
        const hit = (imp: ReturnType<typeof imperative>) =>
          imp.start.test(s) || (first && imp.item.test(s)) || imp.after.test(s);
        const childPenalty =
          (isChild ? 0.05 : 0) +
          (CONDITIONAL_RE.test(s) || prevCond ? 0.15 : 0) +
          (HYPOTHETICAL_RE.test(s) ? 0.15 : 0);
        if (hit(IMP_DECISION) && !hit(IMP_ACTION_STRONG)) add("decision", 0.66 + posBonus - childPenalty, "imperative-decision");
        else if (hit(IMP_ACTION_STRONG)) add("action", 0.68 + posBonus - childPenalty, "imperative-action");
        else if (hit(IMP_REVIEW)) {
          const howTo = /командой|command/iu.test(s) ? 0.15 : 0;
          // «Проверь на глаз» in the middle of a report is advice; a check
          // the agent hands over closes the message.
          const aside = isLast ? 0 : 0.1;
          add("review", 0.62 + posBonus - childPenalty - howTo - aside, "imperative-review");
        }
        else if (hit(IMP_ACTION_WEAK)) {
          // «Удали вручную: …», «запусти у себя в терминале» — a step only the user can take.
          const manual = MANUAL_HINT_RE.test(s);
          add("action", (manual ? 0.68 : 0.48) + posBonus - childPenalty, manual ? "imperative-manual" : "imperative-weak");
        }
      }

      // A question to the user. Offers («могу …— делать?», «хочешь — …?»,
      // «Могу … Нужно?») and idle prompts («Чем займёмся?») are weak.
      if (/\?\s*[)»"”]*\s*$/u.test(s) && !/^‹/u.test(s)) {
        let w = isLast ? 0.68 : si === sents.length - 1 ? 0.6 : 0.5;
        const weak = OFFER_Q_RE.test(s) || IDLE_Q_RE.test(s) || inOffer;
        if (weak) w -= 0.25;
        if (s.split(/\s+/u).length <= 3) w -= 0.1;
        if (russian && !/[а-яё]/iu.test(s)) w -= 0.25; // a quoted English line
        add("decision", w, "question");
        if (!weak) tailQuestions++;
      }
    });
  }

  // Several real questions in the tail: a pack of questions to answer.
  if (tailQuestions >= 2) {
    const lastQ = signals.filter((s) => s.reason === "question").pop()!;
    signals.push({ kind: "decision", weight: 0.72, reason: "several-questions", unit: lastQ.unit, text: lastQ.text });
  }

  // Options in the tail make a question a choice.
  const opt = extractOptions(units, tailStart, last);
  if (opt.options.length >= 2) {
    const asked = signals.some((s) => s.kind === "decision" && s.weight >= 0.45);
    signals.push({
      kind: "decision",
      weight: asked ? 0.75 + (opt.recommended ? 0.05 : 0) : 0.45,
      reason: "options",
      unit: opt.unit,
    });
  }
  // Packs may start long before the tail: look at the whole prose.
  const multi = extractMulti(units, 0, last, text);
  if (multi) {
    const live = multi.endUnit >= tailStart;
    signals.push({ kind: "decision", weight: live ? 0.8 : 0.5, reason: "numbered-questions", unit: multi.headUnit });
  }

  sink?.push(...signals);
  const best = pickBest(signals);
  const score = best ? best.weight - (noNeed ? 0.25 : 0) : 0;
  // The agent waits for its own run or subthread. An ask after that line,
  // or a strong one before it, still makes the move the user's.
  if (
    selfWaitUnit >= 0 &&
    (!best || score < THRESHOLD || (best.unit < selfWaitUnit && score < SELF_WAIT_OVERRIDE))
  ) {
    return result("unknown", "rules", 0.35, ["self-wait"]);
  }
  if (!best || score < THRESHOLD) {
    if (commitSentences.length > 0) {
      return result("commit", "rules", 0.75, ["commit-prompt"], {
        ask: clip(commitSentences[commitSentences.length - 1]!.replace(/\n+/g, " "), ASK_MAX),
      });
    }
    const reasons = [isChild ? "child-report" : "report"];
    if (noNeed) reasons.push("no-need");
    if (best) reasons.push(`weak:${best.reason}`);
    return result("done", "rules", best ? 0.55 : 0.7, reasons);
  }

  const kind = best.kind;
  const reasons = Array.from(
    new Set(signals.filter((s) => s.weight >= THRESHOLD).map((s) => `${s.kind}:${s.reason}`)),
  );
  let ask: string;
  let isMulti = false;
  let replyTemplate: string | null = null;
  let options: AnswerOption[] = [];
  if (multi && kind === "decision" && (best.reason === "numbered-questions" || (best.unit >= multi.headUnit && multi.endUnit >= tailStart))) {
    ask = multi.ask;
    isMulti = true;
    replyTemplate = multi.replyTemplate;
  } else if (best.reason === "several-questions") {
    ask = questionsAsk(units, signals);
    isMulti = true;
  } else {
    let askUnit = best.unit;
    if (best.reason === "options") {
      // The question that goes with the options, else the line before them.
      const q = signals
        .filter((x) => x.kind === "decision" && x.reason !== "options" && x.weight >= 0.4)
        .sort((a, b) => b.weight - a.weight || b.unit - a.unit)[0];
      askUnit = q ? q.unit : Math.max(0, opt.first - 1);
    }
    ask = askAround(units, askUnit);
    if (kind === "decision" && opt.options.length >= 2) options = opt.options;
  }
  const due = dueOf(ask, now);
  const confidence = Math.min(0.9, Math.max(0.5, score));
  return result(kind, "rules", Number(confidence.toFixed(2)), reasons, {
    ask,
    options,
    multi: isMulti,
    replyTemplate,
    due,
  });
}

/** A line of a trailing source list: «- [Name](url)» or a bare link. */
function isSourceLine(u: Unit): boolean {
  if (u.type !== "item" && u.type !== "para") return false;
  if (!/^(?:[^\p{L}]*‹ссылка›[^\p{L}]*|[^.?!]{0,120}‹ссылка›\s*)$/u.test(u.probe)) return false;
  const imp = [IMP_ACTION_STRONG, IMP_ACTION_WEAK, IMP_REVIEW, IMP_DECISION];
  return !imp.some((i) => i.start.test(u.probe) || i.item.test(u.probe));
}

const KIND_RANK: Record<RuleKind, number> = { decision: 4, action: 3, review: 2, commit: 1 };

function pickBest(signals: Signal[]): Signal | null {
  let best: Signal | null = null;
  for (const s of signals) {
    if (
      !best ||
      s.weight > best.weight + 1e-9 ||
      (Math.abs(s.weight - best.weight) < 1e-9 &&
        (KIND_RANK[s.kind] > KIND_RANK[best.kind] ||
          (KIND_RANK[s.kind] === KIND_RANK[best.kind] && s.unit > best.unit)))
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * The ask: the unit with the winning signal. A list item gets the label
 * above its list when that label is an ask («Что от тебя:»); a label gets
 * its list. Long text keeps its end, where the question usually is.
 */
function askAround(units: Unit[], index: number): string {
  const u = units[index]!;
  const oneLine = (x: Unit) => x.display.replace(/\n+/g, " ");
  const listAfter = (i: number) => {
    const next = units[i + 1];
    return next && next.type === "item" ? units.filter((y) => y.block === next.block) : [];
  };
  const fit = (head: string[], items: Unit[]) => {
    const parts = [...head];
    for (const x of items) {
      const line = "• " + oneLine(x);
      if ([...parts, line].join("\n").length > ASK_MAX) break;
      parts.push(line);
    }
    return parts.length > head.length ? parts.join("\n") : null;
  };
  if (u.type === "item") {
    const blockUnits = units.filter((x) => x.block === u.block);
    const label = units[units.indexOf(blockUnits[0]!) - 1];
    if (label && /[:：]\s*$/u.test(label.display) && ASK_LABEL_RE.test(label.probe) && label.display.length < 200) {
      const fromHit = blockUnits.slice(blockUnits.indexOf(u));
      const all = fit([oneLine(label)], blockUnits);
      if (all && all.split("\n").length - 1 === blockUnits.length) return all;
      const own = fit([oneLine(label)], fromHit);
      if (own) return own;
    }
    return tailClip(oneLine(u));
  }
  if (/[:：]\s*$/u.test(u.display) && listAfter(index).length > 0) {
    const all = fit([oneLine(u)], listAfter(index));
    if (all) return all;
  }
  const text = oneLine(u) + (u.codeAfter && u.codeAfter.length < 300 ? "\n" + u.codeAfter : "");
  return tailClip(text);
}

/** The units with real questions, in order, as one ask. */
function questionsAsk(units: Unit[], signals: Signal[]): string {
  const idx = Array.from(
    new Set(signals.filter((s) => s.reason === "question" && s.weight >= 0.45).map((s) => s.unit)),
  ).sort((a, b) => a - b);
  const parts: string[] = [];
  for (const i of idx) {
    const line = units[i]!.display.replace(/\n+/g, " ");
    if ([...parts, line].join("\n").length > ASK_MAX) break;
    parts.push(line);
  }
  return parts.length > 0 ? parts.join("\n") : tailClip(units[idx[idx.length - 1] ?? 0]!.display);
}

const DUE_PAST_LIMIT_MS = 30 * 24 * 60 * 60 * 1000;

/** A deadline in the ask; one more than a month back is a mention, not a deadline. */
function dueOf(ask: string, now: number): string | null {
  const due = parseDue(ask, now);
  if (!due) return null;
  return Date.parse(due + "T23:59:59+03:00") < now - DUE_PAST_LIMIT_MS ? null : due;
}

/** Keep whole trailing sentences that fit ASK_MAX, else clip. */
function tailClip(text: string): string {
  if (text.length <= ASK_MAX) return text;
  const sents = sentencesDisplay(text);
  let acc = "";
  for (let i = sents.length - 1; i >= 0; i--) {
    const next = sents[i] + (acc ? " " + acc : "");
    if (next.length > ASK_MAX) break;
    acc = next;
  }
  return acc || clip(text, ASK_MAX);
}

function sentencesDisplay(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== "");
}

// ---------------------------------------------------------------------------
// Options and numbered question packs.

interface OptionsFound {
  options: AnswerOption[];
  /** Unit of the first and of the last option line. */
  first: number;
  unit: number;
  recommended: boolean;
}

function extractOptions(units: Unit[], from: number, to: number): OptionsFound {
  // Groups of consecutive option lines: paragraph lines, list items, table
  // rows. A line that is not an option ends the group; the last group wins.
  let bestGroup: { options: AnswerOption[]; first: number; unit: number } | null = null;
  let group: AnswerOption[] = [];
  let groupFirst = -1;
  let groupUnit = -1;
  const close = () => {
    const seq = dedupe(group);
    if (isOptionSequence(seq)) bestGroup = { options: seq, first: groupFirst, unit: groupUnit };
    group = [];
  };
  for (let i = from; i <= to; i++) {
    const u = units[i]!;
    // Items: only the first line can carry the key, the rest continues it.
    const lines =
      u.type === "row" ? [rowAsOption(u.display)] : u.type === "item" ? [u.display.split("\n")[0]!] : u.display.split("\n");
    for (const line of lines) {
      const o = line ? parseOptionLine(line) : null;
      if (!o) {
        close();
        continue;
      }
      if (group.length > 0 && o.key === "А") close();
      if (group.length === 0) groupFirst = i;
      group.push(o);
      groupUnit = i;
    }
  }
  close();
  const found = bestGroup as { options: AnswerOption[]; first: number; unit: number } | null;
  if (!found) return { options: [], first: -1, unit: -1, recommended: false };
  const options = found.options.map((o) => ({ ...o }));
  // «Рекомендую Б» near the options marks the recommendation.
  if (!options.some((o) => o.recommended)) {
    for (let i = Math.max(from, found.unit - 3); i <= Math.min(to, found.unit + 3); i++) {
      const m = units[i]!.probe.match(RECOMMEND_KEY_RE);
      const key = m ? normalizeOptionKey(m[1]!) : null;
      const target = key ? options.find((o) => o.key === key) : undefined;
      if (target) {
        target.recommended = true;
        break;
      }
    }
  }
  return { options, first: found.first, unit: found.unit, recommended: options.some((o) => o.recommended) };
}

function rowAsOption(row: string): string {
  // «А | раскатить всем | …» → «А — раскатить всем»
  const cells = row.split(" | ").map((c) => c.trim()).filter((c) => c !== "");
  if (cells.length >= 2 && normalizeOptionKey(cells[0]!) && /^[АБВГДABCDE]$/u.test(cells[0]!)) {
    return `${cells[0]} — ${cells.slice(1).join(" — ")}`;
  }
  return cells[0] ?? "";
}

function dedupe(options: AnswerOption[]): AnswerOption[] {
  const seen = new Set<string>();
  return options.filter((o) => (seen.has(o.key) ? false : (seen.add(o.key), true)));
}

interface MultiFound {
  ask: string;
  headUnit: number;
  /** Last unit of the pack: a pack ending in the tail is a live ask. */
  endUnit: number;
  replyTemplate: string | null;
}

interface Section {
  num: number;
  /** Units of the section; the first one is its head. */
  units: number[];
  /** Text of the question line shown in the ask. */
  line: string;
  /** Recommendation from a «Рекомендую» table column, if any. */
  tableRec: string | null;
}

// «**1. Формат набора**», «## 2. Запускать всё через оркестратор?», «Вопрос 3: …».
const SECTION_HEAD_RE = /^(?:вопрос|решение|р|q)?\s*(\d{1,2})\s*[.):—–-]\s*(\S.{0,150})$/iu;
// An inline alternative marked as the recommendation: «Б — 0,5% (рекомендую)», «Б ⭐».
const INLINE_REC_RE =
  /(?<![\p{L}\p{N}])([АБВГДABCDE])\s*[—–:-]\s*(?:[^,;()]|,(?=\d)){1,80}?\s*(?:\((?:рекомендую|рекомендуется|рекомендация|recommended)\)|⭐)/u;
// The agent's own reply example: «1 — А, 2 — Б, 3 — …».
const REPLY_EXAMPLE_RE =
  /[«"“]\s*(1\s*[—–-]\s*[^,»"”\n]{1,30}(?:,\s*\d{1,2}\s*[—–-]\s*[^,»"”\n]{1,30})+)\s*[»"”]/u;
const PACK_LABEL_RE = /(?:вопрос|решени|выбор|ответ|согласова|от\s+(?:тебя|вас))/iu;

function normalizeTemplate(t: string): string {
  return t.replace(/(?<![\p{L}\p{N}])([ABCDE])(?![\p{L}\p{N}])/gu, (k) => normalizeOptionKey(k) ?? k).replace(/\s+/g, " ").trim();
}

/** Packs of numbered questions: list items, numbered table rows, numbered sections. */
function findPacks(units: Unit[], from: number, to: number): Section[][] {
  const packs: Section[][] = [];
  // 1. Numbered list items (top level) and numbered table rows, per block.
  const blocks = new Map<number, number[]>();
  for (let i = from; i <= to; i++) {
    const u = units[i]!;
    if (u.type === "item" || u.type === "row") blocks.set(u.block, [...(blocks.get(u.block) ?? []), i]);
  }
  for (const idxs of blocks.values()) {
    const minIndent = Math.min(...idxs.map((i) => units[i]!.indent));
    const header = units[idxs[0]!]!.type === "row" ? units[idxs[0]!]!.display.split(" | ") : null;
    const recCol = header ? header.findIndex((c) => /рекоменд|recommend/iu.test(c)) : -1;
    const pack: Section[] = [];
    for (const i of idxs) {
      const u = units[i]!;
      if (u.type === "row") {
        const cells = u.display.split(" | ");
        const m = cells[0]!.match(/^(\d{1,2})$/u);
        if (!m) continue;
        const recCell = recCol > 0 ? stripMarkdown(cells[recCol] ?? "").trim() : "";
        const recKey = /^[АБВГДABCDE](?![\p{L}\p{N}])/u.test(recCell) ? normalizeOptionKey(recCell[0]!) : null;
        pack.push({ num: Number(m[1]), units: [i], line: cells.slice(1, recCol > 1 ? recCol : 2).join(" — "), tableRec: recKey });
      } else if (u.indent === minIndent && u.num !== null) {
        pack.push({ num: u.num, units: [i], line: u.display.replace(/\n+/g, " "), tableRec: null });
      } else if (pack.length > 0) {
        pack[pack.length - 1]!.units.push(i);
      }
    }
    if (pack.length >= 2) packs.push(pack);
  }
  // 2. Numbered section heads: headings or one-line labels.
  let pack: Section[] = [];
  const flush = () => {
    if (pack.length >= 2) packs.push(pack);
    pack = [];
  };
  for (let i = from; i <= to; i++) {
    const u = units[i]!;
    const firstLine = u.display.split("\n")[0]!;
    const m =
      (u.type === "heading" || u.type === "para") && (firstLine === u.display || firstLine.length <= 80)
        ? firstLine.match(SECTION_HEAD_RE)
        : null;
    if (m) {
      const num = Number(m[1]);
      if (pack.length > 0 && num !== pack[pack.length - 1]!.num + 1) flush();
      pack.push({ num, units: [i], line: m[2]!.replace(/\*\*/g, "").trim(), tableRec: null });
    } else if (u.type === "heading") {
      flush();
    } else if (pack.length > 0) {
      pack[pack.length - 1]!.units.push(i);
    }
  }
  flush();
  return packs.sort((a, b) => a[0]!.units[0]! - b[0]!.units[0]!);
}

function sectionRecommendation(units: Unit[], s: Section): string | null {
  if (s.tableRec) return s.tableRec;
  const first = s.units[0]!;
  const lastUnit = s.units[s.units.length - 1]!;
  const opts = extractOptions(units, first, lastUnit);
  const rec = opts.options.find((o) => o.recommended);
  if (rec) return rec.key;
  // «Рекомендую Б» or inline alternatives «А — …, Б — … (рекомендую)».
  for (const i of s.units) {
    const m = units[i]!.probe.match(RECOMMEND_KEY_RE) ?? units[i]!.probe.match(INLINE_REC_RE);
    const key = m ? normalizeOptionKey(m[1]!) : null;
    if (key) return key;
  }
  return null;
}

/**
 * Several numbered questions at once — a numbered list, numbered table rows
 * or numbered sections («**1. Формат**» + options + «Рекомендую А»). The pack
 * must look like questions: «?», options per section, a label like
 * «Нужны ваши решения» or a reply example «1 — А, 2 — Б». Recommendations
 * give the reply template; the agent's own example is the fallback.
 */
function extractMulti(units: Unit[], from: number, to: number, fullText: string): MultiFound | null {
  let found: MultiFound | null = null;
  const example = fullText.match(REPLY_EXAMPLE_RE);
  for (const pack of findPacks(units, from, to)) {
    const head = pack[0]!.units[0]!;
    const end = pack[pack.length - 1]!.units[pack[pack.length - 1]!.units.length - 1]!;
    const labelUnit = units[head - 1];
    const label =
      labelUnit && labelUnit.display.length < 200 && PACK_LABEL_RE.test(labelUnit.probe) && units[head]!.block !== labelUnit.block
        ? labelUnit
        : null;
    const asked = pack.filter((s) => s.units.some((i) => /\?/u.test(units[i]!.probe))).length;
    const withOptions = pack.filter((s) => extractOptions(units, s.units[0]!, s.units[s.units.length - 1]!).options.length >= 2 || s.tableRec).length;
    if (!(asked >= 2 || withOptions >= 2 || (label && asked + withOptions >= 1) || (example && withOptions >= 1))) continue;

    const recs = pack.map((s) => sectionRecommendation(units, s));
    const replyTemplate = recs.some((r) => r !== null)
      ? pack.map((s, i) => `${s.num} — ${recs[i] ?? "?"}`).join(", ")
      : example
        ? normalizeTemplate(example[1]!)
        : null;
    const lines: string[] = label ? [label.display.replace(/\n+/g, " ")] : [];
    for (const s of pack) {
      const line = `${s.num}. ${s.line}`;
      if ([...lines, line].join("\n").length > ASK_MAX) break;
      lines.push(line);
    }
    const ask = lines.length > (label ? 1 : 0) ? lines.join("\n") : clip(`${pack[0]!.num}. ${pack[0]!.line}`, ASK_MAX);
    found = { ask, headUnit: label ? head - 1 : head, endUnit: end, replyTemplate };
  }
  return found;
}
