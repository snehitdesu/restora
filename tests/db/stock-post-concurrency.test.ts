/**
 * Group 3 kitchen writes raced against themselves. Each pair is started
 * together and awaited with Promise.allSettled: on PostgreSQL these are
 * concurrent SERIALIZABLE transactions on separate connections; on SQLite the
 * single writer serializes them. Whatever the interleaving, stock moves once:
 *  - two completions of one batch: one posts its inputs and output, the other
 *    is refused and writes nothing
 *  - two batches that only fit the department's stock one at a time: one
 *    completes, the department never goes negative
 *  - one wastage document posted twice at once: one set of ledger rows
 *  - a worksheet "add wasted" double tap (same Idempotency-Key): one document,
 *    posted once
 *  - a manual sales log sent twice (same key): one order, consumed once
 *  - a goods receipt and a store issue posted twice at once: stock moves once,
 *    both requests answer (posting a posted receipt / issue is a no-op)
 * A refused request is a clean domain error (4xx), never a raw database error:
 * on PostgreSQL the second post's ledger insert collides with the first's
 * posting key and runInTx re-runs it (server/db/conflict.ts isLedgerKeyRace).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import type { AccessContext } from "@/server/db/scope";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { createProductionBatch, startProductionBatch, completeProductionBatch } from "@/server/services/production";
import { createWastage, postWastage } from "@/server/services/wastage";
import { recordWorksheetWastage } from "@/server/services/productionWorksheet";
import { recordManualSales } from "@/server/services/manualSales";
import { recordPurchaseReceipt, currentQuantity, departmentQuantity } from "@/server/services/inventory";
import { createGRN, postGRN } from "@/server/services/procurement";
import { createIssue, postIssue } from "@/server/services/stockOps";
import { businessDayRange } from "@/domain/time";
import { num } from "@/domain/money";

const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
let orgId: string, A: string, kg: string, kitchen: string;
let sys: AccessContext, owner: AccessContext, alice: AccessContext, bob: AccessContext;
let mTomato: string, mOnion: string, mGravy: string, gravyRecipe: string, curryItem: string;
let n = 0;
const ref = () => `pc:${RUN}:${++n}`;
const today = () => businessDayRange(new Date(), TZ).date;
const member = (userId: string): AccessContext => ({ userId, organizationId: orgId, outletIds: [A], roles: ["MANAGER"], outletRoles: { [A]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function material(name: string) {
  return (await prisma.material.create({ data: { organizationId: orgId, sku: `${name.toUpperCase()}-${RUN}-${++n}`, name: `${name} ${RUN}`, baseUnitId: kg } })).id;
}
/** Receive into the outlet and hand it to the kitchen (OUT unassigned, IN kitchen), as an issue does. */
async function intoKitchen(materialId: string, q: number, rate: number) {
  await recordPurchaseReceipt(sys, { outletId: A, materialId, quantity: q, rate, sourceRef: ref() });
  await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, materialId, txnType: "ISSUE", qty: -q, rate, amount: -q * rate, sourceRef: ref() } });
  await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, departmentId: kitchen, materialId, txnType: "ISSUE", qty: q, rate, amount: q * rate, sourceRef: ref() } });
}
const kitchenQty = async (materialId: string) => num(await departmentQuantity(prisma, sys, A, kitchen, materialId));

