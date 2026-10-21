"""Проверяет собранный выпуск в release/ (после scripts/build-kit.py).

Использование: python3 scripts/check-kit.py [--private-patterns ФАЙЛ]

Проверки: CRC и пути ZIP, нет symlink, node_modules, dist и .DS_Store; MANIFEST
совпадает с содержимым ZIP и с MANIFEST.json репозитория; GUIDE.md в ZIP и
08-BB-VADIM-SETUP.md равны GUIDE.md; файл для агента: встроенный скрипт равен
scripts/extract-kit.mjs, «## Порядок» равен AGENT-TASK.md, извлечение в путь с
пробелом и кириллицей, повторный запуск, отказ перезаписать чужой файл; поиск
личного по ZIP и служебным файлам репозитория.

--private-patterns — файл вне репозитория с регулярками (по одной на строку) для
имён, которые нельзя публиковать: клиенты, закрытые репозитории.
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RELEASE = ROOT / "release"
PREFIX = "bb-vadim-kit/"
# Встроенный в Terminal_vibecom шрифт значков (base64) даёт ложные совпадения.
SKIP = ("plugins/floating-terminal/fonts/nerd-symbols.css",)
# Вымышленные пользователи в примерах и тестах.
FICTIONAL = r"(?:me|dev|user|alex|someone-else|ИМЯ|Ivan|Kate|KateX|Public|Other|Nobody|Иван)\b|Имя|Другой|\$\{|%D0|…"
GENERIC = [
    r"/Users/(?!(?:" + FICTIONAL + r"))[A-Za-z]", r"C:[/\\]+Users[/\\]+(?![/\\]*(?:" + FICTIONAL + r"))",
    r"\b(thr|proj|env|host)_[a-z0-9]{8,}\b", r"@gmail\.com", r"\bsk-[A-Za-z0-9]{10,}", r"\bghp_[A-Za-z0-9]{10,}",
    r"\beyJ[A-Za-z0-9_-]{20,}\.", r"\bAQVN[A-Za-z0-9_-]{10,}", r"\bb1g[a-z0-9]{17}\b",
    r"Documents/_CODE", r"\.bb/thread-storage", r"getbb\.app/[a-z]",
]

# Вымышленные ID bb в тестах и комментариях Пульта: явный список, чтобы новый ID проверял человек.
FICTIONAL_IDS = {
    "thr_aaaaaaaaaa", "thr_bbbbbbbbbb", "thr_dddddddddd", "thr_hhhhhhhhhh", "thr_xxxxxxxxxx", "thr_zzzzzzzzzz",
    "thr_classify01", "thr_test000001", "thr_action01", "thr_commit01", "thr_fresh001", "thr_comm0004",
    "thr_grandchild", "thr_approval", "thr_parent01", "thr_child001", "thr_other001", "proj_fixture01",
}

failures: list[str] = []


def check(ok: bool, msg: str) -> None:
    print(("ok   " if ok else "FAIL ") + msg)
    if not ok:
        failures.append(msg)


def slug(heading: str) -> str:
    """Якорь заголовка, как его строит GitHub."""
    h = re.sub(r"[^\w\- ]", "", heading.strip().lower())
    return h.replace(" ", "-")


def check_catalog() -> None:
    cat = json.loads((ROOT / "catalog.json").read_text(encoding="utf-8"))
    version = (ROOT / "VERSION").read_text().strip()
    tag = f"v{version}"
    check("draft" not in cat and cat.get("version") == version and cat.get("tag") == tag
          and tag in cat["archive"]["url"] and tag in cat["guide"], f"каталог: версия и тег = {tag}, без draft")
    check((RELEASE / "catalog.json").read_bytes() == (ROOT / "catalog.json").read_bytes(), "каталог: копия в release/ = catalog.json")
    ids = [i["id"] for i in cat["items"]]
    sections = {s["id"] for s in cat["sections"]}
    check(len(ids) == len(set(ids)) and all(i["section"] in sections for i in cat["items"]),
          f"каталог: {len(ids)} пунктов, id уникальны, разделы существуют")
    refs = [r for i in cat["items"] for r in i.get("requires", []) + i.get("recommends", [])]
    check(all(r in ids for r in refs), "каталог: requires и recommends ссылаются на существующие пункты")
    task = (ROOT / "AGENT-TASK.md").read_text(encoding="utf-8")
    table = task.split("## Пункты комплекта", 1)[1].split("\n## ", 1)[0]
    in_task = set(re.findall(r"`([a-z0-9-]+)`", table.split("|---|---|", 1)[1]))
    check(set(ids) <= in_task, f"каталог: все id есть в AGENT-TASK.md «Пункты комплекта» {sorted(set(ids) - in_task)}")
    bad_ver = [i["id"] for i in cat["items"] if (ROOT / "plugins" / i["id"] / "package.json").exists()
               and i.get("version") != json.loads((ROOT / "plugins" / i["id"] / "package.json").read_text())["version"]]
    plugins = [d.name for d in (ROOT / "plugins").iterdir() if (d / "package.json").exists()]
    check(not bad_ver and set(plugins) <= set(ids), f"каталог: все плагины есть, версии = package.json {bad_ver}")
    guide = (ROOT / "GUIDE.md").read_text(encoding="utf-8")
    anchors = {slug(m) for m in re.findall(r"^#{1,6} (.+)$", re.sub(r"```.*?```", "", guide, flags=re.S), re.M)}
    bad_docs = [i["id"] for i in cat["items"] if (i["docs"].lstrip("#") not in anchors if i["docs"].startswith("#")
                                                  else not (ROOT / i["docs"]).exists())]
    check(not bad_docs, f"каталог: docs — существующие якоря GUIDE.md или файлы {bad_docs}")
    need = ["{{install}}", "{{skip}}", "{{repo}}", "{{tag}}", "{{archive_url}}"]
    check(all(all(n in cat["prompts"][k] for n in need) for k in ("has_bb", "no_bb")),
          "каталог: в обоих промптах есть подстановки списков, репозитория, тега и архива")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--private-patterns", type=Path)
    args = ap.parse_args()

    zpath = RELEASE / "08-BB-VADIM-KIT.zip"
    z = zipfile.ZipFile(zpath)
    names = z.namelist()
    check(z.testzip() is None, "ZIP: CRC")
    check(len(names) == len(set(names)) and all(n.startswith(PREFIX) and ".." not in n.split("/") for n in names),
          f"ZIP: пути внутри {PREFIX}, без повторов и ..")
    check(all(((i.external_attr >> 16) & 0o170000) != 0o120000 for i in z.infolist()), "ZIP: нет symlink")
    check(not [n for n in names if re.search(r"/(node_modules|dist)/|\.DS_Store$", n)], "ZIP: нет node_modules, dist, .DS_Store")

    m = json.loads(z.read(PREFIX + "MANIFEST.json"))
    listed = {f["path"]: f for f in m["files"]}
    actual = {n[len(PREFIX):] for n in names} - {"MANIFEST.json"}
    check(set(listed) == actual, f"MANIFEST: состав = ZIP ({len(listed)} файлов)")
    bad = [p for p, f in listed.items() if p in actual and (
        len(b := z.read(PREFIX + p)) != f["bytes"] or hashlib.sha256(b).hexdigest() != f["sha256"])]
    check(not bad, f"MANIFEST: размеры и SHA-256 {bad[:3]}")
    check(z.read(PREFIX + "MANIFEST.json") == (ROOT / "MANIFEST.json").read_bytes(), "MANIFEST в ZIP = MANIFEST.json репозитория")
    check(m.get("version") == (ROOT / "VERSION").read_text().strip(), f"MANIFEST: version = VERSION ({m.get('version')})")

    guide = (ROOT / "GUIDE.md").read_bytes()
    check(z.read(PREFIX + "GUIDE.md") == guide, "GUIDE.md в ZIP = GUIDE.md")
    check((RELEASE / "08-BB-VADIM-SETUP.md").read_bytes() == guide, "08-BB-VADIM-SETUP.md = GUIDE.md")

    agent_path = RELEASE / "08-BB-AGENT-SETUP.md"
    agent = agent_path.read_text(encoding="utf-8")
    js = re.search(r"```js\n(.*?)\n```", agent, re.S)
    check(bool(js) and js.group(1) == (ROOT / "scripts/extract-kit.mjs").read_text(encoding="utf-8").rstrip("\n"),
          "файл агента: встроенный скрипт = scripts/extract-kit.mjs")
    order = agent.split("## Порядок", 1)[1].split("\n## Встроенный комплект", 1)[0]
    task = (ROOT / "AGENT-TASK.md").read_text(encoding="utf-8").split("## Порядок", 1)[1].rstrip()
    check(order.rstrip() == task, "файл агента: «## Порядок» = AGENT-TASK.md")
    zip_sha = hashlib.sha256(zpath.read_bytes()).hexdigest()
    check(f"KIT_SHA256: {zip_sha}" in agent, "файл агента: KIT_SHA256 = ZIP")

    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "extract-kit.mjs"
        script.write_text(js.group(1) + "\n" if js else "", encoding="utf-8")
        out = Path(tmp) / "папка с пробелом" / "комплект.zip"
        run = lambda: subprocess.run(["node", str(script), str(agent_path), str(out)], capture_output=True, text=True)
        r1 = run()
        check(r1.returncode == 0 and out.exists() and hashlib.sha256(out.read_bytes()).hexdigest() == zip_sha,
              "извлечение: путь с пробелом и кириллицей, SHA-256 совпал")
        check(run().returncode == 0, "извлечение: повторный запуск")
        out.write_bytes(b"other")
        r3 = run()
        check(r3.returncode != 0 and out.read_bytes() == b"other", "извлечение: чужой файл не перезаписан")

    check_catalog()

    patterns = list(GENERIC)
    if args.private_patterns:
        patterns += ["(?i:" + l.strip() + ")" for l in args.private_patterns.read_text(encoding="utf-8").splitlines()
                     if l.strip() and not l.startswith("#")]
    pat = re.compile("|".join(f"(?:{p})" for p in patterns))
    texts = {n[len(PREFIX):]: z.read(n) for n in names}
    for p in subprocess.run(["git", "-C", str(ROOT), "ls-files", "--cached", "--others", "--exclude-standard"],
                            capture_output=True, text=True, check=True).stdout.split():
        if p.startswith(("scripts/", ".gitignore")) and p != "scripts/check-kit.py":
            texts[p] = (ROOT / p).read_bytes()
    hits = []
    for p, b in texts.items():
        if p in SKIP:
            continue
        try:
            t = b.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for i, line in enumerate(t.splitlines(), 1):
            for mm in pat.finditer(line):
                if mm.group(0) not in FICTIONAL_IDS:
                    hits.append(f"{p}:{i}: {mm.group(0)!r}")
                    break
    for h in hits[:30]:
        print("     " + h)
    extra = " + частные шаблоны" if args.private_patterns else " (без частных шаблонов)"
    check(not hits, f"поиск личного{extra}: {len(hits)} совпадений")

    print(f"\n{'FAIL' if failures else 'OK'}: {len(failures)} ошибок")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
