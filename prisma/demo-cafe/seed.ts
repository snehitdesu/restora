/**
 * RESTORA Demo Café: builds the SAMPLE dataset of ./data.ts in its own
 * organization, through RESTORA's own services (menu, master data, recipes,
 * opening stock, table QR), so every row and audit record is what an operator
 * would create by hand.
 *
 *  - Additive and isolated: one organization ("RESTORA Demo Café — sample data",
 *    outlet DEMO01) next to whatever else the database holds; no other
 *    organization's row is read for writing, changed or deleted.
 *  - All or nothing: the whole dataset is built in ONE transaction, so a failure
 *    leaves the database exactly as it was (no half-built demo to trip over).
 *  - Idempotent: when the demo organization exists, seeding changes nothing and
 *    reports it. Nothing is ever duplicated.
 *  - Reset: deletes ONLY the demo organization and rebuilds it, and refuses when
 *    anyone other than the demo accounts has been given access to it (that would
 *    mean someone started using it for real).
 *  - Recipes are APPROVED inside this demo organization only, so the demo can show
 *    stock deduction and food cost. Approval here is the seed's (audited as the
 *    system), not a chef's: every recipe's note says it is a sample recipe, not
 *    verified, and allergens are not verified.
 *
 * The CLI (prisma/seed-demo-cafe.ts) adds the opt-in and environment guards.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { hashPassword } from "@/server/auth/password";
import { withAppendOnlyGuardsOff } from "@/server/db/appendOnly";
import { addModifierOption, addVariant, attachModifierGroup, createMenuCategory, createMenuItem, createModifierGroup } from "@/server/services/menu";
import { createMaterial, createMaterialCategory, createTable, createUnit, createVendor, linkVendorMaterial, rotateTableQr } from "@/server/services/masterData";
import { approveRecipeVersion, createRecipe } from "@/server/services/recipe";
import { recordOpeningStock } from "@/server/services/inventory";
import { deleteOrganizationData } from "../coders-cafe/seed";
import { DEMO_CATEGORIES, DEMO_INGREDIENTS, DEMO_MENU, DEMO_MODIFIER_GROUPS, DEMO_PREPARED, DEMO_RECIPES, DEMO_SAMBAR, DEMO_SUPPLIERS, type Allergen, type DemoLine } from "./data";

type Tx = Prisma.TransactionClient;

export const DEMO_CAFE = {
  orgName: "RESTORA Demo Café — sample data",
  outletCode: "DEMO01",
  outletName: "RESTORA Demo Café",
  invoiceSeries: "DEMO",
  timezone: "Asia/Kolkata",
  currency: "INR",
  tableCodes: ["D01", "D02", "D03", "D04", "D05", "D06"],
  users: [
    { email: "owner@demo-cafe.restora.local", name: "Demo Owner", role: "OWNER", outlet: false },
    { email: "manager@demo-cafe.restora.local", name: "Demo Manager", role: "MANAGER", outlet: true },
    { email: "chef@demo-cafe.restora.local", name: "Demo Chef", role: "KITCHEN", outlet: true },
    { email: "cashier@demo-cafe.restora.local", name: "Demo Cashier", role: "CASHIER", outlet: true },
  ],
} as const;

/** Printed on every demo recipe (Recipe → version notes). */
export const DEMO_RECIPE_NOTE = "SAMPLE recipe written for the RESTORA demo café: illustrative quantities, not a chef-verified or weighed recipe. Allergens not verified.";

export type DemoCafeResult = {
  created: boolean;
  organizationId: string;
  outletId: string;
  categories: number;
  items: number;
  variants: number;
  modifierGroups: number;
  ingredients: number;
  recipes: number;
  suppliers: number;
  tables: number;
};

export async function findDemoCafe(db: PrismaClient | Tx) {
  return db.organization.findFirst({ where: { name: DEMO_CAFE.orgName, outlets: { some: { code: DEMO_CAFE.outletCode } } } });
}

/** Counts of what the demo organization holds (the seed's report, and the tests' check). */
export async function demoCafeCounts(db: PrismaClient | Tx, organizationId: string) {
  const outlet = await db.outlet.findFirstOrThrow({ where: { organizationId, code: DEMO_CAFE.outletCode }, select: { id: true } });
  const [categories, items, variants, modifierGroups, ingredients, recipes, suppliers, tables] = await Promise.all([
    db.menuCategory.count({ where: { organizationId } }),
    db.menuItem.count({ where: { organizationId } }),
    db.menuItemVariant.count({ where: { organizationId } }),
    db.modifierGroup.count({ where: { organizationId } }),
    db.material.count({ where: { organizationId, sku: { in: DEMO_INGREDIENTS.map((i) => i.sku) } } }),
    db.recipe.count({ where: { organizationId } }),
    db.vendor.count({ where: { organizationId } }),
    db.restaurantTable.count({ where: { organizationId } }),
  ]);
  return { organizationId, outletId: outlet.id, categories, items, variants, modifierGroups, ingredients, recipes, suppliers, tables };
}

