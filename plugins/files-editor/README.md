# Explorer_vibecom 0.1.6

Last Updated: 2026-10-11

Папка и id плагина — `files-editor`; в интерфейсе BB он называется Explorer_vibecom.
Проводник и редактор рабочей копии треда: вкладка Explorer_vibecom в правой
панели треда и страница Files в сайдбаре. BB >= 0.40.

- Дерево с сортировкой (имя, дата изменения, тип), поиск по именам файлов и
  папок, поиск по тексту (`⌘⇧F`), `⌘P`, переключатель скрытия `.gitignore`.
- Меню по правому клику, на телефоне — долгим нажатием: создать, переименовать,
  дублировать, переместить, в корзину с отменой, Copy path, Add to chat, Download,
  открыть в новой вкладке.
- PDF, Word, Excel, PowerPoint и Markdown открываются внутри панели
  просмотрщиками Office_vibecom и Markdown_vibecom; PDF на телефоне — лентой страниц.
- Домашняя папка (Home), загрузка файлов и скачивание.
- Секретные файлы (`.ssh`, `.env`, `.aws` и т. п.) видны в дереве, но содержимое
  и передача — только после подтверждения.
- Текстовые файлы — просмотр с подсветкой и правка с сохранением; CLI `bb files`.

Корзина, Home, загрузка и «Open in Mac app» работают для рабочей копии на
машине с сервером BB под macOS. Файлы на подключённой машине идут через
`sdk.files`, корзины там нет.

Это переделка плагина [abdoutelb/bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor)
v0.1.6 (коммит `10657ef`), MIT, © 2026 AbdElrahman Telb. Загрузка, скачивание
и проверки путей перенесены из file-manager ([xMinor-1/bb-plugins](https://github.com/xMinor-1/bb-plugins)),
MIT, © 2026 Foma. Оба уведомления — в [LICENSE](LICENSE).

## Установка

```sh
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/files-editor
```

Для `.md` нужен установленный Markdown_vibecom: Vditor отдаёт его сервер.
Плагин с тем же id от автора сначала удалите: `bb plugin remove files-editor`.

Локально, в этой папке: npm ci --ignore-scripts, bb plugin build ., bb plugin install .
(`--ignore-scripts` пропускает нативную сборку `better-sqlite3`: он нужен только
для разработки). Тесты: npm test; проверка типов: npm run typecheck.

Просмотрщики Markdown_vibecom и Office_vibecom лежат в `vendor/` архивами
пакетов `@vibecommerce/markdown-view` и `@vibecommerce/office-preview`, собранными
из `../markdown-view/src` и `../office-preview/src`; в npm они не публикуются.
Поменяли код просмотрщика — выполните `npm run pack-viewers`, иначе тест
`lib/vendor-viewers.test.ts` упадёт. `npm run link-viewers` на время разработки
ставит ссылки на соседние папки вместо архивов.

## Настройки

- **Excluded directories** — имена папок, которые не показываются; по умолчанию
  `.git`, `node_modules`, `vendor`.
- **Open documents in** — где открывать PDF и офисные файлы: в этой панели
  (по умолчанию), в просмотрщике BB или в приложении macOS.
