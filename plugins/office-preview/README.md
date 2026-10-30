# Office_vibecom 0.4.0

Last Updated: 2026-10-11

Папка и id плагина — `office-preview`; в интерфейсе BB он называется Office_vibecom.
Просмотр Excel/CSV/ODS, DOCX и PPTX с заметками докладчика. BB >= 0.43, SDK >= 0.5.9.
Редактирование офисных файлов не реализовано. Формулы не пересчитываются;
HTML-вёрстка может отличаться от Office. Размер читаемого файла ограничен 25 МБ.
Файлы читаются через `sdk.files`: из рабочей копии, с хоста и из хранилища треда.

Установка из Git:

```sh
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.5.0" --subdirectory plugins/office-preview
```

Локально, в этой папке: npm ci, bb plugin build ., bb plugin install .
Тесты: npm test (Node.js >= 22.18; проверено на 25.2.1) — откуда читается файл,
разбор ответа `sdk.files`, состав пакета `src/`. Визуальную точность тесты не проверяют.
Папка `src/` — ещё и пакет `@vibecommerce/office-preview`: из него Explorer_vibecom
показывает офисные файлы у себя в панели (архив в `plugins/files-editor/vendor/`).
SheetJS получает закреплённый архив xlsx-0.20.3 по URL из lockfile;
не заменяйте его старым пакетом xlsx из npm.

DOC/RTF/ODT используют macOS textutil на сервере. Для локального Windows-сервера
эти форматы открывайте внешним приложением. Старые PPT/PPS также требуют
внешнего приложения.
