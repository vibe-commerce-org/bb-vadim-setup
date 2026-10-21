// The «⏸ Ход за Вадимом» marker and the shared text helpers. Synthetic text
// only. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, cut, normalizeOptionKey, parseDue, parseMarker, parseOptionLine, tail } from "../lib/marker.ts";

const NOW = Date.parse("2026-10-10T12:50:00+03:00");

test("marker: decision with deadline and options", () => {
  const m = parseMarker(
    "Отчёт готов.\n\n⏸ Ход за Вадимом · решение · до 2026-10-13: какой тариф берём?\nВарианты: А — базовый; Б — расширенный (рекомендую)",
    NOW,
  );
  assert.deepEqual(m, {
    kind: "decision",
    ask: "какой тариф берём?",
    due: "2026-10-13",
    options: [
      { key: "А", label: "базовый", recommended: false },
      { key: "Б", label: "расширенный (рекомендую)", recommended: true },
    ],
  });
});

test("marker: action and review kinds, no date, bold wrapper", () => {
  assert.deepEqual(parseMarker("**⏸ Ход за Вадимом · действие: введи ПИН в приложении банка**", NOW), {
    kind: "action",
    ask: "введи ПИН в приложении банка",
    due: null,
    options: [],
  });
  assert.equal(parseMarker("⏸ Ход за Вадимом · проверка: открой страницу на телефоне", NOW)?.kind, "review");
});

test("marker: a year-less date takes the year from now", () => {
  assert.equal(parseMarker("⏸ Ход за Вадимом · действие · до 13.10: оплатить счёт", NOW)?.due, "2026-10-13");
});

test("marker: the last one wins, code blocks are ignored", () => {
  const text = [
    "⏸ Ход за Вадимом · решение: старый вопрос?",
    "",
    "```",
    "⏸ Ход за Вадимом · действие: пример в коде",
    "```",
    "⏸ Ход за Вадимом · проверка: послушай запись",
  ].join("\n");
  assert.equal(parseMarker(text, NOW)?.ask, "послушай запись");
  assert.equal(parseMarker("```\n⏸ Ход за Вадимом · действие: только в коде\n```", NOW), null);
});

test("marker: options on separate lines, Latin keys normalized", () => {
  const m = parseMarker("⏸ Ход за Вадимом · решение: куда выкладываем?\nВарианты:\nA — в общий репозиторий\nB — в личный", NOW);
  assert.deepEqual(
    m?.options.map((o) => o.key),
    ["А", "Б"],
  );
});

test("marker: absent or malformed → null", () => {
  assert.equal(parseMarker("Готово, всё проверил.", NOW), null);
  assert.equal(parseMarker("Ход за Вадимом сегодня не нужен.", NOW), null);
});

test("normalizeOptionKey: Cyrillic kept, Latin mapped by position", () => {
  assert.equal(normalizeOptionKey("Б"), "Б");
  assert.equal(normalizeOptionKey("б"), "Б");
  assert.equal(normalizeOptionKey("A"), "А");
  assert.equal(normalizeOptionKey("C"), "В");
  assert.equal(normalizeOptionKey("E"), "Д");
  assert.equal(normalizeOptionKey("Z"), null);
  assert.equal(normalizeOptionKey("АБ"), null);
});

test("parseOptionLine: common shapes", () => {
  assert.deepEqual(parseOptionLine("**А.** раскатить всем"), { key: "А", label: "раскатить всем", recommended: false });
  assert.equal(parseOptionLine("- Б) оставить как есть")?.key, "Б");
  assert.equal(parseOptionLine("Вариант В: третий путь")?.key, "В");
  assert.equal(parseOptionLine("C — latin key (recommended)")?.recommended, true);
  assert.equal(parseOptionLine("В понедельник всё готово."), null);
  assert.equal(parseOptionLine("а — строчная буква не вариант"), null);
});

test("parseDue: forms of a deadline", () => {
  assert.equal(parseDue("сделать до 13.10", NOW), "2026-10-13");
  assert.equal(parseDue("нужно к 12.10, иначе поздно", NOW), "2026-10-12");
  assert.equal(parseDue("до 2026-10-13", NOW), "2026-10-13");
  assert.equal(parseDue("дедлайн 15.10", NOW), "2026-10-15");
  assert.equal(parseDue("оплатить до 20 октября", NOW), "2026-10-20");
  assert.equal(parseDue("до 1.11.2027", NOW), "2027-11-01");
  // Earliest of several.
  assert.equal(parseDue("до 20.10, а черновик к 14.10", NOW), "2026-10-14");
});

test("parseDue: no deadline, versions and invalid dates", () => {
  assert.equal(parseDue("обновил до 0.46.0", NOW), null);
  assert.equal(parseDue("встреча 13.10 прошла", NOW), null);
  assert.equal(parseDue("до 31.02", NOW), null);
});

test("parseDue: a date half a year back rolls to next year", () => {
  const december = Date.parse("2026-12-28T10:00:00+03:00");
  assert.equal(parseDue("до 05.01", december), "2027-01-05");
});

/** No lone surrogate anywhere (String.prototype.isWellFormed is ES2024). */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

test("cuts never leave half of a surrogate pair", () => {
  const text = "🛠".repeat(10); // 20 UTF-16 units
  for (let max = 2; max <= 21; max++) {
    for (const out of [tail(text, max), cut(text, max), clip(text, max)]) {
      assert.ok(wellFormed(out), `${max}: ${JSON.stringify(out)}`);
      assert.ok(out.length <= max, `${max}: ${out.length}`);
    }
  }
  assert.equal(tail("абвгд", 3), "…гд");
  assert.equal(cut("абвгд", 3), "аб…");
  assert.equal(tail("абв", 3), "абв");
});

test("the marker names the user any way: «за тобой», «за вами», a name", () => {
  for (const who of ["тобой", "вами", "Вадимом", "Анной"]) {
    assert.equal(parseMarker(`⏸ Ход за ${who} · решение: какой тариф берём?`, NOW)?.kind, "decision", who);
  }
  assert.equal(parseMarker("Ход за тобой и за мной · решение: что-то", NOW), null);
});
