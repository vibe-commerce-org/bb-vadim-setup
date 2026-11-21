# Parakeet_vibecom 0.2.0

Last Updated: 2026-11-21

Папка и id плагина — `parakeet-voice`; в интерфейсе BB он называется Parakeet_vibecom. Нужен bb 0.50 или новее
(AI-сервисы плагинов, SDK 0.6.157). Интерфейса у плагина нет: он добавляет в **Settings → AI services** сервис
`parakeet` — «Parakeet Ultra (local)», только для голосового ввода.

Плагин подменяет распознавание голоса bb (по умолчанию — bb cloud) локальной моделью **Parakeet Ultra** — той же,
что в каталоге Handy. Запись распознаётся на компьютере, где работает bb: `ffmpeg` переводит её в WAV 16 кГц моно,
`transcribe-cli` из [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) (MIT) выдаёт текст с
пунктуацией. Звук никуда не уходит: плагин не делает сетевых запросов, два процесса запускает сам bb на той же машине.

| | |
|---|---|
| Модель | `parakeet-ultra-Q8_0.gguf`, 740 МБ, CC-BY-4.0, 25 языков, русский WER 5,6 % (FLEURS) |
| Движок | transcribe.cpp v0.4.2: для Mac с Apple silicon — готовый `transcribe-cli` с Metal в `prebuilt/macos-arm64/` (macOS 11+, M1–M4); на Linux и Intel Mac — сборка из исходников |
| Скорость (Mac, Apple silicon) | 30 с живой речи — около 1 с, 2 мин — около 2 с |
| Подсказка bb (словарь имён) | не принимается: Parakeet может хуже писать имена и названия |

## Установка на Mac с Apple silicon

Компилятор и cmake не нужны. **Запускайте `setup.sh` в своём Terminal, а не агентом:** в песочнице агента Metal
падает, а запись в `~/.local/share` запрещена.

```bash
cd <папка плагина>              # plugins/parakeet-voice комплекта
bash setup.sh                   # готовый transcribe-cli + модель 740 МБ (sha256) + ffmpeg через brew + прогрев ~20 с
bb plugin install path:"$PWD" --yes
bb parakeet-voice status        # должно быть ready
bb settings ai-services set voice parakeet
```

`setup.sh` кладёт всё в `~/.local/share/parakeet-voice/` (другое место — переменная `PARAKEET_VOICE_HOME`).
Бинарник сверяется с `prebuilt/macos-arm64/SHA256SUMS`, с него снимается флаг карантина Gatekeeper. `ffmpeg` ставится
через Homebrew, если его нет. Модель поменьше — `bash setup.sh --model q5` (550 МБ, качество почти то же); готовая
модель на диске — `--model-file <путь>`. Первый запуск Metal 15–20 секунд готовит шейдеры, поэтому `setup.sh` сразу
делает пробный прогон.

Собрать движок самому вместо готового: `bash setup.sh --build` (нужны `xcode-select --install` и `brew install cmake`).
Пересобрать готовый бинарник (новая версия transcribe.cpp) — `bash build-prebuilt.sh` на Mac с Apple silicon, вне
песочницы агента.

## Linux и Windows — собрать самим

- **Linux:** `bash setup.sh` собирает из исходников (нужны `build-essential cmake git ffmpeg libopenblas-dev`).
  На Linux-CPU уровня Ryzen 5 4750U 2 минуты речи — около 9 секунд. На Linux сборка в этом комплекте не проверялась.
- **Windows:** готового бинарника нет, `setup.sh` не работает. Соберите `transcribe-cli.exe` по
  [инструкции transcribe.cpp](https://github.com/handy-computer/transcribe.cpp/blob/main/docs/build-windows.md), скачайте
  модель (ссылка и sha256 — в `setup.sh`), поставьте `ffmpeg` и пропишите полные пути в настройках плагина
  `cliPath`, `modelPath`, `ffmpegPath`.

## Включить, выключить, вернуть

```bash
bb settings ai-services set voice parakeet     # голос — локально
bb settings ai-services set voice automatic    # как было: bb cloud, при сбое — следующие сервисы
bb settings ai-services show
```

То же — в Settings → AI services. В режиме Automatic bb идёт по порядку: bb cloud, затем остальные готовые сервисы;
Parakeet там запасной — если облако недоступно, диктовка распознаётся локально. Проверить, не переключая голос:
`bb parakeet-voice transcribe <файл>` (любой формат, который читает ffmpeg; файл на компьютере с bb).

## После обновления bb — пробная диктовка

API AI-сервисов плагинов у bb экспериментальный и может поменяться. После каждого обновления bb:

1. `bb plugin list` — `parakeet-voice … running`;
2. `bb settings ai-services show` — у `parakeet` статус `ready`;
3. одна диктовка в поле ввода, если голос переключён на `parakeet`.

Не работает — сразу `bb settings ai-services set voice automatic` (голос снова через bb cloud), потом разбирайтесь:
`bb plugin logs parakeet-voice`.

## Настройки (`bb plugin config parakeet-voice`)

| Ключ | По умолчанию | Что |
|---|---|---|
| `cliPath` | пусто → `~/.local/share/parakeet-voice/bin/transcribe-cli`, потом `PATH` | путь к `transcribe-cli` |
| `modelPath` | пусто → `…/models/parakeet-ultra-Q8_0.gguf`, потом `-Q5_K_M` | путь к модели |
| `ffmpegPath` | пусто → `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` | путь к `ffmpeg` |
| `backend` | `auto` | `auto` — Metal, если он есть в бинарнике; `cpu` — только процессор |

Чего не хватает, видно в `bb parakeet-voice status` и рядом с сервисом в Settings → AI services: пока сервис не готов,
bb пропускает его в Automatic.

## Ограничения

- Запись до 20 МБ (Opus 32 кбит/с — больше часа речи). bb ждёт голос 70 с, движку плагин даёт 65 с.
- Сервис работает на основном компьютере bb: модель и `ffmpeg` нужны там, где bb-сервер, а не на телефоне.
- Готовый бинарник работает только на Apple silicon; на Intel Mac, Linux и Windows — сборка из исходников.
- Тесты: `npm test` (проверка путей, ошибок, таймаута, отмены и того, что во время работы нет сетевых соединений).
  Сквозной прогон на реальной записи — переменная `PARAKEET_E2E_AUDIO`, подробности в `tests/engine.test.ts`.

Движок и его лицензии — `prebuilt/macos-arm64/README.md`, `LICENSE`, `THIRD-PARTY-LICENSES.md`; модель Parakeet Ultra
распространяется по CC-BY-4.0 с указанием авторства.

Установка из Git (плагин без движка и модели — `setup.sh` запускается из клона):

```sh
bb plugin install "git:https://github.com/vibe-commerce-org/bb-vadim-setup.git@semver:~0.6.0" --subdirectory plugins/parakeet-voice
```
