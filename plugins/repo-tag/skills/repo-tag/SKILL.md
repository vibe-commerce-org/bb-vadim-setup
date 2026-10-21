---
name: repo-tag
description: "Change or explain the repository tags on thread rows in the bb sidebar (Repo tags_vibecom plugin): tag length on the desktop and on the phone, why two repositories share a tag, why tags disappeared after a bb update."
---

# Repo tags_vibecom

The plugin draws a short tag with the thread's repository (bb project) name on every row of the sidebar thread
list, right after the model icon: the first characters of the project name without the `_code` suffix, in a color
of the project's own. Threads of the personal workspace have no tag.

## Settings

```sh
bb plugin config repo-tag                          # show both values
bb plugin config repo-tag set tagLength 6          # characters in a wide window, 2–16, default 3
bb plugin config repo-tag set compactTagLength 4   # characters in a window narrower than 768 px, default 3
bb plugin config repo-tag unset tagLength          # back to the default
```

Changes apply in every open window at once; no reload needed.

## Explaining what the user sees

- Two repositories with the same tag text (for example both read `vib`) differ by color. With a longer tag the
  longer name gets its end when it fits (`online·vip`).
- Colors are handed out oldest project first, so adding a project does not recolor older ones; changing
  `compactTagLength` can reshuffle colors inside groups of equal tags.
- No tags at all after a bb update: the plugin relies on the row markup of bb's built-in Thread list
  (`a[data-sidebar-thread-id]`, `.bb-thread-title`). Run the plugin's tests (`npm test` in the plugin folder);
  `tests/bb-markup.test.ts` names the marker that is gone. Rows still work without tags.
