/**
 * Hosted guest checkout latency is dominated by database round trips: on the Preview (functions in iad1,
 * Neon in Singapore) each statement cost ~0.47 s and a one-line order took 22.9 s (2026-10-19). This
 * budget keeps the number of Prisma operations a QR order makes from creeping back up. Measured before
 * the 2026-10-19 change: 32 for one line, +9 per extra line; now 30, +5 per line.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";
import { placeGuestOrder } from "@/server/services/guestOrdering";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, tableToken: string;
const dishes: string[] = [];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Guest Budget ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `GB${RUN}`.slice(0, 12), name: "GB" } })).id;
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  for (let i = 0; i < 3; i++) dishes.push((await prisma.menuItem.create({ data: { organizationId: orgId, name: `GB dish ${i} ${RUN}`, price: 80 + i * 10, taxPct: 5, station: "KITCHEN" } })).id);
  tableToken = randomBytes(18).toString("base64url");
  await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `GB${RUN}`.slice(0, 10), qrToken: tableToken } });
});
afterAll(async () => { await prisma.$disconnect(); });

async function measured(lines: number, key: string) {
  let ops = 0;
  const db = prisma.$extends({ query: { $allModels: { async $allOperations({ args, query }) { ops++; return query(args); } } } });
  const items = dishes.slice(0, lines).map((menuItemId) => ({ menuItemId, qty: 1 }));
  const placed = await placeGuestOrder(tableToken, { items, paymentMethod: "ONLINE" }, key, {}, db as never);
  return { ops, placed };
}

describe("a guest QR order's database round trips", () => {
  it("stays within budget for 1 and 3 lines, and the order is still complete (one order, right total, waiting for its online payment: no KOT yet)", async () => {
    const one = await measured(1, `gb-${RUN}-one-key`);
    const three = await measured(3, `gb-${RUN}-three-key`);
    expect(one.ops).toBeLessThanOrEqual(30);
    expect(three.ops - one.ops).toBeLessThanOrEqual(2 * 5);
    for (const [p, lines] of [[one.placed, 1], [three.placed, 3]] as const) {
      const o = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { items: true, kots: true } });
      expect(o.items).toHaveLength(lines);
      expect(o.kots).toHaveLength(0);
      expect(o.status).toBe("OPEN");
      const expected = o.items.reduce((a, i) => a + Number(i.lineTotal) * (1 + Number(i.taxPct) / 100), 0);
      expect(Number(o.total)).toBeCloseTo(expected, 2);
    }
  });

  it("a replay of the same key returns the same order with fewer operations and creates nothing", async () => {
    const first = await measured(2, `gb-${RUN}-replay-key`);
    const counts = async () => ({ orders: await prisma.order.count({ where: { organizationId: orgId } }), kots: await prisma.kot.count({ where: { organizationId: orgId } }) });
    const before = await counts();
    const again = await measured(2, `gb-${RUN}-replay-key`);
    expect(again.placed).toMatchObject({ orderId: first.placed.orderId, replayed: true });
    expect(again.ops).toBeLessThan(first.ops);
    expect(await counts()).toEqual(before);
  });
});