const allergenNote = (allergens: Set<Allergen>) =>
  allergens.size ? `This sample ingredient list contains: ${[...allergens].sort().join(", ")}. Not verified; do not use as allergen information.` : "No allergen is listed in this sample ingredient list. Not verified; do not use as allergen information.";

/**
 * The demo organization's users. Their only purpose is signing in to the demo;
 * the password comes from the CLI (prisma/coders-cafe/seed.ts demoStaffPasswordForCli rules).
 */
async function createDemoUsers(tx: Tx, organizationId: string, outletId: string, password: string) {
  const passwordHash = await hashPassword(password);
  for (const u of DEMO_CAFE.users) {
    const user = await tx.user.create({ data: { organizationId, email: u.email, name: u.name, passwordHash } });
    await tx.membership.create({ data: { organizationId, userId: user.id, outletId: u.outlet ? outletId : null, role: u.role } });
  }
}

async function build(tx: Tx, password: string): Promise<{ organizationId: string; outletId: string }> {
  const org = await tx.organization.create({ data: { name: DEMO_CAFE.orgName, currency: DEMO_CAFE.currency, timezone: DEMO_CAFE.timezone } });
  const outlet = await tx.outlet.create({ data: { organizationId: org.id, code: DEMO_CAFE.outletCode, name: DEMO_CAFE.outletName, currency: DEMO_CAFE.currency, timezone: DEMO_CAFE.timezone, invoiceSeries: DEMO_CAFE.invoiceSeries, openTime: "07:00", closeTime: "23:00" } });
  // Kitchen tickets route by station name. No departments: sales then draw on the outlet's stock (where opening stock lands).
  for (const name of ["KITCHEN", "BAR"]) await tx.kitchenStation.create({ data: { organizationId: org.id, outletId: outlet.id, name, kind: name } });
  await createDemoUsers(tx, org.id, outlet.id, password);
  const ctx: AccessContext = systemContext(org.id, [outlet.id]);

  // Units, ingredient categories, ingredients (base units kg / L / pc).
  const unitId: Record<string, string> = {};
  for (const u of [{ code: "kg", name: "Kilogram", kind: "WEIGHT" }, { code: "L", name: "Litre", kind: "VOLUME" }, { code: "pc", name: "Piece", kind: "COUNT" }] as const) {
    unitId[u.code] = (await createUnit(ctx, u, tx)).id;
  }
  const categoryId: Record<string, string> = {};
  for (const name of new Set([...DEMO_INGREDIENTS.map((i) => i.category), DEMO_PREPARED.category])) categoryId[name] = (await createMaterialCategory(ctx, { name }, tx)).id;
  const material: Record<string, { id: string; allergens: Allergen[] }> = {};
  for (const i of DEMO_INGREDIENTS) {
    const m = await createMaterial(ctx, { sku: i.sku, name: i.name, baseUnitId: unitId[i.unit], categoryId: categoryId[i.category], reorderLevel: i.reorderLevel, minStock: i.reorderLevel, perishable: i.perishable ?? false }, tx);
    material[i.sku] = { id: m.id, allergens: i.allergens ?? [] };
  }
  const sambarOut = await createMaterial(ctx, { sku: DEMO_PREPARED.sku, name: DEMO_PREPARED.name, baseUnitId: unitId[DEMO_PREPARED.unit], categoryId: categoryId[DEMO_PREPARED.category], perishable: true }, tx);

  // Opening stock at the demo rates (the only place a demo price enters RESTORA: it becomes the weighted-average cost).
  await recordOpeningStock(ctx, { outletId: outlet.id, note: "DEMO opening stock: sample quantities at demo-estimate rates (not supplier prices)", lines: DEMO_INGREDIENTS.map((i) => ({ materialId: material[i.sku].id, qty: i.opening, rate: i.rate })) }, tx);

  // Demo suppliers: no contact, tax or bank details; linked to their ingredients at the same demo rates.
  for (const s of DEMO_SUPPLIERS) {
    const v = await createVendor(ctx, { name: s.name, category: s.category, notes: "SAMPLE supplier for the RESTORA demo café; not a real vendor." }, tx);
    for (const sku of s.skus) await linkVendorMaterial(ctx, { vendorId: v.id, materialId: material[sku].id, lastRate: DEMO_INGREDIENTS.find((i) => i.sku === sku)!.rate, preferred: true }, tx);
  }

  // Menu: categories, items, sizes, modifier groups.
  const menuCategoryId: Record<string, string> = {};
  for (const [sortOrder, name] of DEMO_CATEGORIES.entries()) menuCategoryId[name] = (await createMenuCategory(ctx, { name, sortOrder }, tx)).id;
  const groupId: Record<string, string> = {};
  for (const g of DEMO_MODIFIER_GROUPS) {
    groupId[g.name] = (await createModifierGroup(ctx, { name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect }, tx)).id;
    for (const o of g.options) {
      await addModifierOption(ctx, { groupId: groupId[g.name], name: o.name, priceDelta: o.priceDelta ?? 0, ...(o.material ? { materialId: material[o.material.sku].id, materialQty: o.material.qty, unitId: null } : {}) }, tx);
    }
  }
  const itemId: Record<string, string> = {};
  for (const it of DEMO_MENU) {
    const item = await createMenuItem(ctx, { name: it.name, categoryId: menuCategoryId[it.category], description: it.description, price: it.price, station: it.station, posCode: it.posCode, isVeg: it.isVeg }, tx);
    itemId[it.name] = item.id;
    for (const v of it.variants ?? []) await addVariant(ctx, { menuItemId: item.id, name: v.name, priceDelta: v.priceDelta, consumptionFactor: v.consumptionFactor }, tx);
    for (const g of it.modifiers ?? []) await attachModifierGroup(ctx, item.id, groupId[g], tx);
  }

  // Recipes: the sambar sub-recipe first (dishes need its approved version), then one per dish.
  const sambarAllergens = new Set(DEMO_SAMBAR.lines.flatMap((l) => material[l.sku].allergens));
  const sambar = await createRecipe(ctx, {
    name: DEMO_SAMBAR.name, outputType: "SUB_RECIPE", outputMaterialId: sambarOut.id, yieldQty: DEMO_SAMBAR.yieldKg, yieldUnitId: unitId.kg,
    notes: `${DEMO_RECIPE_NOTE} Method: ${DEMO_SAMBAR.method} ${allergenNote(sambarAllergens)}`,
    lines: DEMO_SAMBAR.lines.map((l) => ({ componentType: "MATERIAL", materialId: material[l.sku].id, qty: l.qty })),
  }, tx);
  await approveRecipeVersion(ctx, sambar.version.id, tx);
  const lineIn = (l: DemoLine) => ("sub" in l ? { componentType: "SUB_RECIPE" as const, subRecipeId: sambar.recipe.id, qty: l.qty } : { componentType: "MATERIAL" as const, materialId: material[l.sku].id, qty: l.qty });
  for (const r of DEMO_RECIPES) {
    const allergens = new Set(r.lines.flatMap((l) => ("sub" in l ? [...sambarAllergens] : material[l.sku].allergens)));
    const made = await createRecipe(ctx, {
      name: r.item, outputType: "MENU_ITEM", menuItemId: itemId[r.item], yieldQty: r.yield, yieldUnitId: unitId.pc,
      notes: `${DEMO_RECIPE_NOTE} Method: ${r.method} ${allergenNote(allergens)}`,
      lines: r.lines.map(lineIn),
    }, tx);
    await approveRecipeVersion(ctx, made.version.id, tx);
  }

  // Dine-in tables with random QR tokens (the same issuance staff use). The common QR is left for staff to issue.
  for (const [i, code] of DEMO_CAFE.tableCodes.entries()) {
    const t = await createTable(ctx, { outletId: outlet.id, code, capacity: i < 4 ? 4 : 2 }, tx);
    await rotateTableQr(ctx, t.id, tx);
  }
  return { organizationId: org.id, outletId: outlet.id };
}

