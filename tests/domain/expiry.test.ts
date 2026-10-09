/**
 * Stock that is about to expire (audit IN-14) against the real services and database: expiry dates and the FSSAI lot code
 * travel from the goods receipt into the ledger; what is left of each batch is derived assuming earliest-expiry-first;
 * the list, the window, the use-first marker, the permission and the manager's alert.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createGRN, postGRN } from "@/server/services/procurement";
import { expiringStock } from "@/server/services/expiry";
import { businessInsights } from "@/server/services/insights";
import { localDate } from "@/domain/time";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let vendor: string;
let kg: string;
let store: AccessContext;
const NOW = new Date();
const today = localDate(NOW, "Asia/Kolkata");
const ymd = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function material(name: string) {
  return (await prisma.material.create({ data: { organizationId: env.orgId, sku: `${name.slice(0, 3).toUpperCase()}-${uniq()}`, name: `${name} ${uniq()}`, baseUnitId: kg, perishable: true, trackBatch: true } })).id;
}
/** A goods receipt posted through the real service: stock comes in with its batch, expiry and lot. */
async function receive(materialId: string, qty: number, batch: { batchNo?: string; expiryDate?: string; fssaiLot?: string }) {
  const grn = await createGRN(store, { outletId: env.outletA, vendorId: vendor, lines: [{ materialId, qty, rate: 10, batchNo: batch.batchNo, fssaiLot: batch.fssaiLot, expiryDate: batch.expiryDate ? new Date(`${batch.expiryDate}T00:00:00Z`) : undefined }] });
  await postGRN(store, grn.id);
}
/** Stock used up (a sale or wastage): negative ledger rows, as the consumption paths write them. */
const use = (materialId: string, qty: number) => prisma.inventoryLedger.create({ data: { organizationId: env.orgId, outletId: env.outletA, materialId, txnType: "SALE_CONSUMPTION", qty: -qty, rate: 10, amount: -qty * 10, sourceType: "ORDER", sourceId: `test-${uniq()}` } });
const report = (days = 7, ctx: AccessContext = env.manager) => expiringStock(prisma, ctx, { outletId: env.outletA, days }, NOW);
const mine = (r: Awaited<ReturnType<typeof report>>, materialId: string) => r.rows.filter((x) => x.materialId === materialId);

