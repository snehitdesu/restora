/**
 * Group 5 aggregator control room against the real services and database:
 * payout statements (import, reconcile, review), what the platform still owes,
 * charges, net margin per platform and per dish, tenants and outlets.
 *
 *  AF1 platforms and commission %: owner only, audited
 *  AF2 statement import: idempotent, immutable, all-or-nothing, validated
 *  AF3 reconciliation verdicts and exact figures
 *  AF4 review raises ONE anomaly per statement
 *  AF5 orders no statement has paid
 *  AF6 charges: idempotent, voided never deleted
 *  AF7 net margin per platform and dish (no guessed costs)
 *  AF8 authorization and isolation
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import {
  aggregatorMargin, createAggregatorCharge, importAggregatorStatement, listAggregatorCharges, listAggregatorStatements, listAggregators, outstandingAggregatorOrders,
  reconcileAggregatorStatement, reviewAggregatorStatement, saveAggregator, validateStatementLines, voidAggregatorCharge,
} from "@/server/services/aggregatorFinance";

const RUN = Date.now().toString(36);
const FROZEN = Date.now();
let orgId: string, A: string, B: string, C: string;
let owner: AccessContext, manager: AccessContext, managerB: AccessContext, kitchen: AccessContext, foreign: AccessContext;
let zomato: string, swiggy: string;
let n = 0;
const member = (id: string, role: string, outletId: string): AccessContext => ({ userId: id, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const day = (offset = 0) => new Date(FROZEN + offset * 86400000);
const r2 = (v: number) => Math.round(v * 100) / 100;

type Item = { name: string; qty: number; price: number; cost?: number | null };
/** An order as the aggregator webhook stores it: Order + items + AggregatorOrder at the platform's commission. */
async function platformOrder(aggregatorId: string, ext: string, o: { gross: number; pct?: number; fee?: number; discount?: number; status?: string; outletId?: string; placedAt?: Date; items?: Item[] }) {
  const outletId = o.outletId ?? A, discount = o.discount ?? 0, fee = o.fee ?? 0, pct = o.pct ?? 22;
  const commission = r2(((o.gross - discount) * pct) / 100);
  const status = o.status ?? "PAID";
  const order = await prisma.order.create({
    data: {
      organizationId: orgId, outletId, channel: "AGGREGATOR", source: "ZOMATO", externalRef: `${ext}-${RUN}`, status, subtotal: o.gross, total: o.gross - discount,
      items: { create: (o.items ?? []).map((i) => ({ organizationId: orgId, outletId, name: i.name, qty: i.qty, unitPrice: i.price, lineTotal: i.qty * i.price, lineCost: i.cost ?? null })) },
    },
  });
  await prisma.aggregatorOrder.create({
    data: { organizationId: orgId, outletId, aggregatorId, externalId: `${ext}-${RUN}`, orderId: order.id, grossAmount: o.gross, discount, commission, platformFee: fee, netPayout: status === "PAID" ? r2(o.gross - discount - commission - fee) : 0, placedAt: o.placedAt ?? new Date() },
  });
}
const id = (ext: string) => `${ext}-${RUN}`;
const line = (ext: string, gross: number, commission: number, net: number, extra: Partial<{ penalty: number; adSpend: number; otherDeductions: number }> = {}) =>
  ({ externalId: id(ext), settledAt: day(0).toISOString(), grossAmount: gross, commission, penalty: extra.penalty ?? 0, adSpend: extra.adSpend ?? 0, otherDeductions: extra.otherDeductions ?? 0, netPayout: net });
const importStatement = (aggregatorId: string, statementRef: string, lines: ReturnType<typeof line>[], outletId = A, ctx = owner) => importAggregatorStatement(ctx, { outletId, aggregatorId, statementRef, lines });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `AF Org ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AFA${RUN}`, name: "AF A" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AFB${RUN}`, name: "AF B" } })).id;
  C = (await prisma.outlet.create({ data: { organizationId: orgId, code: `AFC${RUN}`, name: "AF C" } })).id;
  owner = { ...systemContext(orgId, [A, B, C]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
  manager = member(`mgr-${RUN}`, "MANAGER", A);
  managerB = member(`mgrb-${RUN}`, "MANAGER", B);
  kitchen = member(`kit-${RUN}`, "KITCHEN", A);
  const fOrg = (await prisma.organization.create({ data: { name: `AF Foreign ${RUN}` } })).id;
  foreign = { ...systemContext(fOrg, [(await prisma.outlet.create({ data: { organizationId: fOrg, code: `AFF${RUN}`, name: "F" } })).id]), userId: `fo-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true };
});

