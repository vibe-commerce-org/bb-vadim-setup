# Terminal_vibecom 0.6.2

Last Updated: 2026-10-11

Папка и id плагина — `floating-terminal`; в интерфейсе BB он называется Terminal_vibecom.
Настоящий терминал с вкладками шеллов: вкладкой в правой панели треда
(«+» → Terminal_vibecom или `Ctrl+\``) и плавающим окном из футера сайдбара.
Шеллы общие для окна и вкладки и переживают перезапуск BB. На телефоне —
строка клавиш, высота над клавиатурой, вставка многострочного текста.
BB >= 0.35, SDK >= 0.6.15.

Это переделка плагина [vburojevic/bb-plugin-floating-terminal](https://github.com/vburojevic/bb-plugin-floating-terminal)
v0.5.3 (коммит `ff6df634885a`), MIT, © 2026 Vedran Burojević — см. [LICENSE](LICENSE).
Изменения:

1. Кнопка `paste` на строке клавиш срабатывает на `pointerup`: iOS даёт читать
   буфер обмена только по завершённому касанию, и в оригинале вставка на iPhone
   не работала.
2. Вставка идёт через `terminal.paste()`: многострочный текст встаёт в строку
   ввода и ждёт Enter, а не выполняет каждую строку сразу.
3. Терминал — вкладка правой панели треда; команда BB «Terminal_vibecom: open in
   side panel» (`Ctrl+\`` по умолчанию, меняется в Settings → Keyboard). Вне треда
   команда открывает и прячет плавающее окно. SDK — npm-пакет `@get-bb/plugin-sdk`.
4. Видимое имя плагина, вкладки и команды — Terminal_vibecom; id команды прежний.
5. Открытие ещё одного терминала больше не портит текст в остальных: шрифт
   значков грузится один раз на страницу, и по его приходу общую текстуру
   глифов WebGL сбрасывают все открытые терминалы сразу (`lib/symbol-font.ts`).

Установка из Git:

```sh
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.4.0" --subdirectory plugins/floating-terminal
```

Плагин с тем же id из каталога BB или от автора сначала удалите:
`bb plugin remove floating-terminal`.

Локально, в этой папке: npm ci --ignore-scripts, bb plugin build ., bb plugin install .
(`--ignore-scripts` пропускает нативную сборку `better-sqlite3`: он нужен только для разработки).
Тесты: npm test; проверка типов: npm run typecheck. `npm run test:mobile` не запускайте на BB с живыми
шеллами: набор шлёт `clear`, `seq`, `^C` и `less` в первый терминал машины.

Шрифт `fonts/nerd-symbols.css` — символы [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts)
(MIT, см. `fonts/LICENSE-nerd-fonts`); входящие в него наборы иконок — под
своими лицензиями, подробности в `fonts/README.md`.
