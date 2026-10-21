// bb-plugin-russifier — frontend entry. «Русификатор_vibecom».
//
// - content script «translate»: applies the dictionary to bb's page in every
//   window, browser tab and phone (lib/dom.ts, lib/controller.ts);
// - app overlay «settings»: renders nothing, hands the plugin settings
//   (language, collectMissing) to the controller;
// - command «Язык интерфейса: русский ↔ English»: switches this device only.
//
// React and @get-bb/plugin-sdk/app come from the bb app at load time;
// `bb plugin build` compiles this file and the dictionaries into dist/app.js.
import { useEffect } from "react";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { controller } from "./lib/controller.ts";
import { createEngine } from "./lib/dictionary.ts";

function SettingsBridge() {
  const { values, isLoading } = useSettings();
  useEffect(() => {
    if (!isLoading) controller.setServerSettings(values as Record<string, unknown>);
  }, [isLoading, values]);
  return null;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "translate",
    mount: (ctx) => controller.mount(ctx, createEngine),
  });

  app.slots.experimental_appOverlay({ id: "settings", component: SettingsBridge });

  app.commands.register({
    id: "toggle-language",
    title: "Язык интерфейса: русский ↔ English (interface language)",
    run() {
      controller.toggleLocal();
    },
  });
});
