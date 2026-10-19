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

  // 2026-10-19: a replay whose original commits just AFTER the replay looked its key up, but before the
  // replay checked the table's limits, saw the original as one more waiting order and was refused (422),
  // so the guest page reported "failed" for an order the restaurant had. The refusal must recover it.
  it("a replay that races the original's commit returns the original instead of a limit refusal", async () => {
    const token = randomBytes(18).toString("base64url");
    const tableId = (await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `LIM${RUN}`.slice(0, 12), qrToken: token } })).id;
    const body = { items: [{ menuItemId: dish, qty: 1 }] }; // no payment choice: waits for acceptance (OPEN)
    for (let i = 0; i < 2; i++) await placeGuestOrder(token, body, `lim-${RUN}-${i}-key`);
    const key = `lim-${RUN}-orig-key`;
    let original: { orderId: string } | undefined;
    let lookups = 0;
    // The replay's first key lookup misses; the original commits right after it (the third waiting order).
    const racing = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "order") {
          return new Proxy(target.order, {
            get(o, p) {
              if (p === "findUnique" && lookups++ === 0) {
                return async (args: Parameters<typeof prisma.order.findUnique>[0]) => {
                  const miss = await o.findUnique(args);
                  original = await placeGuestOrder(token, body, key);
                  return miss;
                };
              }
              const v = Reflect.get(o, p);
              return typeof v === "function" ? v.bind(o) : v;
            },
          });
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const replay = await placeGuestOrder(token, body, key, {}, racing);
    expect(original).toBeDefined();
    expect(replay).toMatchObject({ orderId: original!.orderId, replayed: true });
    expect(await prisma.order.count({ where: { organizationId: orgId, tableId } })).toBe(3);
    // A genuinely new order is still refused at the limit.
    await expect(placeGuestOrder(token, body, `lim-${RUN}-new-key`)).rejects.toThrow(/waiting for the restaurant/);
  });
});
