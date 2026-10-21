// bb-plugin-repo-tag — backend entry. The plugin is a frontend feature; the
// server only declares the settings the sidebar tags read (useSettings in
// app.tsx). Changes apply in open windows without a reload.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_COMPACT_LENGTH, DEFAULT_LENGTH, MAX_LENGTH, MIN_LENGTH } from "./lib/labels.ts";

export default async function plugin(bb: BbPluginApi) {
  bb.settings.define({
    tagLength: {
      type: "number",
      label: "Tag length",
      description: `Characters of the repository name in a wide window (${MIN_LENGTH}–${MAX_LENGTH}). Repositories that start alike differ by color; with a longer tag they also get the end of the name when it fits ("online·vip"). Widen the sidebar for longer tags.`,
      default: DEFAULT_LENGTH,
    },
    compactTagLength: {
      type: "number",
      label: "Tag length on a phone",
      description: `Characters in a window narrower than 768 px (${MIN_LENGTH}–${MAX_LENGTH}). The color tells repositories with the same first letters apart.`,
      default: DEFAULT_COMPACT_LENGTH,
    },
  });
}
