import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../lib/engine.ts";
import { translateCount } from "../lib/nouns.ts";

const engine = new Engine({
  "New thread": "Новый чат",
  Archive: "В архив",
  "Toggle sidebar": "Показать или скрыть боковую панель",
  "Search threads": "Поиск чатов",
  Settings: "Настройки",
  "Explored {0}": "Изучено: {0}",
  "Ran {0}": "Выполнено: {0}",
  "Edited {0}": "Изменено: {0}",
  "Open {0}": "Открыть {0}",
  "Running {0} background command{1}":
    "{0, plural, one {Работает # фоновая команда} few {Работают # фоновые команды} many {Работают # фоновых команд} other {Работают # фоновой команды}}",
  "Couldn’t load projects.": "Не удалось загрузить проекты.",
  "Loading…": "Загрузка…",
  Thought: "Размышления",
  Created: "Создано",
  "{0} {1}": "должно игнорироваться",
  "Skipped": "",
});

test("exact match keeps the surrounding spaces", () => {
  assert.equal(engine.translate("New thread"), "Новый чат");
  assert.equal(engine.translate("  New thread "), "  Новый чат ");
});

test("letter case, apostrophes and ellipsis are normalised", () => {
  assert.equal(engine.translate("Toggle Sidebar"), "Показать или скрыть боковую панель");
  assert.equal(engine.translate("Couldn't load projects."), "Не удалось загрузить проекты.");
  assert.equal(engine.translate("Loading..."), "Загрузка…");
});

test("templates with the Russian plural", () => {
  assert.equal(engine.translate("Running 1 background command"), "Работает 1 фоновая команда");
  assert.equal(engine.translate("Running 3 background commands"), "Работают 3 фоновые команды");
  assert.equal(engine.translate("Running 5 background commands"), "Работают 5 фоновых команд");
  assert.equal(engine.translate("Running 21 background commands"), "Работает 21 фоновая команда");
  assert.equal(engine.translate("Running 11 background commands"), "Работают 11 фоновых команд");
});

test("counted nouns bb pluralises itself", () => {
  assert.equal(translateCount("1 file"), "1 файл");
  assert.equal(translateCount("2 threads"), "2 чата");
  assert.equal(translateCount("5 threads"), "5 чатов");
  assert.equal(translateCount("21 threads"), "21 чат");
  assert.equal(translateCount("193 files"), "193 файла");
  assert.equal(translateCount("1.5 files"), "1,5 файла");
  assert.equal(translateCount("1,234 files"), "1 234 файла");
  assert.equal(translateCount("4 unicorns"), null);
});

test("activity summaries glued from pieces", () => {
  assert.equal(
    engine.translate("Explored 4 lists, 1 file, 1 search, ran 6 commands, edited 2 files"),
    "Изучено: 4 списка, 1 файл, 1 поиск, выполнено: 6 команд, изменено: 2 файла",
  );
  assert.equal(engine.translate("Edited 3 files, ran 1 command"), "Изменено: 3 файла, выполнено: 1 команда");
  assert.equal(engine.translate("4 files, 2 lists, 4 searches"), "4 файла, 2 списка, 4 поиска");
  assert.equal(engine.translate("Ran browser_evaluate"), "Выполнено: browser_evaluate");
});

test("shortcut hints stay as they are", () => {
  assert.equal(engine.translate("Search threads (⌘ K)"), "Поиск чатов (⌘ K)");
  assert.equal(engine.translate("Settings (⌘ ,)"), "Настройки (⌘ ,)");
});

test("a known verb before a count, and bare durations", () => {
  assert.equal(engine.translate("Ran 7 subagents, created 17 files, explored 4 lists"), "Выполнено: 7 субагентов, создано: 17 файлов, изучено: 4 списка");
  assert.equal(engine.translate("created 17 files"), "создано: 17 файлов");
  assert.equal(engine.translate("Ran 7 subagents, created 17 files, ran 10 commands"), "Выполнено: 7 субагентов, создано: 17 файлов, выполнено: 10 команд");
  assert.equal(engine.translate("3s"), "3 с");
  assert.equal(engine.translate("2m 38s"), "2 мин 38 с");
  assert.equal(engine.translate("1h 5m"), "1 ч 5 мин");
});

test("durations in brackets", () => {
  assert.equal(engine.translate("Thought (13s)"), "Размышления (13 с)");
  assert.equal(engine.translate("Thought (2m 38s)"), "Размышления (2 мин 38 с)");
  assert.equal(engine.translate("Ran browser_evaluate playwright (4s)"), "Выполнено: browser_evaluate playwright (4 с)");
  assert.equal(engine.translate("Unknown thing (4s)"), null);
});

test("names inside a template are kept", () => {
  assert.equal(engine.translate("Open Русификатор: план"), "Открыть Русификатор: план");
  assert.equal(engine.translate("Open Settings"), "Открыть Settings");
});

test("unknown text, Russian text and empty translations give null", () => {
  assert.equal(engine.translate("Something bb has never said"), null);
  assert.equal(engine.translate("Уже по-русски"), null);
  assert.equal(engine.translate("Skipped"), null);
  assert.equal(engine.translate("anything goes"), null); // «{0} {1}» is too loose to load
});
