---
name: parakeet-voice
description: Local voice input for bb with Parakeet Ultra (Parakeet_vibecom plugin). Use to check whether local transcription is installed, to transcribe an audio file on the bb machine, or to switch bb's voice input to the local model and back.
---

# Parakeet_vibecom — local voice input

The plugin registers the AI service `parakeet` ("Parakeet Ultra (local)") for bb's voice task.
Recordings are transcribed on the bb machine by `transcribe-cli` with the Parakeet Ultra model; audio
does not leave the machine.

## Commands

- `bb parakeet-voice status [--json]` — which `transcribe-cli`, model and `ffmpeg` the plugin found on the
  bb machine, or what is missing.
- `bb parakeet-voice transcribe <file> [--json]` — transcribe a file on the bb machine (any format ffmpeg
  reads) without changing the voice service. Prints the text; timings go to stderr.

## Switching voice input

- To local: `bb settings ai-services set voice parakeet`
- Back to the default: `bb settings ai-services set voice automatic`
- Check: `bb settings ai-services show`

Switching changes the user's everyday dictation — do it only when the user asked for it.

## Settings (`bb plugin config parakeet-voice`)

`cliPath`, `modelPath`, `ffmpegPath` — empty means: `$PARAKEET_VOICE_HOME` (default
`~/.local/share/parakeet-voice`) `bin/transcribe-cli` and `models/parakeet-ultra-Q8_0.gguf` (then `-Q5_K_M`),
then `PATH`. `backend` — `auto` (Metal on Apple silicon when the binary has it) or `cpu`.

## Limits

- Recordings up to 20 MB; bb waits 70 s, the plugin gives the engine 65 s (≈14 min of speech on a
  laptop-class CPU, far more on Apple silicon).
- Parakeet takes no vocabulary hint; bb's prompt is ignored.
- Install or update the engine and model with `setup.sh` in the plugin folder. On Apple silicon it installs the
  ready-made Metal binary from `prebuilt/macos-arm64/` and warms it up (the first Metal run compiles shaders for
  ~15 s); `--cpu` builds without Metal. Inside an agent sandbox use only `--cpu` with a temporary
  `PARAKEET_VOICE_HOME`: Metal crashes there.