/** Thrown when the demo organization has accounts the seed did not create: it is no longer a pure demo. */
export const DEMO_IN_USE = "The demo organization has user accounts the demo seed did not create; it is not reset. Remove those accounts first if it really is disposable.";

/**
 * Build the demo café. Exists already: nothing changes (created: false), unless
 * `reset`, which deletes ONLY the demo organization and builds it again.
 */
export async function seedDemoCafe(db: PrismaClient, opts: { password: string; reset?: boolean }): Promise<DemoCafeResult> {
  const existing = await findDemoCafe(db);
  if (existing && !opts.reset) return { created: false, ...(await demoCafeCounts(db, existing.id)) };
  if (existing) {
    const demoEmails: string[] = DEMO_CAFE.users.map((u) => u.email);
    const others = await db.user.count({ where: { organizationId: existing.id, email: { notIn: demoEmails } } });
    const foreignMembers = await db.membership.count({ where: { organizationId: existing.id, user: { email: { notIn: demoEmails } } } });
    if (others || foreignMembers) throw new Error(DEMO_IN_USE);
    // The audit trail and the ledger refuse deletion (src/server/db/appendOnly.ts); resetting the demo is the one deliberate exception.
    await withAppendOnlyGuardsOff(db, () => deleteOrganizationData(db, existing.id));
  }
  const built = await db.$transaction((tx) => build(tx, opts.password), { maxWait: 30_000, timeout: 300_000 });
  return { created: true, ...(await demoCafeCounts(db, built.organizationId)) };
}