afterAll(async () => { await prisma.$disconnect(); });

describe("AF1. platforms", () => {
  it("AF1 only integration.manage changes a commission %; it is audited with before / after; names and % are validated; another tenant sees none", async () => {
    await expect(saveAggregator(manager, { name: "ZOMATO", commissionPct: 22 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveAggregator(owner, { name: "zomato; drop", commissionPct: 22 })).rejects.toThrow(/Letters, digits/);
    await expect(saveAggregator(owner, { name: "ZOMATO", commissionPct: 61 })).rejects.toThrow();
    await expect(saveAggregator(owner, { name: "ZOMATO", commissionPct: -1 })).rejects.toThrow();
    const z = await saveAggregator(owner, { name: " zomato ", commissionPct: 22 });
    zomato = z.id;
    expect(z).toMatchObject({ name: "ZOMATO", commissionPct: 22, active: true });
    swiggy = (await saveAggregator(owner, { name: "SWIGGY", commissionPct: 20 })).id;
    expect(await saveAggregator(owner, { name: "ZOMATO", commissionPct: 24.5 })).toMatchObject({ id: zomato, commissionPct: 24.5 });
    await saveAggregator(owner, { name: "ZOMATO", commissionPct: 22 });
    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "Aggregator", entityId: zomato }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["CREATE", "UPDATE", "UPDATE"]);
    expect(String(audit[1].before)).toContain("22");
    expect(String(audit[1].after)).toContain("24.5");
    expect((await listAggregators(prisma, manager)).map((a) => a.name)).toEqual(["SWIGGY", "ZOMATO"]);
    await expect(listAggregators(prisma, kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listAggregators(prisma, foreign)).toEqual([]);
  });
});

describe("AF2. statement import", () => {
  it("AF2 a statement imports once; the same lines again import nothing; a changed line is refused; one bad line imports nothing", async () => {
    const lines = [line("I1", 500, 110, 390), line("I2", 300, 66, 234)];
    expect(await importStatement(zomato, "IMP-1", lines)).toMatchObject({ imported: 2, alreadyImported: 0, gross: 800, netPayout: 624 });
    expect(await importStatement(zomato, "IMP-1", lines)).toMatchObject({ imported: 0, alreadyImported: 2 }); // idempotent
    expect(await importStatement(zomato, "IMP-1", [...lines, line("I3", 100, 22, 78)])).toMatchObject({ imported: 1, alreadyImported: 2 }); // extended
    expect(await prisma.aggregatorStatementLine.count({ where: { organizationId: orgId, statementRef: "IMP-1" } })).toBe(3);
    // a changed line is refused, and nothing in the request is applied
    await expect(importStatement(zomato, "IMP-1", [line("I1", 500, 120, 380), line("I9", 100, 22, 78)])).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.aggregatorStatementLine.count({ where: { organizationId: orgId, statementRef: "IMP-1" } })).toBe(3);
    // the audit row says how many lines came in, not what they said
    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "AggregatorStatement", action: "IMPORT" } });
    expect(audit).toHaveLength(2);
    // every line must add up; a duplicate order id inside one upload is refused; all-or-nothing
    await expect(importStatement(zomato, "IMP-2", [line("J1", 500, 110, 390), line("J2", 300, 66, 200)])).rejects.toThrow(/Line 2 \(J2-.*\): gross 300.00 less deductions is 234.00, not the net paid 200.00/);
    await expect(importStatement(zomato, "IMP-2", [line("J1", 500, 110, 390), line("J1", 500, 110, 390)])).rejects.toThrow(/appears twice/);
    expect(await prisma.aggregatorStatementLine.count({ where: { organizationId: orgId, statementRef: "IMP-2" } })).toBe(0);
    expect(validateStatementLines([{ ...line("K1", 100, 22, 78.005), } as never])).toEqual([]); // within a paisa
    // shapes
    await expect(importStatement(zomato, "IMP-3", [])).rejects.toThrow();
    await expect(importStatement(zomato, "bad ref!", [line("L1", 1, 0, 1)])).rejects.toThrow(/Letters, digits/);
    await expect(importStatement(zomato, "IMP-3", Array.from({ length: 2001 }, (_, i) => line(`M${i}`, 1, 0, 1)))).rejects.toThrow(/At most 2000 lines/);
    await expect(importStatement(zomato, "IMP-3", [{ ...line("N1", 1, 0, 1), grossAmount: -5 }])).rejects.toThrow();
    // the statement belongs to one outlet
    await expect(importStatement(zomato, "IMP-1", lines, B)).rejects.toBeInstanceOf(ConflictError);
    // two imports of one statement at the same moment end with the lines once
    const twice = await Promise.all([importStatement(zomato, "IMP-4", [line("O1", 100, 22, 78)]), importStatement(zomato, "IMP-4", [line("O1", 100, 22, 78)])]);
    expect(twice.reduce((a, r) => a + r.imported, 0)).toBe(1);
    expect(await prisma.aggregatorStatementLine.count({ where: { organizationId: orgId, statementRef: "IMP-4" } })).toBe(1);
    const list = await listAggregatorStatements(prisma, manager, { outletId: A });
    expect(list.find((s) => s.statementRef === "IMP-1")).toMatchObject({ lines: 3, gross: 900, commission: 198, netPayout: 702, aggregator: "ZOMATO" });
  });
});

