// The Gemini budget's spend counter — pure logic over Pi session files.
//
// Pi (the bb provider `pi`) appends one JSON line per event to
// `<session>.jsonl`. An answer of the model is
//   {"type":"message","timestamp":"…","message":{"role":"assistant","provider":"google-vertex",
//    "model":"gemini-4-neon","timestamp":1795242669923,"usage":{…,"cost":{…,"total":0.13}}}}
// where `cost.total` is in US dollars by Pi's model catalog (checked on Pi 1.6.0, 21.11.2026).
// So the counter is an estimate by list price, not Google's bill (the card says so).
//
// Files are read by increment (server/budget.ts keeps an offset per file); this
// module only parses lines and adds them up.

export interface CostEntry {
  /** ms of the answer. */
  at: number;
  provider: string;
  model: string;
  /** US dollars. */
  cost: number;
  /** A context compaction billed to the session's model: money counts, but it is not an answer. */
  compaction?: boolean;
}

/**
 * What one line was: an answer with a cost; a suspect line — an answer without a cost, or a line with
 * `usage.cost` that is not a recognisable answer (Pi renamed `type`/`role`?) — or anything else.
 * A suspect line keeps what it can tell: when and whose, so a later answer with a cost can clear it.
 */
export type ParsedLine =
  | { kind: "cost"; entry: CostEntry }
  /** The session switched model (`model_change`): what later compactions are billed to. */
  | { kind: "model"; provider: string; model: string }
  /** Pi's context compaction: its own model call, priced at the top level, no provider — the session's current one. */
  | { kind: "compaction"; at: number; cost: number }
  | { kind: "suspect"; at: number | null; provider: string | null; why: string }
  | { kind: "other" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLine(line: string): ParsedLine {
  const text = line.trim();
  const looksPriced = text.includes('"usage"') && text.includes('"cost"');
  const looksModel = text.includes('"model_change"');
  if (text === "" || (!text.includes('"assistant"') && !looksPriced && !looksModel)) return { kind: "other" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "other" };
  }
  if (!isRecord(json)) return { kind: "other" };
  const topAt = Date.parse(String(json.timestamp));
  if (json.type === "model_change") {
    return typeof json.provider === "string" && typeof json.modelId === "string" ? { kind: "model", provider: json.provider, model: json.modelId } : { kind: "other" };
  }
  if (json.type === "compaction" && isRecord(json.usage) && isRecord(json.usage.cost)) {
    const total = json.usage.cost.total;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0 && Number.isFinite(topAt)) return { kind: "compaction", at: topAt, cost: total };
    return { kind: "suspect", at: Number.isFinite(topAt) ? topAt : null, provider: null, why: "запись сжатия без usage.cost.total или времени" };
  }
  const isAnswer = json.type === "message" && isRecord(json.message) && json.message.role === "assistant";
  if (!isAnswer) {
    // By structure, not by text: a user message that quotes JSON with "usage"/"cost" has no usage object of its own.
    const holder = isRecord(json) && isRecord(json.message) ? json.message : isRecord(json) ? json : null;
    const priced = holder !== null && isRecord(holder.usage) && isRecord(holder.usage.cost) && holder.role !== "user";
    return priced
      ? { kind: "suspect", at: Number.isFinite(topAt) ? topAt : null, provider: null, why: "строка с usage.cost не похожа на ответ модели (type/role)" }
      : { kind: "other" };
  }
  const m = (json as { message: Record<string, unknown> }).message;
  const provider = typeof m.provider === "string" ? m.provider : null;
  const atRaw = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : Date.parse(String((json as Record<string, unknown>).timestamp));
  const at = Number.isFinite(atRaw) ? atRaw : null;
  const usage = isRecord(m.usage) ? m.usage : null;
  const cost = usage !== null && isRecord(usage.cost) ? usage.cost.total : undefined;
  if (provider === null || typeof m.model !== "string" || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || at === null) {
    return { kind: "suspect", at, provider, why: "ответ модели без usage.cost.total (или без provider/model/времени)" };
  }
  return { kind: "cost", entry: { at, provider, model: m.model, cost } };
}

export interface Totals {
  /** Since `from` (the week start). */
  spent: number;
  /** Since `dayFrom` (today's start). */
  today: number;
  /** Week spend per model id, largest first when listed. */
  byModel: Record<string, number>;
  /** Answers counted this week. */
  answers: number;
}

export function totalsFor(entries: Iterable<CostEntry>, opts: { from: number; dayFrom: number; providers: readonly string[] }): Totals {
  const totals: Totals = { spent: 0, today: 0, byModel: {}, answers: 0 };
  for (const e of entries) {
    if (e.at < opts.from || !opts.providers.includes(e.provider)) continue;
    totals.spent += e.cost;
    if (e.compaction !== true) totals.answers += 1;
    if (e.at >= opts.dayFrom) totals.today += e.cost;
    totals.byModel[e.model] = (totals.byModel[e.model] ?? 0) + e.cost;
  }
  return totals;
}
