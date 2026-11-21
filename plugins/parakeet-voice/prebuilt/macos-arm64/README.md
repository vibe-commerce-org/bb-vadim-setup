# `prebuilt/macos-arm64/` — готовый `transcribe-cli` для Mac с Apple silicon

Last Updated: 2026-11-21

Чтобы пользователям комплекта «bb как у Вадима» на Mac не ставить Xcode и cmake (Linux и Windows собирают движок сами).
`setup.sh` на Apple silicon копирует этот бинарник в `~/.local/share/parakeet-voice/bin/` после сверки sha256.

| Файл | Что |
|---|---|
| `transcribe-cli` | transcribe.cpp v0.4.2, 9,1 МБ, CPU + Metal (шейдеры вшиты), macOS 11.0+, arm64, `GGML_NATIVE=OFF` — работает на M1–M4; связан только с системными библиотеками и фреймворками |
| `SHA256SUMS` | sha256 бинарника, его проверяет `setup.sh` |
| `LICENSE` | MIT, transcribe.cpp |
| `THIRD-PARTY-LICENSES.md` | MIT: ggml, Silero VAD, miniz — тексты лицензий |

Собран 21.11 на M4 Pro скриптом [`../../build-prebuilt.sh`](../../build-prebuilt.sh); там же проверка CPU и Metal.
Обновить (новая версия transcribe.cpp): поменять `TRANSCRIBE_CPP_TAG` в `build-prebuilt.sh` и `setup.sh`, запустить
`bash build-prebuilt.sh` вне песочницы агента, закоммитить четыре файла.

Не подписан сертификатом разработчика (подпись ad-hoc от компоновщика). Копия из git или curl запускается сразу;
копию, скачанную браузером, Gatekeeper блокирует — `setup.sh` снимает с неё флаг карантина.

## Связанные

- Родитель: [`../../README.md`](../../README.md)
