# BB как у Вадима — комплект настройки

Last Updated: 2026-10-21
Версия: 0.4.0 · Лицензия: [MIT](LICENSE) для собственных материалов ·
Сторонние части: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Инструкция и комплект, чтобы установить [bb](https://github.com/get-bb/bb) и настроить
его так же, как у меня: подключение моделей (в том числе российских), русский интерфейс,
тема, просмотр и правка Markdown, офисные файлы рядом с чатом, проводник проекта, терминал
в панели треда, ссылки на папки, теги репозиториев у тредов, Пульт «чей ход», важные
артефакты треда (бета), шаблон правил для агентов. Подходит для кода, документов,
исследований и работы селлера. Доступ к другим репозиториям не нужен.

Это единственный источник комплекта: из него собираются архив `08-BB-VADIM-KIT.zip`,
инструкция `08-BB-VADIM-SETUP.md` и файл для агента `08-BB-AGENT-SETUP.md`.

**Проверено на macOS, bb 0.46.1:** сборка девяти плагинов с нуля и их тесты, установка
так, как это делает bb при установке из Git, тот же код плагинов работает у автора.
Установка из публичного Git проверяется после публикации; Windows проверял автор
на bb 0.45.0, Linux-сервер — только по документации. Подробно — [VALIDATION.md](VALIDATION.md).

## Что внутри

| Путь | Что это |
|---|---|
| [GUIDE.md](GUIDE.md) | Полная инструкция: установка bb, модели, настройка, телефон, проверка |
| [PHONE.md](PHONE.md) | Как пользоваться bb с телефона: подключение, голос, документы, терминал |
| [AGENT-TASK.md](AGENT-TASK.md) | Готовое задание кодинговому агенту: настроить bb по комплекту |
| [theme/](theme/README.md) | Тема `atom-one_vibecom` (One Dark / One Light) |
| [plugins/](plugins/README.md) | Исходники плагинов Markdown_vibecom, Office_vibecom, Folder links_vibecom, Explorer_vibecom, Terminal_vibecom, Русификатор_vibecom, Repo tags_vibecom, Пульт_vibecom, Важные артефакты_vibecom (бета) |
| [models/pi/](models/pi/README.md) | Шаблоны агента Pi для моделей Яндекса, Cloud.ru и LM Studio, без ключей |
| [instructions/](instructions/README.md) | Универсальный шаблон `AGENTS.md` для агентов в bb |
| [examples/](examples/README.md) | Искусственный `demo.md` для проверки |
| [VALIDATION.md](VALIDATION.md) | Что проверено и что нет |
| [catalog.json](catalog.json) | Каталог пунктов комплекта и промптов установки для страницы выбора на сайте |
| [MANIFEST.json](MANIFEST.json) | Состав комплекта: размеры и SHA-256 файлов |
| [CHANGELOG.md](CHANGELOG.md) | История выпусков |
| [scripts/](scripts/README.md) | Сборка и проверка выпуска; в архив не входят |

## Быстрый старт

**bb ещё нет, а скрипт установки не сработал** — [GUIDE.md, «Поставить bb вручную, без скриптов»](GUIDE.md#поставить-bb-вручную-без-скриптов):
прямые ссылки на установщики, SHA-256 и что делать дальше на Windows и Mac.

**Путь 1 — архив.** Скачайте `08-BB-VADIM-KIT.zip` и `08-BB-VADIM-SETUP.md`, распакуйте
архив в `~/Developer` (появится папка `bb-vadim-kit`) и идите по инструкции. Плагины
ставятся из этой папки командами из [GUIDE.md, раздел 12](GUIDE.md#12-мои-плагины-из-комплекта).
Часть 3 инструкции может сделать агент: дайте ему `AGENT-TASK.md` из папки комплекта.

**Путь 2 — Git** (когда репозиторий опубликован). Плагины bb ставит прямо из репозитория
и потом обновляет командой; ставьте только нужные:

```sh
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/markdown-view
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/office-preview
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/folder-links
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/files-editor
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/floating-terminal
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/russifier
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/repo-tag
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/pult
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/artifacts
bb plugin list
```

Тему, правила и шаблоны моделей берите из клона:
`git clone https://github.com/vibe-commerce-org/bb-vadim-setup.git ~/Developer/bb-vadim-setup`.

Explorer_vibecom показывает `.md` через Markdown_vibecom — ставьте их вместе.
Если у вас уже стоят Files editor (abdoutelb) или Floating Terminal (vburojevic),
сначала удалите их: id совпадают (`bb plugin remove files-editor`,
`bb plugin remove floating-terminal`). Folder links_vibecom на Windows проверен только тестами.

## Обновление и откат

| Что | Обновить | Откатить |
|---|---|---|
| Плагин из Git с диапазоном `~0.4.0` | `bb plugin outdated`, затем `bb plugin update ИМЯ` | `bb plugin remove ИМЯ` и установка нужного тега, например `@v0.3.6` |
| Плагин из Git с тегом `@v0.4.0` | закреплён: `remove` и установка нового тега | то же |
| Плагин из папки комплекта | новые файлы в ту же папку, `npm ci`, `bb plugin build .`, `bb plugin reload ИМЯ` | предыдущая версия папки и те же команды |
| Тема | скопировать новую папку `atom-one_vibecom` | резервная копия темы или `bb theme reset` |
| Правила | сравнить новый шаблон со своим `AGENTS.md` и перенести нужное | ваш файл остаётся вашим |

Выпуски 0.4.x будут совместимы между собой; опубликованные теги не передвигаются.
Диапазоны `~0.2.0` и `~0.3.0` выпуски 0.4.x не принимают: переустановите плагин
(`bb plugin remove ИМЯ`, затем установка с `@semver:~0.4.0`). Тема с 0.2.0 называется
`atom-one_vibecom`. ИМЯ — id из `bb plugin list`: `markdown-view`, `office-preview`,
`folder-links`, `files-editor`, `floating-terminal`, `russifier`, `repo-tag`, `pult`, `artifacts`.
`bb plugin remove` удаляет настройки, секреты, расписания и базу плагина (настройки есть у Explorer_vibecom,
Terminal_vibecom, Русификатора и тега репозитория; база — у Пульта и Артефактов);
папка комплекта остаётся на диске.

## Ограничения

- Folder links_vibecom опирается на внутренние селекторы чата bb; пути Windows и WSL2 проверены тестами,
  на живой Windows не испытаны. Сетевые пути `\\сервер\папка` не поддерживаются.
- Русификатор, тег репозитория, Пульт и Артефакты требуют bb 0.46+, на Windows не испытаны. Русификатор и
  тег опираются на разметку bb: после обновления bb новые подписи остаются английскими, теги могут пропасть.
- Важные артефакты_vibecom — бета: панель не открывается сама при входе в тред, список наполняет агент
  командой `bb artifacts`; подробно — [его README](plugins/artifacts/README.md).
- Office_vibecom показывает файлы только для чтения; DOC/RTF/ODT конвертирует
  через `textutil` macOS. Его тесты проверяют чтение файлов, но не вёрстку.
- Корзина, домашняя папка, загрузка файлов и «Open in Mac app» в Explorer_vibecom
  работают, когда рабочая копия на том же Mac, что и сервер bb.
- CSS-поправка темы и Folder links_vibecom опираются на внутреннюю разметку bb:
  после обновления bb пройдите [GUIDE.md, раздел 19](GUIDE.md#19-проверка-после-настройки).
- Плагины bb — код с полным доверием. Перед установкой прочитайте источник.

## Участие

Предлагайте исправления через issue или pull request из своего fork.
Личные пути, токены и данные своих проектов в изменения не включайте.