function exactlyOne(results: PromiseSettledResult<unknown>[]) {
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(ok).toHaveLength(1);
  expect(failed).toHaveLength(1);
  const status = (failed[0].reason as { status?: number }).status;
  expect(typeof status, `the refused request must be a domain error, got: ${String(failed[0].reason)}`).toBe("number");
  expect(status).toBeGreaterThanOrEqual(400);
  expect(status).toBeLessThan(500);
  return ok[0] as PromiseFulfilledResult<unknown>;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Prod conc ${RUN}`, timezone: TZ } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PC${RUN}`, name: "PC", timezone: TZ } })).id;
  sys = systemContext(orgId, [A]);
  owner = { userId: `owner-${RUN}`, organizationId: orgId, outletIds: [A], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
  alice = member(`alice-${RUN}`);
  bob = member(`bob-${RUN}`);
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  kitchen = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Kitchen", kind: "KITCHEN" } })).id;
  mTomato = await material("Tomato"); mOnion = await material("Onion"); mGravy = await material("Gravy");
  // 2 kg of gravy = 1 kg tomato + 1 kg onion; batch-produced.
  const gravy = await createRecipe(owner, { name: `Gravy ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: mGravy, stocked: true, yieldQty: 2, yieldUnitId: kg, lines: [
    { componentType: "MATERIAL", materialId: mTomato, qty: 1 }, { componentType: "MATERIAL", materialId: mOnion, qty: 1 },
  ] });
  gravyRecipe = gravy.recipe.id;
  await approveRecipeVersion(owner, gravy.version.id);
  curryItem = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Curry ${RUN}`, price: 250, taxPct: 5, station: "KITCHEN" } })).id;
  const curry = await createRecipe(owner, { name: `Curry recipe ${RUN}`, outputType: "MENU_ITEM", menuItemId: curryItem, yieldQty: 1, lines: [{ componentType: "SUB_RECIPE", subRecipeId: gravyRecipe, qty: 0.5 }] });
  await approveRecipeVersion(owner, curry.version.id);
  await intoKitchen(mTomato, 3, 40);
  await intoKitchen(mOnion, 3, 30);
});

afterAll(async () => { await prisma.$disconnect(); });

