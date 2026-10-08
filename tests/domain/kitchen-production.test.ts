/**
 * Group 3 kitchen production (docs/group3-implementation-map.md), real services
 * against the test database:
 *  P  batch-produced sub-recipes: dishes draw on prepared stock, so raw
 *     materials are consumed once (the double-consumption defect), production
 *     by department, partial yield, decimals and unit conversion, idempotency
 *  C  costing: plate cost through prepared stock, fallback, ingredient price
 *     changes, historical rows keep their cost
 *  W  dish wastage: one stock movement, plate cost, department, kitchen sees
 *     no costs
 *  S  dish production worksheet: prepared / sold / wasted / variance, the
 *     register as the only stock path, approval, back-dating
 *  M  manual sales log
 *  V  consumption variance and leakage
 *  K  the kitchen workspace permissions (wastage, production, indents)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { createRecipe, approveRecipeVersion, setRecipeStocked, calculateRecipeCost, getActiveVersionForMenuItem, explodeRecipe } from "@/server/services/recipe";
import { createProductionBatch, startProductionBatch, completeProductionBatch } from "@/server/services/production";
import { createDishWastage, createWastage, postWastage, cancelWastage, listWastage } from "@/server/services/wastage";
import { getWorksheet, saveWorksheetEntry, recordWorksheetWastage } from "@/server/services/productionWorksheet";
import { recordManualSales } from "@/server/services/manualSales";
import { consumptionVariance } from "@/server/services/variance";
import { createIndent, transitionIndent } from "@/server/services/procurement";
import { listIndents, getWastage, getProductionBatch } from "@/server/services/documentQueries";
import { recordPurchaseReceipt, currentQuantity, departmentQuantity, getAvgCost } from "@/server/services/inventory";
import { createOrder, addOrderItem, submitOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { createStockCount, startStockCount, enterStockCounts, submitStockCountForReview, approveStockCount } from "@/server/services/stockOps";
import { WASTAGE_RULES } from "@/server/services/wastage";
import { businessDayRange } from "@/domain/time";
import { D, num } from "@/domain/money";

const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
let orgId: string, A: string, B: string, kg: string, g: string, kitchenDept: string, storeDept: string, barDept: string;
let owner: AccessContext, sys: AccessContext, mgrA: AccessContext, kitchenA: AccessContext, cashierA: AccessContext, mgrB: AccessContext, foreign: AccessContext;
let mTomato: string, mOnion: string, mButter: string, mGravy: string, mGinger: string, mGarlic: string, mGgp: string, mRice: string;
let gravyRecipe: string, ggpRecipe: string, curryItem: string, riceItem: string;
let n = 0;
const key = () => `kp-${RUN}-${++n}`;
const today = () => businessDayRange(new Date(), TZ).date;
const yesterday = () => businessDayRange(new Date(Date.now() - 86_400_000), TZ).date;

const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const qty = async (materialId: string, outletId = A) => num(await currentQuantity(prisma, sys, outletId, materialId));
const deptQty = async (materialId: string, departmentId: string | null) => num(await departmentQuantity(prisma, sys, A, departmentId, materialId));
async function material(name: string, unit = kg) {
  return (await prisma.material.create({ data: { organizationId: orgId, sku: `${name.toUpperCase()}-${RUN}-${++n}`, name: `${name} ${RUN}`, baseUnitId: unit } })).id;
}
async function receive(materialId: string, q: number, rate: number, departmentId?: string) {
  await recordPurchaseReceipt(sys, { outletId: A, materialId, quantity: q, rate, sourceRef: `kp:${RUN}:${++n}` });
  if (departmentId) {
    // Move it into the department the way the store does (an issue: OUT unassigned, IN department).
    await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, materialId, txnType: "ISSUE", qty: -q, rate, amount: -q * rate, sourceRef: `kp-out:${RUN}:${++n}` } });
    await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, departmentId, materialId, txnType: "ISSUE", qty: q, rate, amount: q * rate, sourceRef: `kp-in:${RUN}:${++n}` } });
  }
}
async function sell(menuItemId: string, q: number, outletId = A) {
  const o = await createOrder(sys, { outletId, channel: "DINE_IN", source: "POS" });
  await addOrderItem(sys, o.id, { menuItemId, qty: q });
  await submitOrder(sys, o.id);
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
  const p = await createPayment(sys, o.id, { method: "CASH", amount: num(fresh.total) });
  await verifyPayment(sys, p.id);
  return o.id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Kitchen ${RUN}`, timezone: TZ } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `KA${RUN}`, name: "Kitchen A", timezone: TZ } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `KB${RUN}`, name: "Kitchen B", timezone: TZ } })).id;
  sys = systemContext(orgId, [A, B]);
  owner = { userId: `owner-${RUN}`, organizationId: orgId, outletIds: [A, B], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
  mgrA = member("MANAGER", A); kitchenA = member("KITCHEN", A); cashierA = member("CASHIER", A); mgrB = member("MANAGER", B);
  foreign = systemContext((await prisma.organization.create({ data: { name: `Kitchen other ${RUN}` } })).id, []);
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  g = (await prisma.unit.create({ data: { organizationId: orgId, code: `g${RUN}`, name: "g", kind: "WEIGHT" } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: g, toUnitId: kg, factor: 0.001 } });
  kitchenDept = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Kitchen", kind: "KITCHEN" } })).id;
  storeDept = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Store", kind: "STORE" } })).id;
  barDept = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Bar", kind: "BAR" } })).id;
  mTomato = await material("Tomato"); mOnion = await material("Onion"); mButter = await material("Butter"); mGravy = await material("Gravy");
  mGinger = await material("Ginger"); mGarlic = await material("Garlic"); mGgp = await material("GGP"); mRice = await material("Rice");

  // Gravy base: batch-produced; 5 kg = 2.5 kg tomato + 1.5 kg onion + 500 g butter (grams: unit conversion).
  const gravy = await createRecipe(owner, { name: `Gravy ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: mGravy, stocked: true, yieldQty: 5, yieldUnitId: kg, lines: [
    { componentType: "MATERIAL", materialId: mTomato, qty: 2.5 }, { componentType: "MATERIAL", materialId: mOnion, qty: 1.5 }, { componentType: "MATERIAL", materialId: mButter, qty: 500, unitId: g },
  ] });
  gravyRecipe = gravy.recipe.id;
  await approveRecipeVersion(owner, gravy.version.id);
  // Ginger-garlic paste: made to order (not stocked); dishes explode through it.
  const ggp = await createRecipe(owner, { name: `GGP ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: mGgp, yieldQty: 1, lines: [
    { componentType: "MATERIAL", materialId: mGinger, qty: 0.5 }, { componentType: "MATERIAL", materialId: mGarlic, qty: 0.5 },
  ] });
  ggpRecipe = ggp.recipe.id;
  await approveRecipeVersion(owner, ggp.version.id);
  curryItem = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Curry ${RUN}`, price: 300, taxPct: 5, station: "KITCHEN" } })).id;
  const curry = await createRecipe(owner, { name: `Curry recipe ${RUN}`, outputType: "MENU_ITEM", menuItemId: curryItem, yieldQty: 1, lines: [
    { componentType: "SUB_RECIPE", subRecipeId: gravyRecipe, qty: 0.25 }, { componentType: "SUB_RECIPE", subRecipeId: ggpRecipe, qty: 0.02 },
  ] });
  await approveRecipeVersion(owner, curry.version.id);
  riceItem = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Rice bowl ${RUN}`, price: 120, taxPct: 5, station: "KITCHEN" } })).id;
  const rice = await createRecipe(owner, { name: `Rice recipe ${RUN}`, outputType: "MENU_ITEM", menuItemId: riceItem, yieldQty: 1, lines: [{ componentType: "MATERIAL", materialId: mRice, qty: 0.2 }] });
  await approveRecipeVersion(owner, rice.version.id);

  await receive(mTomato, 20, 40, kitchenDept);
  await receive(mOnion, 20, 30, kitchenDept);
  await receive(mButter, 5, 500, kitchenDept);
  await receive(mGinger, 2, 200);
  await receive(mGarlic, 2, 300);
  await receive(mRice, 50, 90);
});

afterAll(async () => { await prisma.$disconnect(); });

// ============================================================
// P. Batch-produced sub-recipes and production
// ============================================================

describe("P. sub-recipe batches and stock", () => {
  it("P1 a dish sale draws on prepared stock of a batch-produced sub-recipe: raw materials leave once, at production", async () => {
    // Before any batch the stock explosion asks for prepared gravy, the theoretical one for its raw materials.
    const v = (await getActiveVersionForMenuItem(prisma, sys, curryItem))!;
    const stock = await explodeRecipe(prisma, sys, v.id, 4, { stock: true });
    expect(num(stock.get(mGravy)!)).toBeCloseTo(1, 6);
    expect(stock.has(mTomato)).toBe(false);
    expect(num(stock.get(mGinger)!)).toBeCloseTo(0.04, 6); // made to order: through to raw
    const theory = await explodeRecipe(prisma, sys, v.id, 4);
    expect(num(theory.get(mTomato)!)).toBeCloseTo(0.5, 6);

    const batch = await createProductionBatch(kitchenA, { outletId: A, recipeId: gravyRecipe, plannedQty: 5, departmentId: kitchenDept }, prisma, key());
    expect(batch.lines.map((l) => [l.materialId, num(l.qty)]).sort()).toEqual([[mButter, 0.5], [mOnion, 1.5], [mTomato, 2.5]].sort());
    await startProductionBatch(kitchenA, batch.id);
    const done = await completeProductionBatch(kitchenA, batch.id, { actualQty: 5 });
    expect(done.inputCost).toBe(2.5 * 40 + 1.5 * 30 + 0.5 * 500); // 395
    expect(done.outputRate).toBe(79);
    expect(await deptQty(mTomato, kitchenDept)).toBe(17.5);
    expect(await deptQty(mGravy, kitchenDept)).toBe(5);

    const tomatoBefore = await qty(mTomato), gingerBefore = await qty(mGinger);
    await sell(curryItem, 4);
    expect(await qty(mTomato)).toBe(tomatoBefore); // not consumed a second time
    expect(await qty(mGravy)).toBe(4); // 5 - 4 x 0.25
    expect(await qty(mGinger)).toBeCloseTo(gingerBefore - 0.04, 6);
    expect(await deptQty(mGravy, kitchenDept)).toBe(4); // from the kitchen (station KITCHEN)
  });

  it("P2 a made-to-order sub-recipe cannot be produced; marking it batch-produced is org-wide, audited and blocked while batches are open", async () => {
    await expect(createProductionBatch(mgrA, { outletId: A, recipeId: ggpRecipe, plannedQty: 1 })).rejects.toThrow(/made to order/);
    await expect(setRecipeStocked(mgrA, ggpRecipe, true)).rejects.toBeInstanceOf(ForbiddenError); // outlet manager: not org-wide
    const curryRecipe = (await prisma.recipe.findFirstOrThrow({ where: { menuItemId: curryItem } })).id;
    await expect(setRecipeStocked(owner, curryRecipe, true)).rejects.toBeInstanceOf(ValidationError);
    await expect(setRecipeStocked(foreign, ggpRecipe, true)).rejects.toBeInstanceOf(NotFoundError);
    await setRecipeStocked(owner, ggpRecipe, true);
    const open = await createProductionBatch(mgrA, { outletId: A, recipeId: ggpRecipe, plannedQty: 1 });
    await expect(setRecipeStocked(owner, ggpRecipe, false)).rejects.toThrow(/open production batch/);
    await prisma.productionBatch.update({ where: { id: open.id }, data: { status: "CANCELLED" } });
    await setRecipeStocked(owner, ggpRecipe, false);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Recipe", entityId: ggpRecipe, action: "RECIPE_CHANGE" } });
    expect(audits.map((a) => JSON.parse(a.after ?? "{}").stocked).filter((x) => x !== undefined)).toEqual(expect.arrayContaining([true, false]));
  });

  it("P3 department production: inputs must be in that department even if the outlet holds them elsewhere; nothing moves on refusal", async () => {
    // Rice sits in unassigned stock only; a sub-recipe of rice produced in the bar department is short there.
    const mRicePrep = await material("Rice prep");
    const rp = await createRecipe(owner, { name: `Rice prep ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: mRicePrep, stocked: true, yieldQty: 1, lines: [{ componentType: "MATERIAL", materialId: mRice, qty: 1 }] });
    await approveRecipeVersion(owner, rp.version.id);
    const b = await createProductionBatch(mgrA, { outletId: A, recipeId: rp.recipe.id, plannedQty: 2, departmentId: barDept });
    await startProductionBatch(mgrA, b.id);
    const before = await prisma.inventoryLedger.count({ where: { organizationId: orgId } });
    await expect(completeProductionBatch(mgrA, b.id, { actualQty: 2 })).rejects.toThrow(/Insufficient stock/);
    expect(await prisma.inventoryLedger.count({ where: { organizationId: orgId } })).toBe(before);
    // Department of another outlet, inactive department: refused at planning.
    const otherDept = (await prisma.department.create({ data: { organizationId: orgId, outletId: B, name: "B kitchen", kind: "KITCHEN" } })).id;
    await expect(createProductionBatch(mgrA, { outletId: A, recipeId: rp.recipe.id, plannedQty: 1, departmentId: otherDept })).rejects.toThrow(/not in this outlet/);
  });

  it("P4 partial yield, corrected inputs and decimal quantities cost the batch exactly; completion is one-shot", async () => {
    const b = await createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 2.5, departmentId: kitchenDept });
    expect(b.lines.find((l) => l.materialId === mButter)!.qty.toString()).toBe("0.25"); // 500 g x 0.5 in kg
    await startProductionBatch(mgrA, b.id);
    // Used 1.3 kg tomato instead of 1.25 and got 2.2 kg instead of 2.5.
    const r = await completeProductionBatch(mgrA, b.id, { actualQty: 2.2, consumed: [{ materialId: mTomato, qty: 1.3 }] });
    const inputs = D(1.3).times(40).plus(D(0.75).times(30)).plus(D(0.25).times(500)); // 52 + 22.5 + 125 = 199.5
    expect(r.inputCost).toBe(num(inputs));
    expect(r.outputRate).toBe(num(inputs.div(2.2).toDecimalPlaces(2)));
    const rows = await prisma.inventoryLedger.count({ where: { sourceId: b.id } });
    await expect(completeProductionBatch(mgrA, b.id, { actualQty: 2.2 })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: b.id } })).toBe(rows);
    await expect(completeProductionBatch(mgrA, b.id, { actualQty: 2.2, consumed: [{ materialId: mRice, qty: 1 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("P5 a double-submitted plan creates one batch; reusing the key for another plan is refused", async () => {
    const k = key();
    const a1 = await createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 1 }, prisma, k);
    const a2 = await createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 1 }, prisma, k);
    expect(a2.id).toBe(a1.id);
    expect(a2.replayed).toBe(true);
    await expect(createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 2 }, prisma, k)).rejects.toBeInstanceOf(ConflictError);
    // Concurrent double submit: still one.
    const k2 = key();
    const [x, y] = await Promise.all([1, 2].map(() => createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 1 }, prisma, k2)));
    expect(x.id).toBe(y.id);
    expect(await prisma.productionBatch.count({ where: { idempotencyKey: k2 } })).toBe(1);
  });

  it("P6 a completed batch reads back its cost per unit from the ledger, the yield against the plan and who made it; the kitchen sees no costs", async () => {
    const maker = await prisma.user.create({ data: { organizationId: orgId, email: `chef-${RUN}@kp.test`, name: "Chef Ravi", passwordHash: "x" } });
    const chef: AccessContext = { ...kitchenA, userId: maker.id };
    const b = await createProductionBatch(chef, { outletId: A, recipeId: gravyRecipe, plannedQty: 2, departmentId: kitchenDept }, prisma, key());
    await startProductionBatch(chef, b.id);
    await completeProductionBatch(mgrA, b.id, { actualQty: 1.8 });
    const view = await getProductionBatch(prisma, mgrA, b.id);
    // Inputs: 1 kg tomato, 0.6 kg onion, 0.2 kg butter at their average costs; output = that / 1.8 kg.
    const rows = await prisma.inventoryLedger.findMany({ where: { sourceId: b.id, txnType: "PRODUCTION_CONSUMPTION" } });
    const inputCost = rows.reduce((s, r) => s.plus(D(r.amount).abs()), D(0));
    expect(view.costing).toMatchObject({ inputCost: num(inputCost.toDecimalPlaces(2)), unitCost: num(inputCost.div(1.8).toDecimalPlaces(2)) });
    expect(view.costing!.inputs).toHaveLength(3);
    expect(view.yieldVariance).toEqual({ qty: -0.2, pct: -10 });
    expect(view.plannedByName).toBe("Chef Ravi");
    expect(view.departmentId).toBe(kitchenDept);
    const asKitchen = await getProductionBatch(prisma, kitchenA, b.id);
    expect(asKitchen.costing).toBeNull();
    expect(asKitchen.yieldVariance).toEqual({ qty: -0.2, pct: -10 });
    const planned = await createProductionBatch(mgrA, { outletId: A, recipeId: gravyRecipe, plannedQty: 1 });
    expect((await getProductionBatch(prisma, mgrA, planned.id))).toMatchObject({ costing: null, yieldVariance: null, completedByName: null });
  });
});

// ============================================================
// C. Costing
// ============================================================

describe("C. production costing", () => {
  it("C1 plate cost uses the prepared stock's batch cost; before any batch, its recipe cost; Decimal throughout", async () => {
    const v = (await getActiveVersionForMenuItem(prisma, sys, curryItem))!;
    const gravyAvg = await getAvgCost(prisma, sys, A, mGravy);
    const cost = await calculateRecipeCost(prisma, sys, v.id, { outletId: A, quantity: 1 });
    const gingerLine = D(0.01).times(200).plus(D(0.01).times(300)); // 0.02 kg paste = 0.01 ginger + 0.01 garlic
    // Each line is rounded to paise, then summed: within a paisa of the exact figure.
    expect(num(cost.total)).toBeCloseTo(num(D(0.25).times(gravyAvg).plus(gingerLine)), 1);
    expect(cost.lines.find((l) => l.materialId === mGravy)!.unitCost.toString()).toBe(gravyAvg.toString());
    expect(cost.lines.some((l) => l.materialId === mTomato)).toBe(false);
    // Outlet B never produced gravy: the gravy's recipe cost (at B's costs: none) is the fallback, not zero by accident.
    const atB = await calculateRecipeCost(prisma, sys, v.id, { outletId: B, quantity: 1 });
    expect(atB.lines.find((l) => l.materialId === mGravy)!.unitCost.toString()).toBe("0");
  });

  it("C2 an ingredient price change re-costs dishes built on it; ledger rows already posted keep their cost", async () => {
    const v = (await getActiveVersionForMenuItem(prisma, sys, riceItem))!;
    const before = await calculateRecipeCost(prisma, sys, v.id, { outletId: A, quantity: 1 });
    expect(num(before.total)).toBe(18); // 0.2 x 90
    const sale = await sell(riceItem, 1);
    const saleRow = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: sale, materialId: mRice } });
    await receive(mRice, 50, 110); // average 100
    const after = await calculateRecipeCost(prisma, sys, v.id, { outletId: A, quantity: 1 });
    expect(num(after.total)).toBe(num(D(0.2).times(await getAvgCost(prisma, sys, A, mRice)).toDecimalPlaces(2)));
    expect(num(after.total)).toBeGreaterThan(18);
    const again = await prisma.inventoryLedger.findUniqueOrThrow({ where: { id: saleRow.id } });
    expect(again.rate.toString()).toBe(saleRow.rate.toString());
    expect(again.amount.toString()).toBe(saleRow.amount.toString());
  });
});

// ============================================================
// W. Dish wastage
// ============================================================

describe("W. wastage", () => {
  it("W1 dish wastage leaves stock exactly once, from the dish's department, at plate cost; a retry is the same document", async () => {
    const k = key();
    const before = await deptQty(mGravy, kitchenDept);
    const doc = await createDishWastage(kitchenA, { outletId: A, menuItemId: curryItem, qty: 2, reason: "OVERPRODUCTION" }, prisma, k);
    expect(doc.departmentId).toBe(kitchenDept);
    const again = await createDishWastage(kitchenA, { outletId: A, menuItemId: curryItem, qty: 2, reason: "OVERPRODUCTION" }, prisma, k);
    expect(again.id).toBe(doc.id);
    const posted = await postWastage(kitchenA, doc.id);
    await expect(postWastage(kitchenA, doc.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await deptQty(mGravy, kitchenDept)).toBeCloseTo(before - 0.5, 6);
    const v = (await getActiveVersionForMenuItem(prisma, sys, curryItem))!;
    const plate = await calculateRecipeCost(prisma, sys, v.id, { outletId: A, quantity: 2 });
    expect(posted.totalCost).toBeCloseTo(num(plate.total), 2);
    const rows = await prisma.inventoryLedger.findMany({ where: { sourceId: doc.id } });
    expect(new Set(rows.map((r) => r.txnType))).toEqual(new Set(["WASTAGE"]));
  });

  it("W2 the kitchen records wastage but never sees its cost; the register still values it for managers", async () => {
    const doc = await createWastage(kitchenA, { outletId: A, departmentId: kitchenDept, reason: "SPOILAGE", lines: [{ materialId: mOnion, qty: 0.3 }] }, prisma, key());
    await postWastage(kitchenA, doc.id);
    const forKitchen = await listWastage(prisma, kitchenA, { outletId: A });
    expect(forKitchen.items.find((d) => d.id === doc.id)!.lines[0].estCost).toBeNull();
    expect((await getWastage(prisma, kitchenA, doc.id)).lines[0].estCost).toBeNull();
    expect(num((await getWastage(prisma, mgrA, doc.id)).lines[0].estCost!)).toBe(9); // 0.3 x 30
    await expect(createWastage(cashierA, { outletId: A, reason: "SPOILAGE", lines: [{ materialId: mOnion, qty: 0.1 }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createWastage(member("KITCHEN", B), { outletId: A, reason: "SPOILAGE", lines: [{ materialId: mOnion, qty: 0.1 }] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("W3 wastage cannot be dated in the future; a back-dated loss is ledgered on its day", async () => {
    await expect(createWastage(mgrA, { outletId: A, reason: "SPOILAGE", occurredAt: new Date(Date.now() + 3_600_000), lines: [{ materialId: mOnion, qty: 0.1 }] })).rejects.toBeInstanceOf(ValidationError);
    const when = new Date(Date.now() - 30 * 3_600_000);
    const doc = await createWastage(mgrA, { outletId: A, reason: "SPOILAGE", occurredAt: when, lines: [{ materialId: mOnion, qty: 0.1 }] });
    await postWastage(mgrA, doc.id);
    const row = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: doc.id } });
    expect(row.createdAt.toISOString()).toBe(when.toISOString());
  });
});

// ============================================================
// S. Dish production worksheet
// ============================================================

describe("S. dish production worksheet", () => {
  it("S1 prepared (chef) - sold (orders) - wasted (posted dish wastage) = the unexplained gap; costs hidden from the kitchen", async () => {
    const d = today();
    await saveWorksheetEntry(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, preparedQty: 40 });
    for (let i = 0; i < 3; i++) await sell(riceItem, 10); // 30 sold (plus the C2 sale = 31)
    const w = await recordWorksheetWastage(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, qty: 3 }, key());
    expect(w.posted).toBe(true);
    expect((w as { totalCost?: number }).totalCost).toBeUndefined(); // kitchen: quantities only
    const sheet = await getWorksheet(prisma, kitchenA, { outletId: A, businessDate: d });
    const row = sheet.rows.find((r) => r.menuItemId === riceItem)!;
    expect(row).toMatchObject({ prepared: 40, sold: 31, wasted: 3, variance: 6, department: "Kitchen" });
    expect(row.plateCost).toBeUndefined();
    expect(sheet.showCost).toBe(false);
    const forManager = await getWorksheet(prisma, mgrA, { outletId: A, businessDate: d });
    const m = forManager.rows.find((r) => r.menuItemId === riceItem)!;
    expect(m.varianceCost).toBeCloseTo(6 * (m.plateCost ?? 0), 2);
    expect(m.wastageCost).toBeGreaterThan(0);
  });

  it("S2 dish wastage logged in the register shows on the worksheet: one loss, one stock movement", async () => {
    const d = today();
    const before = await qty(mRice);
    const doc = await createDishWastage(mgrA, { outletId: A, menuItemId: riceItem, qty: 2, reason: "DAMAGED" }, prisma, key());
    await postWastage(mgrA, doc.id);
    const row = (await getWorksheet(prisma, mgrA, { outletId: A, businessDate: d })).rows.find((r) => r.menuItemId === riceItem)!;
    expect(row.wasted).toBe(5);
    expect(row.variance).toBe(4);
    expect(await qty(mRice)).toBeCloseTo(before - 0.4, 6);
  });

  it("S3 a retried worksheet wastage posts once; over the approval threshold the kitchen's entry waits for a manager", async () => {
    const d = today();
    const k = key();
    const first = await recordWorksheetWastage(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, qty: 1 }, k);
    const second = await recordWorksheetWastage(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, qty: 1 }, k);
    expect(second.wastage.id).toBe(first.wastage.id);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: first.wastage.id } })).toBe(1);
    await expect(recordWorksheetWastage(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, qty: 1 }, undefined)).rejects.toBeInstanceOf(ValidationError);
    // Large enough to exceed the approval threshold at plate cost.
    const big = Math.ceil(WASTAGE_RULES.approvalThreshold / 18) + 5;
    const pend = await recordWorksheetWastage(kitchenA, { outletId: A, businessDate: d, menuItemId: riceItem, qty: big }, key());
    expect(pend).toMatchObject({ posted: false, awaitingApproval: true });
    expect(await prisma.inventoryLedger.count({ where: { sourceId: pend.wastage.id } })).toBe(0);
    const row = (await getWorksheet(prisma, mgrA, { outletId: A, businessDate: d })).rows.find((r) => r.menuItemId === riceItem)!;
    expect(row.wasted).toBe(6);
    expect(row.wastedPending).toBe(big);
    // A manager rejecting it (cancel) takes it off the worksheet entirely.
    await cancelWastage(mgrA, pend.wastage.id);
    const after = (await getWorksheet(prisma, mgrA, { outletId: A, businessDate: d })).rows.find((r) => r.menuItemId === riceItem)!;
    expect([after.wasted, after.wastedPending]).toEqual([6, 0]);
  });

  it("S4 yesterday's worksheet: back-dated wastage, no future days, validation, scope", async () => {
    const y = yesterday();
    await saveWorksheetEntry(mgrA, { outletId: A, businessDate: y, menuItemId: curryItem, preparedQty: 10, notes: "lunch batch" });
    const w = await recordWorksheetWastage(mgrA, { outletId: A, businessDate: y, menuItemId: curryItem, qty: 1 }, key());
    const day = businessDayRange(y, TZ);
    const row = await prisma.inventoryLedger.findFirstOrThrow({ where: { sourceId: w.wastage.id } });
    expect(row.createdAt.getTime()).toBe(day.end.getTime() - 1);
    const sheet = await getWorksheet(prisma, mgrA, { outletId: A, businessDate: y });
    expect(sheet.rows.find((r) => r.menuItemId === curryItem)).toMatchObject({ prepared: 10, wasted: 1, notes: "lunch batch" });
    const tomorrow = businessDayRange(new Date(Date.now() + 2 * 86_400_000), TZ).date;
    await expect(saveWorksheetEntry(mgrA, { outletId: A, businessDate: tomorrow, menuItemId: curryItem, preparedQty: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(saveWorksheetEntry(mgrA, { outletId: A, businessDate: "2026-13-01", menuItemId: curryItem, preparedQty: 1 })).rejects.toThrow();
    await expect(saveWorksheetEntry(mgrA, { outletId: A, businessDate: y, menuItemId: curryItem, preparedQty: -1 })).rejects.toThrow();
    await expect(saveWorksheetEntry(cashierA, { outletId: A, businessDate: y, menuItemId: curryItem, preparedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveWorksheetEntry(mgrB, { outletId: A, businessDate: y, menuItemId: curryItem, preparedQty: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getWorksheet(prisma, foreign, { outletId: A, businessDate: y })).rejects.toThrow();
    const audits = await prisma.auditLog.count({ where: { entityType: "DishProduction", outletId: A } });
    expect(audits).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================
// M. Manual sales log
// ============================================================

describe("M. manual sales log", () => {
  it("M1 a back-dated manual log is a settled order at menu price, depletes once and is idempotent", async () => {
    const y = yesterday();
    const before = await qty(mRice);
    const k = key();
    const r1 = await recordManualSales(kitchenA, { outletId: A, businessDate: y, lines: [{ menuItemId: riceItem, qty: 5 }] }, k);
    const r2 = await recordManualSales(kitchenA, { outletId: A, businessDate: y, lines: [{ menuItemId: riceItem, qty: 5 }] }, k);
    expect(r2.order.id).toBe(r1.order.id);
    expect(r2.duplicate).toBe(true);
    expect(await qty(mRice)).toBeCloseTo(before - 1, 6);
    expect(r1.order).toMatchObject({ source: "MANUAL", status: "PAID" });
    expect(num(r1.order.subtotal)).toBe(600);
    const day = businessDayRange(y, TZ);
    expect(r1.order.createdAt >= day.start && r1.order.createdAt < day.end).toBe(true);
    const sheet = await getWorksheet(prisma, mgrA, { outletId: A, businessDate: y });
    expect(sheet.rows.find((r) => r.menuItemId === riceItem)!.sold).toBe(5);
    await expect(recordManualSales(cashierA, { outletId: A, businessDate: y, lines: [{ menuItemId: riceItem, qty: 1 }, { menuItemId: riceItem, qty: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordManualSales(member("ACCOUNTANT", A), { outletId: A, businessDate: y, lines: [{ menuItemId: riceItem, qty: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ============================================================
// V. Consumption variance
// ============================================================

describe("V. consumption variance", () => {
  it("V1 expected (sales) vs actual (sales + wastage + count loss) per material, in quantity, rupees and %", async () => {
    // Count onion: book vs physical 1 kg short.
    const c = await createStockCount(mgrA, { outletId: A });
    await startStockCount(mgrA, c.id, { materialIds: [mOnion] });
    const book = await qty(mOnion);
    await enterStockCounts(mgrA, c.id, [{ materialId: mOnion, physicalQty: book - 1 }]);
    await submitStockCountForReview(mgrA, c.id);
    await approveStockCount(mgrA, c.id);
    const r = await consumptionVariance(prisma, mgrA, { outletId: A });
    const onion = r.rows.find((x) => x.materialId === mOnion)!;
    expect(onion.expectedQty).toBe(0);
    expect(onion.wastageQty).toBeCloseTo(0.4, 6); // W2 0.3 + W3 0.1
    expect(onion.countLossQty).toBeCloseTo(1, 6);
    expect(onion.varianceQty).toBeCloseTo(1.4, 6);
    expect(onion.variancePct).toBeNull(); // nothing was expected to be used
    const rice = r.rows.find((x) => x.materialId === mRice)!;
    expect(rice.expectedQty).toBeGreaterThan(0);
    expect(rice.actualQty).toBeCloseTo(rice.expectedQty + rice.wastageQty + rice.countLossQty, 6);
    expect(rice.variancePct).toBeCloseTo((rice.varianceCost / rice.expectedCost) * 100, 1);
    expect(r.totals.varianceCost).toBeCloseTo(r.totals.wastageCost + r.totals.countLossCost, 1);
    expect(r.rows[0].varianceCost).toBeGreaterThanOrEqual(r.rows[r.rows.length - 1].varianceCost);
    expect(r.leakage.leakage).toBeCloseTo(r.leakage.actualFoodCost - r.leakage.theoreticalFoodCost, 2);
    // Department filter, kitchen and foreign access.
    const k = await consumptionVariance(prisma, mgrA, { outletId: A, departmentId: kitchenDept });
    expect(k.rows.every((x) => x.materialId !== mRice || x.expectedQty >= 0)).toBe(true);
    await expect(consumptionVariance(prisma, kitchenA, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(consumptionVariance(prisma, mgrB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(consumptionVariance(prisma, mgrA, { outletId: A, from: new Date(), to: new Date(Date.now() - 86_400_000) })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ============================================================
// K. Kitchen workspace: indents
// ============================================================

describe("K. kitchen indents", () => {
  it("K1 the kitchen raises, submits and lists its indents; approval and later steps stay with the store and approver", async () => {
    const ind = await createIndent(kitchenA, { outletId: A, departmentId: kitchenDept, lines: [{ materialId: mTomato, qty: 6 }] });
    await transitionIndent(kitchenA, ind.id, "SUBMITTED");
    await expect(transitionIndent(kitchenA, ind.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listIndents(prisma, kitchenA, { outletId: A })).items.some((i) => i.id === ind.id)).toBe(true);
    await transitionIndent(mgrA, ind.id, "APPROVED");
    await expect(transitionIndent(kitchenA, ind.id, "CANCELLED")).rejects.toBeInstanceOf(ForbiddenError);
    const draft = await createIndent(kitchenA, { outletId: A, lines: [{ materialId: mOnion, qty: 2 }] });
    await transitionIndent(kitchenA, draft.id, "CANCELLED");
    await expect(createIndent(cashierA, { outletId: A, lines: [{ materialId: mOnion, qty: 2 }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createIndent(member("KITCHEN", B), { outletId: A, lines: [{ materialId: mOnion, qty: 2 }] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
