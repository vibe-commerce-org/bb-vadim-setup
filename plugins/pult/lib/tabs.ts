// Pure: the Pult page's tabs and their subPath. «Лента» comes first and opens
// by default (the user, 16.10; this replaces 13.10, when «Приоритеты» opened): the
// bare page path "" is that tab. The «Приоритеты» tab now lives at "priorities";
// the "feed" link of the first 0.3.0 build still lands on «Лента».

export type Tab = "feed" | "priorities" | "queue" | "map";

/** In the order the page shows them. */
export const TAB_ORDER: readonly Tab[] = ["feed", "priorities", "queue", "map"];

export const TAB_SUB_PATH: Record<Tab, string> = { feed: "", priorities: "priorities", queue: "queue", map: "map" };

export function tabOf(subPath: string): Tab {
  const head = subPath.replace(/^\/+/, "").split("/")[0] ?? "";
  return head === "priorities" || head === "queue" || head === "map" ? head : "feed";
}
