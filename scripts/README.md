# Сборка и проверка выпуска

Last Updated: 2026-10-30

Служебные скрипты репозитория. В комплект (`08-BB-VADIM-KIT.zip`) и в `MANIFEST.json` не входят.
Нужны Python 3.9+, Node.js 22.19+, npm, git и bb.

| Скрипт | Что делает |
|---|---|
| `sync-plugins.py --from ПАПКА [--apply]` | переносит закоммиченный код плагинов из рабочего репозитория автора в `plugins/`; правки комплекта (обезличенные комментарии) сохраняет и предупреждает, если их нужно внести заново |
| `test-plugins.sh` | копия плагинов, `npm ci` с пустым кэшем, `bb plugin build .`, `npm test` для всех плагинов из `plugins/`; `SDK_VERSION=0.6.94 scripts/test-plugins.sh` — то же против другой версии `@get-bb/plugin-sdk` (только в копии) и с проверкой типов: так выпуск сверяют с SDK новой версии bb |
| `check-git-install.sh [ТЕГ]` | установка как у bb из Git: клон по тегу, зависимости без инструментов разработки npm-ом из bb, `bb plugin build` |
| `build-kit.py [--date ГГГГ-ММ-ДД]` | обновляет `MANIFEST.json`, собирает в `release/` ZIP, копию инструкции, файл для агента и `SHA256SUMS.txt` |
| `render-pdf.py [ФАЙЛ.md]` | PDF инструкций в `release/`: `GUIDE.md` → `08-BB-VADIM-SETUP.pdf`, `PHONE.md` → `08-BB-PHONE.pdf`; pandoc и Chromium (Playwright); вне песочницы macOS |
| `check-kit.py [--private-patterns ФАЙЛ]` | проверяет выпуск: манифест, ZIP, файл для агента, извлечение, поиск личного |
| `extract-kit.mjs` | извлекает ZIP из файла для агента; тот же текст встраивается в `08-BB-AGENT-SETUP.md` |

## Порядок выпуска

1. `python3 scripts/sync-plugins.py --from <папка плагинов>` — посмотреть изменения, затем с `--apply`.
   Внести заново правки комплекта, если скрипт попросил; поиск личного по перенесённому.
2. `VERSION`, `CHANGELOG.md`, версии в `GUIDE.md`, `AGENT-TASK.md`, `README.md`, `plugins/README.md`;
   метаданные плагинов в `MANIFEST.json`.
3. `scripts/test-plugins.sh` и `scripts/check-git-install.sh`.
4. `python3 scripts/render-pdf.py`, `python3 scripts/build-kit.py --date <дата выпуска>`, затем
   `python3 scripts/check-kit.py --private-patterns <файл вне репозитория>`.
5. `VALIDATION.md` — итоги проверок. Коммит, тег `vX.Y.Z`, публикация.

ZIP детерминирован: те же файлы и дата дают тот же SHA-256, поэтому прошлый выпуск
воспроизводится из его тега.
