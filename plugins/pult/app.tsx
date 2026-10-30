// bb-plugin-pult — frontend entry.
//
// One place to see whose move it is across every BB thread:
// - the «Пульт» page in the sidebar (tabs «Лента», «Приоритеты», «Ход за
//   тобой», «Карта»), with the queue size in BB's title bar;
// - the same plugin, tabs and all, as «Пульт» in the side panel of a thread
//   (plus «Этот тред») and of the New thread screen;
// - a sidebar footer button that opens the page;
// - «ход за тобой» marks on the rows of BB's own thread list.
//
// React and @get-bb/plugin-sdk/app are provided by the BB app at load time;
// `bb plugin build` compiles this file into dist/app.js + dist/app.css.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { GaugeGlyph, PultBridge, mountRowMarks, openPultPage } from "@/components/pult/bridge";
import { PultNewThreadPanel, PultPage, PultThreadPanel, QueueBadge } from "@/components/pult/pult-page";

export default definePluginApp((app) => {
  // BB 0.46 ships no "Gauge" glyph; this registration makes the name used
  // below (and by bb.branding.icon) resolve while the app bundle is loaded.
  app.experimental_icons.register({ name: "Gauge", component: GaugeGlyph });

  app.slots.navPanel({
    id: "pult",
    title: "Пульт",
    icon: "Gauge",
    // Routed at /plugins/pult/pult; tabs live in subPath: "" (Лента), "priorities", "queue", "map".
    path: "pult",
    component: PultPage,
    headerContent: QueueBadge,
  });

  // The whole plugin in the right panel («Лента» first, then the other tabs).
  // «flush»: the plugin scrolls its own body under a sticky header.
  app.slots.threadPanelAction({
    id: "pult",
    title: "Пульт",
    icon: "Gauge",
    layout: "flush",
    component: PultThreadPanel,
  });

  app.slots.experimental_newThreadPanelAction({
    id: "pult",
    title: "Пульт",
    icon: "Gauge",
    layout: "flush",
    component: PultNewThreadPanel,
  });

  app.slots.sidebarFooterAction({
    id: "open",
    title: "Пульт",
    icon: "Gauge",
    run() {
      openPultPage();
    },
  });

  // Renders nothing: lends navigation to the footer button and keeps the
  // thread-row marks in step with PULT_CHANGED.
  app.slots.experimental_appOverlay({ id: "bridge", component: PultBridge });

  app.contentScripts.register({ id: "row-marks", mount: mountRowMarks });
});
