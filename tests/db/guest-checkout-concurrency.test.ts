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

  // 2026-10-19: a slow answer (22.9 s) makes the guest page replay the request while the first one may
  // still be running. Duplicate taps and replays of one key racing each other: one order, one KOT.
  it("the same request arriving several times at once (taps + replays racing the original) places ONE order with ONE KOT", async () => {
    const token = randomBytes(18).toString("base64url");
    const tableId = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `RACE${RUN}`.slice(0, 12), qrToken: token } })).id;
    const before = { kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }) };
    const body = { items: [{ menuItemId: dish, qty: 2 }], paymentMethod: "CASH" as const };
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => placeGuestOrder(token, body, `race-${RUN}-key`)));
    const failed = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => String((f.reason as Error)?.message).slice(0, 80))).toEqual([]);
    const placed = res.map((r) => (r as PromiseFulfilledResult<{ orderId: string; replayed: boolean; accessKey: string }>).value);
    expect(new Set(placed.map((p) => p.orderId)).size).toBe(1);
    expect(new Set(placed.map((p) => p.accessKey)).size).toBe(1);
    expect(placed.filter((p) => !p.replayed)).toHaveLength(1);
    const orders = await prisma.order.findMany({ where: { organizationId: orgId, tableId }, include: { kots: true } });
    expect(orders).toHaveLength(1);
    expect(orders[0].kots).toHaveLength(1);
    expect({ kots: await prisma.kot.count({ where: { organizationId: orgId } }), alerts: await prisma.notification.count({ where: { organizationId: orgId } }) }).toEqual({ kots: before.kots + 1, alerts: before.alerts + 1 });
    // A later replay (the guest's "Check order status") still returns that order and adds nothing.
    await expect(placeGuestOrder(token, body, `race-${RUN}-key`)).resolves.toMatchObject({ orderId: placed[0].orderId, replayed: true });
    expect(await prisma.kot.count({ where: { organizationId: orgId } })).toBe(before.kots + 1);
  });
});