describe("AF3. reconciliation", () => {
  it("AF3 each line against its order: matched, short-paid with the reason, unknown, duplicate payment, cancelled here, wrong outlet; the figures add up", async () => {
    await platformOrder(zomato, "Z1", { gross: 500 }); // net 390
    await platformOrder(zomato, "Z2", { gross: 400 }); // net 312, commission 88
    await platformOrder(zomato, "Z3", { gross: 300 }); // net 234
    await platformOrder(zomato, "Z4", { gross: 200 }); // net 156
    await platformOrder(zomato, "Z6", { gross: 250 }); // net 195
    await platformOrder(zomato, "Z7", { gross: 100, status: "REFUNDED" }); // cancelled here: expected 0
    await platformOrder(zomato, "Z8", { gross: 100, outletId: B }); // net 78, belongs to outlet B
    await importStatement(zomato, "ST-OLD", [line("Z6", 250, 55, 195)]);
    await importStatement(zomato, "ST-1", [
      line("Z1", 500, 110, 390),
      line("Z2", 400, 100, 300), // commission charged 12 above the stored %
      line("Z3", 300, 66, 214, { penalty: 20 }),
      line("Z4", 200, 44, 141, { adSpend: 15 }),
      line("GHOST", 100, 22, 78), // an order RESTORA never received
      line("Z6", 250, 55, 195), // already paid in ST-OLD
      line("Z7", 100, 22, 78), // cancelled and refunded here, paid anyway
      line("Z8", 100, 22, 78), // another outlet's order
    ]);
    const rec = await reconcileAggregatorStatement(prisma, manager, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" });
    const by = new Map(rec.rows.map((r) => [r.externalId.replace(`-${RUN}`, ""), r]));
    expect(by.get("Z1")).toMatchObject({ verdict: "MATCHED", reasons: [], expectedNet: 390, paidNet: 390, difference: 0 });
    expect(by.get("Z2")).toMatchObject({ verdict: "SHORT_PAID", reasons: ["COMMISSION_DIFFERS"], expectedNet: 312, paidNet: 300, difference: -12, commissionDifference: 12 });
    expect(by.get("Z3")).toMatchObject({ verdict: "SHORT_PAID", reasons: ["PENALTY"], difference: -20, penalty: 20 });
    expect(by.get("Z4")).toMatchObject({ verdict: "SHORT_PAID", reasons: ["AD_SPEND"], difference: -15, adSpend: 15 });
    expect(by.get("GHOST")).toMatchObject({ verdict: "UNKNOWN_ORDER", expectedNet: null, paidNet: 78 });
    expect(by.get("Z6")).toMatchObject({ verdict: "DUPLICATE_PAYMENT", paidInStatements: ["ST-OLD"] });
    expect(by.get("Z7")).toMatchObject({ verdict: "OVER_PAID", reasons: ["ORDER_CANCELLED_HERE"], expectedNet: 0, paidNet: 78, difference: 78 });
    expect(by.get("Z8")).toMatchObject({ verdict: "WRONG_OUTLET" });
    expect(rec.summary).toMatchObject({
      lines: 8, counts: { MATCHED: 1, SHORT_PAID: 3, OVER_PAID: 1, UNKNOWN_ORDER: 1, DUPLICATE_PAYMENT: 1, WRONG_OUTLET: 1 },
      shortfall: 47, shortfallFromCommission: 12, overpaid: 78, penalties: 20, adSpend: 15, paidForUnknownOrders: 78,
    });
    // deterministic: the same statement gives the same answer; a statement of another outlet / tenant does not exist
    expect(await reconcileAggregatorStatement(prisma, manager, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" })).toEqual(rec);
    await expect(reconcileAggregatorStatement(prisma, manager, { outletId: A, aggregatorId: zomato, statementRef: "NOPE" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(reconcileAggregatorStatement(prisma, managerB, { outletId: B, aggregatorId: zomato, statementRef: "ST-1" })).rejects.toBeInstanceOf(NotFoundError); // it belongs to A
    await expect(reconcileAggregatorStatement(prisma, foreign, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" })).rejects.toThrow();
  });

  it("AF4 reviewing raises ONE anomaly for a statement with a shortfall; reviewing again raises none; a clean statement raises none", async () => {
    const entityId = `${zomato}:ST-1`;
    const first = await reviewAggregatorStatement(owner, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" });
    expect(first.anomalyRaised).toBe(true);
    const again = await reviewAggregatorStatement(owner, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" });
    expect(again.anomalyRaised).toBe(false);
    const anomalies = await prisma.anomaly.findMany({ where: { organizationId: orgId, entityType: "AggregatorStatement", entityId } });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ type: "RECONCILIATION_MISMATCH", severity: "HIGH", outletId: A });
    expect(anomalies[0].message).toMatch(/7 of 8 lines differ/);
    await platformOrder(zomato, "C1", { gross: 100 });
    await importStatement(zomato, "ST-CLEAN", [line("C1", 100, 22, 78)]);
    expect((await reviewAggregatorStatement(owner, { outletId: A, aggregatorId: zomato, statementRef: "ST-CLEAN" })).anomalyRaised).toBe(false);
    expect(await prisma.anomaly.count({ where: { organizationId: orgId, entityId: `${zomato}:ST-CLEAN` } })).toBe(0);
    await expect(reviewAggregatorStatement(kitchen, { outletId: A, aggregatorId: zomato, statementRef: "ST-1" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("AF5. what the platform still owes", () => {
  it("AF5 orders older than the grace period that no statement has paid; paid, cancelled and recent ones are left out", async () => {
    await platformOrder(swiggy, "OLD1", { gross: 100, pct: 20, placedAt: day(-10) }); // net 80, unpaid
    await platformOrder(swiggy, "OLD2", { gross: 200, pct: 20, placedAt: day(-10) }); // paid below
    await platformOrder(swiggy, "OLD3", { gross: 300, pct: 20, placedAt: day(-10), status: "CANCELLED" }); // net 0
    await platformOrder(swiggy, "NEW1", { gross: 400, pct: 20, placedAt: day(-2) }); // net 320, recent
    await importStatement(swiggy, "SW-1", [line("OLD2", 200, 40, 160)]);
    const seven = await outstandingAggregatorOrders(prisma, manager, { outletId: A, aggregatorId: swiggy });
    expect(seven).toMatchObject({ aggregator: "SWIGGY", graceDays: 7, count: 1, owed: 80 });
    expect(seven.orders[0].externalId).toBe(id("OLD1"));
    expect(await outstandingAggregatorOrders(prisma, manager, { outletId: A, aggregatorId: swiggy, graceDays: 1 })).toMatchObject({ count: 2, owed: 400 });
    await expect(outstandingAggregatorOrders(prisma, manager, { outletId: A, aggregatorId: swiggy, graceDays: 61 })).rejects.toThrow();
    await expect(outstandingAggregatorOrders(prisma, kitchen, { outletId: A, aggregatorId: swiggy })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(outstandingAggregatorOrders(prisma, foreign, { outletId: A, aggregatorId: swiggy })).rejects.toThrow();
  });
});

describe("AF6. charges", () => {
  it("AF6 recorded once per key, voided with a reason and never deleted; validated and authorized", async () => {
    const body = { outletId: A, aggregatorId: swiggy, kind: "AD_SPEND" as const, amount: 1500, chargedOn: day(-1), reference: "CAMPAIGN-9", notes: "Weekend boost" };
    const k = `af-${RUN}-1`;
    const first = await createAggregatorCharge(manager, body, k);
    expect(first.replayed).toBe(false);
    const replay = await createAggregatorCharge(manager, body, k);
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    await expect(createAggregatorCharge(manager, { ...body, amount: 1600 }, k)).rejects.toThrow(/already used for a different request/);
    await expect(createAggregatorCharge(manager, body, undefined)).rejects.toThrow(/Idempotency-Key/);
    await expect(createAggregatorCharge(manager, { ...body, amount: 0 }, `af-${RUN}-2`)).rejects.toThrow();
    await expect(createAggregatorCharge(manager, { ...body, kind: "BRIBE" as never }, `af-${RUN}-3`)).rejects.toThrow();
    await expect(createAggregatorCharge(manager, { ...body, chargedOn: day(5) }, `af-${RUN}-4`)).rejects.toThrow(/future/);
    await expect(createAggregatorCharge(kitchen, body, `af-${RUN}-5`)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createAggregatorCharge(manager, { ...body, aggregatorId: "nope" }, `af-${RUN}-6`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createAggregatorCharge(foreign, body, `af-${RUN}-7`)).rejects.toThrow();
    expect(await prisma.aggregatorCharge.count({ where: { organizationId: orgId, aggregatorId: swiggy } })).toBe(1);

    await expect(voidAggregatorCharge(manager, first.id, "x")).rejects.toThrow(/reason/i);
    await voidAggregatorCharge(manager, first.id, "Entered on the wrong platform");
    await expect(voidAggregatorCharge(manager, first.id, "again please")).rejects.toThrow(/already void/);
    expect((await listAggregatorCharges(prisma, manager, { outletId: A })).map((c) => c.id)).not.toContain(first.id);
    const all = await listAggregatorCharges(prisma, manager, { outletId: A, includeVoided: true });
    expect(all.find((c) => c.id === first.id)).toMatchObject({ voided: true, voidReason: "Entered on the wrong platform", amount: 1500, kind: "AD_SPEND" });
    expect(await prisma.aggregatorCharge.count({ where: { id: first.id } })).toBe(1); // kept
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "AggregatorCharge", action: "VOID" } })).toBe(1);
    await expect(voidAggregatorCharge(foreign, first.id, "not yours to void")).rejects.toBeInstanceOf(NotFoundError);
    await expect(listAggregatorCharges(prisma, managerB, { outletId: A })).rejects.toThrow(); // another outlet
  });
});

describe("AF7. net margin", () => {
  it("AF7 per platform and per dish: commission, fees and charges are real costs; costs come from the sale; a missing cost shows no margin", async () => {
    const from = day(-30), to = day(1);
    // SWIGGY at outlet C (20%): two fully costed orders and one cancelled
    await platformOrder(swiggy, "S1", { gross: 500, pct: 20, fee: 10, outletId: C, items: [{ name: "Biryani", qty: 2, price: 200, cost: 186 }, { name: "Lassi", qty: 1, price: 100, cost: 30 }] });
    await platformOrder(swiggy, "S2", { gross: 300, pct: 20, outletId: C, items: [{ name: "Biryani", qty: 1, price: 200, cost: 93 }, { name: "Lassi", qty: 1, price: 100, cost: 30 }] });
    await platformOrder(swiggy, "S3", { gross: 200, pct: 20, outletId: C, status: "REFUNDED", items: [{ name: "Biryani", qty: 1, price: 200, cost: 93 }] });
    // ZOMATO at outlet C (22%): one order whose dish has no recorded cost
    await platformOrder(zomato, "ZC1", { gross: 400, outletId: C, items: [{ name: "Pizza", qty: 1, price: 400, cost: null }] });
    const k1 = await createAggregatorCharge(owner, { outletId: C, aggregatorId: swiggy, kind: "AD_SPEND", amount: 50, chargedOn: day(-2) }, `afm-${RUN}-1`);
    await createAggregatorCharge(owner, { outletId: C, aggregatorId: swiggy, kind: "PENALTY", amount: 25, chargedOn: day(-1) }, `afm-${RUN}-2`);
    const gone = await createAggregatorCharge(owner, { outletId: C, aggregatorId: swiggy, kind: "FEE", amount: 999, chargedOn: day(-1) }, `afm-${RUN}-3`);
    await voidAggregatorCharge(owner, gone.id, "Wrong amount, re-entered elsewhere");
    expect(k1.id).toBeTruthy();

    const m = await aggregatorMargin(prisma, owner, { outletId: C, from, to });
    expect(m.aggregators.map((a) => a.aggregator)).toEqual(["SWIGGY", "ZOMATO"]);
    const sw = m.aggregators[0];
    expect(sw).toMatchObject({
      orders: 2, cancelled: 1, grossSales: 800, discounts: 0, commission: 160, platformFees: 10, effectiveCutPct: 21.25, expectedNet: 630,
      charges: { penalty: 25, adSpend: 50, fee: 0, other: 0, total: 75 }, netAfterCharges: 555, foodCost: 339, costCoveragePct: 100, contribution: 216, contributionPct: 27,
    });
    const zm = m.aggregators[1];
    expect(zm).toMatchObject({ orders: 1, grossSales: 400, commission: 88, expectedNet: 312, foodCost: null, costCoveragePct: 0, contribution: null, contributionPct: null });

    const dish = (platform: string, name: string) => m.dishes.find((d) => d.aggregator === platform && d.name === name)!;
    expect(dish("SWIGGY", "Biryani")).toMatchObject({ qty: 3, revenue: 600, platformCut: 128, foodCost: 279, margin: 193, marginPct: 32.17 });
    expect(dish("SWIGGY", "Lassi")).toMatchObject({ qty: 2, revenue: 200, platformCut: 42, foodCost: 60, margin: 98, marginPct: 49 });
    expect(dish("ZOMATO", "Pizza")).toMatchObject({ qty: 1, revenue: 400, platformCut: 88, foodCost: null, margin: null, marginPct: null });
    // the dishes' margins plus the platform's charges are exactly the platform's contribution
    expect(dish("SWIGGY", "Biryani").margin! + dish("SWIGGY", "Lassi").margin! - sw.charges.total).toBe(sw.contribution);
    // best dish first; a dish with no margin goes last
    expect(m.dishes.map((d) => d.name)).toEqual(["Biryani", "Lassi", "Pizza"]);
    expect(m.basis).toMatch(/never a guess|rather than a guess/);
    // a period without orders is empty, not an error
    expect((await aggregatorMargin(prisma, owner, { outletId: C, from: day(-400), to: day(-380) })).aggregators).toEqual([]);
    await expect(aggregatorMargin(prisma, owner, { outletId: C, from: day(-400), to })).rejects.toThrow(/At most one year/);
    await expect(aggregatorMargin(prisma, owner, { outletId: C, from: to, to: from })).rejects.toThrow(/on or before/);
  });
});

describe("AF8. isolation", () => {
  it("AF8 finance access is per outlet; costs need reports access; another tenant sees and changes nothing", async () => {
    await expect(aggregatorMargin(prisma, manager, { outletId: C, from: day(-30), to: day(1) })).rejects.toBeInstanceOf(ForbiddenError); // not their outlet
    await expect(aggregatorMargin(prisma, kitchen, { outletId: A, from: day(-30), to: day(1) })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAggregatorStatements(prisma, kitchen, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importStatement(zomato, "FX-1", [line("FX", 100, 22, 78)], A, kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importStatement(zomato, "FX-1", [line("FX", 100, 22, 78)], A, managerB)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(importStatement(zomato, "FX-1", [line("FX", 100, 22, 78)], A, foreign)).rejects.toThrow();
    await expect(importStatement("not-an-aggregator", "FX-1", [line("FX", 100, 22, 78)])).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.aggregatorStatementLine.count({ where: { statementRef: "FX-1" } })).toBe(0);
    await expect(aggregatorMargin(prisma, foreign, { outletId: C, from: day(-30), to: day(1) })).rejects.toThrow();
    await expect(listAggregatorStatements(prisma, foreign, { outletId: A })).rejects.toThrow();
    expect(await prisma.aggregatorStatementLine.count({ where: { organizationId: foreign.organizationId } })).toBe(0);
    // an org-wide login naming an outlet that is not in its organization is refused (404), nothing is written
    await expect(importAggregatorStatement(foreign, { outletId: A, aggregatorId: zomato, statementRef: "FX-2", lines: [line("FX", 100, 22, 78)] })).rejects.toThrow();
    await expect(createAggregatorCharge(foreign, { outletId: A, aggregatorId: zomato, kind: "FEE", amount: 5, chargedOn: day(0) }, `fx-${RUN}`)).rejects.toThrow();
    expect(await prisma.aggregatorCharge.count({ where: { organizationId: foreign.organizationId } })).toBe(0);
    void ValidationError;
  });
});
