/**
 * RESTORA Demo Café sample dataset (prisma/demo-cafe, docs/demo-cafe-data.md):
 * built through the real services on this run's fresh database (SQLite, or
 * PostgreSQL under `npm run test:pg`) next to another restaurant's data;
 * idempotent; consistent (every recipe line points at a real ingredient, every
 * price and quantity is valid); costed by RESTORA's own costing; sold through the
 * normal POS order + payment rules with stock deducted by the recipes; and reset
 * without touching anything outside the demo organization.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { D, num } from "@/domain/money";
import { createMenuItem, listMenu } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { currentQuantity, lowStock } from "@/server/services/inventory";
import { menuItemCostAndMargin } from "@/server/services/recipe";
import { DEMO_CAFE, DEMO_IN_USE, DEMO_RECIPE_NOTE, demoCafeCounts, findDemoCafe, seedDemoCafe } from "../../prisma/demo-cafe/seed";
import { DEMO_CATEGORIES, DEMO_INGREDIENTS, DEMO_MENU, DEMO_MODIFIER_GROUPS, DEMO_RECIPES, DEMO_SAMBAR, DEMO_SUPPLIERS } from "../../prisma/demo-cafe/data";

const RUN = Date.now().toString(36);
const PASSWORD = "demo-cafe-test-password";
let orgId: string, outletId: string;
let cashier: AccessContext;
let other: { orgId: string; itemId: string; customerId: string };

const rate = (sku: string) => DEMO_INGREDIENTS.find((i) => i.sku === sku)!.rate;
const sambarCostPerKg = DEMO_SAMBAR.lines.reduce((s, l) => s + l.qty * rate(l.sku), 0) / DEMO_SAMBAR.yieldKg;
/** The plate cost of one serving, worked out by hand from data.ts. */
const expectedCost = (item: string) => DEMO_RECIPES.find((r) => r.item === item)!.lines.reduce((s, l) => s + ("sub" in l ? l.qty * sambarCostPerKg : l.qty * rate(l.sku)), 0);

