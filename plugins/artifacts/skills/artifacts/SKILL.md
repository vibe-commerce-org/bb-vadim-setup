---
name: artifacts
description: Manage the persistent important-artifacts panel for the current BB thread.
---

# Важные артефакты

Use the `bb artifacts` command inside the current thread. It stores only explicit metadata in the plugin's SQLite database and never writes a chat message.

```bash
bb artifacts list
bb artifacts add --title "План" --file backlog/plans/2026-10-17-bb-artifacts-panel.md --kind plan
bb artifacts add --title "Документация BB" --url https://github.com/get-bb/bb --kind url
bb artifacts update <id> --title "Новый заголовок"
bb artifacts pin <id>
bb artifacts archive <id>
bb artifacts restore <id>
bb artifacts remove <id>
bb artifacts suggest
```

Paths passed with `--file` are interpreted relative to the current thread workspace. `bb artifacts suggest` checks only a small conventional set (`HANDOFF.md`, `AGENDA.md`, `_status/PROD.md`, `backlog/README.md`, and a bounded list under `backlog/briefs`/`backlog/plans`); it does not index the project and does not add suggestions automatically. URLs must be HTTP(S) without embedded credentials. Files open through BB's own viewer and links through BB's browser preference; the plugin does not fetch or iframe external pages.
