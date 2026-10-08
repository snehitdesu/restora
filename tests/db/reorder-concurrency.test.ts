/**
 * Group 2 reorder engine, C8: two people raise the same reorder at the same
 * time (two requests in flight together, different Idempotency-Keys, both
 * built from the same screen). Exactly one may create a purchase order; the
 * other must get 409 "ordered since you loaded this screen" and create nothing.
 *
 * Both raises are started together and awaited with Promise.allSettled: on
 * PostgreSQL they run as concurrent SERIALIZABLE transactions on separate
 * connections, so the loser is aborted by the database (serialization failure),
 * retried by runInTx, and then sees the winner's PO in its re-check. On SQLite
 * the single writer serializes them; the outcome must be the same.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError } from "@/server/db/scope";
import { computeReorder, raiseReorderPurchaseOrders, raiseReorderIndent } from "@/server/services/reorder";

const onPostgres = /^postgres(ql)?:/.test(process.env.DATABASE_URL ?? "");
const RUN = Date.now().toString(36);
let orgId: string, A: string, kg: string, vendorId: string, otherVendorId: string;
let alice: AccessContext, bob: AccessContext;

const member = (userId: string, role: string): AccessContext => ({ userId, organizationId: orgId, outletIds: [A], roles: [role], outletRoles: { [A]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Reorder conc ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RC${RUN}`, name: "RC" } })).id;
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  vendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RC vendor ${RUN}` } })).id;
  otherVendorId = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RC vendor 2 ${RUN}` } })).id;
  alice = member(`alice-${RUN}`, "STORE");
  bob = member(`bob-${RUN}`, "MANAGER");
});

afterAll(async () => { await prisma.$disconnect(); });

async function freshMaterial(label: string) {
  const id = (await prisma.material.create({ data: { organizationId: orgId, sku: `RC-${label}-${RUN}`, name: `RC ${label} ${RUN}`, baseUnitId: kg, reorderLevel: 10, parLevel: 40 } })).id;
  await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId, materialId: id, lastRate: 25 } });
  await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId: otherVendorId, materialId: id, lastRate: 26 } });
  return id;
}

function expectOneWinner(results: PromiseSettledResult<unknown>[]) {
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  expect(ok).toHaveLength(1);
  expect(failed).toHaveLength(1);
  expect(failed[0].reason).toBeInstanceOf(ConflictError);
  expect((failed[0].reason as ConflictError).status).toBe(409);
  expect((failed[0].reason as Error).message).toMatch(/was ordered since you loaded this screen/);
}

describe(`concurrent reorder raises (${onPostgres ? "PostgreSQL" : "SQLite"})`, () => {
  it("C8 two simultaneous PO raises from the same screen: exactly one PO, the other request is 409", async () => {
    const m = await freshMaterial("po");
    const screen = await computeReorder(prisma, alice, { outletId: A });
    const r = screen.rows.find((x) => x.materialId === m)!;
    expect(r).toMatchObject({ incoming: 0, suggestedBaseQty: 40 });

    // Same material, different vendors and keys: nothing but the re-check can stop the second order.
    const results = await Promise.allSettled([
      raiseReorderPurchaseOrders(alice, { outletId: A, asOf: screen.asOf, lines: [{ materialId: m, vendorId, qty: r.order.qty, expectedIncoming: r.incoming }] }, `c8-a-${RUN}`),
      raiseReorderPurchaseOrders(bob, { outletId: A, asOf: screen.asOf, lines: [{ materialId: m, vendorId: otherVendorId, qty: r.order.qty, expectedIncoming: r.incoming }] }, `c8-b-${RUN}`),
    ]);
    expectOneWinner(results);

    const pos = await prisma.purchaseOrder.findMany({ where: { organizationId: orgId, lines: { some: { materialId: m } } }, include: { lines: true } });
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ status: "DRAFT", source: "REORDER" });
    // Exactly one CREATE audit row: the loser left nothing behind.
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "PurchaseOrder", action: "CREATE", entityId: { in: pos.map((p) => p.id) } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "PurchaseOrder", action: "CREATE" , after: { contains: m } } })).toBe(1);
    const after = await computeReorder(prisma, alice, { outletId: A });
    expect(after.rows.find((x) => x.materialId === m)).toBeUndefined();
  });

  it("C8b a simultaneous PO raise and purchase request for the same material: exactly one document", async () => {
    const m = await freshMaterial("mixed");
    const screen = await computeReorder(prisma, alice, { outletId: A });
    const r = screen.rows.find((x) => x.materialId === m)!;
    const results = await Promise.allSettled([
      raiseReorderPurchaseOrders(bob, { outletId: A, asOf: screen.asOf, lines: [{ materialId: m, vendorId, qty: r.order.qty, expectedIncoming: 0 }] }, `c8b-a-${RUN}`),
      raiseReorderIndent(alice, { outletId: A, asOf: screen.asOf, lines: [{ materialId: m, qty: r.order.qty, expectedIncoming: 0 }] }, `c8b-b-${RUN}`),
    ]);
    expectOneWinner(results);
    const pos = await prisma.purchaseOrder.count({ where: { organizationId: orgId, lines: { some: { materialId: m } } } });
    const indents = await prisma.purchaseIndent.count({ where: { organizationId: orgId, lines: { some: { materialId: m } } } });
    expect(pos + indents).toBe(1);
  });

  it("the same request sent twice at once with the SAME key: one set of POs, both callers get it", async () => {
    const m = await freshMaterial("samekey");
    const screen = await computeReorder(prisma, alice, { outletId: A });
    const r = screen.rows.find((x) => x.materialId === m)!;
    const body = { outletId: A, asOf: screen.asOf, lines: [{ materialId: m, vendorId, qty: r.order.qty, expectedIncoming: 0 }] };
    const results = await Promise.allSettled([raiseReorderPurchaseOrders(alice, body, `c8c-${RUN}`), raiseReorderPurchaseOrders(alice, body, `c8c-${RUN}`)]);
    // The loser resolves to the winner's POs (replay), whether it lost on the key or in the re-check.
    expect(results.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((x) => (x as PromiseFulfilledResult<Awaited<ReturnType<typeof raiseReorderPurchaseOrders>>>).value);
    expect(new Set(values.map((v) => v.purchaseOrders[0].id)).size).toBe(1);
    expect(values.map((v) => v.replayed).sort()).toEqual([false, true]);
    expect(await prisma.purchaseOrder.count({ where: { organizationId: orgId, lines: { some: { materialId: m } } } })).toBe(1);
  });
});
