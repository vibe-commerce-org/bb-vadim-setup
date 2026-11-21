#!/usr/bin/env bash
# Installs what the parakeet-voice bb plugin runs: transcribe-cli, ffmpeg and the Parakeet Ultra
# model, into $PARAKEET_VOICE_HOME (default ~/.local/share/parakeet-voice).
#
#   bash setup.sh                      # Apple silicon: ready-made transcribe-cli (Metal) from prebuilt/;
#                                      # elsewhere: build from source. Then model Q8_0 and ffmpeg.
#   bash setup.sh --build              # build from source even on a Mac (Metal on Apple silicon)
#   bash setup.sh --cpu                # build from source without Metal (agent sandbox, CPU-only servers)
#   bash setup.sh --model q5           # smaller model: Q5_K_M, 550 MB instead of 740 MB
#   bash setup.sh --model-file PATH    # take a model file you already have (sha256 is checked)
#   bash setup.sh --skip-engine | --skip-model
#
# Building needs git, cmake and a C++ compiler (macOS: xcode-select --install; brew install cmake;
# Debian/Ubuntu: apt install build-essential cmake git ffmpeg libopenblas-dev).
# A model already downloaded by Handy is reused when its sha256 matches.
set -euo pipefail

TRANSCRIBE_CPP_REPO="https://github.com/handy-computer/transcribe.cpp"
TRANSCRIBE_CPP_TAG="v0.4.2"
MODEL_BASE_URL="https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/main"
HANDY_MODELS="$HOME/Library/Application Support/com.pais.handy/models"
DEST="${PARAKEET_VOICE_HOME:-$HOME/.local/share/parakeet-voice}"
PREBUILT="$(cd "$(dirname "$0")" && pwd)/prebuilt/macos-arm64"

engine=auto   # auto | build | cpu
model=q8
model_file=""
skip_engine=0
skip_model=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build) engine=build ;;
    --cpu) engine=cpu ;;
    --model) model="${2:?--model needs q8 or q5}"; shift ;;
    --model-file) model_file="${2:?--model-file needs a path}"; shift ;;
    --skip-engine) skip_engine=1 ;;
    --skip-model) skip_model=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

case "$model" in
  q8) model_name="parakeet-ultra-Q8_0.gguf"; model_sha="007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59" ;;
  q5) model_name="parakeet-ultra-Q5_K_M.gguf"; model_sha="f6e3d8172547a3bb468e92ff395696e6d2e0371a9e52690a27741b4e8561c997" ;;
  *) echo "--model must be q8 or q5" >&2; exit 2 ;;
esac

platform="$(uname -s)-$(uname -m)"
if [ "$engine" = auto ]; then
  if [ "$platform" = "Darwin-arm64" ] && [ -f "$PREBUILT/transcribe-cli" ]; then engine=prebuilt; else engine=build; fi
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2" >&2; exit 1; }
}

# Replace by rename so a running transcription keeps its binary.
install_cli() {
  cp "$1" "$DEST/bin/transcribe-cli.new"
  chmod 755 "$DEST/bin/transcribe-cli.new"
  mv -f "$DEST/bin/transcribe-cli.new" "$DEST/bin/transcribe-cli"
  echo "    $DEST/bin/transcribe-cli"
}

mkdir -p "$DEST/bin" "$DEST/models"
# Work inside DEST: the final mv is then a rename on the same disk, not a 740 MB copy.
work="$(mktemp -d "$DEST/.work.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ "$skip_engine" -eq 0 ] && [ "$engine" = prebuilt ]; then
  echo "==> installing the ready-made transcribe-cli $TRANSCRIBE_CPP_TAG (Apple silicon, Metal)"
  want="$(cut -d' ' -f1 "$PREBUILT/SHA256SUMS")"
  got="$(sha256 "$PREBUILT/transcribe-cli")"
  [ "$got" = "$want" ] || { echo "sha256 mismatch for prebuilt transcribe-cli: got $got, want $want" >&2; exit 1; }
  install_cli "$PREBUILT/transcribe-cli"
  # A copy unpacked from a browser download carries the quarantine flag and Gatekeeper would block it.
  xattr -d com.apple.quarantine "$DEST/bin/transcribe-cli" 2>/dev/null || true
