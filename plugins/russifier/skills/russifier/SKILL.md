---
name: russifier
description: "Русификатор_vibecom — русский интерфейс bb. Use when someone asks why bb shows Russian or English, wants to switch the interface language, sees an untranslated or wrong label, or after a bb update to refresh the dictionary (bb russifier missing, scripts/extract-strings.mjs, coverage.mjs, merge.mjs)."
---

# Русификатор_vibecom

Плагин переводит интерфейс bb на русский по словарю: подписи, меню, подсказки и сообщения. Тексты сообщений, код, поле ввода, названия чатов и файлов он не меняет. Термины зафиксированы в `GLOSSARY.md` плагина. Тред там называется «чат», ход — «ответ», sidebar — «боковая панель», approval — «подтверждение», permission — «доступ».

## Язык

- **Везде:** `bb plugin config russifier set language en` (или `ru`).
- **На одном устройстве:** в поиске команд bb (⌘⇧P) выполнить «Язык интерфейса: русский ↔ English». Агент эту команду не вызывает, её выполняет человек.
- **Состояние:** `bb russifier status [--json]`.

## Непереведённое

`bb russifier missing [--limit N] [--json]` выводит английские подписи, которые bb уже показывал, — самые частые сверху. Это главный источник пополнения словаря. После пополнения журнал очищается: `bb russifier missing --clear`. Журнал хранится только на этом сервере bb. Строки из него переводятся как интерфейс, если это интерфейс. Имена людей, чатов и проектов не переводятся.

## Обновление словаря (после новой версии bb)

Работать из папки плагина (в комплекте «bb как у Вадима» — `plugins/russifier/`):

1. `node scripts/extract-strings.mjs` — создаёт каталог `catalog/bb-<версия>.json`.
2. `node scripts/coverage.mjs --todo "$TMPDIR/todo.json"` — показывает новые строки против прошлой версии и выгружает непереведённые.
3. Перевести `todo.json` строго по `GLOSSARY.md`. Результат — `{"English": "Русский"}`.
   - Плейсхолдеры `{0}` сохранить.
   - Для чисел — ICU plural.
   - Служебное, код и названия — пустой строкой.
4. `node scripts/merge.mjs "$TMPDIR/todo.ru.json"` — раскладывает перевод по `dict/core.json`, `builtin.json`, `extra.json`.
5. Добавить подписи из `bb russifier missing` в `dict/extra.json`, если их нет в каталоге.
6. `node scripts/check-dict.mjs && npm test && npx tsc --noEmit` — должно пройти без ошибок. Предупреждения глоссария исправить.
7. `bb plugin build . && bb plugin reload russifier`, затем глазами проверить два-три экрана.
8. Закоммитить файлы плагина по именам, если папка — git-репозиторий. Обновление комплекта затрёт ваши правки словаря: держите их в `dict/extra.json` и переносите заново.

## Если что-то сломалось

- **Подпись переведена неверно:** поправить значение в `dict/*.json` (или добавить в `extra.json` — он главнее остальных), затем шаги 6–7.
- **Переведено то, что трогать нельзя** (данные пользователя): добавить селектор в `PROTECTED_SELECTOR` в `lib/protect.ts` и тест в `tests/dom.test.ts`.
- **Всё плохо:** `bb plugin disable russifier` — bb сразу станет английским.
