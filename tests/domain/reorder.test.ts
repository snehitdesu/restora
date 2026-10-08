/**
 * Group 2 reorder engine (docs/master-feature-audit.md PP-01..03), against the
 * real services and the test database:
 *  A  the pure calculation (planLine / compareRows / chooseVendor / parseAsOf)
 *  B  ledger inputs (net usage, window, observed days, departments, scope)
 *  C  duplicate protection (open POs / indents / draft GRNs; stale screen = 409)
 *  D  vendor eligibility (Group 1 approval rules stay authoritative)
 *  E  permissions (existing purchase.view / purchase.create / purchase.approve)
 *  F  idempotency, atomicity and audit of the raise endpoints
 *  I  recommendation -> PO / indent -> approval -> GRN -> stock, end to end
 * (The genuinely concurrent raise test is tests/db/reorder-concurrency.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, ForbiddenError, ValidationError } from "@/server/db/scope";
import { D } from "@/domain/money";
import {
  planLine, compareRows, chooseVendor, parseAsOf, computeReorder, raiseReorderPurchaseOrders, raiseReorderIndent,
  BadRequestError, REORDER, type PlanInput, type ReorderRow,
} from "@/server/services/reorder";
import { transitionPurchaseOrder, transitionIndent, createPurchaseOrder, createGRN, postGRN } from "@/server/services/procurement";
import { setVendorStatus, createMaterial, updateMaterial } from "@/server/services/masterData";

const RUN = Date.now().toString(36);
const DAY = 86_400_000;
let orgId: string, A: string, B: string, kg: string, kase: string, kitchen: string, store: string;
let owner: AccessContext, mgrA: AccessContext, storeA: AccessContext, storeB: AccessContext, acctA: AccessContext;
let n = 0;
const key = () => `ro-${RUN}-${++n}`;

const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const orgWide = (role: string): AccessContext => ({ userId: `${role.toLowerCase()}-${RUN}`, organizationId: orgId, outletIds: [A, B], roles: [role], outletRoles: {}, orgRoles: [role], isOrgWide: true, isSuperAdmin: false });

async function material(name: string, data: Partial<{ reorderLevel: number; minStock: number; parLevel: number | null; purchaseUnitId: string; preferredVendorId: string; active: boolean }> = {}) {
  return (await prisma.material.create({ data: { organizationId: orgId, sku: `${name.toUpperCase().replace(/\W/g, "")}-${RUN}-${++n}`, name: `${name} ${RUN}`, baseUnitId: kg, ...data } })).id;
}
async function vendor(name: string, status = "ACTIVE") {
  return (await prisma.vendor.create({ data: { organizationId: orgId, name: `${name} ${RUN} ${++n}`, status, active: status === "ACTIVE" } })).id;
}
const link = (vendorId: string, materialId: string, lastRate: number, leadTimeDays = 1, preferred = false) =>
  prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId, materialId, lastRate, leadTimeDays, preferred } });
const ledger = (materialId: string, qty: number, txnType: string, daysAgo: number, opts: { outletId?: string; departmentId?: string } = {}) =>
  prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: opts.outletId ?? A, departmentId: opts.departmentId, materialId, txnType, qty, createdAt: new Date(Date.now() - daysAgo * DAY) } });
const cost = (materialId: string, avgCost: number, lastCost = avgCost) => prisma.outletMaterialCost.create({ data: { organizationId: orgId, outletId: A, materialId, avgCost, lastCost } });
async function po(vendorId: string, status: string, lines: Array<{ materialId: string; qty: number; receivedQty?: number; unitId?: string }>, outletId = A) {
  return prisma.purchaseOrder.create({ data: { organizationId: orgId, outletId, number: `PO-T-${++n}`, vendorId, status, lines: { create: lines.map((l) => ({ organizationId: orgId, materialId: l.materialId, qty: l.qty, rate: 1, receivedQty: l.receivedQty ?? 0, unitId: l.unitId })) } } });
}
async function indent(status: string, materialId: string, qty: number) {
  return prisma.purchaseIndent.create({ data: { organizationId: orgId, outletId: A, number: `IND-T-${++n}`, status, lines: { create: [{ organizationId: orgId, materialId, qty }] } } });
}
async function grn(vendorId: string, status: string, materialId: string, qty: number, opts: { damagedQty?: number; poId?: string } = {}) {
  return prisma.goodsReceipt.create({ data: { organizationId: orgId, outletId: A, number: `GRN-T-${++n}`, vendorId, status, poId: opts.poId, lines: { create: [{ organizationId: orgId, materialId, qty, rate: 1, damagedQty: opts.damagedQty ?? 0 }] } } });
}
async function rowsFor(ctx: AccessContext = mgrA, query: Record<string, unknown> = {}) {
  return computeReorder(prisma, ctx, { outletId: A, ...query });
}
const row = (r: Awaited<ReturnType<typeof rowsFor>>, materialId: string): ReorderRow | undefined => r.rows.find((x) => x.materialId === materialId);
const reorderPOs = (materialId: string) => prisma.purchaseOrder.findMany({ where: { organizationId: orgId, source: "REORDER", lines: { some: { materialId } } }, include: { lines: true } });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Reorder ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RA${RUN}`, name: "RO A", timezone: "Asia/Kolkata" } })).id;
  B = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RB${RUN}`, name: "RO B", timezone: "Asia/Kolkata" } })).id;
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  kase = (await prisma.unit.create({ data: { organizationId: orgId, code: `case${RUN}`, name: "case", kind: "COUNT" } })).id;
  kitchen = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Kitchen", kind: "KITCHEN" } })).id;
  store = (await prisma.department.create({ data: { organizationId: orgId, outletId: A, name: "Main store", kind: "STORE" } })).id;
  owner = orgWide("OWNER");
  mgrA = member("MANAGER", A);
  storeA = member("STORE", A);
  storeB = member("STORE", B);
  acctA = member("ACCOUNTANT", A);
});

afterAll(async () => { await prisma.$disconnect(); });

// ============================================================
// A. Pure calculation
// ============================================================

const base = (o: Partial<PlanInput> = {}): PlanInput => ({
  onHand: D(0), incoming: D(0), usage: D(0), observedDays: 14, minStock: D(0), reorderLevel: D(5), parLevel: D(10), leadTimeDays: 1, pack: null, unitCost: null, ...o,
});

describe("A. reorder calculation (planLine)", () => {
  it("A1 orders up to par from the stock position", () => {
    const p = planLine(base({ onHand: D(2) }));
    expect(p).toMatchObject({ eligible: true, configured: true });
    expect(p.position.toString()).toBe("2");
    expect(p.rawQty.toString()).toBe("8");
    expect(p.orderQty.toString()).toBe("8");
    expect(p.reasons).toEqual(expect.arrayContaining(["BELOW_REORDER_POINT", "NO_HISTORY", "NO_COST"]));
  });

  it("A2 without a par level the reorder level is the par", () => {
    const p = planLine(base({ onHand: D(2), parLevel: null }));
    expect(p.target.toString()).toBe("5");
    expect(p.orderQty.toString()).toBe("3");
  });

  it("A3 safety stock above the reorder level is the reorder point; below it is CRITICAL", () => {
    const p = planLine(base({ onHand: D("5.5"), minStock: D(6), parLevel: null }));
    expect(p.reorderPoint.toString()).toBe("6");
    expect(p.eligible).toBe(true);
    expect(p.orderQty.toString()).toBe("0.5");
    expect(p.priority).toBe("CRITICAL");
    expect(p.reasons).toContain("BELOW_SAFETY_STOCK");
  });

  it("A4 enough history: usage over the lead time raises the reorder point", () => {
    // ADU = 42 / 14 = 3; ROP = 2 + 3 x 2 = 8 > reorder level 5.
    const p = planLine(base({ onHand: D(7), usage: D(42), minStock: D(2), leadTimeDays: 2 }));
    expect(p.history).toBe("OK");
    expect(p.avgDailyUse.toString()).toBe("3");
    expect(p.reorderPoint.toString()).toBe("8");
    expect(p.eligible).toBe(true);
    expect(p.orderQty.toString()).toBe("3"); // target max(par 10, 8) - 7
    expect(p.reasons).toContain("USAGE_RAISED_REORDER_POINT");
    expect(p.priority).toBe("HIGH"); // cover 2.33 days: not < 2, <= 4
  });

  it("A5 insufficient history never raises the reorder point", () => {
    const p = planLine(base({ onHand: D(7), usage: D(15), observedDays: 5, minStock: D(2), leadTimeDays: 2 }));
    expect(p.history).toBe("INSUFFICIENT");
    expect(p.avgDailyUse.toString()).toBe("3");
    expect(p.reorderPoint.toString()).toBe("5");
    expect(p.eligible).toBe(false);
    expect(p.reasons).toContain("INSUFFICIENT_HISTORY");
  });

  it("A6 no usage: no days of cover, fixed levels only", () => {
    const p = planLine(base({ onHand: D(1) }));
    expect(p.history).toBe("NONE");
    expect(p.daysOfCover).toBeNull();
    expect(p.reorderPoint.toString()).toBe("5");
  });

  it("A7 negative stock counts as zero and never inflates the order", () => {
    const p = planLine(base({ onHand: D(-4) }));
    expect(p.onHandClamped.toString()).toBe("0");
    expect(p.orderQty.toString()).toBe("10");
    expect(p.priority).toBe("CRITICAL");
    expect(p.reasons).toEqual(expect.arrayContaining(["NEGATIVE_STOCK", "OUT_OF_STOCK"]));
  });

  it("A8 zero stock is CRITICAL", () => {
    const p = planLine(base());
    expect(p.priority).toBe("CRITICAL");
    expect(p.reasons).toContain("OUT_OF_STOCK");
  });

  it("A9 pack rounding: need 13 kg in 12 kg cases -> 2 cases = 24 kg", () => {
    const p = planLine(base({ parLevel: D(13), reorderLevel: D(5), pack: { factor: D(12) } }));
    expect(p.rawQty.toString()).toBe("13");
    expect(p.orderQty.toString()).toBe("2");
    expect(p.orderBaseQty.toString()).toBe("24");
    expect(p.packFactor!.toString()).toBe("12");
  });

  it("A10 decimal quantities round UP to 4 decimal places", () => {
    const p = planLine(base({ parLevel: D("2.34567"), reorderLevel: D(1) }));
    expect(p.orderQty.toString()).toBe("2.3457");
  });

  it("A11 a purchase unit without a conversion orders in the base unit and is flagged", () => {
    const p = planLine(base({ onHand: D(2), pack: "missing" }));
    expect(p.orderQty.toString()).toBe("8");
    expect(p.packFactor).toBeNull();
    expect(p.reasons).toContain("NO_PACK_CONVERSION");
  });

  it("A12 priority boundaries (ADU 1, lead 2): cover < L CRITICAL, <= 2L HIGH, else NORMAL", () => {
    const at = (oh: string) => planLine(base({ onHand: D(oh), usage: D(14), reorderLevel: D(10), parLevel: D(20), leadTimeDays: 2 })).priority;
    expect(at("1.9")).toBe("CRITICAL");
    expect(at("2")).toBe("HIGH");
    expect(at("4")).toBe("HIGH");
    expect(at("4.1")).toBe("NORMAL");
  });

  it("A12b a lead time of 0 counts as the 1-day minimum", () => {
    const zero = planLine(base({ onHand: D("0.5"), usage: D(14), leadTimeDays: 0 }));
    const one = planLine(base({ onHand: D("0.5"), usage: D(14), leadTimeDays: 1 }));
    expect(REORDER.MIN_LEAD_TIME_DAYS).toBe(1);
    expect(zero.priority).toBe("CRITICAL");
    expect(zero.reasons).toContain("STOCKOUT_BEFORE_DELIVERY");
    expect(zero.reorderPoint.toString()).toBe(one.reorderPoint.toString());
  });

  it("A13 sort: priority, then least days of cover (none last), then name", () => {
    const rows = [
      { priority: "NORMAL" as const, daysOfCover: 1, name: "a" },
      { priority: "HIGH" as const, daysOfCover: null, name: "b" },
      { priority: "HIGH" as const, daysOfCover: 3, name: "c" },
      { priority: "CRITICAL" as const, daysOfCover: 9, name: "d" },
      { priority: "HIGH" as const, daysOfCover: 3, name: "bb" },
    ].sort(compareRows);
    expect(rows.map((r) => r.name)).toEqual(["d", "bb", "c", "b", "a"]);
  });

  it("A14 estimated value is order x unit cost; no cost is flagged", () => {
    const p = planLine(base({ onHand: D(2), unitCost: D("12.5") }));
    expect(p.estimatedValue!.toString()).toBe("100");
    expect(p.reasons).not.toContain("NO_COST");
  });

  it("A15 not configured: never recommended, even out of stock", () => {
    const p = planLine(base({ reorderLevel: D(0), minStock: D(0), parLevel: null, onHand: D(-1) }));
    expect(p).toMatchObject({ configured: false, eligible: false });
  });

  it("A16 incoming stock raises the position: covered items are not listed, partly covered ones order the rest", () => {
    expect(planLine(base({ onHand: D(2), incoming: D(3) })).eligible).toBe(false);
    const p = planLine(base({ onHand: D(2), incoming: D(2) }));
    expect(p.orderQty.toString()).toBe("6");
    expect(p.reasons).toContain("PARTLY_ON_ORDER");
  });

  it("chooseVendor: only ACTIVE vendors; preferred > preferred link > lowest rate > shortest lead > name", () => {
    const c = (id: string, status: string, rate: number | null, lead: number | null, linkPreferred = false) => ({ vendorId: id, name: id, status, lastRate: rate === null ? null : D(rate), leadTimeDays: lead, linkPreferred, linked: true });
    const pending = chooseVendor("p", [c("p", "PENDING", 10, 1), c("x", "ACTIVE", 100, 3), c("y", "ACTIVE", 90, 5), c("z", "BLACKLISTED", 50, 1), c("w", "INACTIVE", 1, 1)]);
    expect(pending.selected?.vendorId).toBe("y");
    expect(pending.selectedBecause).toBe("LOWEST_RATE");
    expect(pending.blockedNote).toMatch(/awaiting approval/);
    expect(pending.eligible.map((v) => v.vendorId)).toEqual(["y", "x"]);
    expect(chooseVendor("x", [c("x", "ACTIVE", 100, 3), c("y", "ACTIVE", 90, 5)]).selectedBecause).toBe("PREFERRED_VENDOR");
    expect(chooseVendor(null, [c("x", "ACTIVE", 100, 3, true), c("y", "ACTIVE", 90, 5)]).selected?.vendorId).toBe("x");
    expect(chooseVendor(null, [c("x", "ACTIVE", null, 3), c("y", "ACTIVE", null, 2)]).selectedBecause).toBe("SHORTEST_LEAD_TIME");
    expect(chooseVendor(null, [c("x", "ACTIVE", 0, 1), c("y", "ACTIVE", 5, 9)]).selected?.vendorId).toBe("y"); // a zero rate is "unknown"
    const none = chooseVendor(null, [c("z", "BLACKLISTED", 1, 1, true)]);
    expect(none.selected).toBeNull();
    expect(none.blockedNote).toMatch(/blacklisted/);
  });

  it("asOf: omitted = server now; malformed or future = 400", () => {
    const now = new Date("2026-10-08T10:00:00.000Z");
    expect(parseAsOf(undefined, now)).toBe(now);
    expect(parseAsOf("", now)).toBe(now);
    expect(parseAsOf("2026-10-08T09:00:00.000Z", now).toISOString()).toBe("2026-10-08T09:00:00.000Z");
    for (const bad of ["yesterday", "2026-13-45", "12345", "not-a-date"]) expect(() => parseAsOf(bad, now)).toThrow(BadRequestError);
    expect(() => parseAsOf("2026-10-08T10:00:01.000Z", now)).toThrow(/future/);
    try { parseAsOf("garbage", now); } catch (e) { expect((e as BadRequestError).status).toBe(400); }
  });
});

// ============================================================
// B. Ledger inputs
// ============================================================

describe("B. ledger inputs", () => {
  it("B1-B4 usage is net of reversals; issues and count adjustments are not usage; the window is respected", async () => {
    const m = await material("Usage", { reorderLevel: 150, parLevel: 200 });
    await ledger(m, 200, "OPENING_BALANCE", 30);
    await ledger(m, -50, "SALE_CONSUMPTION", 20); // outside the 14-day window
    await ledger(m, -30, "SALE_CONSUMPTION", 10);
    await ledger(m, 5, "SALE_CONSUMPTION", 9); // a void / correction reverses part of it
    await ledger(m, -5, "WASTAGE", 8);
    await ledger(m, -10, "TRANSFER_OUT", 7);
    await ledger(m, -20, "ISSUE", 6, { departmentId: store });
    await ledger(m, 20, "ISSUE", 6, { departmentId: kitchen });
    await ledger(m, -10, "COUNT_ADJUSTMENT", 5);
    const r = row(await rowsFor(), m)!;
    expect(r.onHand).toBe(100);
    expect(r.usedInWindow).toBe(40);
    expect(r.observedDays).toBe(14);
    expect(r.avgDailyUse).toBeCloseTo(40 / 14, 4);
    expect(r.historyStatus).toBe("OK");
    // B4 an earlier asOf sees the earlier stock (one asOf for the whole calculation).
    const earlier = await rowsFor(mgrA, { asOf: new Date(Date.now() - 15 * DAY).toISOString() });
    expect(earlier.asOf).toBe(new Date(earlier.asOf).toISOString());
    expect(row(earlier, m)).toBeUndefined(); // 150 on hand then: not below the reorder point
  });

  it("B5 the response carries the single asOf used; asOf / window validation is 400", async () => {
    const before = Date.now();
    const r = await rowsFor();
    expect(new Date(r.asOf).getTime()).toBeGreaterThanOrEqual(before);
    expect(r.lookbackDays).toBe(14);
    await expect(rowsFor(mgrA, { asOf: "nope" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(rowsFor(mgrA, { asOf: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/future/);
    await expect(rowsFor(mgrA, { lookbackDays: "6" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(rowsFor(mgrA, { lookbackDays: "91" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(rowsFor(mgrA, { lookbackDays: "7.5" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(computeReorder(prisma, mgrA, {})).rejects.toBeInstanceOf(BadRequestError);
    expect((await rowsFor(mgrA, { lookbackDays: "30" })).lookbackDays).toBe(30);
  });

  it("B6 a new material is averaged over the days it has existed and is INSUFFICIENT history", async () => {
    const m = await material("New item", { reorderLevel: 10, parLevel: 30 });
    await ledger(m, 12, "OPENING_BALANCE", 2.5);
    await ledger(m, -9, "SALE_CONSUMPTION", 1);
    const r = row(await rowsFor(), m)!;
    expect(r.observedDays).toBe(3);
    expect(r.avgDailyUse).toBe(3);
    expect(r.historyStatus).toBe("INSUFFICIENT");
    expect(r.reasons).toContain("INSUFFICIENT_HISTORY");
  });

  it("B7 department stock: the outlet total drives the order; the split is shown", async () => {
    const m = await material("Split", { reorderLevel: 20, parLevel: 40 });
    await ledger(m, 6, "OPENING_BALANCE", 3, { departmentId: kitchen });
    await ledger(m, 4, "OPENING_BALANCE", 3, { departmentId: store });
    const r = row(await rowsFor(), m)!;
    expect(r.onHand).toBe(10);
    expect(r.suggestedBaseQty).toBe(30);
    expect(r.departments.map((d) => [d.name, d.onHand]).sort()).toEqual([["Kitchen", 6], ["Main store", 4]]);
  });

  it("B8 another outlet's stock and orders, and inactive materials, are not counted", async () => {
    const m = await material("Scoped", { reorderLevel: 10, parLevel: 20 });
    const v = await vendor("Scope vendor");
    await ledger(m, 50, "OPENING_BALANCE", 3, { outletId: B });
    await po(v, "ORDERED", [{ materialId: m, qty: 30 }], B);
    const r = row(await rowsFor(), m)!;
    expect(r).toMatchObject({ onHand: 0, incoming: 0, suggestedBaseQty: 20 });
    const off = await material("Inactive", { reorderLevel: 10, active: false });
    expect(row(await rowsFor(), off)).toBeUndefined();
  });
});

// ============================================================
// C. Duplicate protection
// ============================================================

describe("C. open documents protect against ordering twice", () => {
  it("C1-C5 open POs (remainder, in their unit), open indents and draft GRNs without a PO are incoming; closed ones are not", async () => {
    const m = await material("Netted", { reorderLevel: 100, parLevel: 200, purchaseUnitId: kase });
    await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: kase, toUnitId: kg, factor: 12, materialId: m } });
    const v = await vendor("Net vendor");
    const draft = await po(v, "DRAFT", [{ materialId: m, qty: 5 }]);
    await po(v, "SUBMITTED", [{ materialId: m, qty: 1, unitId: kase }]); // 12 kg
    const partial = await po(v, "PARTIAL", [{ materialId: m, qty: 10, receivedQty: 4 }]); // 6 open
    for (const s of ["RECEIVED", "BILLED", "CLOSED", "CANCELLED"]) await po(v, s, [{ materialId: m, qty: 1000 }]);
    const ind = await indent("DRAFT", m, 3);
    await indent("APPROVED", m, 2);
    for (const s of ["CLOSED", "CANCELLED"]) await indent(s, m, 1000);
    const g = await grn(v, "DRAFT", m, 2, { damagedQty: 0.5 }); // 1.5 good
    await grn(v, "DRAFT", m, 1000, { poId: partial.id }); // already inside the PO
    await grn(v, "POSTED", m, 1000); // already on hand (no ledger here: the fixture only proves it is not "incoming")
    const r = row(await rowsFor(), m)!;
    expect(r.incoming).toBe(5 + 12 + 6 + 3 + 2 + 1.5);
    expect(r.position).toBe(29.5);
    expect(r.suggestedBaseQty).toBe(180); // 170.5 -> 15 cases of 12 kg
    expect(r.order).toMatchObject({ unitId: kase, qty: 15, packFactor: 12 });
    expect(r.includesDrafts).toBe(true);
    expect(r.reasons).toEqual(expect.arrayContaining(["INCLUDES_DRAFTS", "PARTLY_ON_ORDER"]));
    const docs = Object.fromEntries(r.incomingDocs.map((d) => [d.number, d]));
    expect(docs[draft.number]).toMatchObject({ type: "PO", status: "DRAFT", qty: 5, draft: true });
    expect(docs[partial.number]).toMatchObject({ type: "PO", status: "PARTIAL", qty: 6, draft: false });
    expect(docs[ind.number]).toMatchObject({ type: "INDENT", status: "DRAFT", qty: 3, draft: true });
    expect(docs[g.number]).toMatchObject({ type: "GRN", status: "DRAFT", qty: 1.5 });
    expect(r.incomingDocs).toHaveLength(6);
  });

  it("C5b demand covered ONLY by draft documents is never hidden: it is listed with the drafts", async () => {
    const m = await material("Draft covered", { reorderLevel: 10, parLevel: 20 });
    const v = await vendor("Draft vendor");
    const d = await po(v, "DRAFT", [{ materialId: m, qty: 15 }]);
    const res = await rowsFor();
    expect(row(res, m)).toBeUndefined();
    const covered = res.coveredByDrafts.find((c) => c.materialId === m)!;
    expect(covered).toMatchObject({ onHand: 0, reorderPoint: 10, incoming: 15, draftIncoming: 15 });
    expect(covered.drafts).toEqual([expect.objectContaining({ number: d.number, status: "DRAFT", qty: 15, draft: true })]);
    expect(res.summary.coveredByDrafts).toBeGreaterThanOrEqual(1);
    // Once the PO is submitted it is a real commitment, no longer "draft-only" cover.
    await prisma.purchaseOrder.update({ where: { id: d.id }, data: { status: "SUBMITTED" } });
    expect((await rowsFor()).coveredByDrafts.find((c) => c.materialId === m)).toBeUndefined();
  });

  it("C6-C7 raising removes the row on reload; a stale screen is a 409 and creates nothing", async () => {
    const m = await material("Stale", { reorderLevel: 10, parLevel: 20 });
    const v = await vendor("Stale vendor");
    await link(v, m, 30);
    const r = row(await rowsFor(), m)!;
    const line = { materialId: m, vendorId: v, qty: r.order.qty, expectedIncoming: r.incoming };
    const first = await raiseReorderPurchaseOrders(storeA, { outletId: A, asOf: new Date().toISOString(), lines: [line] }, key());
    expect(first.purchaseOrders).toHaveLength(1);
    // A second raise from the same (now stale) screen, under a new key.
    const raised = await raiseReorderPurchaseOrders(storeA, { outletId: A, asOf: new Date().toISOString(), lines: [line] }, key()).catch((e) => e);
    expect(raised).toBeInstanceOf(ConflictError);
    expect((raised as ConflictError).message).toMatch(/was ordered since you loaded this screen \(PO-/);
    expect(await reorderPOs(m)).toHaveLength(1);
    expect(row(await rowsFor(), m)).toBeUndefined();
    // The same through a purchase request.
    const ind = await raiseReorderIndent(storeA, { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, qty: 5, expectedIncoming: 0 }] }, key()).catch((e) => e);
    expect(ind).toBeInstanceOf(ConflictError);
  });
});

// ============================================================
// D. Vendor eligibility (Group 1 rules)
// ============================================================

describe("D. approved-vendor selection", () => {
  it("D1-D3, D8 skips a PENDING preferred vendor and BLACKLISTED / INACTIVE links; cheapest ACTIVE wins; lead time comes from it", async () => {
    const pending = await vendor("Pending pref", "PENDING");
    const m = await material("Vendor pick", { reorderLevel: 10, parLevel: 20, preferredVendorId: pending });
    const x = await vendor("X active"), y = await vendor("Y active"), bl = await vendor("Black", "BLACKLISTED"), off = await vendor("Off", "INACTIVE");
    await link(x, m, 100, 3);
    await link(y, m, 90, 5);
    await link(bl, m, 50, 1);
    await link(off, m, 1, 1);
    await link(pending, m, 10, 1);
    const r = row(await rowsFor(), m)!;
    expect(r.vendor).toMatchObject({ id: y, rate: 90, leadTimeDays: 5, selectedBecause: "LOWEST_RATE" });
    expect(r.leadTimeDays).toBe(5);
    expect(r.blockedVendorNote).toMatch(/awaiting approval/);
    expect(r.reasons).toContain("PREFERRED_VENDOR_BLOCKED");
    expect(r.alternatives.map((a) => a.vendorId)).toEqual([y, x]);
    expect(r.alternatives[0].estimatedValue).toBe(1800);
    // Approval (Group 1, purchase.approve) makes the preferred vendor the choice.
    await setVendorStatus(owner, pending, { status: "ACTIVE" });
    expect(row(await rowsFor(), m)!.vendor).toMatchObject({ id: pending, selectedBecause: "PREFERRED_VENDOR" });
  });

  it("D4 only blocked vendors: listed with NO_VENDOR and in Needs setup; a purchase request is still possible", async () => {
    const bl = await vendor("Only black", "BLACKLISTED");
    const m = await material("Orphan", { reorderLevel: 5, parLevel: 10, preferredVendorId: bl });
    const res = await rowsFor();
    const r = row(res, m)!;
    expect(r.vendor).toBeNull();
    expect(r.reasons).toEqual(expect.arrayContaining(["NO_VENDOR", "PREFERRED_VENDOR_BLOCKED"]));
    expect(res.needsSetup.find((s) => s.materialId === m)).toMatchObject({ reason: "NO_ELIGIBLE_VENDOR", blockedVendorNote: expect.stringMatching(/blacklisted/) });
    expect(res.summary.byVendor.find((g) => g.vendorId === null)!.lines).toBeGreaterThanOrEqual(1);
    const ind = await raiseReorderIndent(storeA, { outletId: A, asOf: res.asOf, lines: [{ materialId: m, qty: 10, expectedIncoming: 0 }] }, key());
    expect(ind.indent).toMatchObject({ status: "DRAFT", source: "REORDER" });
  });

  it("D5 a PENDING or BLACKLISTED vendor anywhere in the request: 422 and zero POs, even with valid lines", async () => {
    const good = await vendor("Good"), pend = await vendor("Pend", "PENDING"), black = await vendor("Blk", "BLACKLISTED"), inactive = await vendor("Inact", "INACTIVE");
    const m1 = await material("D5 one", { reorderLevel: 5, parLevel: 10 }), m2 = await material("D5 two", { reorderLevel: 5, parLevel: 10 });
    await link(good, m1, 10);
    const asOf = new Date().toISOString();
    for (const [bad, msg] of [[pend, /awaiting approval/], [black, /blacklisted/], [inactive, /inactive/]] as const) {
      const err = await raiseReorderPurchaseOrders(mgrA, { outletId: A, asOf, lines: [{ materialId: m1, vendorId: good, qty: 10, expectedIncoming: 0 }, { materialId: m2, vendorId: bad, qty: 10, rate: 5, expectedIncoming: 0 }] }, key()).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toMatch(msg);
    }
    expect(await reorderPOs(m1)).toHaveLength(0);
    expect(await reorderPOs(m2)).toHaveLength(0);
  });

  it("D6-D7 a vendor blacklisted after its draft is raised cannot be ordered from; lifting the blacklist leaves it PENDING (still not eligible)", async () => {
    const v = await vendor("Later black");
    const m = await material("D6", { reorderLevel: 5, parLevel: 10 });
    await link(v, m, 10);
    const r = row(await rowsFor(), m)!;
    const { purchaseOrders } = await raiseReorderPurchaseOrders(storeA, { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, vendorId: v, qty: r.order.qty, expectedIncoming: 0 }] }, key());
    await setVendorStatus(owner, v, { status: "BLACKLISTED", reason: "Short weights" });
    await expect(transitionPurchaseOrder(storeA, purchaseOrders[0].id, "SUBMITTED")).rejects.toThrow(/blacklisted/);
    await setVendorStatus(owner, v, { status: "PENDING", reason: "Re-evaluating" });
    await prisma.purchaseOrder.update({ where: { id: purchaseOrders[0].id }, data: { status: "CANCELLED" } });
    const again = row(await rowsFor(), m)!;
    expect(again.vendor).toBeNull();
    expect(again.alternatives).toEqual([]);
  });
});

// ============================================================
// E. Permissions
// ============================================================

describe("E. RBAC with existing permissions", () => {
  it("E1 viewing needs purchase.view at the outlet", async () => {
    for (const role of ["MANAGER", "STORE", "ACCOUNTANT"]) expect((await computeReorder(prisma, member(role, A), { outletId: A })).outletId).toBe(A);
    for (const role of ["KITCHEN", "CAPTAIN", "CASHIER"]) await expect(computeReorder(prisma, member(role, A), { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(computeReorder(prisma, storeB, { outletId: A })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("E2-E4 raising needs purchase.create at the outlet; STORE cannot approve what it raised, a MANAGER can", async () => {
    const v = await vendor("RBAC vendor");
    const m = await material("RBAC", { reorderLevel: 5, parLevel: 10 });
    await link(v, m, 10);
    const body = () => ({ outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, vendorId: v, qty: 10, expectedIncoming: 0 }] });
    for (const ctx of [acctA, member("KITCHEN", A), storeB]) await expect(raiseReorderPurchaseOrders(ctx, body(), key())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(raiseReorderIndent(acctA, { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, qty: 1, expectedIncoming: 0 }] }, key())).rejects.toBeInstanceOf(ForbiddenError);
    const { purchaseOrders: [p] } = await raiseReorderPurchaseOrders(storeA, body(), key());
    expect(p).toMatchObject({ status: "DRAFT", source: "REORDER" });
    await transitionPurchaseOrder(storeA, p.id, "SUBMITTED");
    await expect(transitionPurchaseOrder(storeA, p.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionPurchaseOrder(mgrA, p.id, "APPROVED")).status).toBe("APPROVED");
  });
});

// ============================================================
// F. Idempotency, atomicity, audit
// ============================================================

describe("F. idempotent, atomic, audited raises", () => {
  it("F1-F3 the key is mandatory; same key + body replays; same key + different body is 409", async () => {
    const v = await vendor("Idem vendor");
    const m = await material("Idem", { reorderLevel: 5, parLevel: 10 });
    await link(v, m, 10);
    const body = { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, vendorId: v, qty: 10, expectedIncoming: 0 }] };
    const noKey = await raiseReorderPurchaseOrders(storeA, body, undefined).catch((e) => e);
    expect(noKey).toBeInstanceOf(BadRequestError);
    expect(noKey.status).toBe(400);
    await expect(raiseReorderPurchaseOrders(storeA, body, "short")).rejects.toBeInstanceOf(BadRequestError);
    await expect(raiseReorderIndent(storeA, { ...body, lines: [{ materialId: m, qty: 1, expectedIncoming: 0 }] }, undefined)).rejects.toBeInstanceOf(BadRequestError);
    const k = key();
    const first = await raiseReorderPurchaseOrders(storeA, body, k);
    const again = await raiseReorderPurchaseOrders(storeA, body, k);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.purchaseOrders.map((p) => p.id)).toEqual(first.purchaseOrders.map((p) => p.id));
    await expect(raiseReorderPurchaseOrders(storeA, { ...body, lines: [{ ...body.lines[0], qty: 11 }] }, k)).rejects.toBeInstanceOf(ConflictError);
    expect(await reorderPOs(m)).toHaveLength(1);

    const ik = key();
    const ib = { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, qty: 1, expectedIncoming: 10 }] };
    const i1 = await raiseReorderIndent(storeA, ib, ik);
    const i2 = await raiseReorderIndent(storeA, ib, ik);
    expect(i2).toMatchObject({ replayed: true, indent: { id: i1.indent.id } });
    await expect(raiseReorderIndent(storeA, { ...ib, notes: "changed" }, ik)).rejects.toBeInstanceOf(ConflictError);
  });

  it("F4 malformed bodies are 400: duplicate materials, empty lines, >4 dp, missing asOf, future asOf", async () => {
    const v = await vendor("Shape vendor");
    const m = await material("Shape", { reorderLevel: 5, parLevel: 10 });
    const l = { materialId: m, vendorId: v, qty: 1, rate: 1, expectedIncoming: 0 };
    const asOf = new Date().toISOString();
    for (const body of [
      { outletId: A, asOf, lines: [l, l] },
      { outletId: A, asOf, lines: [] },
      { outletId: A, asOf, lines: [{ ...l, qty: 1.00001 }] },
      { outletId: A, lines: [l] },
      { outletId: A, asOf: "soon", lines: [l] },
      { outletId: A, asOf: new Date(Date.now() + DAY).toISOString(), lines: [l] },
    ]) await expect(raiseReorderPurchaseOrders(storeA, body, key())).rejects.toBeInstanceOf(BadRequestError);
  });

  it("F5 a failure on the third vendor creates no PO at all; an inactive material or a line without any rate is 422", async () => {
    const v1 = await vendor("F5 a"), v2 = await vendor("F5 b"), v3 = await vendor("F5 c");
    const m1 = await material("F5 one", { reorderLevel: 5, parLevel: 10 }), m2 = await material("F5 two", { reorderLevel: 5, parLevel: 10 }), m3 = await material("F5 three", { reorderLevel: 5, parLevel: 10 });
    await link(v1, m1, 10);
    await link(v2, m2, 10);
    const asOf = new Date().toISOString();
    const lines = [{ materialId: m1, vendorId: v1, qty: 10, expectedIncoming: 0 }, { materialId: m2, vendorId: v2, qty: 10, expectedIncoming: 0 }, { materialId: m3, vendorId: v3, qty: 10, expectedIncoming: 0 }];
    const err = await raiseReorderPurchaseOrders(mgrA, { outletId: A, asOf, lines }, key()).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/Enter a rate/);
    for (const m of [m1, m2, m3]) expect(await reorderPOs(m)).toHaveLength(0);
    const off = await material("F5 inactive", { reorderLevel: 5, active: false });
    await expect(raiseReorderPurchaseOrders(mgrA, { outletId: A, asOf, lines: [{ materialId: off, vendorId: v1, qty: 1, rate: 1, expectedIncoming: 0 }] }, key())).rejects.toThrow(/inactive/);
    // With a rate typed in, the same three-vendor request goes through as three DRAFT POs.
    const ok = await raiseReorderPurchaseOrders(mgrA, { outletId: A, asOf, lines: lines.map((l, i) => (i === 2 ? { ...l, rate: 7 } : l)) }, key());
    expect(ok.purchaseOrders.map((p) => p.status)).toEqual(["DRAFT", "DRAFT", "DRAFT"]);
  });

  it("F6 pack-unit PO: 1 case = 12 kg at Rs 100/kg -> 2 cases at Rs 1,200/case; the audit records suggestion vs order", async () => {
    const v = await vendor("Case vendor"), other = await vendor("Other vendor");
    const m = await material("Paneer", { reorderLevel: 10, parLevel: 24, purchaseUnitId: kase });
    await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: kase, toUnitId: kg, factor: 12, materialId: m } });
    await link(v, m, 100, 2);
    await link(other, m, 120, 1);
    await cost(m, 95);
    const res = await rowsFor();
    const r = row(res, m)!;
    expect(r.order).toMatchObject({ unitId: kase, qty: 2, packFactor: 12 });
    expect(r.suggestedBaseQty).toBe(24);
    expect(r.poRate).toBe(1200);
    expect(r.estimatedValue).toBe(2280); // 24 kg x average cost 95 (the proposal's estimate)
    expect(r.costSource).toBe("AVG_COST");

    const { purchaseOrders: [p] } = await raiseReorderPurchaseOrders(storeA, { outletId: A, asOf: res.asOf, lines: [{ materialId: m, vendorId: v, qty: 2, unitId: kase, expectedIncoming: r.incoming }] }, key());
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ unitId: kase });
    expect(Number(p.lines[0].qty)).toBe(2);
    expect(Number(p.lines[0].rate)).toBe(1200);
    expect(Number(p.total)).toBe(2400);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, entityType: "PurchaseOrder", entityId: p.id, action: "CREATE" } });
    const after = JSON.parse(audit.after!);
    expect(after).toMatchObject({ source: "REORDER", asOf: res.asOf, lookbackDays: 14 });
    expect(after.lines[0]).toMatchObject({ materialId: m, suggestedBaseQty: 24, orderedQty: 2, orderedBaseQty: 24, qtyOverride: false, suggestedVendorId: v, vendorId: v, vendorOverride: false, rate: 1200 });

    // A manager override (other vendor, 3 cases, own rate) is allowed and audited as such.
    await prisma.purchaseOrder.update({ where: { id: p.id }, data: { status: "CANCELLED" } });
    const { purchaseOrders: [q] } = await raiseReorderPurchaseOrders(mgrA, { outletId: A, asOf: res.asOf, lines: [{ materialId: m, vendorId: other, qty: 3, unitId: kase, rate: 1300, expectedIncoming: 0 }] }, key());
    const qa = JSON.parse((await prisma.auditLog.findFirstOrThrow({ where: { entityType: "PurchaseOrder", entityId: q.id, action: "CREATE" } })).after!);
    expect(qa.lines[0]).toMatchObject({ qtyOverride: true, vendorOverride: true, orderedBaseQty: 36, rate: 1300 });
  });

  it("F7 parLevel on the material: validated against the reorder level, clearable, audited", async () => {
    const mat = await createMaterial(owner, { sku: `PAR-${RUN}`, name: `Par ${RUN}`, baseUnitId: kg, reorderLevel: 10, parLevel: 25.5 });
    expect(Number(mat.parLevel)).toBe(25.5);
    await expect(createMaterial(owner, { sku: `PAR2-${RUN}`, name: `Par2 ${RUN}`, baseUnitId: kg, reorderLevel: 10, parLevel: 5 })).rejects.toThrow(/par level/);
    await expect(updateMaterial(owner, mat.id, { reorderLevel: 30 })).rejects.toThrow(/par level/);
    expect((await updateMaterial(owner, mat.id, { parLevel: null })).parLevel).toBeNull();
    await expect(updateMaterial(mgrA, mat.id, { parLevel: 40 })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ============================================================
// I. End to end
// ============================================================

describe("I. recommendation -> purchasing -> stock", () => {
  it("PO path: raise -> submit -> approve -> order -> GRN -> post: stock rises and the row disappears", async () => {
    const v = await vendor("E2E vendor");
    const m = await material("Rice", { reorderLevel: 20, parLevel: 50 });
    await link(v, m, 40, 2);
    await ledger(m, 30, "OPENING_BALANCE", 20);
    await ledger(m, -25, "SALE_CONSUMPTION", 3);
    const r = row(await rowsFor(), m)!;
    expect(r.suggestedBaseQty).toBe(45);
    const { purchaseOrders: [p] } = await raiseReorderPurchaseOrders(storeA, { outletId: A, asOf: new Date().toISOString(), lines: [{ materialId: m, vendorId: v, qty: 45, expectedIncoming: 0 }] }, key());
    // Still DRAFT: nothing is submitted, approved or ordered automatically.
    expect(p.status).toBe("DRAFT");
    expect(row(await rowsFor(), m)).toBeUndefined();
    await transitionPurchaseOrder(storeA, p.id, "SUBMITTED");
    await transitionPurchaseOrder(mgrA, p.id, "APPROVED");
    await transitionPurchaseOrder(storeA, p.id, "ORDERED");
    const g = await createGRN(storeA, { outletId: A, vendorId: v, poId: p.id, lines: [{ materialId: m, qty: 45, rate: 40 }] }, undefined, key());
    await postGRN(storeA, g.id);
    const after = await rowsFor();
    expect(row(after, m)).toBeUndefined();
    const onHand = await prisma.inventoryLedger.aggregate({ where: { outletId: A, materialId: m }, _sum: { qty: true } });
    expect(Number(onHand._sum.qty)).toBe(50);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("RECEIVED");
  });

  it("request path: raise indent -> submit -> approve -> PO from indent; the quantity is never counted twice", async () => {
    const v = await vendor("Indent vendor");
    const m = await material("Oil", { reorderLevel: 10, parLevel: 30 });
    await link(v, m, 150);
    const r = row(await rowsFor(), m)!;
    const { indent: ind } = await raiseReorderIndent(storeA, { outletId: A, asOf: new Date().toISOString(), departmentId: kitchen, lines: [{ materialId: m, qty: r.order.qty, expectedIncoming: 0 }] }, key());
    expect(ind).toMatchObject({ status: "DRAFT", source: "REORDER", departmentId: kitchen });
    await transitionIndent(storeA, ind.id, "SUBMITTED");
    await expect(transitionIndent(storeA, ind.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    await transitionIndent(mgrA, ind.id, "APPROVED");
    expect(row(await rowsFor(), m)).toBeUndefined(); // the approved indent is incoming
    await createPurchaseOrder(mgrA, { outletId: A, vendorId: v, indentId: ind.id, lines: [{ materialId: m, qty: 30, rate: 150 }] }, undefined, key());
    const res = await computeReorder(prisma, mgrA, { outletId: A });
    expect(row(res, m)).toBeUndefined();
    // Indent CLOSED, PO DRAFT: exactly 30 incoming, not 60.
    const ev = await prisma.purchaseIndent.findUniqueOrThrow({ where: { id: ind.id } });
    expect(ev.status).toBe("CLOSED");
    const dept = await raiseReorderIndent(storeA, { outletId: A, asOf: new Date().toISOString(), departmentId: (await prisma.department.create({ data: { organizationId: orgId, outletId: B, name: "B kitchen" } })).id, lines: [{ materialId: m, qty: 1, expectedIncoming: 30 }] }, key()).catch((e) => e);
    expect(dept).toBeInstanceOf(ValidationError);
  });
});
