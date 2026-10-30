// Shared wording of the page, the row marks and `bb pult` (lib/format.ts).
// Runs under plain `node --test`: the CLI imports the same module under Node.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIND_SHORT,
  KIND_TITLES,
  LANE_TITLES,
  MARK_LABELS,
  effortLabel,
  formatAge,
  formatShortDate,
  modelLine,
  modelTag,
  shortModelId,
  snoozePresets,
  sourceLabel,
  tomorrowMorning,
  withoutVendor,
} from "../lib/format.ts";
import { WAITING_KINDS } from "../lib/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("formatAge floors every unit (one rule for the page and the CLI)", () => {
  assert.equal(formatAge(30_000), "только что");
  assert.equal(formatAge(5 * MINUTE + 59_000), "5 мин");
  assert.equal(formatAge(1.5 * HOUR), "1 ч");
  assert.equal(formatAge(23.9 * HOUR), "23 ч");
  assert.equal(formatAge(13.6 * DAY), "13 дн.", "not «2 нед» before the 14-day «застряло» line");
  assert.equal(formatAge(14 * DAY), "2 нед.");
  assert.equal(formatAge(59 * DAY), "8 нед.");
  assert.equal(formatAge(90 * DAY), "3 мес.");
  assert.equal(formatAge(-5), "только что");
});

test("labels cover every kind and lane", () => {
  for (const kind of WAITING_KINDS) {
    assert.ok(KIND_TITLES[kind].length > 0);
    assert.ok(KIND_SHORT[kind].length > 0);
    assert.ok(MARK_LABELS[kind].startsWith("Ход за тобой: "), kind);
  }
  assert.equal(MARK_LABELS.action, "Ход за тобой: сделать руками", "same words as the card");
  assert.equal(MARK_LABELS.failed, "Ход за тобой: упало или прервано");
  assert.deepEqual(LANE_TITLES, { now: "Сейчас", next: "Дальше", later: "Потом" });
});

test("tomorrowMorning is 9:00 of the next calendar day; the preset uses it", () => {
  const evening = new Date(2026, 9, 12, 23, 30).getTime();
  const morning = new Date(tomorrowMorning(evening));
  assert.deepEqual([morning.getDate(), morning.getHours(), morning.getMinutes()], [13, 9, 0]);
  const early = new Date(2026, 9, 12, 0, 10).getTime();
  assert.equal(new Date(tomorrowMorning(early)).getDate(), 13);
  const presets = snoozePresets(evening);
  assert.deepEqual(
    presets.map((preset) => preset.id),
    ["2h", "tomorrow", "3d", "week"],
  );
  assert.equal(presets.find((preset) => preset.id === "tomorrow")?.until, tomorrowMorning(evening));
  assert.equal(presets[0]?.until, evening + 2 * HOUR);
});

test("sourceLabel takes the inventory date from scan.seedAsOf", () => {
  const asOf = new Date(2026, 9, 20, 12, 0).getTime();
  assert.equal(formatShortDate(asOf), "20.10");
  assert.equal(sourceLabel("inventory", 1, asOf), "из разбора 20.10");
  assert.equal(sourceLabel("inventory", 1, null), "из инвентаризации");
  assert.equal(sourceLabel("inventory", 1), "из инвентаризации");
  assert.equal(sourceLabel("rules", 0.704), "по тексту, уверенность 70%");
  assert.equal(sourceLabel("llm", 1.4), "LLM, уверенность 100%");
  assert.equal(sourceLabel("native", 1), "сигнал BB");
});

test("effortLabel words a reasoning level the way BB's own chip does", () => {
  assert.equal(effortLabel("xhigh"), "Extra High");
  assert.equal(effortLabel("xhigh", true), "XHi", "three characters at most (the user, 30.10)");
  assert.equal(effortLabel("medium", true), "Med");
  assert.equal(effortLabel("none"), "None");
  // A level we do not know is better shown than swallowed.
  assert.equal(effortLabel("turbo"), "turbo");
  assert.equal(effortLabel(null), null);
});

test("modelLine joins the model and the effort, whichever of the two is known", () => {
  assert.equal(modelLine("Gemini 4 Argon", "xhigh"), "Gemini 4 Argon · XHi");
  assert.equal(modelLine("Gemini 4 Argon", "xhigh", false), "Gemini 4 Argon · Extra High");
  assert.equal(modelLine("Gemini 4 Argon", null), "Gemini 4 Argon");
  assert.equal(modelLine(null, "medium"), "Med", "the effort alone is still worth a line");
  assert.equal(modelLine(null, null), null, "a thread that has not run a turn shows nothing");
});

test("modelTag shortens a model's name to its meaningful three letters", () => {
  assert.equal(modelTag("Sonnet 5.5"), "Son", "the name, not the family");
  assert.equal(modelTag("Gemini 4 Argon"), "Arg", "the word that names it, not «Gem»");
  assert.equal(modelTag("Opus 5.5"), "Opu");
  assert.equal(modelTag("DeepSeek V4.1 Flash"), "Dee", "the model's own name, not its suffix");
  assert.equal(modelTag("DeepSeek 5.5"), "Dee", "the name alone is enough");
  assert.equal(modelTag("5.5 Sonnet"), "Son", "digits are skipped");
  assert.equal(modelTag("Qi"), "Qi");
  assert.equal(modelTag("gemini 4 argon"), "Arg", "the first letter is capital");
  assert.equal(modelTag("4.1"), null);
  assert.equal(modelTag(""), null);
  assert.equal(modelTag(null), null);
});

test("modelTag names a GPT model by its code name, not by the vendor's initials", () => {
  assert.equal(modelTag("GPT-6.1-Sol"), "Sol");
  assert.equal(modelTag("GPT-6-Sol"), "Sol");
  assert.equal(modelTag("GPT-6.1-Terra"), "Ter");
  assert.equal(modelTag("GPT-6.1 Terra"), "Ter", "the spaced spelling of BB's catalog");
  assert.equal(modelTag("GPT-6-Luna"), "Lun");
  assert.equal(modelTag("GPT-6-Astra"), "Ast");
  assert.equal(modelTag("gpt-6.1-sol"), "Sol", "an id instead of a name");
  assert.equal(modelTag("GPT-6"), null, "a version alone leaves no name to show");
});

test("withoutVendor drops the vendor BB appends to a model name", () => {
  assert.equal(withoutVendor("DeepSeek V4.1 Flash · Yandex"), "DeepSeek V4.1 Flash");
  assert.equal(withoutVendor("Gemini 4 Argon"), "Gemini 4 Argon");
  assert.equal(withoutVendor(" · leading"), " · leading", "nothing left after the cut — keep the name");
  assert.equal(withoutVendor(null), null);
});

test("shortModelId names a model BB's catalog does not know", () => {
  assert.equal(shortModelId("neuraldeep/qwen3.6-35b-a3b"), "qwen3.6 35b a3b");
  assert.equal(shortModelId("yandex/gpt://b1go/deepseek-v4.1-flash/latest"), "deepseek v4.1 flash");
  assert.equal(shortModelId("gemini-4-argon"), "gemini 4 argon");
  assert.equal(shortModelId(""), null);
  assert.equal(shortModelId(null), null);
});