beforeAll(async () => {
  env = await makeEnv("Gex");
  store = { ...member(env.orgId, "STORE", env.outletA), userId: `store-${uniq()}` };
  vendor = (await prisma.vendor.create({ data: { organizationId: env.orgId, name: `Dairy ${uniq()}`, status: "ACTIVE", active: true } })).id;
  kg = (await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("X1. the lot and the expiry reach the ledger", () => {
  it("X1 batch, expiry and FSSAI lot are stored on the receipt line and the ledger row; a bad lot code is refused", async () => {
    const m = await material("Milk");
    await receive(m, 10, { batchNo: "B-1", expiryDate: ymd(3), fssaiLot: "L-2026/10" });
    const row = await prisma.inventoryLedger.findFirstOrThrow({ where: { materialId: m, txnType: "PURCHASE_RECEIPT" } });
    expect(row).toMatchObject({ batchNo: "B-1", fssaiLot: "L-2026/10" });
    expect(row.expiryDate?.toISOString().slice(0, 10)).toBe(ymd(3));
    const line = await prisma.goodsReceiptLine.findFirstOrThrow({ where: { materialId: m } });
    expect(line.fssaiLot).toBe("L-2026/10");
    await expect(createGRN(store, { outletId: env.outletA, vendorId: vendor, lines: [{ materialId: m, qty: 1, rate: 1, fssaiLot: "<script>" }] })).rejects.toThrow(/Lot code/);
    await expect(createGRN(store, { outletId: env.outletA, vendorId: vendor, lines: [{ materialId: m, qty: 1, rate: 1, fssaiLot: "x".repeat(41) }] })).rejects.toThrow();
  });
});

describe("X2. what is left of each batch", () => {
  it("X2 on-hand sits in the latest-expiring batches: the earliest batch is the one used up first", async () => {
    const m = await material("Yoghurt");
    await receive(m, 10, { batchNo: "Y-OLD", expiryDate: ymd(2), fssaiLot: "L-OLD" });
    await receive(m, 20, { batchNo: "Y-NEW", expiryDate: ymd(20) });
    // Nothing used yet: the old batch is whole and expires in two days.
    let r = await report(7);
    expect(mine(r, m)).toMatchObject([{ batchNo: "Y-OLD", fssaiLot: "L-OLD", remaining: 10, daysLeft: 2, status: "SOON", useFirst: true }]);
    // 12 used: the old batch (10) and 2 of the new one are gone.
    await use(m, 12);
    r = await report(7);
    expect(mine(r, m)).toEqual([]);
    expect(mine(await report(30), m)).toMatchObject([{ batchNo: "Y-NEW", remaining: 18, useFirst: true }]);
    // Only 5 used: 5 of the old batch remain.
    const m2 = await material("Cream");
    await receive(m2, 10, { batchNo: "C-OLD", expiryDate: ymd(1) });
    await receive(m2, 20, { batchNo: "C-NEW", expiryDate: ymd(20) });
    await use(m2, 25);
    expect(mine(await report(7), m2)).toEqual([]); // 5 left, all of it the newest
    const m3 = await material("Butter");
    await receive(m3, 10, { batchNo: "B-OLD", expiryDate: ymd(1) });
    await receive(m3, 20, { batchNo: "B-NEW", expiryDate: ymd(20) });
    await use(m3, 5); // on hand 25: the new batch (20) and 5 of the old
    expect(mine(await report(7), m3)).toMatchObject([{ batchNo: "B-OLD", remaining: 5, useFirst: true }]);
  });

  it("X2 the use-first marker is on the earliest batch of each material; batches of one lot are added up", async () => {
    const m = await material("Paneer");
    await receive(m, 4, { batchNo: "P-1", expiryDate: ymd(2), fssaiLot: "L-P1" });
    await receive(m, 6, { batchNo: "P-1", expiryDate: ymd(2), fssaiLot: "L-P1" }); // the same batch delivered in two lots
    await receive(m, 8, { batchNo: "P-2", expiryDate: ymd(5) });
    const rows = mine(await report(7), m);
    expect(rows.map((x) => [x.batchNo, x.remaining, x.useFirst])).toEqual([["P-1", 10, true], ["P-2", 8, false]]);
  });

  it("X2 undated stock is never listed; stock beyond the dated batches does not invent more", async () => {
    const undated = await material("Salt");
    await receive(undated, 50, {});
    expect(mine(await report(120), undated)).toEqual([]);
    const m = await material("Eggs");
    await receive(m, 10, { batchNo: "E-1", expiryDate: ymd(3) });
    await prisma.inventoryLedger.create({ data: { organizationId: env.orgId, outletId: env.outletA, materialId: m, txnType: "OPENING_BALANCE", qty: 100, rate: 5, amount: 500 } }); // undated opening stock
    expect(mine(await report(7), m)).toMatchObject([{ batchNo: "E-1", remaining: 10 }]); // never more than the batch that was received
  });
});

describe("X3. the list", () => {
  it("X3 expired, today and soon are told apart and counted; the window decides what is listed; oldest first", async () => {
    const [a, b, c, d] = [await material("Old"), await material("Today"), await material("Soon"), await material("Later")];
    await receive(a, 3, { batchNo: "A", expiryDate: ymd(-2) });
    await receive(b, 3, { batchNo: "B", expiryDate: ymd(0) });
    await receive(c, 3, { batchNo: "C", expiryDate: ymd(5) });
    await receive(d, 3, { batchNo: "D", expiryDate: ymd(40) });
    const r = await report(7);
    const ours = r.rows.filter((x) => [a, b, c, d].includes(x.materialId));
    expect(ours.map((x) => [x.batchNo, x.status, x.daysLeft])).toEqual([["A", "EXPIRED", -2], ["B", "TODAY", 0], ["C", "SOON", 5]]);
    expect(r.counts.expired).toBeGreaterThanOrEqual(1);
    expect(r.counts.today).toBeGreaterThanOrEqual(1);
    expect(r.asOf).toBe(today);
    expect(r.basis).toMatch(/earliest expiry is used first/);
    expect(mine(await report(60), d)).toHaveLength(1);
    expect(mine(await report(3), c)).toEqual([]); // five days away is outside a three-day window
    expect(await report(0, env.manager).then((x) => x.rows.every((row) => row.daysLeft <= 0))).toBe(true);
  });

  it("X3 permission and tenancy: inventory viewers only, this outlet only, bad input refused", async () => {
    await expect(report(7, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(expiringStock(prisma, member(env.orgId, "MANAGER", env.outletB), { outletId: env.outletA, days: 7 })).rejects.toThrow();
    const foreign = await expiringStock(prisma, env.foreign, { outletId: env.outletA, days: 7 }).catch(() => ({ rows: [] }));
    expect(foreign.rows).toEqual([]);
    await expect(expiringStock(prisma, env.manager, { outletId: env.outletA, days: -1 })).rejects.toThrow();
    await expect(expiringStock(prisma, env.manager, { outletId: env.outletA, days: 1000 })).rejects.toThrow();
    await expect(expiringStock(prisma, env.manager, { outletId: "" } as never)).rejects.toThrow();
    // Kitchen staff hold inventory.view: they may see what to use first.
    expect((await report(7, env.kitchen)).rows.length).toBeGreaterThan(0);
  });
});

describe("X4. the manager's alert", () => {
  it("X4 an expired batch is a critical insight, one about to expire a warning; both point at the expiry screen", async () => {
    const e = await makeEnv("Gey");
    const u = await prisma.unit.create({ data: { organizationId: e.orgId, code: `u${uniq()}`, name: "kg", kind: "WEIGHT" } });
    const m = await prisma.material.create({ data: { organizationId: e.orgId, sku: `Z-${uniq()}`, name: "Curd", baseUnitId: u.id } });
    const v = await prisma.vendor.create({ data: { organizationId: e.orgId, name: `V ${uniq()}`, status: "ACTIVE", active: true } });
    const s2 = { ...member(e.orgId, "STORE", e.outletA), userId: `s-${uniq()}` };
    const grn = await createGRN(s2, { outletId: e.outletA, vendorId: v.id, lines: [{ materialId: m.id, qty: 5, rate: 10, batchNo: "Z-1", expiryDate: new Date(`${ymd(4)}T00:00:00Z`) }] });
    await postGRN(s2, grn.id);
    const soon = (await businessInsights(prisma, e.manager, { outletId: e.outletA, asOf: NOW })).insights.find((i) => i.code === "EXPIRING_STOCK");
    expect(soon).toMatchObject({ severity: "WARNING", category: "inventory", link: "/inventory/expiry" });
    expect(soon!.detail).toMatch(/Curd batch Z-1 \(in 4 days\)/);
    const later = new Date(NOW.getTime() + 6 * 86_400_000);
    const gone = (await businessInsights(prisma, e.manager, { outletId: e.outletA, asOf: later })).insights.find((i) => i.code === "EXPIRED_STOCK");
    expect(gone).toMatchObject({ severity: "CRITICAL" });
    expect(gone!.detail).toMatch(/expired 2 days ago/);
    // A role without inventory rights is not told.
    expect((await businessInsights(prisma, e.cashier, { outletId: e.outletA, asOf: NOW }).catch(() => ({ insights: [] }))).insights.some((i) => i.code.includes("EXPIR"))).toBe(false);
  });
});
