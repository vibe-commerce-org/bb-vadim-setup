# Плагины BB

Last Updated: 2026-10-21

Каждый подкаталог — отдельный плагин. Установка описана в GUIDE.md, раздел 12:
из Git — `bb plugin install "git:<адрес репозитория>@semver:~0.4.0"
--subdirectory plugins/<папка>`; из папки — `npm ci` (у files-editor и
floating-terminal — `npm ci --ignore-scripts`) → `bb plugin build .` →
`bb plugin install <путь папки>`.

| Папка и id | Имя в BB | Версия | Что делает |
|---|---|---|---|
| markdown-view/ | Markdown_vibecom | 0.4.1 | просмотр Markdown в виде Typora и правка в Vditor |
| office-preview/ | Office_vibecom | 0.4.1 | просмотр таблиц, Word и PowerPoint |
| folder-links/ | Folder links_vibecom | 0.4.1 | ссылки на папки открывают дерево справа; домашняя папка, профиль Windows в WSL2, папки проектов bb |
| files-editor/ | Explorer_vibecom | 0.1.6 | проводник и редактор рабочей копии, документы внутри панели; переделка плагина abdoutelb |
| floating-terminal/ | Terminal_vibecom | 0.6.2 | терминал вкладкой правой панели и плавающим окном; переделка плагина vburojevic |
| russifier/ | Русификатор_vibecom | 0.2.0 | интерфейс bb на русском; effort, режимы доступа и названия — по-английски |
| repo-tag/ | Repo tags_vibecom | 0.1.0 | тег репозитория у каждого треда в боковой панели |
| pult/ | Пульт_vibecom | 0.2.0 | какие треды ждут вас, приоритеты задач Сейчас / Дальше / Потом, карта проектов |
| artifacts/ | Важные артефакты_vibecom | 0.1.0, бета | бриф, план и важные файлы треда во вкладке справа |

Суффикс `_vibecom` есть только в видимом имени плагина: id, папки и имена
пакетов прежние, поэтому команды `bb plugin update/reload/remove` используют
id из первой колонки. Три просмотрщика нумеруются версией комплекта, у
Русификатора, тега репозитория, Пульта и Артефактов — свои версии. У двух
переделок версии продолжают версии их авторов; откуда они взяты и что изменено —
в их README, лицензии — в LICENSE и THIRD_PARTY_NOTICES.md.

Explorer_vibecom показывает документы кодом Markdown_vibecom и Office_vibecom:
их папки `src/` — пакеты `@vibecommerce/markdown-view` и `@vibecommerce/office-preview`,
упакованные в `files-editor/vendor/`. Для `.md` нужен установленный Markdown_vibecom.

Исходники взяты из работающих локальных плагинов автора; README заменены
универсальными, в коде обезличены комментарии и тестовые данные. В package.json
своих плагинов добавлено поле license, версия трёх просмотрщиков поднята до версии
комплекта (в package.json и корне package-lock.json). У Пульта в комплекте маркер
конца хода принимает любое слово после «Ход за» («Ход за тобой»), у тега
репозитория добавлен package-lock.json. node_modules, dist, служебные документы,
образцы и снимки экрана исключены.
