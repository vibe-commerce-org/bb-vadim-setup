"""Переносит код плагинов из рабочего репозитория автора в plugins/.

Использование: python3 scripts/sync-plugins.py --from ПАПКА_ПЛАГИНОВ [--apply]

ПАПКА_ПЛАГИНОВ — папка внутри git-репозитория, где лежат плагины из списка PLUGINS.
Берутся только закоммиченные файлы HEAD. Плагин, которого в коммитах источника нет
(в 0.4.0 — repo-tag и artifacts; с 0.5.0 они в коммитах), пропускается: его копия в комплекте остаётся как есть.
Без --apply скрипт только показывает, что изменится.

Правила:
- не переносятся README.md плагина (в комплекте свои), PLUGIN_OVERVIEW.md, .gitignore,
  docs/, samples/, scratch/, .claude/; исключение — снимки интерфейса docs/screens/*.png
  (README и аудит рядом с ними остаются в источнике: в комплекте подписи — в README плагина,
  гайде и catalog.json);
- у трёх своих плагинов в package.json и в корне package-lock.json версия = VERSION
  комплекта, в package.json добавляется "license": "MIT";
- у своих плагинов с собственной версией (NEW_OWN) версия остаётся, в package.json
  добавляется "license": "MIT";
- LICENSE и package-lock.json, которых нет в источнике, — файлы комплекта: не удаляются;
- файл, который в комплекте отличается от источника, но в источнике не менялся с прошлого
  переноса, считается правкой комплекта (например, обезличенный комментарий) и остаётся;
- если такой файл изменился и в источнике, он заменяется, а скрипт просит заново внести
  правку комплекта.
Коммит источника прошлого переноса хранится в scripts/plugins-source-commit.txt.
"""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "scripts" / "plugins-source-commit.txt"
OWN = ("markdown-view", "office-preview", "folder-links")
NEW_OWN = ("russifier", "pult", "repo-tag", "artifacts", "composer-labels")
PLUGINS = OWN + ("files-editor", "floating-terminal") + NEW_OWN
KIT_ADDED = {"LICENSE", "package-lock.json"}
EXCLUDED_TOP = {"README.md", "PLUGIN_OVERVIEW.md", ".gitignore"}
EXCLUDED_DIRS = {"docs", "samples", "scratch", ".claude", "node_modules", "dist"}
SCREENS = "docs/screens/"


def git(repo: Path, *args: str, binary: bool = False):
    r = subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)
    return r.stdout if binary else r.stdout.decode()


def excluded(rel: str) -> bool:
    parts = rel.split("/")
    if rel.startswith(SCREENS):
        return not rel.endswith(".png")
    return rel in EXCLUDED_TOP or any(p in EXCLUDED_DIRS for p in parts[:-1]) or parts[-1] == ".DS_Store"


def transform(plugin: str, rel: str, data: bytes, version: str) -> bytes:
    if plugin not in OWN + NEW_OWN or rel not in ("package.json", "package-lock.json"):
        return data
    s = data.decode("utf-8")
    head, tail = s[:800], s[800:]
    limit = 1 if rel == "package.json" else 2
    if plugin in OWN:
        head = re.sub(r'"version": "[^"]+"', f'"version": "{version}"', head, count=limit)
    if rel == "package.json" and '"license"' not in s:
        head = re.sub(r'("version": "[^"]+",\n)', r'\1  "license": "MIT",\n', head, count=1)
    return (head + tail).encode("utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    src = args.src.resolve()
    repo = Path(git(src, "rev-parse", "--show-toplevel").strip())
    prefix = src.relative_to(repo).as_posix()
    head = git(repo, "rev-parse", "HEAD").strip()
    last = STATE.read_text().strip() if STATE.exists() else None
    version = (ROOT / "VERSION").read_text().strip()
    dirty = git(repo, "status", "--short", "--", prefix).strip()
    print(f"источник: HEAD {head[:7]}, прошлый перенос: {last[:7] if last else 'нет'}, версия комплекта {version}")
    if dirty:
        print("в источнике есть незакоммиченные правки — они не переносятся:\n" + dirty)

    changes, kept, conflicts = [], [], []
    for plugin in PLUGINS:
        base = f"{prefix}/{plugin}/"
        src_files = [f[len(base):] for f in git(repo, "ls-tree", "-r", "--name-only", "HEAD", "--", base).splitlines()]
        src_files = [f for f in src_files if not excluded(f)]
        if not src_files:
            print(f"пропущен {plugin}: в коммитах источника его нет, копия комплекта не меняется")
            continue
        changed_since = None
        if last:
            changed_since = {f[len(base):] for f in git(repo, "diff", "--name-only", last, head, "--", base).splitlines()}
        lib_dir = ROOT / "plugins" / plugin
        for rel in src_files:
            data = transform(plugin, rel, git(repo, "show", f"{head}:{base}{rel}", binary=True), version)
            target = lib_dir / rel
            current = target.read_bytes() if target.exists() else None
            if current == data:
                continue
            if current is not None and changed_since is not None and rel not in changed_since:
                kept.append(f"{plugin}/{rel}")
                continue
            if current is not None and changed_since is not None and rel in changed_since:
                prev = transform(plugin, rel, git(repo, "show", f"{last}:{base}{rel}", binary=True), version) \
                    if rel in git(repo, "ls-tree", "-r", "--name-only", last, "--", base + rel) else None
                if prev is not None and prev != current:
                    conflicts.append(f"{plugin}/{rel}")
            changes.append(("update" if current is not None else "add", plugin, rel, data))
        src_set = set(src_files)
        for f in sorted(lib_dir.rglob("*")):
            rel = f.relative_to(lib_dir).as_posix()
            if f.is_file() and not excluded(rel) and rel not in src_set and rel not in KIT_ADDED:
                changes.append(("remove", plugin, rel, None))

    for kind, plugin, rel, _ in changes:
        print(f"{kind:7} plugins/{plugin}/{rel}")
    if kept:
        print("оставлены правки комплекта (в источнике не менялись):\n  " + "\n  ".join(kept))
    if conflicts:
        print("ВНЕСИ ЗАНОВО правку комплекта (файл изменился и в источнике):\n  " + "\n  ".join(conflicts))
    if not changes:
        print("изменений нет")
    if args.apply:
        for kind, plugin, rel, data in changes:
            target = ROOT / "plugins" / plugin / rel
            if kind == "remove":
                target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        STATE.write_text(head + "\n")
        print(f"применено; {STATE.relative_to(ROOT)} = {head[:7]}. Дальше: поиск личного, тесты, CHANGELOG.")


if __name__ == "__main__":
    main()
