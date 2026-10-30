#!/bin/bash
# Сборка и тесты всех плагинов из plugins/ с нуля в копии: npm ci с пустым кэшем, bb plugin build, npm test.
# Использование: scripts/test-plugins.sh [ПАПКА_ДЛЯ_КОПИИ]   (по умолчанию — новая папка в $TMPDIR)
# SDK_VERSION=0.6.94 scripts/test-plugins.sh — то же против другой версии @get-bb/plugin-sdk (только в копии)
# и с проверкой типов; так выпуск сверяют с SDK новой версии bb (0.48.0 → 0.6.94). Версия 0.6.37 — базовая.
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
  if [ -n "${SDK_VERSION:-}" ]; then
    (cd "$d" && npm install --save-dev --save-exact --ignore-scripts "@get-bb/plugin-sdk@$SDK_VERSION" --cache "$OUT/npm-cache" --no-audit --no-fund >"$OUT/$p.sdk.log" 2>&1) || { echo "SDK $SDK_VERSION: npm install FAIL"; fail=1; continue; }
  fi
  (cd "$d" && bb plugin build . >"$OUT/$p.build.log" 2>&1) || { echo "build FAIL"; fail=1; continue; }
  if [ -n "${SDK_VERSION:-}" ]; then
    tc="npm run typecheck"; grep -q '"typecheck"' "$d/package.json" || tc="npx --no-install tsc --noEmit"
    (cd "$d" && $tc >"$OUT/$p.typecheck.log" 2>&1) && printf "types ok  " || { printf "types FAIL (лог: $OUT/$p.typecheck.log)  "; fail=1; }
  fi
  if ! grep -q '"test"' "$d/package.json"; then
    echo "собран, тестов у плагина нет"; continue
  fi
  if (cd "$d" && npm test >"$OUT/$p.test.log" 2>&1); then
    echo "ok  $(grep -hE '^ℹ (pass|fail) |Tests +[0-9]+' "$OUT/$p.test.log" | tr -s ' ' | tr '\n' ' ')"
  else
    echo "test FAIL (лог: $OUT/$p.test.log)"; fail=1
  fi
done
exit $fail
