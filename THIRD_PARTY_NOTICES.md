# Сторонние компоненты и лицензии

Last Updated: 2026-10-21

Собственные материалы комплекта распространяются по [MIT](LICENSE). Лицензия
комплекта не меняет условий сторонних компонентов ниже: для них действуют их
собственные лицензии.

## Включено в репозиторий

| Файл или папка | Происхождение | Лицензия |
|---|---|---|
| `theme/atom-one_vibecom/one-dark.json` | Atom One Dark для VS Code, [akamud/vscode-theme-onedark](https://github.com/akamud/vscode-theme-onedark) 2.3.0, © 2015 Mahmoud Ali | MIT, полный текст — [`theme/atom-one_vibecom/LICENSE-One-Dark.txt`](theme/atom-one_vibecom/LICENSE-One-Dark.txt) |
| `theme/atom-one_vibecom/theme.css` | Собственный CSS. Цвета тёмного режима — из Atom One Dark (выше); светлого — из Atom One Light ([atom/atom](https://github.com/atom/atom), MIT); терминала — из [One Half](https://github.com/sonph/onehalf) (MIT) | MIT (комплект) |
| `plugins/files-editor/` (Explorer_vibecom) | Переделка [abdoutelb/bb-plugin-files-editor](https://github.com/abdoutelb/bb-plugin-files-editor) v0.1.6, коммит `10657ef`, © 2026 AbdElrahman Telb. Загрузка, скачивание и проверки путей (`lib/uploads.ts`, `lib/upload-manager.ts`, `lib/transfer.ts`, проверки в `lib/mutations.ts`) перенесены из file-manager, [xMinor-1/bb-plugins](https://github.com/xMinor-1/bb-plugins) v0.9.2, коммит `dfd8e07`, © 2026 Foma. Изменения автора комплекта — MIT (комплект) | MIT, [`plugins/files-editor/LICENSE`](plugins/files-editor/LICENSE); тексты ниже |
| `plugins/files-editor/vendor/*.tgz` | Пакеты `@vibecommerce/markdown-view` и `@vibecommerce/office-preview` — код Markdown_vibecom и Office_vibecom из этого комплекта | MIT (комплект) |
| `plugins/floating-terminal/` (Terminal_vibecom) | Переделка [vburojevic/bb-plugin-floating-terminal](https://github.com/vburojevic/bb-plugin-floating-terminal) v0.5.3, коммит `ff6df634885a`, © 2026 Vedran Burojević. Изменения автора комплекта — MIT (комплект) | MIT, [`plugins/floating-terminal/LICENSE`](plugins/floating-terminal/LICENSE); текст ниже |
| `plugins/floating-terminal/fonts/nerd-symbols.css` | Symbols Nerd Font Mono из [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts), © 2014 Ryan L McIntyre. Входящие в шрифт наборы иконок (Powerline, Font Awesome, Devicons, Octicons, Codicons, Font Logos, Material Design Icons, Weather Icons) — под своими лицензиями, перечень — в проекте Nerd Fonts | MIT, [`plugins/floating-terminal/fonts/LICENSE-nerd-fonts`](plugins/floating-terminal/fonts/LICENSE-nerd-fonts); текст ниже |

## Загружается npm при установке (в репозиторий не входит)

Зависимости скачивает npm по `package-lock.json` с registry.npmjs.org; SheetJS —
закреплённым архивом с cdn.sheetjs.com. Версии ниже — из рабочей установки
выпуска 0.2.0 (как при установке BB из Git, без dev-зависимостей).

| Плагин | Пакет | Версия | Лицензия |
|---|---|---|---|
| Markdown_vibecom | vditor | 4.0.0 | MIT |
| Markdown_vibecom | diff | 9.0.0 | BSD-3-Clause |
| Markdown_vibecom (через vditor) | diff-match-patch | 1.0.5 | Apache-2.0 |
| Office_vibecom | @aiden0z/pptx-renderer | 1.3.0 | Apache-2.0 |
| Office_vibecom | docx-preview | 0.4.1 | Apache-2.0 |
| Office_vibecom | exceljs | 4.4.0 | MIT |
| Office_vibecom | jszip | 3.10.2 | MIT или GPL-3.0-or-later на выбор; используется на условиях MIT |
| Office_vibecom | xlsx (SheetJS Community Edition) | 0.20.3 | Apache-2.0 |
| Office_vibecom, Folder links_vibecom, Explorer_vibecom, Terminal_vibecom | zod | 4.6.5 | MIT |
| Explorer_vibecom | pdfjs-dist | 4.10.38 | Apache-2.0 |
| Explorer_vibecom | @hugeicons/core-free-icons, @hugeicons/react | 4.3.0, 1.1.10 | MIT |
| Explorer_vibecom | @radix-ui/react-checkbox, @radix-ui/react-slot | 1.3.11, 1.3.3 | MIT |
| Explorer_vibecom | зависимости Markdown_vibecom и Office_vibecom (выше) — через пакеты из `vendor/` | те же | те же |
| Terminal_vibecom | @xterm/xterm и аддоны fit, search, unicode11, web-links, webgl | 6.0.0; 0.11.0, 0.16.0, 0.9.0, 0.12.0, 0.19.0 | MIT |
| Terminal_vibecom | @hugeicons/core-free-icons, @hugeicons/react | 4.2.3, 1.1.9 | MIT |
| Terminal_vibecom | @radix-ui/react-dropdown-menu, react-scroll-area, react-select, react-slot, react-tooltip | 2.1.24, 1.2.18, 2.3.7, 1.3.3, 1.2.16 | MIT |
| Terminal_vibecom | cmdk, clsx, tailwind-merge | 1.1.1, 2.1.1, 3.6.0 | MIT |
| Terminal_vibecom | class-variance-authority | 0.7.1 | Apache-2.0 |
| Русификатор_vibecom, Важные артефакты_vibecom | zod | 4.6.7; 4.6.5 | MIT |
| Пульт_vibecom | zod, @radix-ui/react-checkbox, @radix-ui/react-slot (с react, react-dom из дерева radix) | 4.6.6, 1.3.12, 1.4.0 | MIT |
| Repo tags_vibecom | — (зависимостей нет) | | |

Инструменты сборки и тестов (devDependencies): `typescript` (Apache-2.0),
`@types/*` (MIT), `vitest` (MIT), `jsdom` (MIT), `better-sqlite3` (MIT, у Пульта и Артефактов), `@get-bb/plugin-sdk` —
пакет SDK от BB (0.6.15; у Folder links_vibecom — 0.5.9; у Русификатора, тега, Пульта и Артефактов —
0.6.37), поле лицензии в нём не указано.
При установке из Git BB их не загружает.

Транзитивные зависимости рабочей установки: Office_vibecom — 106 пакетов,
Explorer_vibecom — 225, Terminal_vibecom — 62; в основном MIT, ISC, Apache-2.0,
BSD. Отдельно (Office_vibecom и Explorer_vibecom):

| Пакет | Откуда | Лицензия |
|---|---|---|
| mtx-decompressor 1.6.0 (у Explorer_vibecom — 1.8.0) | @aiden0z/pptx-renderer | MPL-2.0 (пофайловый copyleft; используется без изменений) |
| big-integer 1.6.52 | exceljs → unzipper | Unlicense |
| buffers 0.1.1 | exceljs → unzipper → binary | в пакете не указана |

## Тексты лицензий переделанных плагинов и шрифта

### Explorer_vibecom — AbdElrahman Telb и Foma (`plugins/files-editor/LICENSE`)

```text
MIT License

Copyright (c) 2026 AbdElrahman Telb
Copyright (c) 2026 Foma (code ported from file-manager, github.com/xMinor-1/bb-plugins, MIT:
lib/uploads.ts, lib/upload-manager.ts, lib/transfer.ts, path and name checks in lib/mutations.ts)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Explorer_vibecom — file-manager, Foma (LICENSE исходного репозитория xMinor-1/bb-plugins)

```text
MIT License

Copyright (c) 2026 Foma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Terminal_vibecom — Vedran Burojević (`plugins/floating-terminal/LICENSE`)

```text
MIT License

Copyright (c) 2026 Vedran Burojević

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Nerd Fonts — Ryan L McIntyre (`plugins/floating-terminal/fonts/LICENSE-nerd-fonts`)

```text
The MIT License (MIT)

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
