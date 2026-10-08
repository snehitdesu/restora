/**
 * Group 3 money desk (proposal module 06), real services against the test DB:
 * the three-way check (POS billed vs declared vs bank), declared revenue per
 * channel, payment channels, aggregator commission, bank deposits, petty cash
 * for the day, closing (blockers, reconciliations completed, discrepancies
 * raised, locked day, changes after close shown) and reopening (audited, new
 * revision), permissions and tenant / outlet isolation. Decimal exactness:
 * a one-paisa gap stays a one-paisa gap.
 * (Concurrent closes: tests/db/day-close-concurrency.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { getMoneyDesk, declareSales, recordBankDeposit, voidBankDeposit, closeDay, reopenDay, listDayCloses, channelOf } from "@/server/services/moneyDesk";
import { saveDailyReconciliation, recordPettyCash, createExpense, openCashDrawer, closeCashDrawer } from "@/server/services/finance";
import { createOrder, addOrderItem, submitOrder, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { recordManualSales } from "@/server/services/manualSales";
import { saveWorksheetEntry } from "@/server/services/productionWorksheet";
import { createWastage, postWastage } from "@/server/services/wastage";
import { businessDayRange } from "@/domain/time";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
const TZ = "Asia/Kolkata";
let orgId: string, M: string, N: string, dish: string, mat: string;
let sys: AccessContext, mgr: AccessContext, cashier: AccessContext, kitchen: AccessContext, mgrN: AccessContext, foreign: AccessContext;
let n = 0;
const key = () => `md-${RUN}-${++n}`;
const D0 = () => businessDayRange(new Date(), TZ).date;
const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function paid(opts: { channel?: string; source?: string; menuItemId?: string; qty?: number; price?: number; method: string }) {
  const o = await createOrder(sys, { outletId: M, channel: (opts.channel ?? "DINE_IN") as never, source: (opts.source ?? "POS") as never });
  if (opts.menuItemId) await addOrderItem(sys, o.id, { menuItemId: opts.menuItemId, qty: opts.qty ?? 1 });
  else await addOrderItem(sys, o.id, { name: "Open item", qty: 1, unitPrice: opts.price!, taxPct: 0 });
  await submitOrder(sys, o.id);
  const total = num((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
  const p = await createPayment(sys, o.id, { method: opts.method as never, amount: total });
  await verifyPayment(sys, p.id);
  return { orderId: o.id, paymentId: p.id, total };
}
const desk = (ctx: AccessContext = mgr) => getMoneyDesk(prisma, ctx, { outletId: M, businessDate: D0() });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Money desk ${RUN}`, timezone: TZ } })).id;
  M = (await prisma.outlet.create({ data: { organizationId: orgId, code: `MD${RUN}`, name: "Desk", timezone: TZ } })).id;
  N = (await prisma.outlet.create({ data: { organizationId: orgId, code: `MN${RUN}`, name: "Other", timezone: TZ } })).id;
  sys = systemContext(orgId, [M, N]);
  mgr = member("MANAGER", M); cashier = member("CASHIER", M); kitchen = member("KITCHEN", M); mgrN = member("MANAGER", N);
  foreign = { ...member("OWNER", M), organizationId: (await prisma.organization.create({ data: { name: `Money other ${RUN}` } })).id, outletIds: [], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true };
  dish = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Thali ${RUN}`, price: 100, taxPct: 5, station: "KITCHEN" } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  mat = (await prisma.material.create({ data: { organizationId: orgId, sku: `MD-${RUN}`, name: `Dal ${RUN}`, baseUnitId: kg } })).id;
  await prisma.aggregator.create({ data: { organizationId: orgId, name: "ZOMATO", commissionPct: 25 } });

  // Dine-in 2 x Thali (210 incl. 5% tax) cash, table QR 300 UPI, takeaway 150 card, Zomato 500.
  const cash = await paid({ menuItemId: dish, qty: 2, method: "CASH" });
  await paid({ channel: "QR", source: "QR", price: 300, method: "UPI" });
  await paid({ channel: "TAKEAWAY", price: 150, method: "CARD" });
  await paid({ channel: "AGGREGATOR", source: "ZOMATO", price: 500, method: "OTHER" });
  await refundPayment(sys, cash.paymentId, { amount: 10, reason: "cold" });
  // The menu price moved after the sale: the cross-check uses today's menu price.
  await prisma.menuItem.update({ where: { id: dish }, data: { price: 120 } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("figures from the transaction rows", () => {
  it("channels, collections, refunds, commission and the menu-price cross-check", async () => {
    expect(channelOf({ source: "SWIGGY", channel: "DELIVERY" })).toBe("SWIGGY");
    expect(channelOf({ source: "QR", channel: "QR" })).toBe("DINE_IN");
    const d = await desk();
    expect(d.status).toBe("OPEN");
    expect(d.channels.map((c) => [c.key, c.orders, c.billed, c.declared])).toEqual([["DINE_IN", 2, 510, null], ["TAKEAWAY", 1, 150, null], ["ZOMATO", 1, 500, null]]);
    const z = d.channels.find((c) => c.key === "ZOMATO")!;
    expect(z).toMatchObject({ aggregator: true, commissionPct: 25, commission: 125, commissionBasis: "rate", expectedPayout: 375 });
    expect(d.collections).toEqual([
      { method: "CARD", expected: 150, declared: null, difference: null },
      { method: "CASH", expected: 200, declared: null, difference: null },
      { method: "OTHER", expected: 500, declared: null, difference: null },
      { method: "UPI", expected: 300, declared: null, difference: null },
    ]);
    expect(d.pos).toMatchObject({ orders: 4, billed: 1160, refunds: 10, refundCount: 1, tax: 10, atMenuPrice: 1190, billedItems: 1150, menuPriceGap: -40, unpricedLines: 3 });
    expect(d.bank).toMatchObject({ expected: 650, deposited: 0, gap: -650 });
    expect(d.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/counted per payment method/), expect.stringMatching(/not been declared/)]));
    expect(d.readyToClose).toBe(false);
  });
});

describe("declared revenue (SALES reconciliation)", () => {
  it("keeps a one-paisa gap exact, counts an omitted channel as zero and validates input", async () => {
    let r = await declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 509.99 }, { channel: "ZOMATO", amount: 500 }] });
    const line = (k: string) => r.lines.find((l) => l.method === k)!;
    expect(line("DINE_IN").difference.toString()).toBe("-0.01");
    expect(num(line("TAKEAWAY").actual)).toBe(0);
    r = await declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 509.99 }, { channel: "TAKEAWAY", amount: 150 }, { channel: "ZOMATO", amount: 500, note: "app summary" }] });
    expect(r.lines).toHaveLength(3);
    const d = await desk();
    expect(d.channels.find((c) => c.key === "DINE_IN")).toMatchObject({ declared: 509.99, difference: -0.01 });
    expect(d.declaredTotal).toBe(1159.99);
    expect(d.channels.find((c) => c.key === "ZOMATO")).toMatchObject({ note: "app summary", commission: 125 });

    await expect(declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 1 }, { channel: "DINE_IN", amount: 2 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "BARTER", amount: 1 }] })).rejects.toThrow();
    await expect(declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 1.005 }] })).rejects.toThrow();
    const tomorrow = businessDayRange(new Date(Date.now() + 2 * 86_400_000), TZ).date;
    await expect(declareSales(mgr, { outletId: M, businessDate: tomorrow, declared: [{ channel: "DINE_IN", amount: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(declareSales(cashier, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(declareSales(mgrN, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 1 }] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("bank deposits", () => {
  it("records idempotently, validates, voids with a reason and compares per method", async () => {
    await saveDailyReconciliation(mgr, { outletId: M, businessDate: D0(), actuals: [{ method: "CASH", actual: 190 }, { method: "UPI", actual: 300 }, { method: "CARD", actual: 150 }, { method: "OTHER", actual: 500 }] });
    const k = key();
    const base = { outletId: M, businessDate: D0(), depositedAt: new Date() };
    const a = await recordBankDeposit(mgr, { ...base, method: "CASH", amount: 190, reference: "SLIP-1" }, k);
    const again = await recordBankDeposit(mgr, { ...base, method: "CASH", amount: 190, reference: "SLIP-1" }, k);
    expect(again.id).toBe(a.id);
    await expect(recordBankDeposit(mgr, { ...base, method: "CASH", amount: 191, reference: "SLIP-1" }, k)).rejects.toBeInstanceOf(ConflictError);
    await expect(recordBankDeposit(mgr, { ...base, amount: 1, reference: "X1" }, undefined)).rejects.toBeInstanceOf(ValidationError);
    await expect(recordBankDeposit(mgr, { ...base, amount: 0.105, reference: "X1" }, key())).rejects.toThrow();
    await expect(recordBankDeposit(mgr, { ...base, depositedAt: new Date(Date.now() + 3_600_000), amount: 1, reference: "X1" }, key())).rejects.toBeInstanceOf(ValidationError);
    await expect(recordBankDeposit(mgr, { ...base, depositedAt: new Date(Date.now() - 3 * 86_400_000), amount: 1, reference: "X1" }, key())).rejects.toBeInstanceOf(ValidationError);
    await expect(recordBankDeposit(cashier, { ...base, amount: 1, reference: "X1" }, key())).rejects.toBeInstanceOf(ForbiddenError);
    const upi = await recordBankDeposit(mgr, { ...base, method: "UPI", amount: 300, reference: "UTR-1" }, key());
    await recordBankDeposit(mgr, { ...base, method: "CARD", amount: 0.1, reference: "CARD-A" }, key());
    await recordBankDeposit(mgr, { ...base, method: "CARD", amount: 0.2, reference: "CARD-B" }, key());
    let d = await desk();
    expect(d.bank.rows.find((r) => r.method === "CARD")).toMatchObject({ expected: 150, basis: "counted", deposited: 0.3, gap: -149.7 });
    expect(d.bank.rows.find((r) => r.method === "CASH")).toMatchObject({ expected: 190, deposited: 190, gap: 0 });
    await recordBankDeposit(mgr, { ...base, method: "CARD", amount: 129.7, reference: "CARD-C" }, key()); // 20 short
    await expect(voidBankDeposit(mgr, upi.id, "no")).rejects.toThrow();
    await voidBankDeposit(mgr, upi.id, "duplicate of UTR-1 entry");
    await expect(voidBankDeposit(mgr, upi.id, "again please")).rejects.toBeInstanceOf(ValidationError);
    await expect(voidBankDeposit(foreign, upi.id, "not mine at all")).rejects.toBeInstanceOf(NotFoundError);
    await recordBankDeposit(mgr, { ...base, method: "UPI", amount: 300, reference: "UTR-2" }, key());
    d = await desk();
    expect(d.bank).toMatchObject({ expected: 640, deposited: 620, gap: -20 });
    expect(d.bank.deposits.find((x) => x.id === upi.id)).toMatchObject({ status: "VOIDED", voidReason: "duplicate of UTR-1 entry" });
    expect(await prisma.auditLog.count({ where: { entityType: "BankDeposit", outletId: M } })).toBeGreaterThanOrEqual(7);
  });
});

describe("petty cash for the day", () => {
  it("opening, in, out, closing and spend by category", async () => {
    await recordPettyCash(mgr, { outletId: M, type: "OPENING", amount: 1000 });
    await recordPettyCash(mgr, { outletId: M, type: "EXPENSE", amount: 120, category: "GAS", reason: "cylinder" });
    await recordPettyCash(mgr, { outletId: M, type: "EXPENSE", amount: 30.5, category: "ICE", reason: "ice" });
    const d = await desk();
    const spent = [{ category: "GAS", amount: 120 }, { category: "ICE", amount: 30.5 }];
    expect(d.pettyCash).toEqual({ opening: 0, inflow: 1000, outflow: 150.5, closing: 849.5, byCategory: spent, monthToDate: { outflow: 150.5, byCategory: spent } });
  });
});

describe("closing the day", () => {
  it("refuses while anything blocks it, then completes both reconciliations, raises the discrepancies and locks the day", async () => {
    const drawer = await openCashDrawer(mgr, { outletId: M, openingFloat: 0 });
    const pending = await createOrder(sys, { outletId: M, channel: "DINE_IN" });
    await addOrderItem(sys, pending.id, { name: "Tea", qty: 1, unitPrice: 20, taxPct: 0 });
    let d = await desk();
    expect(d.blockers).toEqual([expect.stringMatching(/1 order/), expect.stringMatching(/1 cash drawer/)]);
    await expect(closeDay(mgr, { outletId: M, businessDate: D0() })).rejects.toThrow(/cannot be closed yet/);
    await cancelOrder(sys, pending.id, "guest left");
    await closeCashDrawer(mgr, drawer.id, 0);
    await expect(closeDay(cashier, { outletId: M, businessDate: D0() })).rejects.toBeInstanceOf(ForbiddenError);

    const res = await closeDay(mgr, { outletId: M, businessDate: D0(), notes: "all good" });
    expect(res.close).toMatchObject({ revision: 1, status: "CLOSED", notes: "all good" });
    d = await desk();
    expect(d.status).toBe("CLOSED");
    expect(d.reconciliations).toMatchObject({ payments: { status: "COMPLETED" }, sales: { status: "COMPLETED" } });
    // Cash counted 10 short and the bank 20 short raise discrepancies; the one-paisa sales gap is within tolerance.
    const msgs = d.discrepancies.map((x) => x.message);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringMatching(/PAYMENTS .*CASH/), expect.stringMatching(/Bank .*gap ₹-20/)]));
    expect(msgs.some((m) => /SALES .*DINE_IN/.test(m))).toBe(false);
    expect(d.discrepancies.every((x) => x.status === "OPEN")).toBe(true);
    await expect(closeDay(mgr, { outletId: M, businessDate: D0() })).rejects.toBeInstanceOf(ConflictError);
  });

  it("a closed day refuses every write dated into it, but service and late deposits go on and are shown", async () => {
    const day = { outletId: M, businessDate: D0() };
    await expect(declareSales(mgr, { ...day, declared: [{ channel: "DINE_IN", amount: 1 }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(saveDailyReconciliation(mgr, { ...day, actuals: [{ method: "CASH", actual: 1 }] })).rejects.toBeInstanceOf(ConflictError);
    await expect(recordPettyCash(mgr, { outletId: M, type: "ADD", amount: 5 })).rejects.toBeInstanceOf(ConflictError);
    await expect(createExpense(mgr, { outletId: M, category: "GAS", amount: 5 })).rejects.toBeInstanceOf(ConflictError);
    await expect(recordManualSales(mgr, { ...day, lines: [{ menuItemId: dish, qty: 1 }] }, key())).rejects.toBeInstanceOf(ConflictError);
    await expect(saveWorksheetEntry(mgr, { ...day, menuItemId: dish, preparedQty: 3 })).rejects.toBeInstanceOf(ConflictError);
    const w = await createWastage(mgr, { outletId: M, reason: "SPOILAGE", lines: [{ materialId: mat, qty: 1 }] });
    await expect(postWastage(mgr, w.id)).rejects.toBeInstanceOf(ConflictError);

    // A deposit made late is normal; an order rung after the close is never blocked, and shows.
    await recordBankDeposit(mgr, { ...day, method: "CARD", amount: 20, reference: "LATE-1", depositedAt: new Date() }, key());
    await paid({ price: 40, method: "CASH" });
    const d = await desk();
    expect(d.bank.gap).toBe(0);
    expect(d.changedSinceClose).toEqual(expect.arrayContaining([
      { figure: "Orders", atClose: 4, now: 5 }, { figure: "Billed", atClose: 1160, now: 1200 }, { figure: "Deposited", atClose: 620, now: 640 },
    ]));
  });

  it("reopening needs a reason, keeps the frozen revision and makes the next close revision 2", async () => {
    await expect(reopenDay(mgr, { outletId: M, businessDate: D0(), reason: "oops" })).rejects.toThrow();
    await expect(reopenDay(cashier, { outletId: M, businessDate: D0(), reason: "late cash sale to record" })).rejects.toBeInstanceOf(ForbiddenError);
    await reopenDay(mgr, { outletId: M, businessDate: D0(), reason: "late cash sale to record" });
    await expect(reopenDay(mgr, { outletId: M, businessDate: D0(), reason: "late cash sale to record" })).rejects.toBeInstanceOf(ConflictError);
    let d = await desk();
    expect(d.status).toBe("REOPENED");
    expect(d.reconciliations).toMatchObject({ payments: { status: "DRAFT" }, sales: { status: "DRAFT" } });
    await recordPettyCash(mgr, { outletId: M, type: "ADD", amount: 5 }); // writable again
    await declareSales(mgr, { outletId: M, businessDate: D0(), declared: [{ channel: "DINE_IN", amount: 549.99 }, { channel: "TAKEAWAY", amount: 150 }, { channel: "ZOMATO", amount: 500 }] });
    await saveDailyReconciliation(mgr, { outletId: M, businessDate: D0(), actuals: [{ method: "CASH", actual: 230 }, { method: "UPI", actual: 300 }, { method: "CARD", actual: 150 }, { method: "OTHER", actual: 500 }] });
    const second = await closeDay(mgr, { outletId: M, businessDate: D0() });
    expect(second.close.revision).toBe(2);
    d = await desk();
    expect(d.status).toBe("CLOSED");
    expect(d.closes.map((c) => [c.revision, c.status])).toEqual([[2, "CLOSED"], [1, "REOPENED"]]);
    expect(d.closes[1].reopenReason).toBe("late cash sale to record");
    expect(d.changedSinceClose).toEqual([]);
    const history = await listDayCloses(prisma, mgr, { outletId: M });
    expect(history.map((h) => h.revision)).toEqual([2, 1]);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "DayClose", outletId: M }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.action)).toEqual(["APPROVE", "UPDATE", "APPROVE"]);
  });
});

describe("access", () => {
  it("finance.view reads, finance.reconcile writes; the kitchen, another outlet and another organization cannot", async () => {
    expect((await desk(cashier)).businessDate).toBe(D0());
    await expect(desk(kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(desk(mgrN)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMoneyDesk(prisma, foreign, { outletId: M, businessDate: D0() })).rejects.toThrow();
    await expect(closeDay(foreign, { outletId: M, businessDate: D0() })).rejects.toThrow();
    await expect(getMoneyDesk(prisma, mgr, { outletId: M, businessDate: "08-10-2026" })).rejects.toThrow();
    await expect(listDayCloses(prisma, kitchen, { outletId: M })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
