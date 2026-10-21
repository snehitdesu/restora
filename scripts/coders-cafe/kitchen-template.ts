/**
 * Writes the Coders' Cafe kitchen data-collection sheets (CSV, opens in Excel /
 * Google Sheets) from the DRAFT recipes, so the kitchen can confirm or correct
 * every estimate:
 *
 *   docs/kitchen-recipe-data/recipe-lines.csv  one row per draft recipe line
 *   docs/kitchen-recipe-data/ingredients.csv   one row per ingredient: cost + allergen evidence
 *   docs/kitchen-recipe-data/size-factors.csv  one row per menu size (Medium / Large ...)
 *   docs/kitchen-recipe-data/not-covered.csv   dishes with no draft (contents unknown)
 *
 *   npx tsx scripts/coders-cafe/kitchen-template.ts
 *
 * The "draft" columns are RESTORA's ESTIMATES from the dish names, never the
 * kitchen's figures; every "confirmed" column starts empty. Nothing here is
 * read back automatically: confirmed values are entered in Recipes (then
 * "Confirm quantities" and approval) and purchase costs come from goods receipts.
 */
import fs from "node:fs";
import path from "node:path";
import { CODERS_CAFE_MENU } from "../../prisma/coders-cafe/menu";
import { DRAFT_INGREDIENTS, DRAFT_RECIPES, NOT_COVERED } from "../../prisma/coders-cafe/recipes";

const out = path.join(process.cwd(), "docs", "kitchen-recipe-data");
fs.mkdirSync(out, { recursive: true });

const cell = (v: string | number | undefined) => {
  const s = v === undefined ? "" : String(v);
  // Quote everything that needs it; a leading = + - @ would be a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const write = (file: string, header: string[], rows: Array<Array<string | number | undefined>>) => {
  fs.writeFileSync(path.join(out, file), "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n");
  console.log(`wrote docs/kitchen-recipe-data/${file} (${rows.length} rows)`);
};

const ingredient = new Map(DRAFT_INGREDIENTS.map((i) => [i.sku, i]));
const category = new Map(CODERS_CAFE_MENU.flatMap((c) => c.items.map((i) => [i.name, c.name] as const)));

write(
  "recipe-lines.csv",
  ["Menu item", "Category", "Size the quantity is for", "Ingredient SKU", "Ingredient", "DRAFT quantity (estimate)", "Unit", "CONFIRMED quantity", "CONFIRMED unit", "Correct? (Y / N / remove)", "Missing ingredient to add", "Portion yield (CONFIRMED)", "Checked by (name)", "Date checked"],
  DRAFT_RECIPES.flatMap((r) =>
    r.lines.map(([sku, qty]) => {
      const i = ingredient.get(sku)!;
      return [r.item, category.get(r.item), "Base size (smallest)", sku, i.name, qty, i.unit, "", "", "", "", "", "", ""];
    }),
  ),
);

write(
  "ingredients.csv",
  ["Ingredient SKU", "Ingredient", "Recipe unit", "DRAFT allergens (NOT VERIFIED)", "CONFIRMED allergens", "Allergen evidence (label photo / supplier sheet / none)", "Brand / supplier", "Purchase pack size", "Pack unit", "Purchase price per pack (Rs, incl. or excl. GST: say which)", "Price date", "Checked by (name)"],
  DRAFT_INGREDIENTS.map((i) => [i.sku, i.name, i.unit, i.allergens?.join("; ") ?? "", "", "", "", "", "", "", "", ""]),
);

write(
  "size-factors.csv",
  ["Menu item", "Size", "Board price (Rs)", "DRAFT factor (today: same as base)", "CONFIRMED factor vs base size (e.g. 1.5)", "Checked by (name)"],
  CODERS_CAFE_MENU.flatMap((c) => c.items.flatMap((i) => (i.sizes ?? []).map((s) => [i.name, s.name, s.price, 1, "", ""]))),
);

// One row per draft recipe, in menu order: the sign-off tracker from estimate to approved version.
const sizes = new Map(CODERS_CAFE_MENU.flatMap((c) => c.items.map((i) => [i.name, (i.sizes ?? []).map((s) => s.name)] as const)));
const menuOrder = CODERS_CAFE_MENU.flatMap((c) => c.items.map((i) => i.name));
write(
  "recipe-signoff.csv",
  ["Category", "Menu item", "DRAFT ingredient lines", "Sizes needing a factor", "Ingredients with DRAFT allergens (NOT VERIFIED)", "Lines weighed + recipe-lines.csv filled (Y/N)", "Size factors filled (Y / N / none)", "Allergen evidence for every ingredient (Y/N)", "Entered in RESTORA + Confirm quantities (Y/N)", "Approved in RESTORA by (name)", "Date approved"],
  [...DRAFT_RECIPES]
    .sort((a, b) => menuOrder.indexOf(a.item) - menuOrder.indexOf(b.item))
    .map((r) => [
      category.get(r.item),
      r.item,
      r.lines.length,
      sizes.get(r.item)?.join("; ") || "none",
      r.lines.map(([sku]) => ingredient.get(sku)!).filter((i) => i.allergens?.length).map((i) => i.name).join("; "),
      "", "", "", "", "", "",
    ]),
);

write(
  "not-covered.csv",
  ["Menu item", "Why there is no draft", "Contents (pieces / sides / drink)", "Checked by (name)"],
  NOT_COVERED.map((n) => [n.item, n.reason, "", ""]),
);
