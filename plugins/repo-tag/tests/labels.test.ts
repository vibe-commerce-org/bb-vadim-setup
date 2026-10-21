// Tag texts and hues: "_code" dropped, first N characters, head·tail for
// shared beginnings, different hues for tags that still read the same.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUES,
  assignHues,
  baseName,
  buildProjectTags,
  clampLength,
  hash,
  shortLabels,
} from "../lib/labels.ts";

test("baseName drops the _code suffix and nothing else", () => {
  assert.equal(baseName("online-store_code"), "online-store");
  assert.equal(baseName("Shop_code"), "Shop");
  assert.equal(baseName("crm-code"), "crm");
  assert.equal(baseName("Учебный магазин"), "Учебный магазин");
  assert.equal(baseName("_code"), "_code");
  assert.equal(baseName("  site  "), "site");
});

test("clampLength keeps settings in 2..16 and falls back on junk", () => {
  assert.equal(clampLength(10, 3), 10);
  assert.equal(clampLength(1, 3), 2);
  assert.equal(clampLength(40, 3), 16);
  assert.equal(clampLength(7.6, 3), 8);
  assert.equal(clampLength(undefined, 3), 3);
  assert.equal(clampLength("10", 3), 3);
  assert.equal(clampLength(Number.NaN, 3), 3);
});

test("short names stay whole, long ones are cut", () => {
  const labels = shortLabels(["crm", "online-store", "landing"], 10);
  assert.equal(labels.get("crm"), "crm");
  assert.equal(labels.get("online-store"), "online-sto");
  assert.equal(labels.get("landing"), "landing");
});

test("a shared beginning: the shortest keeps it, the others get head·tail", () => {
  const labels = shortLabels(
    ["onlinestore", "onlinestore_vip", "inventory-manager", "inventory-manager-v2", "photo-studio", "photo-studio-lab"],
    10,
  );
  assert.equal(labels.get("onlinestore"), "onlinestor");
  assert.equal(labels.get("onlinestore_vip"), "online·vip");
  assert.equal(labels.get("inventory-manager"), "inventory-");
  assert.equal(labels.get("inventory-manager-v2"), "invento·v2");
  assert.equal(labels.get("photo-studio"), "photo-stud");
  assert.equal(labels.get("photo-studio-lab"), "photo·lab");
  for (const label of labels.values()) assert.ok(Array.from(label).length <= 10, label);
  assert.equal(new Set(labels.values()).size, labels.size);
});

test("when head·tail does not fit, tags stay equal (the hue differs)", () => {
  const labels = shortLabels(["shop_web", "shop-services", "shopping"], 3);
  assert.deepEqual([...new Set(labels.values())], ["sho"]);
});

test("Cyrillic and other non-ASCII names are cut by characters", () => {
  const labels = shortLabels(["Учебный магазин"], 3);
  assert.equal(labels.get("Учебный магазин"), "Уче");
});

test("hues: deterministic, different inside a group of equal tags", () => {
  assert.equal(hash("shop"), hash("shop"));
  const bases = ["shop_web", "shop-services", "shopping", "shop_vip", "crm"];
  const hues = assignHues(bases, (base) => base.slice(0, 3));
  const shopHues = ["shop_web", "shop-services", "shopping", "shop_vip"].map((base) => hues.get(base));
  assert.equal(new Set(shopHues).size, 4);
  for (const index of hues.values()) assert.ok(index >= 0 && index < HUES.length);
  assert.deepEqual(assignHues(bases, (base) => base.slice(0, 3)), hues);
});

test("hues are spread evenly: no hue is used twice before all are used once", () => {
  const bases = Array.from({ length: 25 }, (_, index) => `project-${index}`);
  const hues = assignHues(bases, (base) => base);
  const counts = HUES.map((_, index) => [...hues.values()].filter((hue) => hue === index).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, String(counts));
});

test("a new project does not recolor the older ones", () => {
  const older = ["alpha", "beta", "gamma", "delta"];
  const before = assignHues(older, (base) => base);
  const after = assignHues([...older, "epsilon"], (base) => base);
  for (const base of older) assert.equal(after.get(base), before.get(base), base);
});

test("colors follow project age, not the order the sidebar lists projects in", () => {
  const projects = ["alpha_code", "beta_code", "gamma_code", "delta_code"].map((name, index) => ({
    id: `p${index}`,
    name,
    isPersonal: false,
  }));
  const createdAt = new Map(projects.map((project, index) => [project.id, 1000 + index]));
  const hues = (list: typeof projects) =>
    [...buildProjectTags(list, 10, 3, createdAt)].map(([id, tag]) => `${id}:${tag.hueIndex}`).sort();
  assert.deepEqual(hues([...projects].reverse()), hues(projects));
  assert.deepEqual(hues([projects[2], projects[0], projects[3], projects[1]] as typeof projects), hues(projects));
});

test("more equal tags than hues still get a hue each", () => {
  const bases = Array.from({ length: HUES.length + 3 }, (_, index) => `same${index}`);
  const hues = assignHues(bases, () => "sam");
  assert.equal(hues.size, bases.length);
  assert.equal(new Set(hues.values()).size, HUES.length);
});

test("buildProjectTags: personal project has no tag; wide and compact texts", () => {
  const tags = buildProjectTags(
    [
      { id: "p1", name: "onlinestore_code", isPersonal: false },
      { id: "p2", name: "onlinestore_vip_code", isPersonal: false },
      { id: "p3", name: "erp_code", isPersonal: false },
      { id: "personal", name: "Personal", isPersonal: true },
      { id: "blank", name: "  ", isPersonal: false },
    ],
    10,
    3,
  );
  assert.equal(tags.has("personal"), false);
  assert.equal(tags.has("blank"), false);
  assert.deepEqual(
    { text: tags.get("p2")?.text, compactText: tags.get("p2")?.compactText, name: tags.get("p2")?.name },
    { text: "online·vip", compactText: "onl", name: "onlinestore_vip_code" },
  );
  assert.equal(tags.get("p3")?.text, "erp");
  // p1 and p2 both read "onl" on the phone: their colors differ.
  assert.notEqual(tags.get("p1")?.hueIndex, tags.get("p2")?.hueIndex);
});