describe(`concurrent stock posts (${onPostgres ? "PostgreSQL" : "SQLite"})`, () => {
  it("two completions of one batch at the same moment: inputs and output are posted once", async () => {
    const b = await createProductionBatch(alice, { outletId: A, recipeId: gravyRecipe, plannedQty: 2, departmentId: kitchen });
    await startProductionBatch(alice, b.id);
    exactlyOne(await Promise.allSettled([completeProductionBatch(alice, b.id, { actualQty: 2 }), completeProductionBatch(bob, b.id, { actualQty: 2 })]));
    const rows = await prisma.inventoryLedger.findMany({ where: { sourceId: b.id }, orderBy: { sourceRef: "asc" } });
    expect(rows.map((r) => [r.txnType, num(r.qty)])).toEqual([
      ["PRODUCTION_CONSUMPTION", -1], ["PRODUCTION_CONSUMPTION", -1], ["PRODUCTION_OUTPUT", 2],
    ]);
    expect(await kitchenQty(mTomato)).toBe(2);
    expect(await kitchenQty(mGravy)).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityType: "ProductionBatch", entityId: b.id, action: "INVENTORY_MOVEMENT" } })).toBe(1);
  });

  it("two batches that fit the kitchen's stock one at a time: one completes, the kitchen never goes negative", async () => {
    // 2 kg tomato and 2 kg onion left in the kitchen; each batch of 4 kg gravy needs 2 kg of each.
    const [x, y] = [await createProductionBatch(alice, { outletId: A, recipeId: gravyRecipe, plannedQty: 4, departmentId: kitchen }), await createProductionBatch(bob, { outletId: A, recipeId: gravyRecipe, plannedQty: 4, departmentId: kitchen })];
    await startProductionBatch(alice, x.id);
    await startProductionBatch(bob, y.id);
    exactlyOne(await Promise.allSettled([completeProductionBatch(alice, x.id, { actualQty: 4 }), completeProductionBatch(bob, y.id, { actualQty: 4 })]));
    expect(await kitchenQty(mTomato)).toBe(0);
    expect(await kitchenQty(mOnion)).toBe(0);
    expect(await kitchenQty(mGravy)).toBe(6);
    const statuses = (await prisma.productionBatch.findMany({ where: { id: { in: [x.id, y.id] } } })).map((b) => b.status).sort();
    expect(statuses).toEqual(["COMPLETED", "IN_PROGRESS"]);
  });

  it("one wastage document posted twice at once: one set of ledger rows", async () => {
    const w = await createWastage(alice, { outletId: A, departmentId: kitchen, reason: "SPOILAGE", lines: [{ materialId: mGravy, qty: 0.5 }] });
    exactlyOne(await Promise.allSettled([postWastage(alice, w.id), postWastage(bob, w.id)]));
    expect(await prisma.inventoryLedger.count({ where: { sourceId: w.id } })).toBe(1);
    expect(await kitchenQty(mGravy)).toBe(5.5);
  });

  it("a double-tapped 'add wasted' on the worksheet (same key): one dish-wastage document, posted once", async () => {
    const k = `wsw-${RUN}-race`;
    const input = { outletId: A, businessDate: today(), menuItemId: curryItem, qty: 1, reason: "OVERPRODUCTION" as const };
    const [r1, r2] = await Promise.all([recordWorksheetWastage(alice, input, k), recordWorksheetWastage(alice, input, k)]);
    expect(r1.wastage.id).toBe(r2.wastage.id);
    const docs = await prisma.wastage.findMany({ where: { organizationId: orgId, idempotencyKey: k } });
    expect(docs.map((d) => d.status)).toEqual(["POSTED"]);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: docs[0].id } })).toBe(1);
    expect(await kitchenQty(mGravy)).toBe(5); // 5.5 - 1 x 0.5
  });

  it("a manual sales log sent twice at once (same key): one order, consumed once", async () => {
    const k = `ms-${RUN}-race`;
    const input = { outletId: A, businessDate: today(), lines: [{ menuItemId: curryItem, qty: 2 }] };
    // Both answer: one records the sale, the other replays it.
    const results = await Promise.all([recordManualSales(alice, input, k), recordManualSales(alice, input, k)]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(results[0].order.id).toBe(results[1].order.id);
    const orders = await prisma.order.findMany({ where: { organizationId: orgId, source: "MANUAL", externalRef: `manual:${k}` } });
    expect(orders).toHaveLength(1);
    expect(await prisma.inventoryLedger.count({ where: { sourceRef: { startsWith: `order:${orders[0].id}:` } } })).toBe(1);
    expect(await kitchenQty(mGravy)).toBe(4); // 5 - 2 x 0.5
    expect(num(await currentQuantity(prisma, sys, A, mGravy))).toBe(4);
  });

  it("a goods receipt posted twice at once: received once (the second post is the no-op it always was)", async () => {
    const vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Veg ${RUN}` } })).id;
    const before = num(await currentQuantity(prisma, sys, A, mOnion));
    const grn = await createGRN(alice, { outletId: A, vendorId, lines: [{ materialId: mOnion, qty: 5, rate: 32 }] });
    const results = await Promise.all([postGRN(alice, grn.id), postGRN(bob, grn.id)]);
    expect(results.map((r) => r.status)).toEqual(["POSTED", "POSTED"]);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: grn.id } })).toBe(1);
    expect(num(await currentQuantity(prisma, sys, A, mOnion))).toBe(before + 5);
  });

  it("a store issue posted twice at once: the stock moves to the kitchen once (posting an issued issue is a no-op)", async () => {
    const before = await kitchenQty(mOnion);
    const issue = await createIssue(alice, { outletId: A, toDepartmentId: kitchen, lines: [{ materialId: mOnion, qty: 2 }] });
    const results = await Promise.all([postIssue(alice, issue.id), postIssue(bob, issue.id)]);
    expect(results.map((r) => r.status)).toEqual(["ISSUED", "ISSUED"]);
    expect(await prisma.inventoryLedger.count({ where: { sourceId: issue.id } })).toBe(2); // OUT unassigned, IN kitchen
    expect(await kitchenQty(mOnion)).toBe(before + 2);
  });
});
