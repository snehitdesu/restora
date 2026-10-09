/**
 * Operational notifications that used to exist only as types: the morning stock and dues check (once a day per outlet, from
 * 08:00 on the outlet's own clock), a purchase order waiting for an approver, and a new reservation.
 *
 *  A1 morning check: nothing before 08:00 local; low stock and overdue vendor bills notify once a day; nothing to say, nothing sent
 *  A2 who sees them: only people holding the permission at that outlet; another organization never does
 *  A3 purchase orders: a submitted order waits for an approver (and the second of two); a small order that approves itself does not
 *  A4 a new reservation reaches the people who manage reservations, with the party and the time on the outlet's clock
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import type { AccessContext } from "@/server/db/scope";
import { OPS_ALERTS, runOperationsAlerts, runScheduledJobs } from "@/server/ops/scheduled";
import { listNotifications } from "@/server/services/notifications";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/server/services/procurement";
import { saveProcurementRules } from "@/server/services/procurementRules";
import { createReservation } from "@/server/services/reservations";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let vendor: string;
let flour: string;
let store: AccessContext;
let managerA: AccessContext;
let managerB: AccessContext;
let seq = 0;

// Asia/Kolkata is UTC+5:30: 07:30 local on 9 Oct is 02:00 UTC, 08:30 local is 03:00 UTC.
const BEFORE_8 = new Date("2026-10-09T02:00:00Z");
const AFTER_8 = new Date("2026-10-09T03:00:00Z");
const NEXT_DAY = new Date("2026-10-10T03:00:00Z");

const notes = (type: string, outletId = env.outletA, org = env.orgId) => prisma.notification.findMany({ where: { organizationId: org, outletId, type }, orderBy: { createdAt: "asc" } });
const run = (now: Date, outletId = env.outletA) => runOperationsAlerts(prisma, now, outletId);

beforeAll(async () => {
  env = await makeEnv("Ops");
  store = { ...member(env.orgId, "STORE", env.outletA), userId: `store-${uniq()}` };
  managerA = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-a-${uniq()}` };
  managerB = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-b-${uniq()}` };
  vendor = (await prisma.vendor.create({ data: { organizationId: env.orgId, name: `Vendor ${uniq()}`, status: "ACTIVE", active: true } })).id;
  const unit = await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } });
  flour = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `FL-${uniq()}`, name: "Flour", baseUnitId: unit.id } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("A1. the morning check", () => {
  it("A1 nothing sent when nothing is low or overdue; before 08:00 on the outlet's own clock nothing runs at all", async () => {
    expect(await run(BEFORE_8)).toMatchObject({ started: 0, skipped: 1 });
    expect(await prisma.jobRun.count({ where: { name: OPS_ALERTS, scopeKey: env.outletA } })).toBe(0);
    expect(await run(AFTER_8)).toMatchObject({ started: 1, succeeded: 1, lowStock: 0, overdue: 0 });
    expect(await notes("LOW_STOCK")).toHaveLength(0);
    expect(await notes("VENDOR_DUE")).toHaveLength(0);
    const row = await prisma.jobRun.findFirstOrThrow({ where: { name: OPS_ALERTS, scopeKey: env.outletA } });
    expect(row).toMatchObject({ status: "SUCCESS", runDate: "2026-10-09" });
  });

  it("A1 low stock and overdue vendor bills each produce one notification a day, however many times the worker ticks", async () => {
    await prisma.material.update({ where: { id: flour }, data: { reorderLevel: 10 } }); // no stock at all: at or below its reorder level
    const due = (days: number) => new Date(AFTER_8.getTime() + days * 86_400_000);
    const bill = (total: number, dueDate: Date) => prisma.purchaseBill.create({ data: { organizationId: env.orgId, outletId: env.outletA, number: `B-${uniq()}`, vendorId: vendor, total, dueDate, status: "OPEN" } });
    await bill(1200, due(-3)); // overdue
    await bill(800, due(-1)); // overdue, part paid
    await prisma.purchaseBill.updateMany({ where: { organizationId: env.orgId, total: 800 }, data: { paidAmount: 300, status: "PARTIAL" } });
    await bill(5000, due(10)); // not due yet: not counted

    // The day was already claimed by the first test; the next day is a new run.
    expect(await run(AFTER_8)).toMatchObject({ started: 0, skipped: 1 });
    const first = await run(NEXT_DAY);
    expect(first).toMatchObject({ started: 1, succeeded: 1, lowStock: 1, overdue: 1 });
    expect(await run(NEXT_DAY)).toMatchObject({ started: 0, skipped: 1 });
    const [low] = await notes("LOW_STOCK");
    const [dues] = await notes("VENDOR_DUE");
    expect(low).toMatchObject({ title: "Low stock alert", body: "1 item at or below reorder level" });
    expect(dues).toMatchObject({ title: "Vendor payments overdue", body: "Overdue ₹1700.00" }); // 1200 + (800 - 300)
    expect(await notes("LOW_STOCK")).toHaveLength(1);
    expect(await notes("VENDOR_DUE")).toHaveLength(1);
    expect(JSON.parse((await prisma.jobRun.findFirstOrThrow({ where: { name: OPS_ALERTS, scopeKey: env.outletA, runDate: "2026-10-10" } })).detail!)).toMatchObject({ lowStock: 1, overdue: "1700.00" });
  });

  it("A1 the worker's scheduled run includes it and a failure there never costs the other jobs their result", async () => {
    const result = await runScheduledJobs(prisma, new Date("2026-10-11T03:00:00Z"));
    expect(result.opsAlerts).not.toBeNull();
    expect(result.posRepull).toBeDefined();
  });
});

describe("A2. who sees them", () => {
  it("A2 stock alerts go to people who can view inventory, dues to people who can pay vendors; another organization sees neither", async () => {
    const cashier = { ...env.cashier, userId: `cashier-${uniq()}` };
    const seen = async (ctx: AccessContext) => (await listNotifications(prisma, ctx)).map((n) => n.type);
    expect(await seen(store)).toContain("LOW_STOCK");
    expect(await seen(store)).not.toContain("VENDOR_DUE");
    expect(await seen(managerA)).toEqual(expect.arrayContaining(["LOW_STOCK", "VENDOR_DUE"]));
    expect(await seen(cashier)).not.toContain("LOW_STOCK");
    expect(await seen(cashier)).not.toContain("VENDOR_DUE");
    expect(await seen(env.foreign)).toEqual([]);
  });

  it("A2 an outlet of another organization is never touched by this organization's run", async () => {
    const other = await makeEnv("OpsOther");
    expect(await notes("LOW_STOCK", other.outletA, other.orgId)).toHaveLength(0);
    expect(await notes("VENDOR_DUE", other.outletA, other.orgId)).toHaveLength(0);
  });
});

describe("A3. purchase orders waiting for an approver", () => {
  const order = async (qty: number) => createPurchaseOrder(store, { outletId: env.outletA, vendorId: vendor, number: `PO-A-${++seq}-${uniq()}`, lines: [{ materialId: flour, qty, rate: 100, taxPct: 0 }] });

  it("A3 a submitted order notifies the people who can approve at that outlet, and nobody who cannot", async () => {
    await saveProcurementRules(env.owner, { autoApproveBelow: null, dualApprovalAtOrAbove: null });
    const po = await order(2);
    expect(await notes("PURCHASE_APPROVAL")).toHaveLength(0); // a draft is nobody's business yet
    await transitionPurchaseOrder(store, po.id, "SUBMITTED");
    const sent = await notes("PURCHASE_APPROVAL");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Purchase order awaiting approval", body: po.number });
    const seen = async (ctx: AccessContext) => (await listNotifications(prisma, ctx)).filter((n) => n.type === "PURCHASE_APPROVAL").length;
    expect(await seen(managerA)).toBe(1);
    expect(await seen(store)).toBe(0); // the person who raised it cannot approve it
    expect(await seen(env.cashier)).toBe(0);
    await transitionPurchaseOrder(managerA, po.id, "APPROVED");
  });

  it("A3 a small order that approves itself notifies nobody; the first of two approvals asks for the second", async () => {
    await saveProcurementRules(env.owner, { autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
    const before = (await notes("PURCHASE_APPROVAL")).length;
    const small = await order(1); // 100
    expect((await transitionPurchaseOrder(store, small.id, "SUBMITTED")).status).toBe("APPROVED");
    expect(await notes("PURCHASE_APPROVAL")).toHaveLength(before);

    const large = await order(60); // 6000: two approvers
    await transitionPurchaseOrder(store, large.id, "SUBMITTED");
    expect(await notes("PURCHASE_APPROVAL")).toHaveLength(before + 1);
    await transitionPurchaseOrder(managerA, large.id, "APPROVED"); // first of two: stays SUBMITTED
    const all = await notes("PURCHASE_APPROVAL");
    expect(all).toHaveLength(before + 2);
    expect(all.at(-1)).toMatchObject({ body: `${large.number}: second approval needed` });
    await transitionPurchaseOrder(managerB, large.id, "APPROVED");
    expect(await notes("PURCHASE_APPROVAL")).toHaveLength(before + 2); // approving is not a new request
    await saveProcurementRules(env.owner, { autoApproveBelow: null, dualApprovalAtOrAbove: null });
  });
});

describe("A4. reservations", () => {
  it("A4 a new booking reaches the people who manage reservations, with the party and the time on the outlet's clock", async () => {
    const host = { ...env.manager, userId: `host-${uniq()}` };
    const when = new Date(Date.now() + 3 * 86_400_000);
    when.setUTCHours(14, 0, 0, 0); // 19:30 in Asia/Kolkata
    await createReservation(host, { outletId: env.outletA, partySize: 4, reservedAt: when } as never);
    const [n] = await notes("RESERVATION");
    expect(n.title).toBe("New reservation");
    expect(n.body).toMatch(/^Party of 4, /);
    expect(n.body).toMatch(/7:30\s?pm/i);
    expect((await listNotifications(prisma, host)).some((x) => x.type === "RESERVATION")).toBe(true);
    expect((await listNotifications(prisma, env.kitchen)).some((x) => x.type === "RESERVATION")).toBe(false);
  });
});
