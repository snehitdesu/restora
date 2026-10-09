/**
 * The owner's purchase-order approval queue on the phone (audit MB-05), against the real services and database.
 *
 *  M1 the summary lists what is waiting (oldest first, with vendor, amount and item count) and nothing else
 *  M2 only people who can approve see it; it never crosses outlets or restaurants
 *  M3 approving from the queue is the ordinary PO transition: audited, and it leaves the queue
 *  M4 rejecting cancels; a store keeper can neither approve nor see the queue
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/db/scope";
import { managerSummary } from "@/server/services/mobile";
import { transitionPurchaseOrder } from "@/server/services/procurement";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let storeKeeper: ReturnType<typeof member>;
let unit: string;
let material: string;
const po: Record<string, string> = {};

async function vendor(name: string, orgId = env.orgId) {
  return (await prisma.vendor.create({ data: { organizationId: orgId, name: `${name} ${uniq()}`, status: "ACTIVE", active: true } })).id;
}
async function makePo(label: string, vendorId: string, opts: { status?: string; total?: number; outletId?: string; createdAt?: Date; lines?: number; notes?: string } = {}) {
  const row = await prisma.purchaseOrder.create({
    data: {
      organizationId: env.orgId, outletId: opts.outletId ?? env.outletA, number: `PO-${label}-${uniq()}`, vendorId, status: opts.status ?? "SUBMITTED", total: opts.total ?? 1000, subtotal: opts.total ?? 1000,
      createdAt: opts.createdAt, notes: opts.notes,
      lines: { create: Array.from({ length: opts.lines ?? 1 }, () => ({ organizationId: env.orgId, materialId: material, qty: 2, rate: 10 })) },
    },
  });
  po[label] = row.id;
  return row;
}
const summary = (ctx = env.manager) => managerSummary(prisma, ctx, env.outletA);

beforeAll(async () => {
  env = await makeEnv("Gma");
  storeKeeper = member(env.orgId, "STORE", env.outletA);
  unit = (await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } })).id;
  material = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `RICE-${uniq()}`, name: "Rice", baseUnitId: unit } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("M1. what is waiting", () => {
  it("M1 submitted purchase orders, oldest first, with vendor, amount and item count; other states are not in the queue", async () => {
    const fresh = await vendor("Fresh Farms");
    const dairy = await vendor("Dairy Co");
    await makePo("new", dairy, { total: 4200.5, lines: 3, notes: "Needed for Friday" });
    await makePo("old", fresh, { total: 1800, createdAt: new Date(Date.now() - 2 * 86400_000) });
    await makePo("draft", fresh, { status: "DRAFT" });
    await makePo("approved", fresh, { status: "APPROVED" });
    await makePo("cancelled", fresh, { status: "CANCELLED" });
    const a = (await summary()).approvals!;
    expect(a.pendingPurchaseOrders).toBe(2);
    expect(a.purchaseOrders.map((p) => p.id)).toEqual([po.old, po.new]);
    expect(a.purchaseOrders[1]).toMatchObject({ vendor: expect.stringContaining("Dairy Co"), total: 4200.5, lines: 3, notes: "Needed for Friday" });
    expect(a.purchaseOrders[0]).toMatchObject({ vendor: expect.stringContaining("Fresh Farms"), total: 1800, lines: 1, notes: null });
    expect(Number.isNaN(Date.parse(a.purchaseOrders[0].raisedAt))).toBe(false);
  });

  it("M1 the queue is capped at 20 rows while the count stays true", async () => {
    const v = await vendor("Bulk");
    const e = await makeEnv("Gmb");
    for (let i = 0; i < 22; i++) {
      await prisma.purchaseOrder.create({ data: { organizationId: e.orgId, outletId: e.outletA, number: `PO-BULK-${i}`, vendorId: v, status: "SUBMITTED", total: 10 } });
    }
    const a = (await managerSummary(prisma, e.manager, e.outletA)).approvals!;
    expect(a.pendingPurchaseOrders).toBe(22);
    expect(a.purchaseOrders).toHaveLength(20);
  });
});

describe("M2. who sees it", () => {
  it("M2 a manager and an owner see the queue; a store keeper (no approval right) gets no queue — and no summary at all", async () => {
    expect((await summary(env.owner)).approvals).not.toBeNull();
    // A store keeper holds inventory.view, so the summary opens, but the approvals section is absent.
    const s = await summary(storeKeeper);
    expect(s.approvals).toBeNull();
    expect(s.inventory).not.toBeNull();
  });

  it("M2 never another outlet's or another restaurant's purchase orders", async () => {
    const v = await vendor("Elsewhere");
    await makePo("outletB", v, { outletId: env.outletB });
    const a = (await summary()).approvals!;
    expect(a.purchaseOrders.map((p) => p.id)).not.toContain(po.outletB);
    // The same manager is not a member of outlet B at all.
    await expect(managerSummary(prisma, env.manager, env.outletB)).rejects.toBeInstanceOf(ForbiddenError);
    // The owner reading outlet B sees B's queue.
    const b = (await managerSummary(prisma, env.owner, env.outletB)).approvals!;
    expect(b.purchaseOrders.map((p) => p.id)).toEqual([po.outletB]);
    // Another restaurant's owner cannot read this outlet at all (it does not exist for them).
    await expect(managerSummary(prisma, env.foreign, env.outletA)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("M3. approving from the queue", () => {
  it("M3 approve leaves the queue, records who approved, and is audited", async () => {
    const before = (await summary()).approvals!.pendingPurchaseOrders;
    const updated = await transitionPurchaseOrder(env.manager, po.new, "APPROVED");
    expect(updated.status).toBe("APPROVED");
    expect(updated.approvedById).toBe(env.manager.userId);
    expect(updated.approvedAt).not.toBeNull();
    const a = (await summary()).approvals!;
    expect(a.pendingPurchaseOrders).toBe(before - 1);
    expect(a.purchaseOrders.map((p) => p.id)).not.toContain(po.new);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "PurchaseOrder", entityId: po.new, action: "APPROVE" } });
    expect(audit).not.toBeNull();
    // Approving twice is refused by the state machine.
    await expect(transitionPurchaseOrder(env.manager, po.new, "APPROVED")).rejects.toThrow(/purchase order/i);
  });
});

describe("M4. rejecting and refusal", () => {
  it("M4 reject cancels the order and it leaves the queue", async () => {
    const r = await transitionPurchaseOrder(env.manager, po.old, "CANCELLED");
    expect(r.status).toBe("CANCELLED");
    expect((await summary()).approvals!.purchaseOrders.map((p) => p.id)).not.toContain(po.old);
  });

  it("M4 a store keeper cannot approve from anywhere", async () => {
    const v = await vendor("Late");
    const late = await makePo("late", v);
    await expect(transitionPurchaseOrder(storeKeeper, late.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: late.id } })).status).toBe("SUBMITTED");
  });
});