beforeAll(async () => {
  // Another restaurant in the same database: the demo must never touch it.
  const o = await prisma.organization.create({ data: { name: `Real Restaurant ${RUN}` } });
  const outlet = await prisma.outlet.create({ data: { organizationId: o.id, code: `RR${RUN}`.slice(0, 12), name: "Real" } });
  const sys = systemContext(o.id, [outlet.id]);
  const item = await createMenuItem(sys, { name: "Masala Chai", price: 25, taxPct: 5 });
  const customer = await prisma.customer.create({ data: { organizationId: o.id, name: "Regular", phone: `98${RUN.slice(-8).replace(/\D/g, "1").padEnd(8, "1")}` } });
  other = { orgId: o.id, itemId: item.id, customerId: customer.id };
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("seeding the demo café", () => {
  it("builds the whole dataset in its own organization", async () => {
    const r = await seedDemoCafe(prisma, { password: PASSWORD });
    expect(r.created).toBe(true);
    orgId = r.organizationId;
    outletId = r.outletId;
    expect(r).toMatchObject({
      categories: DEMO_CATEGORIES.length,
      items: DEMO_MENU.length,
      variants: DEMO_MENU.reduce((n, i) => n + (i.variants?.length ?? 0), 0),
      modifierGroups: DEMO_MODIFIER_GROUPS.length,
      ingredients: DEMO_INGREDIENTS.length,
      recipes: DEMO_RECIPES.length + 1, // + the sambar sub-recipe
      suppliers: DEMO_SUPPLIERS.length,
      tables: DEMO_CAFE.tableCodes.length,
    });
    expect(DEMO_MENU.length).toBeGreaterThanOrEqual(25);
    expect(DEMO_RECIPES.length + 1).toBeGreaterThanOrEqual(10);
    const m = (await prisma.membership.findMany({ where: { organizationId: orgId }, include: { user: { select: { email: true } } } })).find((x) => x.role === "CASHIER")!;
    cashier = { userId: m.userId, organizationId: orgId, outletIds: [outletId], roles: ["CASHIER"], outletRoles: { [outletId]: ["CASHIER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  }, 300_000);

  it("seeding again changes nothing and duplicates nothing", async () => {
    const before = await demoCafeCounts(prisma, orgId);
    const rows = { audit: await prisma.auditLog.count({ where: { organizationId: orgId } }), ledger: await prisma.inventoryLedger.count({ where: { organizationId: orgId } }), users: await prisma.user.count({ where: { organizationId: orgId } }) };
    const again = await seedDemoCafe(prisma, { password: PASSWORD });
    expect(again.created).toBe(false);
    expect(again.organizationId).toBe(orgId);
    expect(await demoCafeCounts(prisma, orgId)).toEqual(before);
    expect(await prisma.organization.count({ where: { name: DEMO_CAFE.orgName } })).toBe(1);
    expect({ audit: await prisma.auditLog.count({ where: { organizationId: orgId } }), ledger: await prisma.inventoryLedger.count({ where: { organizationId: orgId } }), users: await prisma.user.count({ where: { organizationId: orgId } }) }).toEqual(rows);
  });

  it("every menu item, recipe, ingredient and table belongs to the demo organization; prices are valid", async () => {
    const items = await prisma.menuItem.findMany({ where: { posCode: { startsWith: "DEMO-" } }, include: { variants: true } });
    expect(items).toHaveLength(DEMO_MENU.length);
    for (const i of items) {
      expect(i.organizationId).toBe(orgId);
      expect(D(i.price).gt(0)).toBe(true);
      for (const v of i.variants) expect(D(i.price).plus(D(v.priceDelta)).gt(0)).toBe(true);
    }
    expect(await prisma.material.count({ where: { sku: { startsWith: "DEMO-" }, organizationId: { not: orgId } } })).toBe(0);
    const tables = await prisma.restaurantTable.findMany({ where: { organizationId: orgId } });
    expect(tables.every((t) => t.outletId === outletId && t.qrToken && t.qrToken.length >= 22)).toBe(true);
    // The other restaurant's same-named item is its own.
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: other.itemId } })).organizationId).toBe(other.orgId);
  });

  it("every recipe is approved, points at real demo records, has valid quantities and says it is a sample", async () => {
    const recipes = await prisma.recipe.findMany({ where: { organizationId: orgId }, include: { menuItem: true, versions: { include: { lines: { include: { material: true, subRecipe: true } } } } } });
    expect(recipes).toHaveLength(DEMO_RECIPES.length + 1);
    for (const r of recipes) {
      expect(r.versions).toHaveLength(1);
      const v = r.versions[0];
      expect(v.status).toBe("APPROVED");
      expect(v.estimated).toBe(false);
      expect(v.notes).toContain(DEMO_RECIPE_NOTE);
      expect(v.notes).toMatch(/not verified/i);
      expect(v.notes).not.toMatch(/allergen-free|chef-approved/i);
      if (r.outputType === "MENU_ITEM") expect(r.menuItem?.organizationId).toBe(orgId);
      else expect((await prisma.material.findUniqueOrThrow({ where: { id: r.outputMaterialId! } })).organizationId).toBe(orgId);
      expect(v.lines.length).toBeGreaterThan(0);
      for (const l of v.lines) {
        expect(D(l.qty).gt(0)).toBe(true);
        if (l.componentType === "MATERIAL") expect(l.material?.organizationId).toBe(orgId);
        else expect(l.subRecipe?.organizationId).toBe(orgId);
      }
    }
    // A recipe with milk in its ingredient list says so (and nothing claims to be allergen-free).
    const chai = recipes.find((r) => r.name === "Masala Chai")!;
    expect(chai.versions[0].notes).toContain("contains: milk");
  });

  it("recipe costs come from RESTORA's costing and match the sample data worked out by hand", async () => {
    const sys = systemContext(orgId, [outletId]);
    for (const item of ["Masala Chai", "Masala Dosa", "Paneer Butter Masala", "Butter Naan", "Café Latte", "Veg Burger", "French Fries", "Lemon Iced Tea"]) {
      const menuItem = await prisma.menuItem.findFirstOrThrow({ where: { organizationId: orgId, name: item } });
      const c = await menuItemCostAndMargin(prisma, sys, menuItem.id, outletId);
      expect(c.complete).toBe(true);
      expect(c.cost!).toBeCloseTo(expectedCost(item), 2);
      expect(c.margin!).toBeGreaterThan(0);
    }
  });

  it("the low-stock list shows what opened below its reorder level", async () => {
    const low = await lowStock(prisma, systemContext(orgId, [outletId]), outletId);
    const expected = DEMO_INGREDIENTS.filter((i) => i.opening <= i.reorderLevel).map((i) => i.sku).sort();
    expect(expected).toContain("DEMO-PANEER");
    expect(low.map((r) => r.material.sku).sort()).toEqual(expected);
  });
});

describe("the sample data is internally consistent (no database)", () => {
  const unitOf = (sku: string) => DEMO_INGREDIENTS.find((i) => i.sku === sku)?.unit;

  it("every recipe names a menu item and known ingredients; no item has two recipes", () => {
    const names = DEMO_RECIPES.map((r) => r.item);
    expect(new Set(names).size).toBe(names.length);
    for (const r of DEMO_RECIPES) {
      expect(DEMO_MENU.some((m) => m.name === r.item), r.item).toBe(true);
      for (const l of r.lines) if (!("sub" in l)) expect(unitOf(l.sku), `${r.item}: ${l.sku}`).toBeDefined();
    }
    expect(new Set(DEMO_INGREDIENTS.map((i) => i.sku)).size).toBe(DEMO_INGREDIENTS.length);
    expect(new Set(DEMO_MENU.map((i) => i.posCode)).size).toBe(DEMO_MENU.length);
  });

  it("quantities are in the ingredient's base unit: kg / L per serving below 1, pieces whole", () => {
    // A gram or millilitre figure typed as kg / L (e.g. 150 instead of 0.15) would deduct a thousand times the stock.
    for (const r of DEMO_RECIPES) {
      for (const l of r.lines) {
        expect(l.qty, `${r.item}`).toBeGreaterThan(0);
        if ("sub" in l) expect(l.qty, `${r.item}: sambar kg`).toBeLessThan(1);
        else if (unitOf(l.sku) === "pc") expect(Number.isInteger(l.qty), `${r.item}: ${l.sku} pieces`).toBe(true);
        else expect(l.qty, `${r.item}: ${l.sku} ${unitOf(l.sku)}`).toBeLessThan(1);
      }
    }
    for (const g of DEMO_MODIFIER_GROUPS) for (const o of g.options) if (o.material) expect(o.material.qty).toBeLessThan(1);
  });

  it("every recipe's food cost is a plausible share of its sample price (2–45 %)", () => {
    for (const r of DEMO_RECIPES) {
      const price = DEMO_MENU.find((m) => m.name === r.item)!.price;
      const share = expectedCost(r.item) / price;
      expect(share, `${r.item}: ₹${expectedCost(r.item).toFixed(2)} of ₹${price}`).toBeGreaterThan(0.02);
      expect(share, `${r.item}: ₹${expectedCost(r.item).toFixed(2)} of ₹${price}`).toBeLessThan(0.45);
    }
  });

  it("is a café menu: at least 30 items over at least 8 categories, at least 20 dish recipes, every category used", () => {
    expect(DEMO_MENU.length).toBeGreaterThanOrEqual(30);
    expect(DEMO_CATEGORIES.length).toBeGreaterThanOrEqual(8);
    expect(DEMO_RECIPES.length).toBeGreaterThanOrEqual(20);
    for (const c of DEMO_CATEGORIES) expect(DEMO_MENU.some((m) => m.category === c), c).toBe(true);
    for (const m of DEMO_MENU) expect((DEMO_CATEGORIES as readonly string[]).includes(m.category), m.name).toBe(true);
  });
});

describe("a demo sale through the normal POS rules", () => {
  it("the cashier sees the demo menu; an order sent to the kitchen and paid deducts exactly its recipes' ingredients", async () => {
    const menu = await listMenu(prisma, cashier, { outletId, activeOnly: true });
    expect(menu).toHaveLength(DEMO_MENU.length);
    const byName = (n: string) => menu.find((i) => i.name === n)!;
    const chai = byName("Masala Chai");
    const large = chai.variants.find((v) => v.name === "Large")!;
    const dosa = byName("Masala Dosa");
    const paneer = await prisma.material.findFirstOrThrow({ where: { organizationId: orgId, sku: "DEMO-PANEER" } });
    const milk = await prisma.material.findFirstOrThrow({ where: { organizationId: orgId, sku: "DEMO-MILK" } });
    const potato = await prisma.material.findFirstOrThrow({ where: { organizationId: orgId, sku: "DEMO-POTATO" } });
    const tomato = await prisma.material.findFirstOrThrow({ where: { organizationId: orgId, sku: "DEMO-TOMATO" } });
    const before = { milk: await currentQuantity(prisma, cashier, outletId, milk.id), potato: await currentQuantity(prisma, cashier, outletId, potato.id), tomato: await currentQuantity(prisma, cashier, outletId, tomato.id), paneer: await currentQuantity(prisma, cashier, outletId, paneer.id) };

    const table = await prisma.restaurantTable.findFirstOrThrow({ where: { organizationId: orgId, code: "D01" } });
    const order = await placeOrder(cashier, {
      outletId, channel: "DINE_IN", tableId: table.id, submit: true, idempotencyKey: `demo-sale-${RUN}`,
      items: [{ menuItemId: chai.id, variantId: large.id, qty: 2 }, { menuItemId: dosa.id, qty: 1 }],
    });
    expect(order.kots.length).toBeGreaterThan(0);
    // Chai goes to the bar, the dosa to the kitchen.
    expect(new Set((await prisma.kot.findMany({ where: { orderId: order.id }, include: { station: true } })).map((k) => k.station?.name))).toEqual(new Set(["BAR", "KITCHEN"]));
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(num(fresh.total)).toBeCloseTo((2 * (30 + 15) + 110) * 1.05, 2);
    // Nothing is deducted before the order is paid.
    expect(D(await currentQuantity(prisma, cashier, outletId, milk.id)).eq(before.milk)).toBe(true);

    const pay = await createPayment(cashier, order.id, { method: "CASH", amount: num(fresh.total), idempotencyKey: `demo-pay-${RUN}` });
    await verifyPayment(cashier, pay.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");

    // Large chai = 1.5 × the recipe, twice: 0.3 L milk. The dosa's sambar explodes into its tomato (0.15 / 2 kg batch).
    const after = (id: string) => currentQuantity(prisma, cashier, outletId, id);
    expect(num(D(before.milk).minus(await after(milk.id)))).toBeCloseTo(2 * 1.5 * 0.1, 6);
    expect(num(D(before.potato).minus(await after(potato.id)))).toBeCloseTo(0.12, 6); // the dosa masala only (sambar has none)
    expect(num(D(before.tomato).minus(await after(tomato.id)))).toBeCloseTo((0.15 / DEMO_SAMBAR.yieldKg) * 0.2, 6);
    expect(D(await after(paneer.id)).eq(before.paneer)).toBe(true);
    expect(await prisma.inventoryLedger.count({ where: { organizationId: orgId, txnType: "SALE_CONSUMPTION", sourceId: order.id } })).toBeGreaterThan(0);
    // Stock never goes negative in the demo.
    const negative = await prisma.inventoryLedger.groupBy({ by: ["materialId"], where: { organizationId: orgId, outletId }, _sum: { qty: true } });
    expect(negative.filter((g) => D(g._sum.qty ?? 0).lt(0))).toEqual([]);
  });
});

describe("resetting the demo café", () => {
  it("deletes and rebuilds only the demo organization; the other restaurant is untouched", async () => {
    const otherBefore = { items: await prisma.menuItem.count({ where: { organizationId: other.orgId } }), customers: await prisma.customer.count({ where: { organizationId: other.orgId } }) };
    const r = await seedDemoCafe(prisma, { password: PASSWORD, reset: true });
    expect(r.created).toBe(true);
    expect(r.organizationId).not.toBe(orgId);
    expect(await prisma.organization.findUnique({ where: { id: orgId } })).toBeNull();
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(0);
    expect((await findDemoCafe(prisma))?.id).toBe(r.organizationId);
    expect({ items: await prisma.menuItem.count({ where: { organizationId: other.orgId } }), customers: await prisma.customer.count({ where: { organizationId: other.orgId } }) }).toEqual(otherBefore);
    expect(await prisma.customer.findUnique({ where: { id: other.customerId } })).not.toBeNull();
    orgId = r.organizationId;
  }, 300_000);

  it("refuses to reset once someone else has an account in it (it is no longer a pure demo)", async () => {
    await prisma.user.create({ data: { organizationId: orgId, email: `real-${RUN}@example.test`, name: "Real staff", passwordHash: "x" } });
    await expect(seedDemoCafe(prisma, { password: PASSWORD, reset: true })).rejects.toThrow(DEMO_IN_USE);
    expect((await findDemoCafe(prisma))?.id).toBe(orgId);
  });
});