elif [ "$skip_engine" -eq 0 ]; then
  need git "install git"
  need cmake "macOS: brew install cmake; Debian: apt install cmake"
  need c++ "macOS: xcode-select --install; Debian: apt install build-essential"
  echo "==> building transcribe-cli $TRANSCRIBE_CPP_TAG ($([ "$engine" = cpu ] && echo "CPU only" || echo "default backends"))"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TRANSCRIBE_CPP_TAG" "$TRANSCRIBE_CPP_REPO" "$work/src" 2>&1 \
    | grep -v "is not a commit" >&2 || true
  [ -f "$work/src/CMakeLists.txt" ] || { echo "git clone of $TRANSCRIBE_CPP_REPO failed" >&2; exit 1; }
  flags=(-DCMAKE_BUILD_TYPE=Release -DTRANSCRIBE_BUILD_TESTS=OFF)
  [ "$engine" = cpu ] && flags+=(-DTRANSCRIBE_METAL=OFF)
  cmake -S "$work/src" -B "$work/build" "${flags[@]}" >"$work/cmake.log" 2>&1 || { tail -20 "$work/cmake.log" >&2; exit 1; }
  jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
  cmake --build "$work/build" -j "$jobs" --target transcribe-cli >>"$work/cmake.log" 2>&1 || { tail -20 "$work/cmake.log" >&2; exit 1; }
  install_cli "$work/build/bin/transcribe-cli"
fi

if [ "$skip_model" -eq 0 ]; then
  target="$DEST/models/$model_name"
  if [ -f "$target" ] && [ "$(sha256 "$target")" = "$model_sha" ]; then
    echo "==> model already in place: $target"
  else
    src=""
    if [ -n "$model_file" ]; then
      src="$model_file"
    elif [ -f "$HANDY_MODELS/$model_name" ]; then
      src="$HANDY_MODELS/$model_name"
    fi
    if [ -n "$src" ]; then
      echo "==> copying model from $src"
      # On APFS a clone is instant and takes no extra space; elsewhere fall back to a plain copy.
      cp -c "$src" "$work/$model_name" 2>/dev/null || cp "$src" "$work/$model_name"
    else
      need curl "install curl"
      echo "==> downloading $model_name from Hugging Face"
      curl -L --fail --progress-bar -o "$work/$model_name" "$MODEL_BASE_URL/$model_name"
    fi
    got="$(sha256 "$work/$model_name")"
    [ "$got" = "$model_sha" ] || { echo "sha256 mismatch for $model_name: got $got, want $model_sha" >&2; exit 1; }
    mv -f "$work/$model_name" "$target"
    echo "    $target (sha256 ok)"
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    echo "==> installing ffmpeg with Homebrew"
    brew install ffmpeg
  else
    echo "note: ffmpeg is not on PATH — macOS: brew install ffmpeg; Debian: apt install ffmpeg" >&2
  fi
fi

# The first Metal run compiles the GPU shaders (~15 s); macOS caches them. Pay that here,
# not on the first dictation.
cli="$DEST/bin/transcribe-cli"
model_path="$DEST/models/$model_name"
if [ "$(uname -s)" = Darwin ] && [ -x "$cli" ] && [ -f "$model_path" ] \
  && /usr/bin/afconvert -f WAVE -d LEI16@16000 -c 1 /System/Library/Sounds/Tink.aiff "$work/warmup.wav" 2>/dev/null; then
  echo "==> warming up the engine (the first Metal run compiles shaders, up to ~20 s)"
  "$cli" -m "$model_path" --timestamps none -q -o "$work/warmup.txt" "$work/warmup.wav" >/dev/null 2>"$work/warmup.log" \
    || { tail -5 "$work/warmup.log" >&2; echo "engine check failed" >&2; exit 1; }
  echo "    engine ok"
fi

echo "==> done. Check: bb parakeet-voice status"
