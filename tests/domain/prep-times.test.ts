/**
 * Measured preparation time (audit MB-07) against the real services and database. Orders are placed through the order
 * service so the kitchen tickets are real; only the lifecycle stamps are set directly, to build exact durations
 * (simulating the passage of time, never business data).
 *
 *  P1 median / p90 / average per dish, grouped by menu item; cooking time next to it
 *  P2 what is not a measurement: cancelled and never-ready tickets, absurd durations, other outlets and tenants, old tickets
 *  P3 reliability threshold, station breakdown, permission
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { createOrder, addOrderItem, submitOrder } from "@/server/services/orders";
import { dishPrepTimes, percentile, PREP_MIN_SAMPLES } from "@/server/services/prepTimes";
import { makeEnv, type Env } from "./growthSupport";

let env: Env;
let dosa: string;
let coffee: string;
const MIN = 60_000;
const NOW = new Date("2026-10-08T10:00:00Z");

beforeAll(async () => {
  env = await makeEnv("Gpt");
  dosa = (await createMenuItem(env.owner, { name: "Masala Dosa", price: 120, taxPct: 5 })).id;
  coffee = (await createMenuItem(env.owner, { name: "Filter Coffee", price: 40, taxPct: 5 })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

/** One ticket: an order with the given dishes, sent to the kitchen, with its lifecycle stamped `readyAfterMin` minutes after it arrived. */
async function ticket(dishes: Array<{ menuItemId?: string; name: string }>, readyAfterMin: number | null, opts: { outletId?: string; cookMin?: number; status?: string; ageDays?: number; station?: string } = {}) {
  const outletId = opts.outletId ?? env.outletA;
  const o = await createOrder(env.owner, { outletId, channel: "TAKEAWAY" });
  for (const d of dishes) await addOrderItem(env.owner, o.id, { ...d, qty: 1, ...(d.menuItemId ? {} : { unitPrice: 100, taxPct: 0 }), ...(opts.station ? { station: opts.station } : {}) });
  await submitOrder(env.owner, o.id);
  const kots = await prisma.kot.findMany({ where: { orderId: o.id } });
  const arrived = new Date(NOW.getTime() - (opts.ageDays ?? 1) * 86400_000);
  for (const k of kots) {
    const ready = readyAfterMin === null ? null : new Date(arrived.getTime() + readyAfterMin * MIN);
    await prisma.kot.update({
      where: { id: k.id },
      data: {
        createdAt: arrived, status: opts.status ?? (ready ? "SERVED" : "NEW"), acceptedAt: ready ? new Date(arrived.getTime() + MIN) : null,
        startedAt: ready && opts.cookMin !== undefined ? new Date(ready.getTime() - opts.cookMin * MIN) : null, readyAt: ready, servedAt: ready,
      },
    });
  }
  return o.id;
}
const times = (extra: Record<string, unknown> = {}) => dishPrepTimes(prisma, env.manager, { outletId: env.outletA, days: 30, ...extra } as never, NOW);

describe("P1. per dish", () => {
  it("P1 median, average and p90 per dish; each dish on a ticket is credited with the ticket's time; cooking time from Start", async () => {
    for (const m of [8, 10, 12, 14, 30]) await ticket([{ menuItemId: dosa, name: "Masala Dosa" }], m, { cookMin: m - 3 });
    await ticket([{ menuItemId: dosa, name: "Masala Dosa" }, { menuItemId: coffee, name: "Filter Coffee" }], 16, { cookMin: 12 });
    for (const m of [3, 4, 5]) await ticket([{ menuItemId: coffee, name: "Filter Coffee" }], m);
    const r = await times();
    const d = Object.fromEntries(r.dishes.map((x) => [x.name, x]));
    // Dosa: 8, 10, 12, 14, 16, 30 -> median 13, average 15, p90 23 (interpolated between 16 and 30).
    expect(d["Masala Dosa"]).toMatchObject({ tickets: 6, medianMinutes: 13, averageMinutes: 15, p90Minutes: 23, reliable: true, menuItemId: dosa });
    expect(d["Masala Dosa"].cookMedianMinutes).toBe(10); // cooking only, from Start: 5, 7, 9, 11, 12, 27 -> (9 + 11) / 2
    // Coffee: 3, 4, 5 and the shared 16-minute ticket.
    expect(d["Filter Coffee"]).toMatchObject({ tickets: 4, medianMinutes: 4.5, reliable: true });
    expect(r.overall.tickets).toBe(9);
    expect(r.dishes[0].name).toBe("Masala Dosa"); // slowest reliable dish first
    expect(r.minSamples).toBe(PREP_MIN_SAMPLES);
  });

  it("P1 percentile helper", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.9)).toBe(46);
  });
});

