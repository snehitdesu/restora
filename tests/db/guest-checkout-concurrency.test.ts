/**
 * Load-test regression (2026-10-13): 25–50 guests checking out at once.
 *
 * placeGuestOrder used to write its audit row and the staff "New QR order"
 * alert in a second transaction AFTER the order (with its KOT) had committed,
 * outside the queued runInTx path. Under concurrent checkouts on SQLite that
 * transaction lost the write-lock wait (Prisma P1008), so the guest got HTTP 500
 * for an order that was already in the kitchen, and the audit row and staff
 * alert were never written (a retry only replays the order). They are now part
 * of the order's own transaction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";
import { placeGuestOrder } from "@/server/services/guestOrdering";

const RUN = Date.now().toString(36);
const N = 30;
let orgId: string, outletId: string, dish: string;
const tokens: string[] = [];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Guest Conc ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `GC${RUN}`.slice(0, 12), name: "GC" } })).id;
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  dish = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `GC dish ${RUN}`, price: 85, taxPct: 5, station: "KITCHEN" } })).id;
  for (let i = 0; i < N; i++) {
    const token = randomBytes(18).toString("base64url");
    await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `C${i}`, qrToken: token } });
    tokens.push(token);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe(`${N} guests paying cash check out at the same moment`, () => {
  it("every order is placed once, with exactly one KOT, one audit row and one staff alert; no request fails", async () => {
    const res = await Promise.allSettled(tokens.map((t, i) => placeGuestOrder(t, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "CASH" }, `gc-${RUN}-${i}-key`)));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => `${(f.reason as { code?: string })?.code ?? ""} ${String((f.reason as Error)?.message).slice(0, 80)}`)).toEqual([]);
    const ids = res.map((r) => (r as PromiseFulfilledResult<{ orderId: string }>).value.orderId);
    expect(new Set(ids).size).toBe(N);
    const orders = await prisma.order.findMany({ where: { id: { in: ids } }, include: { kots: true } });
    expect(orders).toHaveLength(N);
    for (const o of orders) {
      expect(o.status).toBe("SENT");
      expect(o.kots).toHaveLength(1);
    }
    // One "via guest-qr" row per order (placeOrder also writes its own CREATE row).
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order", entityId: { in: ids }, after: { contains: "guest-qr" } } })).toBe(N);
    expect(await prisma.notification.count({ where: { organizationId: orgId, type: "NEW_ORDER" } })).toBe(N);
  });

  it("replaying all of them (lost responses) returns the same orders and adds nothing", async () => {
    const before = { orders: await prisma.order.count({ where: { organizationId: orgId } }), kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }), audits: await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order" } }) };
    const res = await Promise.all(tokens.map((t, i) => placeGuestOrder(t, { items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "CASH" }, `gc-${RUN}-${i}-key`)));
    expect(res.every((r) => r.replayed)).toBe(true);
    expect({ orders: await prisma.order.count({ where: { organizationId: orgId } }), kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }), audits: await prisma.auditLog.count({ where: { organizationId: orgId, action: "CREATE", entityType: "Order" } }) }).toEqual(before);
  });
});
