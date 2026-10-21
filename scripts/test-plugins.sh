#!/bin/bash
# Сборка и тесты всех плагинов из plugins/ с нуля в копии: npm ci с пустым кэшем, bb plugin build, npm test.
# Использование: scripts/test-plugins.sh [ПАПКА_ДЛЯ_КОПИИ]   (по умолчанию — новая папка в $TMPDIR)
# Сеть: registry.npmjs.org и cdn.sheetjs.com. В floating-terminal запускается только npm test:
# его другие скрипты шлют команды в открытый терминал.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/kit-test.XXXX")}"
mkdir -p "$OUT/plugins" "$OUT/npm-cache"
echo "bb $(bb --version)  node $(node --version)  npm $(npm --version)  → $OUT"
fail=0
for p in $(cd "$ROOT/plugins" && ls -d */ | tr -d /); do
  [ -f "$ROOT/plugins/$p/package.json" ] || continue
  rsync -a --exclude node_modules --exclude dist "$ROOT/plugins/$p/" "$OUT/plugins/$p/"
  d="$OUT/plugins/$p"
  flags=""; case "$p" in files-editor|floating-terminal) flags="--ignore-scripts";; esac
  printf "=== %-18s " "$p"
  (cd "$d" && npm ci $flags --cache "$OUT/npm-cache" --no-audit --no-fund >"$OUT/$p.npm.log" 2>&1) || { echo "npm ci FAIL"; fail=1; continue; }
  (cd "$d" && bb plugin build . >"$OUT/$p.build.log" 2>&1) || { echo "build FAIL"; fail=1; continue; }
  if (cd "$d" && npm test >"$OUT/$p.test.log" 2>&1); then
    echo "ok  $(grep -hE '^ℹ (pass|fail) |Tests +[0-9]+' "$OUT/$p.test.log" | tr -s ' ' | tr '\n' ' ')"
  else
    echo "test FAIL (лог: $OUT/$p.test.log)"; fail=1
  fi
done
exit $fail