describe("P2. what is not a measurement", () => {
  it("P2 cancelled and never-ready tickets, absurd durations, old tickets, other outlets and other tenants are left out", async () => {
    const e2 = await makeEnv("Gpu");
    const only = (await createMenuItem(env.owner, { name: "Bao Bun", price: 90, taxPct: 5 })).id;
    const item = { menuItemId: only, name: "Bao Bun" };
    await ticket([item], 9);
    await ticket([item], 11);
    await ticket([item], 13);
    await ticket([item], null); // still on the board
    await ticket([item], 7, { status: "CANCELLED" }); // voided
    await ticket([item], 20 * 60); // left open overnight: 20 hours is not a prep time
    await ticket([item], 5, { ageDays: 45 }); // older than the period
    await ticket([item], 6, { outletId: env.outletB }); // another outlet of the same restaurant
    // Another restaurant's own Bao Bun.
    const o = await createOrder(e2.owner, { outletId: e2.outletA, channel: "TAKEAWAY" });
    await addOrderItem(e2.owner, o.id, { name: "Bao Bun", qty: 1, unitPrice: 90, taxPct: 0 });
    await submitOrder(e2.owner, o.id);
    await prisma.kot.updateMany({ where: { orderId: o.id }, data: { status: "SERVED", readyAt: new Date(Date.now() + 2 * MIN) } });

    const r = await times();
    const bao = r.dishes.find((x) => x.name === "Bao Bun")!;
    expect(bao).toMatchObject({ tickets: 3, medianMinutes: 11, averageMinutes: 11 });
    const other = await dishPrepTimes(prisma, env.owner, { outletId: env.outletB, days: 30 }, NOW);
    expect(other.dishes.find((x) => x.name === "Bao Bun")).toMatchObject({ tickets: 1, medianMinutes: 6 });
    expect((await times({ days: 90 })).dishes.find((x) => x.name === "Bao Bun")!.tickets).toBe(4); // the 45-day-old one counts in a longer period
  });
});

describe("P3. reliability, stations, permission", () => {
  it("P3 a dish needs enough tickets before it is used as an expectation; stations are reported separately", async () => {
    const rare = (await createMenuItem(env.owner, { name: "Chef Special", price: 300, taxPct: 5 })).id;
    await ticket([{ menuItemId: rare, name: "Chef Special" }], 25);
    await ticket([{ menuItemId: rare, name: "Chef Special" }], 27);
    const r = await times();
    const special = r.dishes.find((x) => x.name === "Chef Special")!;
    expect(special).toMatchObject({ tickets: 2, reliable: false });
    expect(r.dishes.findIndex((x) => x.name === "Chef Special")).toBeGreaterThan(r.dishes.findIndex((x) => x.reliable)); // unreliable dishes sort after reliable ones
    expect(r.stations.length).toBeGreaterThan(0);
    expect(r.stations.every((s) => s.tickets > 0 && s.medianMinutes >= 0)).toBe(true);
  });

  it("P3 kitchen staff can read it; a cashier cannot; another restaurant sees nothing of this outlet; bad input is refused", async () => {
    expect((await dishPrepTimes(prisma, env.kitchen, { outletId: env.outletA, days: 30 }, NOW)).overall.tickets).toBeGreaterThan(0);
    await expect(dishPrepTimes(prisma, env.cashier, { outletId: env.outletA, days: 30 }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    // Another restaurant asking for this outlet's id gets nothing (every read is scoped to its own organization).
    const foreign = await dishPrepTimes(prisma, env.foreign, { outletId: env.outletA, days: 30 }, NOW);
    expect(foreign.overall.tickets).toBe(0);
    expect(foreign.dishes).toEqual([]);
    await expect(dishPrepTimes(prisma, env.kitchen, { outletId: env.outletB, days: 30 }, NOW)).rejects.toThrow(); // not their outlet
    await expect(dishPrepTimes(prisma, env.manager, { outletId: env.outletA, days: 0 } as never, NOW)).rejects.toThrow();
    await expect(dishPrepTimes(prisma, env.manager, { outletId: "", days: 30 } as never, NOW)).rejects.toThrow();
    expect(ValidationError).toBeDefined();
  });
});
