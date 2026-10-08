/**
 * Group 4 advanced inventory (docs/group4-implementation-map.md), real services
 * against the test database:
 *  M  live stock matrix: materials x departments, values only for cost viewers
 *  C  department stock counts freeze and correct THAT department (fixed: they
 *     compared against the whole outlet and corrected unassigned stock)
 *  P  department P&L and daily costing, reconciled against the ledger
 *  S  supplier price board: per base unit, purchase-unit pricing, only ACTIVE
 *     vendors can be the cheapest; purchase price history; vendor pricing is
 *     never shown to the kitchen
 *  T  stock count variance trend
 *  L  QR stock labels: SKU payload, scan look-up, tenant isolation, no values
 *     for the kitchen
 *  X  CSV exports of the new reports
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { createMenuItem } from "@/server/services/menu";
import { placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { recordPurchaseReceipt, getAvgCost, departmentQuantity, currentQuantity } from "@/server/services/inventory";
import { createGRN, postGRN } from "@/server/services/procurement";
import { createIssue, postIssue, createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount } from "@/server/services/stockOps";
import { createWastage, postWastage } from "@/server/services/wastage";
import { stockMatrix, departmentPnl, dailyCosting } from "@/server/services/departmentCosting";
import { supplierPriceComparison } from "@/server/services/supplierPrices";
import { materialPriceHistory, countVarianceTrend, labelSheet } from "@/server/services/inventoryInsights";
import { lookupStockLabel } from "@/server/services/stockLabels";
import { getReport, exportReportCSV } from "@/server/services/reports";
import { businessDayRange } from "@/domain/time";
import { D, money, num } from "@/domain/money";

const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
let orgId: string, A: string, kg: string, crate: string, store: string, kitchen: string, bar: string;
let sys: AccessContext, owner: AccessContext, mgr: AccessContext, kitchenUser: AccessContext, foreign: AccessContext;
let tomato: string, milk: string, sugar: string, v1: string, v2: string, v3: string;
let n = 0;
const member = (role: string): AccessContext => ({ userId: `${role}-${RUN}`, organizationId: orgId, outletIds: [A], roles: [role], outletRoles: { [A]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const today = () => businessDayRange(new Date(), TZ);
const ledgerSum = async (where: Record<string, unknown>) => D((await prisma.inventoryLedger.aggregate({ where: { organizationId: orgId, outletId: A, ...where }, _sum: { amount: true } }))._sum.amount ?? 0);

async function dish(name: string, price: number, station: "KITCHEN" | "BAR", materialId: string, qty: number) {
  const id = (await createMenuItem(sys, { name, price, taxPct: 5, station })).id;
  const r = await createRecipe(owner, { name: `${name} recipe`, outputType: "MENU_ITEM", menuItemId: id, yieldQty: 1, lines: [{ componentType: "MATERIAL", materialId, qty }] });
  await approveRecipeVersion(owner, r.version.id);
  return id;
}
async function sell(menuItemId: string, qty: number) {
  const o = await placeOrder(sys, { outletId: A, channel: "DINE_IN", submit: true, items: [{ menuItemId, qty }] });
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  const p = await createPayment(sys, o.id, { method: "CASH", amount: num(fresh.total) });
  await verifyPayment(sys, p.id);
}
async function count(materialId: string, physicalQty: number, departmentId?: string) {
  const c = await createStockCount(sys, { outletId: A, departmentId });
  await startStockCount(sys, c.id, { materialIds: [materialId] });
  await enterStockCounts(sys, c.id, [{ materialId, physicalQty }]);
  await submitStockCountForReview(sys, c.id);
  await approveStockCount(sys, c.id);
  return prisma.stockCount.findUniqueOrThrow({ where: { id: c.id }, include: { lines: true } });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `AdvInv ${RUN}`, timezone: TZ } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AI${RUN}`, name: "Adv A", timezone: TZ } })).id;
  sys = systemContext(orgId, [A]);
  owner = { userId: `owner-${RUN}`, organizationId: orgId, outletIds: [A], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
  mgr = member("MANAGER"); kitchenUser = member("KITCHEN");
  foreign = systemContext((await prisma.organization.create({ data: { name: `AdvInv other ${RUN}` } })).id, []);
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  crate = (await prisma.unit.create({ data: { organizationId: orgId, code: `crate${RUN}`, name: "crate", kind: "COUNT" } })).id;
  store = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Store", kind: "STORE" } })).id;
  kitchen = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Kitchen", kind: "KITCHEN" } })).id;
  bar = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Bar", kind: "BAR" } })).id;
  tomato = (await prisma.material.create({ data: { organizationId: orgId, sku: `TOM-${RUN.toUpperCase()}`, name: `Tomato ${RUN}`, baseUnitId: kg, purchaseUnitId: crate, reorderLevel: 10 } })).id;
  milk = (await prisma.material.create({ data: { organizationId: orgId, sku: `MLK-${RUN.toUpperCase()}`, name: `Milk ${RUN}`, baseUnitId: kg } })).id;
  sugar = (await prisma.material.create({ data: { organizationId: orgId, sku: `SUG-${RUN.toUpperCase()}`, name: `Sugar ${RUN}`, baseUnitId: kg, reorderLevel: 5 } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: crate, toUnitId: kg, factor: 12, materialId: tomato } });
  v1 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg One ${RUN}`, status: "ACTIVE" } })).id;
  v2 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg Two ${RUN}`, status: "ACTIVE" } })).id;
  v3 = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg Banned ${RUN}`, status: "BLACKLISTED", active: false } })).id;
  await prisma.vendorMaterial.createMany({ data: [
    { organizationId: orgId, vendorId: v1, materialId: tomato, lastRate: 40, leadTimeDays: 2, preferred: true },
    { organizationId: orgId, vendorId: v2, materialId: tomato, lastRate: 35, leadTimeDays: 4 },
    { organizationId: orgId, vendorId: v3, materialId: tomato, lastRate: 20, leadTimeDays: 1 },
  ] });

  // Tomato: 2 crates at 480 a crate (40 / kg) from vendor one, then 10 kg at 36 from vendor two.
  const g1 = await createGRN(sys, { outletId: A, vendorId: v1, lines: [{ materialId: tomato, qty: 2, rate: 480, unitId: crate }] });
  await postGRN(sys, g1.id);
  const g2 = await createGRN(sys, { outletId: A, vendorId: v2, lines: [{ materialId: tomato, qty: 10, rate: 36 }] });
  await postGRN(sys, g2.id);
  await recordPurchaseReceipt(sys, { outletId: A, materialId: milk, quantity: 10, rate: 50, sourceRef: `ai:${RUN}:${++n}` });
  await recordPurchaseReceipt(sys, { outletId: A, materialId: sugar, quantity: 1, rate: 45, sourceRef: `ai:${RUN}:${++n}` });
  // The store hands 20 kg tomato to the kitchen and 6 kg milk to the bar.
  const i1 = await createIssue(sys, { outletId: A, toDepartmentId: kitchen, lines: [{ materialId: tomato, qty: 20 }] });
  await postIssue(sys, i1.id);
  const i2 = await createIssue(sys, { outletId: A, toDepartmentId: bar, lines: [{ materialId: milk, qty: 6 }] });
  await postIssue(sys, i2.id);
  // Sales from the stations' departments, and 1 kg tomato spoiled in the kitchen.
  const soup = await dish(`Tomato soup ${RUN}`, 120, "KITCHEN", tomato, 0.5);
  const shake = await dish(`Milkshake ${RUN}`, 90, "BAR", milk, 0.3);
  await sell(soup, 4);
  await sell(shake, 5);
  const w = await createWastage(sys, { outletId: A, departmentId: kitchen, reason: "SPOILAGE", lines: [{ materialId: tomato, qty: 1 }] });
  await postWastage(sys, w.id);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("M. live stock matrix", () => {
  it("M1 every material against every department, valued at average cost for cost viewers only", async () => {
    const m = await stockMatrix(prisma, mgr, { outletId: A });
    const cols = Object.fromEntries(m.columns.map((c) => [c.name, c.id]));
    const t = m.rows.find((r) => r.materialId === tomato)!;
    // Received 34 kg; 20 to the kitchen; the kitchen sold 2 kg and wasted 1 kg.
    expect(t.quantities[cols["Unassigned"]]).toBe(14);
    expect(t.quantities[cols["Kitchen"]]).toBe(17);
    expect(t.total).toBe(31);
    const avg = await getAvgCost(prisma, sys, A, tomato);
    expect(t.value).toBe(num(money(D(31).times(avg))));
    const mk = m.rows.find((r) => r.materialId === milk)!;
    expect([mk.quantities[cols["Unassigned"]], mk.quantities[cols["Bar"]], mk.total]).toEqual([4, 4.5, 8.5]);
    expect(m.rows.find((r) => r.materialId === sugar)).toMatchObject({ belowPar: true, total: 1 });
    expect(m.showValue).toBe(true);

    const k = await stockMatrix(prisma, kitchenUser, { outletId: A });
    expect(k.showValue).toBe(false);
    expect(k.rows.find((r) => r.materialId === tomato)).not.toHaveProperty("value");
    expect(k).not.toHaveProperty("totalValue");
    await expect(stockMatrix(prisma, foreign, { outletId: A })).resolves.toMatchObject({ rows: [] });
  });
});

describe("C. department stock counts", () => {
  it("C1 a kitchen count compares the kitchen's own book quantity and corrects the kitchen only", async () => {
    const c = await count(tomato, 16, kitchen);
    expect(D(c.lines[0].bookQty).toString()).toBe("17"); // not the outlet's 31
    expect(D(c.lines[0].variance).toString()).toBe("-1");
    expect(num(await departmentQuantity(prisma, sys, A, kitchen, tomato))).toBe(16);
    expect(num(await departmentQuantity(prisma, sys, A, null, tomato))).toBe(14); // unassigned untouched
    const adj = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: c.id } });
    expect(adj).toMatchObject({ txnType: "COUNT_ADJUSTMENT", departmentId: kitchen });
  });

  it("C2 an outlet-wide count still counts the whole outlet", async () => {
    const c = await count(milk, 9, undefined); // book 8.5 (4 unassigned + 4.5 bar), found 9
    expect(D(c.lines[0].bookQty).toString()).toBe("8.5");
    expect(D(c.lines[0].variance).toString()).toBe("0.5");
    expect(num(await currentQuantity(prisma, sys, A, milk))).toBe(9);
  });

  it("C3 a department of another outlet cannot be counted", async () => {
    const other = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AX${RUN}`, name: "Other" } })).id;
    const dept = (await prisma.department.create({ data: { organizationId: orgId, outletId: other, name: "Far kitchen", kind: "KITCHEN" } })).id;
    await expect(createStockCount(sys, { outletId: A, departmentId: dept })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("P. department P&L and daily costing", () => {
  it("P1 sales by the station's department; cost issued in and wastage from the ledger; store departments hold stock and are not listed", async () => {
    const d = today();
    const pnl = await departmentPnl(prisma, mgr, { outletId: A, from: d.start, to: new Date(d.end.getTime() - 1) });
    const byName = new Map(pnl.rows.map((r) => [r.department, r]));
    expect(byName.has("Store")).toBe(false);
    const kitchenIn = await ledgerSum({ departmentId: kitchen, txnType: "ISSUE" });
    const kitchenWaste = (await ledgerSum({ departmentId: kitchen, txnType: { in: ["WASTAGE", "SPOILAGE", "STAFF_MEAL"] } })).neg();
    expect(byName.get("Kitchen")).toMatchObject({ sales: 480, costIssuedIn: num(money(kitchenIn)), wastage: num(money(kitchenWaste)) });
    expect(byName.get("Kitchen")!.grossMargin).toBe(num(money(D(480).minus(kitchenIn).minus(kitchenWaste))));
    expect(byName.get("Bar")).toMatchObject({ sales: 450, costIssuedIn: 300, wastage: 0, grossMargin: 150, marginPct: 33.33 });
    expect(pnl.total.sales).toBe(930);
    await expect(departmentPnl(prisma, kitchenUser, { outletId: A, from: d.start, to: d.end })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("P2 daily costing: opening + receipts - issues out - consumption - wastage + adjustments = closing, and the closing is the department's ledger value", async () => {
    const d = today();
    const dc = await dailyCosting(prisma, mgr, { outletId: A, from: d.date, to: d.date });
    const k = dc.rows.find((r) => r.departmentId === kitchen)!;
    expect(num(money(D(k.opening).plus(k.receipts).minus(k.issuesOut).minus(k.consumption).minus(k.wastage).plus(k.adjustments)))).toBe(k.closing);
    expect(k.closing).toBe(num(money(await ledgerSum({ departmentId: kitchen }))));
    expect(k.consumption).toBe(num(money((await ledgerSum({ departmentId: kitchen, txnType: "SALE_CONSUMPTION" })).neg())));
    await expect(dailyCosting(prisma, mgr, { outletId: A, from: d.date, to: "2020-01-01" })).rejects.toBeInstanceOf(ValidationError);
    await expect(dailyCosting(prisma, mgr, { outletId: A, from: "2026-01-01", to: "2026-03-01" })).rejects.toThrow(/at most 31 days/);
  });
});

describe("S. supplier prices", () => {
  it("S1 every vendor per base unit and per purchase unit; a blacklisted vendor is never the cheapest", async () => {
    const b = await supplierPriceComparison(prisma, mgr, { outletId: A, materialId: tomato });
    const row = b.rows[0];
    expect(row).toMatchObject({ baseUnit: `kg${RUN}`, purchaseUnit: `crate${RUN}`, packFactor: 12, comparable: 2, spread: 5 });
    expect(row.quotes.map((q) => [q.vendor, q.buyable, q.ratePerBase, q.ratePerPurchaseUnit, q.cheapest, q.aboveCheapestPct])).toEqual([
      [`Veg Two ${RUN}`, true, 35, 420, true, null],
      [`Veg One ${RUN}`, true, 40, 480, false, 14.29],
      [`Veg Banned ${RUN}`, false, 20, 240, false, -42.86],
    ]);
    // Last received, converted to the base unit (480 a crate = 40 / kg).
    expect(row.quotes.find((q) => q.vendorId === v1)!.lastReceived).toMatchObject({ ratePerBase: 40 });
    expect(row.quotes.find((q) => q.vendorId === v2)!.lastReceived).toMatchObject({ ratePerBase: 36 });
    expect(row.quotes.find((q) => q.vendorId === v1)!.preferred).toBe(true);
    await expect(supplierPriceComparison(prisma, kitchenUser, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("S2 purchase price history: newest first, change against the previous receipt, weighted average over the window", async () => {
    const h = await materialPriceHistory(prisma, mgr, { outletId: A, materialId: tomato });
    expect(h.receipts.map((r) => [r.vendor, r.qty, r.ratePerBase, r.changePct])).toEqual([[`Veg Two ${RUN}`, 10, 36, -10], [`Veg One ${RUN}`, 24, 40, null]]);
    expect(h.window).toEqual({ receipts: 2, qty: 34, weightedRate: num(D(24 * 40 + 10 * 36).div(34).toDecimalPlaces(6)), low: 36, high: 40 });
    await expect(materialPriceHistory(prisma, kitchenUser, { outletId: A, materialId: tomato })).rejects.toBeInstanceOf(ForbiddenError);
    const otherOrg = systemContext(foreign.organizationId, [A]);
    await expect(materialPriceHistory(prisma, otherOrg, { outletId: A, materialId: tomato })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("T. count variance trend", () => {
  it("T1 one row per approved count with the loss or surplus it found; later counts losing less = closing", async () => {
    const t = await countVarianceTrend(prisma, mgr, { outletId: A });
    expect(t.rows.map((r) => [r.department, r.itemsAdjusted, r.loss > 0, r.surplus > 0])).toEqual([["Kitchen", 1, true, false], ["Whole outlet", 1, false, true]]);
    expect(t.trend).toMatchObject({ direction: "CLOSING", laterAvgLoss: 0 });
    await expect(countVarianceTrend(prisma, kitchenUser, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("L. QR stock labels", () => {
  it("L1 the label carries the SKU; scanning it finds the material, its stock per department and (for cost viewers) its value", async () => {
    const sheet = await labelSheet(prisma, kitchenUser, { outletId: A, search: "Tomato" });
    expect(sheet).toEqual([expect.objectContaining({ sku: `TOM-${RUN.toUpperCase()}`, payload: `RESTORA-STOCK:TOM-${RUN.toUpperCase()}` })]);
    const found = await lookupStockLabel(prisma, mgr, { outletId: A, code: sheet[0].payload });
    expect(found).toMatchObject({ materialId: tomato, onHand: 30, unit: `kg${RUN}` });
    expect(found.departments.map((d) => [d.department, d.qty]).sort()).toEqual([["Kitchen", 16], ["Unassigned", 14]]);
    expect(found.value).toBe(num(money(D(30).times(await getAvgCost(prisma, sys, A, tomato)))));
    const asKitchen = await lookupStockLabel(prisma, kitchenUser, { outletId: A, code: `tom-${RUN}` }); // typed by hand, lower case
    expect(asKitchen.materialId).toBe(tomato);
    expect(asKitchen).not.toHaveProperty("value");
    expect(asKitchen).not.toHaveProperty("avgCost");
  });

  it("L2 unknown, malformed and other organizations' codes find nothing", async () => {
    await expect(lookupStockLabel(prisma, mgr, { outletId: A, code: "RESTORA-STOCK:NOPE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(lookupStockLabel(prisma, mgr, { outletId: A, code: "RESTORA-STOCK:" })).rejects.toBeInstanceOf(ValidationError);
    const otherOrg = systemContext(foreign.organizationId, [A]);
    await expect(lookupStockLabel(prisma, otherOrg, { outletId: A, code: `TOM-${RUN.toUpperCase()}` })).rejects.toBeInstanceOf(NotFoundError);
    const outsider = { ...mgr, outletIds: [], outletRoles: {} };
    await expect(lookupStockLabel(prisma, outsider, { outletId: A, code: `TOM-${RUN.toUpperCase()}` })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("X. exports", () => {
  it("X1 supplier prices, stock by department and department P&L export as CSV", async () => {
    const sp = await exportReportCSV(mgr, "SUPPLIER_PRICES", { outletId: A });
    expect(sp.csv.split("\r\n")[0]).toBe("Material,SKU,Base unit,Vendor,Vendor status,Preferred,Rate per base unit,Purchase unit,Base units per purchase unit,Rate per purchase unit,Lead time (days),Last received rate per base unit,Last received at,Cheapest buyable,% above cheapest");
    expect(sp.rowCount).toBe(3);
    const sd = await getReport(prisma, mgr, "STOCK_BY_DEPARTMENT", { outletId: A });
    expect(sd.rows.filter((r) => r.material === `Tomato ${RUN}`).map((r) => [r.department, r.qty]).sort()).toEqual([["Kitchen", 16], ["Unassigned", 14]]);
    const d = today();
    const pnl = await getReport(prisma, mgr, "DEPARTMENT_PNL", { outletId: A, from: d.start.toISOString(), to: d.end.toISOString() });
    expect(pnl.rows.find((r) => r.department === "Bar")).toMatchObject({ sales: 450, grossMargin: 150 });
    const ph = await getReport(prisma, mgr, "PURCHASE_PRICE_HISTORY", { outletId: A });
    expect(ph.rows.filter((r) => r.material === `Tomato ${RUN}`).map((r) => [r.rate, r.change])).toEqual([[40, ""], [36, -10]]);
    await expect(getReport(prisma, kitchenUser, "SUPPLIER_PRICES", { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
