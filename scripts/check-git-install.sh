#!/bin/bash
# Установка «как у bb из Git»: клон по тегу, удаление .npmrc/.yarnrc, установка зависимостей
# без инструментов разработки npm-ом из bb, bb plugin build — для каждого плагина из plugins/.
# Использование: scripts/check-git-install.sh [ТЕГ]
#   ТЕГ — существующий тег репозитория; без него — временный репозиторий из рабочей копии
#   (отслеживаемые и новые неигнорируемые файлы) с тегом v<VERSION>.
# Сеть: registry.npmjs.org и cdn.sheetjs.com. Путь к npm из bb можно задать в BB_NPM.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/kit-git.XXXX")"
NPM="${BB_NPM:-/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/npm/bin/npm-cli.js}"
if [ -f "$NPM" ]; then NPM_CMD=(node "$NPM"); else NPM_CMD=(npm); echo "npm из bb не найден, беру системный"; fi
if [ $# -ge 1 ]; then
  TAG="$1"; SRC="$ROOT"
else
  TAG="v$(cat "$ROOT/VERSION")"; SRC="$T/repo"; mkdir "$SRC"
  (cd "$ROOT" && git ls-files -z --cached --others --exclude-standard) >"$T/files"
  rsync -a --from0 --files-from="$T/files" "$ROOT/" "$SRC/"
  git -C "$SRC" init -q -b main && git -C "$SRC" add -A
  git -C "$SRC" -c user.name=check -c user.email=check@example.invalid commit -qm check
  git -C "$SRC" tag "$TAG"
fi
git -c advice.detachedHead=false clone -q --branch "$TAG" "$SRC" "$T/clone"
export npm_config_cache="$T/npm-cache"
echo "npm $("${NPM_CMD[@]}" --version), клон $TAG → $T/clone"
fail=0
for p in $(cd "$T/clone/plugins" && ls -d */ | tr -d /); do
  [ -f "$T/clone/plugins/$p/package.json" ] || continue
  R="$T/clone/plugins/$p"
  for f in .npmrc .yarnrc .yarnrc.yml; do [ -e "$R/$f" ] && mv "$R/$f" "$T/removed-$p-$f"; done
  printf "=== %-18s " "$p"
  if "${NPM_CMD[@]}" install --prefix "$R" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund >"$T/$p.npm.log" 2>&1 \
     && bb plugin build "$R" >"$T/$p.build.log" 2>&1; then
    echo "ok"
  else
    echo "FAIL (логи: $T/$p.*.log)"; fail=1
  fi
done
exit $fail
