// Pure: the Pult page's tabs and their subPath. «Приоритеты» comes first and
// opens by default (the user, 13.10): the bare page path "" is that tab. The old
// "priorities" link of 0.1 still lands there.

export type Tab = "priorities" | "queue" | "map";

/** In the order the page shows them. */
export const TAB_ORDER: readonly Tab[] = ["priorities", "queue", "map"];

export const TAB_SUB_PATH: Record<Tab, string> = { priorities: "", queue: "queue", map: "map" };

export function tabOf(subPath: string): Tab {
  const head = subPath.replace(/^\/+/, "").split("/")[0] ?? "";
  return head === "queue" || head === "map" ? head : "priorities";
}
