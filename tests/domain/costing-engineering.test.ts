/**
 * Group 4 costing and menu engineering (docs/group4-implementation-map.md),
 * real services against the test database:
 *  F  what a sale freezes on its lines: the recipe cost of ONE standard
 *     portion (no add-ons, variant size divided out) and the line's real cost
 *     of goods (variant scaling + add-ons); later price moves never change them
 *  E  menu engineering: median split of this menu, the proposal's verdicts and
 *     advice, every variant counted as a dish sold, historical vs current plate
 *     cost and price, cost coverage, data sufficiency, unscored dishes with
 *     their reason, authorization, CSV with formula-injection guard
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { recordPurchaseReceipt, getAvgCost } from "@/server/services/inventory";
import { menuEngineering } from "@/server/services/menuEngineering";
import { getReport, exportReportCSV } from "@/server/services/reports";
import { D, money, num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, A: string, B: string, kg: string, g: string;
let sys: AccessContext, owner: AccessContext, mgrA: AccessContext, mgrB: AccessContext, kitchenA: AccessContext;
let rice: string, chicken: string, cheese: string, milk: string, tea: string, bread: string;
let biryani: string, chai: string, sandwich: string, lassi: string, large: string, extraCheese: string;
let n = 0;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function material(name: string) {
  return (await prisma.material.create({ data: { organizationId: orgId, sku: `${name.toUpperCase()}-${RUN}`, name: `${name} ${RUN}`, baseUnitId: kg } })).id;
}
const receive = (materialId: string, quantity: number, rate: number, outletId = A) => recordPurchaseReceipt(sys, { outletId, materialId, quantity, rate, sourceRef: `ce:${RUN}:${++n}` });
async function dish(name: string, price: number, lines: Array<{ materialId: string; qty: number }>, overheadPct = 0) {
  const id = (await createMenuItem(sys, { name, price, taxPct: 5 })).id;
  const r = await createRecipe(owner, { name: `${name} recipe`, outputType: "MENU_ITEM", menuItemId: id, yieldQty: 1, overheadPct, lines: lines.map((l) => ({ componentType: "MATERIAL" as const, ...l })) });
  await approveRecipeVersion(owner, r.version.id);
  return id;
}
async function sell(items: Array<{ menuItemId: string; qty: number; variantId?: string; modifierOptionIds?: string[] }>, outletId = A) {
  const o = await placeOrder(sys, { outletId, channel: "TAKEAWAY", submit: true, items });
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  const p = await createPayment(sys, o.id, { method: "CASH", amount: num(fresh.total) });
  await verifyPayment(sys, p.id);
  return prisma.orderItem.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Costing ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CA${RUN}`, name: "Costing A", timezone: "Asia/Kolkata" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CB${RUN}`, name: "Costing B", timezone: "Asia/Kolkata" } })).id;
  sys = systemContext(orgId, [A, B]);
  owner = { userId: `owner-${RUN}`, organizationId: orgId, outletIds: [A, B], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
  mgrA = member("MANAGER", A); mgrB = member("MANAGER", B); kitchenA = member("KITCHEN", A);
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  g = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "g", kind: "WEIGHT" } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: g, toUnitId: kg, factor: 0.001 } });
  rice = await material("Rice"); chicken = await material("Chicken"); cheese = await material("Cheese");
  milk = await material("Milk"); tea = await material("Tea"); bread = await material("Bread");
  await receive(rice, 20, 90); await receive(chicken, 5, 300); await receive(cheese, 5, 400);
  await receive(milk, 30, 60); await receive(tea, 2, 500); await receive(bread, 10, 50);

  // Biryani: 0.2 kg rice (18) + 0.25 kg chicken (75) = 93, overhead 10% -> plate 102.30.
  biryani = await dish(`Biryani ${RUN}`, 300, [{ materialId: rice, qty: 0.2 }, { materialId: chicken, qty: 0.25 }], 10);
  large = (await addVariant(sys, { menuItemId: biryani, name: "Large", priceDelta: 100, consumptionFactor: 1.5 })).id;
  const grp = await createModifierGroup(sys, { name: `Add-ons ${RUN}`, minSelect: 0, maxSelect: 1 });
  extraCheese = (await addModifierOption(sys, { groupId: grp.id, name: "Extra cheese", priceDelta: 40, materialId: cheese, materialQty: 50, unitId: g })).id; // 50 g = ₹20
  await attachModifierGroup(sys, biryani, grp.id);
  chai = await dish(`Chai ${RUN}`, 80, [{ materialId: milk, qty: 0.15 }, { materialId: tea, qty: 0.01 }]); // 9 + 5 = 14
  sandwich = await dish(`@Sandwich ${RUN}`, 150, [{ materialId: bread, qty: 0.1 }, { materialId: cheese, qty: 0.1 }]); // 5 + 40 = 45
  lassi = await dish(`Lassi ${RUN}`, 60, [{ materialId: milk, qty: 0.5 }]); // 30: food cost 50%
});

afterAll(async () => { await prisma.$disconnect(); });

describe("F. what a sale freezes", () => {
  it("F1 unitCost = recipe cost of one standard portion (no add-ons, size divided out); lineCost = everything the line consumed", async () => {
    const lines = await sell([
      { menuItemId: biryani, qty: 2, modifierOptionIds: [extraCheese] },
      { menuItemId: biryani, qty: 1, variantId: large },
    ]);
    const base = lines.find((l) => !l.variantId)!, big = lines.find((l) => l.variantId === large)!;
    // Plate cost of one standard portion: 93 of ingredients + the recipe's 10% overhead. The extra cheese
    // (₹20 a portion) is not part of it, or the dish would look 20 dearer than its base price pays for.
    expect(D(base.unitCost!).toString()).toBe("102.3");
    expect(D(big.unitCost!).toString()).toBe("102.3"); // per standard portion, not per Large
    // The cost of goods is what left stock: no overhead, add-ons and size included.
    expect(D(base.lineCost!).toString()).toBe("226"); // 2 x 93 + 2 x 50 g cheese at 400/kg
    expect(D(big.lineCost!).toString()).toBe("139.5"); // 1.5 x 93
    // The ledger agrees with the line costs (one movement per material, nothing doubled).
    const ledger = await prisma.inventoryLedger.aggregate({ where: { sourceId: base.orderId, txnType: "SALE_CONSUMPTION" }, _sum: { amount: true } });
    expect(D(ledger._sum.amount ?? 0).neg().toString()).toBe("365.5");
  });

  it("F2 an item without a recipe freezes nothing (its cost is unknown, never guessed)", async () => {
    const soda = (await createMenuItem(sys, { name: `Soda ${RUN}`, price: 40 })).id;
    const [line] = await sell([{ menuItemId: soda, qty: 1 }]);
    expect(line.unitCost).toBeNull();
    expect(line.lineCost).toBeNull();
  });
});

describe("E. menu engineering", () => {
  it("E1 median split of this menu, the proposal's verdicts, every size counted as a dish sold", async () => {
    await sell([{ menuItemId: chai, qty: 10 }]);
    await sell([{ menuItemId: sandwich, qty: 1 }]);
    await sell([{ menuItemId: lassi, qty: 6 }]);
    const r = await menuEngineering(prisma, mgrA, { outletId: A });
    expect(r.sufficient).toBe(true);
    // Volumes 1, 3, 6, 10 -> median 4.5. Margin %: biryani 65.9, chai 82.5, sandwich 70, lassi 50 -> median 67.95.
    expect(r.medianSold).toBe(4.5);
    expect(r.medianMarginPct).toBe(67.95);
    const byId = new Map(r.rows.map((x) => [x.menuItemId, x]));
    expect(byId.get(chai)).toMatchObject({ class: "STAR", sold: 10, plateCost: 14, marginPct: 82.5 });
    expect(byId.get(lassi)).toMatchObject({ class: "PLOWHORSE", sold: 6, foodCostPct: 50, highCost: true });
    expect(byId.get(sandwich)).toMatchObject({ class: "PUZZLE", sold: 1 });
    expect(byId.get(biryani)).toMatchObject({ class: "DOG", sold: 3, ingredientCost: 93, overheadPct: 10, plateCost: 102.3, margin: 197.7, marginPct: 65.9, foodCostPct: 31 });
    expect(byId.get(chai)!.action).toMatch(/Protect and feature/);
    expect(byId.get(lassi)!.action).toMatch(/raise the price a little/);
    expect(byId.get(sandwich)!.action).toMatch(/Market it harder/);
    expect(byId.get(biryani)!.action).toMatch(/Remove it/);
    expect(r.counts).toEqual({ STAR: 1, PLOWHORSE: 1, PUZZLE: 1, DOG: 1 });
    expect(r.highCostItems).toBe(1);
  });

  it("E2 historical plate cost matches today's until an ingredient price moves; the sale-time cost never changes", async () => {
    let row = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === biryani)!;
    expect(row).toMatchObject({ historicalPlateCost: 102.3, costChange: 0, historicalPrice: 300, priceChange: 0, confidence: "FULL", costCoverage: 100 });
    // Real cost of goods sold: 226 + 139.5; revenue 2 x 340 + 400 = 1080 (ex tax, add-on and size prices included).
    expect(row).toMatchObject({ actualCost: 365.5, netRevenue: 1080, actualGrossMargin: 714.5 });
    expect(row.notes).toEqual([]);

    await receive(chicken, 1, 700); // average cost of chicken rises
    const avg = await getAvgCost(prisma, sys, A, chicken);
    // Recipe costing rounds each line to the paisa, then applies the overhead.
    const today = money(D(18).plus(money(D(0.25).times(avg))).times(1.1));
    row = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === biryani)!;
    expect(row.plateCost).toBe(num(today));
    expect(row.historicalPlateCost).toBe(102.3);
    expect(row.costChange).toBe(num(money(today.minus(102.3))));
    expect(row.marginChange).toBe(num(money(D(102.3).minus(today))));
    expect(row.notes[0]).toMatch(/Plate cost rose from ₹102.3/);
    // What was frozen at the sale did not move.
    const frozen = await prisma.orderItem.findMany({ where: { menuItemId: biryani } });
    expect(frozen.map((l) => D(l.unitCost!).toString())).toEqual(["102.3", "102.3"]);
  });

  it("E2b the margin is not dragged down by add-ons, and a later overhead edit never rewrites the history", async () => {
    // Biryani was sold with extra cheese (₹20 of stock a portion, ₹40 on the bill): its menu-engineering margin
    // is the dish's own (price - plate cost), the add-on shows only in the real cost of goods.
    const before = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === biryani)!;
    expect(before.margin).toBe(num(money(D(before.price).minus(before.plateCost))));
    expect(before.actualCost).toBe(365.5); // add-ons and size included, kept apart from the plate cost

    const version = await prisma.recipeVersion.findFirstOrThrow({ where: { recipe: { menuItemId: biryani }, status: "APPROVED" } });
    await prisma.recipeVersion.update({ where: { id: version.id }, data: { overheadPct: 20 } });
    try {
      const after = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === biryani)!;
      const today = money(D(after.ingredientCost).times(1.2));
      expect(after.overheadPct).toBe(20);
      expect(after.plateCost).toBe(num(today));
      expect(after.historicalPlateCost).toBe(before.historicalPlateCost); // the sales were costed at 10% overhead
      expect(after.costChange).toBe(num(money(today.minus(D(before.historicalPlateCost!)))));
      const frozen = await prisma.orderItem.findMany({ where: { menuItemId: biryani } });
      expect(frozen.map((l) => D(l.unitCost!).toString())).toEqual(["102.3", "102.3"]);
    } finally {
      await prisma.recipeVersion.update({ where: { id: version.id }, data: { overheadPct: 10 } });
    }
  });

  it("E3 a price change is measured against what was actually charged", async () => {
    await prisma.menuItem.update({ where: { id: chai }, data: { price: 90 } });
    const row = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === chai)!;
    expect(row).toMatchObject({ price: 90, historicalPrice: 80, priceChange: 10, historicalMarginPct: 82.5 });
    expect(row.marginPctChange).toBe(num(money(D(76).div(90).times(100).minus(82.5))));
    expect(row.notes.some((x) => /Price is ₹90 today against ₹80/.test(x))).toBe(true);
    await prisma.menuItem.update({ where: { id: chai }, data: { price: 80 } });
  });

  it("E4 sales without a frozen cost lower the confidence instead of being guessed", async () => {
    const [line] = await sell([{ menuItemId: sandwich, qty: 3 }]);
    await prisma.orderItem.update({ where: { id: line.id }, data: { unitCost: null, lineCost: null } }); // a sale recorded before costs were frozen
    const row = (await menuEngineering(prisma, mgrA, { outletId: A })).rows.find((x) => x.menuItemId === sandwich)!;
    expect(row).toMatchObject({ sold: 4, costCoverage: 25, confidence: "PARTIAL", actualCost: null, actualGrossMargin: null });
    expect(row.notes.some((x) => /Only 25% of the portions sold carry a sale-time cost/.test(x))).toBe(true);
  });

  it("E5 data sufficiency: unknown costs, no sales in the period, new dishes and dishes without a recipe or price are never classified", async () => {
    // Outlet B has bought nothing: no dish can be costed there, so none is scored (never a margin on a "free" ingredient).
    let atB = await menuEngineering(prisma, mgrB, { outletId: B });
    expect(atB.rows).toEqual([]);
    expect(atB.unscored.find((u) => u.menuItemId === biryani)!.reason).toBe(`No purchase cost at this outlet for Chicken ${RUN}, Rice ${RUN}`);
    expect(atB).toMatchObject({ sufficient: false, insufficientReason: expect.stringMatching(/At least two dishes/) });

    await receive(milk, 5, 60, B); await receive(tea, 1, 500, B);
    atB = await menuEngineering(prisma, mgrB, { outletId: B });
    expect(atB.rows.map((x) => x.menuItemId).sort()).toEqual([chai, lassi].sort());
    expect(atB).toMatchObject({ sufficient: false, insufficientReason: expect.stringMatching(/No dishes were sold/), medianSold: null });
    expect(atB.rows.every((x) => x.class === null && x.label === null)).toBe(true);
    // Lassi still carries the re-cost flag (a fact about its cost, not a verdict).
    expect(atB.rows.find((x) => x.menuItemId === lassi)!.action).toMatch(/above 38%/);

    const from = new Date(Date.now() - 1000);
    const fresh = await dish(`Fresh ${RUN}`, 120, [{ materialId: bread, qty: 0.1 }]);
    const noRecipe = (await createMenuItem(sys, { name: `Water ${RUN}`, price: 20 })).id;
    const free = (await createMenuItem(sys, { name: `Free ${RUN}`, price: 0 })).id;
    const r = await menuEngineering(prisma, mgrA, { outletId: A, from });
    const reason = (id: string) => r.unscored.find((u) => u.menuItemId === id)?.reason;
    expect(reason(fresh)).toMatch(/New in this period/);
    expect(reason(noRecipe)).toBe("No approved recipe");
    expect(reason(free)).toBe("No price");
    expect(r.rows.some((x) => [fresh, noRecipe, free].includes(x.menuItemId))).toBe(false);
  });

  it("E6 one dish cannot be split at a median", async () => {
    const org2 = (await prisma.organization.create({ data: { name: `Costing solo ${RUN}` } })).id;
    const o2 = (await prisma.outlet.create({ data: { organizationId: org2, code: `CS${RUN}`, name: "Solo" } })).id;
    const sys2 = systemContext(org2, [o2]);
    const owner2: AccessContext = { ...owner, userId: `owner2-${RUN}`, organizationId: org2, outletIds: [o2] };
    const unit = (await prisma.unit.create({ data: { organizationId: org2, code: `kg2${RUN}`, name: "kg" } })).id;
    const mat = (await prisma.material.create({ data: { organizationId: org2, sku: `S-${RUN}`, name: "Solo", baseUnitId: unit } })).id;
    const item = (await createMenuItem(sys2, { name: "Only dish", price: 100 })).id;
    const rec = await createRecipe(owner2, { name: "Only", outputType: "MENU_ITEM", menuItemId: item, yieldQty: 1, lines: [{ componentType: "MATERIAL", materialId: mat, qty: 1 }] });
    await approveRecipeVersion(owner2, rec.version.id);
    const r = await menuEngineering(prisma, sys2, { outletId: o2 });
    expect(r).toMatchObject({ sufficient: false, insufficientReason: expect.stringMatching(/At least two dishes/) });
  });

  it("E7 reports access and recipe access are both required; other outlets and organizations see nothing", async () => {
    await expect(menuEngineering(prisma, kitchenA, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(menuEngineering(prisma, mgrB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    const foreign = systemContext((await prisma.organization.create({ data: { name: `Costing foreign ${RUN}` } })).id, []);
    expect((await menuEngineering(prisma, foreign, { outletId: A })).rows).toEqual([]);
  });

  it("E8 the CSV export carries verdict, advice and history, with spreadsheet formulas neutralised", async () => {
    const report = await getReport(prisma, mgrA, "MENU_ENGINEERING", { outletId: A });
    expect(report.rows.length).toBeGreaterThanOrEqual(4);
    const csv = await exportReportCSV(mgrA, "MENU_ENGINEERING", { outletId: A });
    const [header, ...body] = csv.csv.trim().split("\r\n");
    expect(header).toBe("Dish,Category,Price,Plate cost,Margin,Margin %,Food cost %,Sold,Verdict,What to do,Historical plate cost,Cost change,Historical price,Price change,Cost coverage %");
    const sandwichLine = body.find((l) => l.includes("Sandwich"))!;
    expect(sandwichLine.startsWith("'@Sandwich")).toBe(true); // =, +, -, @ never reach a spreadsheet as a formula
    expect(body.find((l) => l.startsWith("Lassi"))).toMatch(/Food cost is above 38%/);
  });
});
