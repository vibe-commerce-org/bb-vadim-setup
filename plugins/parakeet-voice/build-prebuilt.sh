#!/usr/bin/env bash
# Rebuilds the ready-made transcribe-cli that setup.sh installs on Apple silicon Macs
# (prebuilt/macos-arm64/). Run on an Apple silicon Mac, outside an agent sandbox:
#
#   bash build-prebuilt.sh
#
# Portable build: Metal with embedded shaders, GGML_NATIVE=OFF (runs on M1..M4),
# macOS 11.0+ like transcribe.cpp's own wheels. Writes the binary, its licenses and SHA256SUMS,
# then checks it on the CPU and on Metal. Commit the four files in prebuilt/macos-arm64/.
set -euo pipefail

TRANSCRIBE_CPP_REPO="https://github.com/handy-computer/transcribe.cpp"
TRANSCRIBE_CPP_TAG="v0.4.2"
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/prebuilt/macos-arm64"

[ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] || { echo "run this on an Apple silicon Mac" >&2; exit 1; }
for tool in git cmake c++; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing: $tool" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/parakeet-prebuilt.XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "==> building transcribe-cli $TRANSCRIBE_CPP_TAG for macOS 11+ arm64 (CPU + Metal)"
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TRANSCRIBE_CPP_TAG" "$TRANSCRIBE_CPP_REPO" "$work/src" 2>&1 \
  | grep -v "is not a commit" >&2 || true
[ -f "$work/src/CMakeLists.txt" ] || { echo "git clone of $TRANSCRIBE_CPP_REPO failed" >&2; exit 1; }
cmake -S "$work/src" -B "$work/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DGGML_NATIVE=OFF \
  -DTRANSCRIBE_METAL=ON \
  -DTRANSCRIBE_BUILD_TESTS=OFF >"$work/cmake.log" 2>&1 || { tail -20 "$work/cmake.log" >&2; exit 1; }
cmake --build "$work/build" -j "$(sysctl -n hw.ncpu)" --target transcribe-cli >>"$work/cmake.log" 2>&1 \
  || { tail -20 "$work/cmake.log" >&2; exit 1; }

bin="$work/build/bin/transcribe-cli"
grep -q "backends: metal;cpu" "$work/cmake.log" || { echo "build has no Metal backend" >&2; exit 1; }
otool -L "$bin" | tail -n +2 | grep -v -E "^\s*(/usr/lib/|/System/Library/)" \
  && { echo "binary links a non-system library — not portable" >&2; exit 1; }

mkdir -p "$out"
cp "$bin" "$out/transcribe-cli"
chmod 755 "$out/transcribe-cli"
cp "$work/src/LICENSE" "$out/LICENSE"
cp "$work/src/THIRD-PARTY-LICENSES.md" "$out/THIRD-PARTY-LICENSES.md"
(cd "$out" && shasum -a 256 transcribe-cli > SHA256SUMS)
echo "    $out/transcribe-cli ($(stat -f %z "$out/transcribe-cli") bytes)"
echo "    minos: $(otool -l "$out/transcribe-cli" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"
echo "    $(cat "$out/SHA256SUMS")"

model="${PARAKEET_VOICE_HOME:-$HOME/.local/share/parakeet-voice}/models/parakeet-ultra-Q8_0.gguf"
if [ -f "$model" ]; then
  echo "==> smoke test on a system sound: CPU, then Metal"
  "$bin" --list-devices 2>&1 | sed 's/^/    /'
  /usr/bin/afconvert -f WAVE -d LEI16@16000 -c 1 /System/Library/Sounds/Tink.aiff "$work/t.wav" 2>/dev/null \
    || { echo "afconvert failed" >&2; exit 1; }
  for backend in cpu metal; do
    "$out/transcribe-cli" -m "$model" --backend "$backend" --timestamps none -q -o "$work/$backend.txt" "$work/t.wav" >/dev/null \
      && echo "    $backend: ok" || { echo "    $backend: FAILED" >&2; exit 1; }
  done
else
  echo "note: no model at $model — skipped the smoke test" >&2
fi
