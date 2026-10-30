// bb-plugin-composer-labels — frontend entry.
//
// The plugin's whole behaviour is its imported stylesheet (app.css): bb hides
// the reasoning effort in a narrow composer, and only CSS can bring it back —
// there is no slot that replaces the composer's model chip.
//
// bb's documented home for "styling or decorating existing app-shell DOM" is a
// content script, and the host retains a plugin's imported stylesheet for every
// generation that registers one. So the plugin registers a content script whose
// mount has nothing left to do.
//
// React and @get-bb/plugin-sdk/app are provided by the BB app at load time;
// `bb plugin build` compiles this file into dist/app.js + dist/app.css.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "composer-effort-label",
    mount() {
      // Nothing to install: the stylesheet above is the install, and the host
      // keeps it for as long as this frontend generation lives.
    },
  });
});
