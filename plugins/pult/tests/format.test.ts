// Shared wording of the page, the row marks and `bb pult` (lib/format.ts).
// Runs under plain `node --test`: the CLI imports the same module under Node.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIND_SHORT,
  KIND_TITLES,
  LANE_TITLES,
  MARK_LABELS,
  formatAge,
  formatShortDate,
  snoozePresets,
  sourceLabel,
  tomorrowMorning,
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
