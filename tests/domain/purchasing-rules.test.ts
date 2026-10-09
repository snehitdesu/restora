/**
 * Purchase order approval rules and line review (audit PP-07, PP-06) against the real services and database:
 *  R1 the rules (who sets them, what is refused, audit)   R2 small orders approve themselves
 *  R3 large orders need two different approvers            R4 line-by-line review before approval
 *  R5 what the queue, the order and the owner's phone report
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createPurchaseOrder, transitionPurchaseOrder, reviewPurchaseOrder, createGRN, postGRN } from "@/server/services/procurement";
import { getProcurementRules, saveProcurementRules, approvalPlan } from "@/server/services/procurementRules";
import { getPurchaseOrder } from "@/server/services/documentQueries";
import { procurementQueue } from "@/server/services/procurementQueue";
import { managerSummary } from "@/server/services/mobile";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let vendor: string;
let flour: string;
let sugar: string;
let managerA: AccessContext;
let managerB: AccessContext;
let store: AccessContext;
let seq = 0;

const rules = (ctx: AccessContext = env.owner) => getProcurementRules(prisma, ctx.organizationId);
const setRules = (r: { autoApproveBelow?: number | null; dualApprovalAtOrAbove?: number | null }) => saveProcurementRules(env.owner, r);
/** A submitted order: `qty` x ₹100 per line (no tax) for flour, and optionally sugar. */
async function po(opts: { flour?: number; sugar?: number; submit?: boolean } = {}) {
  const lines = [{ materialId: flour, qty: opts.flour ?? 1, rate: 100, taxPct: 0 }, ...(opts.sugar ? [{ materialId: sugar, qty: opts.sugar, rate: 100, taxPct: 0 }] : [])];
  const made = await createPurchaseOrder(store, { outletId: env.outletA, vendorId: vendor, number: `PO-R-${++seq}-${uniq()}`, lines });
  return opts.submit === false ? made : transitionPurchaseOrder(store, made.id, "SUBMITTED");
}
const row = (id: string) => prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } });
const audits = (id: string, action?: string) => prisma.auditLog.findMany({ where: { organizationId: env.orgId, entityType: "PurchaseOrder", entityId: id, ...(action ? { action } : {}) }, orderBy: { createdAt: "asc" } });

beforeAll(async () => {
  env = await makeEnv("Gpr2");
  managerA = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-a-${uniq()}` };
  managerB = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-b-${uniq()}` };
  store = { ...member(env.orgId, "STORE", env.outletA), userId: `store-${uniq()}` };
  vendor = (await prisma.vendor.create({ data: { organizationId: env.orgId, name: `Vendor ${uniq()}`, status: "ACTIVE", active: true } })).id;
  const unit = await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } });
  flour = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `FL-${uniq()}`, name: "Flour", baseUnitId: unit.id } })).id;
  sugar = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `SU-${uniq()}`, name: "Sugar", baseUnitId: unit.id } })).id;
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("R1. the rules", () => {
  it("R1 start empty; only the owner changes them; changes are validated and audited with before and after", async () => {
    expect(await rules()).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: null });
    await expect(saveProcurementRules(managerA, { autoApproveBelow: 500 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRules({ autoApproveBelow: -1 })).rejects.toThrow();
    await expect(setRules({ autoApproveBelow: 10.005 })).rejects.toThrow();
    await expect(setRules({ autoApproveBelow: 5000, dualApprovalAtOrAbove: 1000 })).rejects.toThrow(/smaller than/);
    await expect(setRules({ autoApproveBelow: 1000, dualApprovalAtOrAbove: 1000 })).rejects.toThrow(/smaller than/);
    await expect(saveProcurementRules(env.owner, { nonsense: 1 } as never)).rejects.toThrow();
    expect(await setRules({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 })).toEqual({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
    expect(await rules()).toEqual({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
    // A partial change keeps the other limit; null switches one off.
    expect(await setRules({ autoApproveBelow: null })).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: 5000 });
    await setRules({ autoApproveBelow: 500 });
    const log = await prisma.auditLog.findMany({ where: { organizationId: env.orgId, entityType: "ProcurementSettings" }, orderBy: { createdAt: "asc" } });
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(log[0].before!)).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: null });
    expect(JSON.parse(log[0].after!)).toEqual({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
  });

  it("R1 each restaurant has its own rules; the pure rule is exact at the edges", async () => {
    const other = await makeEnv("Gpr3");
    expect(await getProcurementRules(prisma, other.orgId)).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: null });
    const limits = { autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 };
    expect(approvalPlan(500, limits)).toBe("AUTO");
    expect(approvalPlan(500.01, limits)).toBe("SINGLE");
    expect(approvalPlan(4999.99, limits)).toBe("SINGLE");
    expect(approvalPlan(5000, limits)).toBe("DUAL");
    expect(approvalPlan(0, limits)).toBe("AUTO");
    expect(approvalPlan(1e9, { autoApproveBelow: null, dualApprovalAtOrAbove: null })).toBe("SINGLE");
    expect(approvalPlan(100, { autoApproveBelow: null, dualApprovalAtOrAbove: 100 })).toBe("DUAL");
  });
});

describe("R2. small orders approve themselves", () => {
  it("R2 at or below the limit the order is approved when submitted, by nobody; above it, it waits", async () => {
    await setRules({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
    const small = await po({ flour: 5 }); // 500: at the limit
    expect(small.status).toBe("APPROVED");
    const r = await row(small.id);
    expect(r).toMatchObject({ status: "APPROVED", autoApproved: true, approvedById: null });
    expect(r.approvedAt).toBeInstanceOf(Date);
    const approval = (await audits(small.id, "APPROVE"))[0];
    expect(JSON.parse(approval.after!)).toMatchObject({ status: "APPROVED", auto: true, limit: 500 });
    const bigger = await po({ flour: 6 }); // 600
    expect(bigger.status).toBe("SUBMITTED");
    expect((await row(bigger.id)).autoApproved).toBe(false);
  });

  it("R2 an auto-approved order can be ordered and received like any other; with no rule nothing approves itself", async () => {
    await setRules({ autoApproveBelow: 500 });
    const small = await po({ flour: 2 });
    expect((await transitionPurchaseOrder(store, small.id, "ORDERED")).status).toBe("ORDERED");
    await setRules({ autoApproveBelow: null });
    expect((await po({ flour: 1 })).status).toBe("SUBMITTED");
  });

  it("R2 a draft is never approved by the rule, only a submission is", async () => {
    await setRules({ autoApproveBelow: 500 });
    const draft = await po({ flour: 1, submit: false });
    expect(draft.status).toBe("DRAFT");
  });
});

describe("R3. large orders need two different approvers", () => {
  it("R3 the first approval waits, the same person cannot give the second, a different person completes it", async () => {
    await setRules({ autoApproveBelow: null, dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 60 }); // 6000
    const first = await transitionPurchaseOrder(managerA, big.id, "APPROVED");
    expect(first.status).toBe("SUBMITTED"); // still waiting
    expect(await row(big.id)).toMatchObject({ firstApprovedById: managerA.userId, status: "SUBMITTED", approvedById: null });
    await expect(transitionPurchaseOrder(managerA, big.id, "APPROVED")).rejects.toThrow(/second, different approver/);
    const done = await transitionPurchaseOrder(managerB, big.id, "APPROVED");
    expect(done.status).toBe("APPROVED");
    expect(await row(big.id)).toMatchObject({ status: "APPROVED", approvedById: managerB.userId, firstApprovedById: managerA.userId });
    const steps = (await audits(big.id, "APPROVE")).map((a) => JSON.parse(a.after!));
    expect(steps[0]).toMatchObject({ approval: "1 of 2", limit: 5000 });
    expect(steps[1]).toMatchObject({ status: "APPROVED", approval: "2 of 2", firstApprovedById: managerA.userId });
  });

  it("R3 an order just under the limit needs one approver; exactly at it needs two", async () => {
    await setRules({ dualApprovalAtOrAbove: 5000 });
    const under = await po({ flour: 49 }); // 4900
    expect((await transitionPurchaseOrder(managerA, under.id, "APPROVED")).status).toBe("APPROVED");
    const at = await po({ flour: 50 }); // 5000
    expect((await transitionPurchaseOrder(managerA, at.id, "APPROVED")).status).toBe("SUBMITTED");
  });

  it("R3 whoever may not approve cannot give either approval; the order's creator is not blocked from approving", async () => {
    await setRules({ dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 60 });
    await expect(transitionPurchaseOrder(store, big.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(transitionPurchaseOrder(env.foreign, big.id, "APPROVED")).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(big.id)).firstApprovedById).toBeNull();
    // The owner is a different person from the store keeper who raised it.
    expect((await transitionPurchaseOrder(env.owner, big.id, "APPROVED")).status).toBe("SUBMITTED");
    expect((await transitionPurchaseOrder(managerA, big.id, "APPROVED")).status).toBe("APPROVED");
  });

  it("R3 cancelling a half-approved order is allowed; the order then cannot be approved", async () => {
    await setRules({ dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 60 });
    await transitionPurchaseOrder(managerA, big.id, "APPROVED");
    expect((await transitionPurchaseOrder(store, big.id, "CANCELLED")).status).toBe("CANCELLED");
    await expect(transitionPurchaseOrder(managerB, big.id, "APPROVED")).rejects.toThrow(/purchase order/);
  });
});

describe("R4. reviewing an order line by line", () => {
  it("R4 change a quantity and take a line off: totals follow, the quantity as raised is kept, the review is audited", async () => {
    await setRules({ autoApproveBelow: null, dualApprovalAtOrAbove: null });
    const order = await po({ flour: 10, sugar: 4 }); // 1000 + 400
    const [lf, ls] = [order.id, order.id].map(() => null) && (await row(order.id)).lines.sort((a, b) => (a.materialId === flour ? -1 : 1) - (b.materialId === flour ? -1 : 1));
    const reviewed = await reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: lf.id, action: "KEEP", qty: 6 }, { lineId: ls.id, action: "REJECT" }], note: "Too much flour, no sugar this week" });
    expect(Number(reviewed.total)).toBe(600);
    const after = await row(order.id);
    expect(Number(after.subtotal)).toBe(600);
    const fl = after.lines.find((l) => l.id === lf.id)!;
    const su = after.lines.find((l) => l.id === ls.id)!;
    expect([Number(fl.qty), Number(fl.requestedQty)]).toEqual([6, 10]);
    expect([su.lineStatus, Number(su.qty)]).toEqual(["REJECTED", 4]);
    expect((await row(order.id)).status).toBe("SUBMITTED"); // a review approves nothing
    const log = JSON.parse((await audits(order.id)).at(-1)!.after!);
    expect(log).toMatchObject({ total: "600.00", note: "Too much flour, no sugar this week" });
    expect(log.review).toHaveLength(2);
    // A rejected line can be put back.
    const restored = await reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: ls.id, action: "KEEP" }] });
    expect(Number(restored.total)).toBe(1000);
  });

  it("R4 refusals: at least one line stays, nothing to change, a stranger's line, a line twice, a rejected line with a quantity, bad quantities", async () => {
    const order = await po({ flour: 2, sugar: 2 });
    const lines = (await row(order.id)).lines;
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: lines.map((l) => ({ lineId: l.id, action: "REJECT" as const })) })).rejects.toThrow(/At least one line/);
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: lines[0].id, action: "KEEP" }] })).rejects.toThrow(/Nothing to change/);
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: "nope", action: "REJECT" }] })).rejects.toThrow(/not on this purchase order/);
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: lines[0].id, action: "REJECT" }, { lineId: lines[0].id, action: "KEEP", qty: 3 }] })).rejects.toThrow(/twice/);
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: lines[0].id, action: "REJECT", qty: 1 }] })).rejects.toThrow(/no quantity/);
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: lines[0].id, action: "KEEP", qty: 0 }] })).rejects.toThrow();
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [] })).rejects.toThrow();
    expect(Number((await row(order.id)).total)).toBe(400); // nothing moved
  });

  it("R4 only a submitted order, only an approver, only this restaurant's order", async () => {
    const draft = await po({ flour: 2, sugar: 2, submit: false });
    const dl = (await row(draft.id)).lines[0];
    await expect(reviewPurchaseOrder(managerA, draft.id, { lines: [{ lineId: dl.id, action: "REJECT" }] })).rejects.toThrow(/Only a submitted order/);
    const order = await po({ flour: 2, sugar: 2 });
    const l = (await row(order.id)).lines[0];
    await expect(reviewPurchaseOrder(store, order.id, { lines: [{ lineId: l.id, action: "REJECT" }] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(reviewPurchaseOrder(env.foreign, order.id, { lines: [{ lineId: l.id, action: "REJECT" }] })).rejects.toBeInstanceOf(NotFoundError);
    await transitionPurchaseOrder(managerA, order.id, "APPROVED");
    await expect(reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: l.id, action: "REJECT" }] })).rejects.toThrow(/Only a submitted order/);
  });

  it("R4 a review after the first of two approvals clears it; the new total is judged against the rules", async () => {
    await setRules({ autoApproveBelow: null, dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 40, sugar: 20 }); // 6000
    await transitionPurchaseOrder(managerA, big.id, "APPROVED");
    expect((await row(big.id)).firstApprovedById).toBe(managerA.userId);
    const sl = (await row(big.id)).lines.find((l) => l.materialId === sugar)!;
    await reviewPurchaseOrder(managerB, big.id, { lines: [{ lineId: sl.id, action: "REJECT" }] }); // 4000: now under the limit
    expect(await row(big.id)).toMatchObject({ firstApprovedById: null, firstApprovedAt: null });
    expect(JSON.parse((await audits(big.id)).at(-1)!.after!)).toMatchObject({ firstApprovalCleared: true });
    expect((await transitionPurchaseOrder(managerB, big.id, "APPROVED")).status).toBe("APPROVED"); // one approver is enough now
  });

  it("R4 a rejected line cannot be received and does not hold the order open", async () => {
    await setRules({ dualApprovalAtOrAbove: null });
    const order = await po({ flour: 3, sugar: 3 });
    const sl = (await row(order.id)).lines.find((l) => l.materialId === sugar)!;
    await reviewPurchaseOrder(managerA, order.id, { lines: [{ lineId: sl.id, action: "REJECT" }] });
    await transitionPurchaseOrder(managerA, order.id, "APPROVED");
    await transitionPurchaseOrder(store, order.id, "ORDERED");
    await expect(createGRN(store, { outletId: env.outletA, vendorId: vendor, poId: order.id, lines: [{ materialId: sugar, qty: 1, rate: 100 }] })).rejects.toThrow(/not on purchase order/);
    const grn = await createGRN(store, { outletId: env.outletA, vendorId: vendor, poId: order.id, lines: [{ materialId: flour, qty: 3, rate: 100 }] });
    await postGRN(store, grn.id);
    expect((await row(order.id)).status).toBe("RECEIVED"); // the rejected sugar line does not keep it open
  });
});

describe("R5. what the screens are told", () => {
  it("R5 the order says how many approvers it needs, how many it has and who gave the first (and whether it was you)", async () => {
    await setRules({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 60 });
    const before = (await getPurchaseOrder(prisma, managerA, big.id)).approval;
    expect(before).toMatchObject({ plan: "DUAL", needed: 2, done: 0, firstApprovedBy: null, autoApproved: false, youApprovedFirst: false });
    await transitionPurchaseOrder(managerA, big.id, "APPROVED");
    const mine = (await getPurchaseOrder(prisma, managerA, big.id)).approval;
    expect(mine).toMatchObject({ needed: 2, done: 1, youApprovedFirst: true });
    expect((await getPurchaseOrder(prisma, managerB, big.id)).approval).toMatchObject({ done: 1, youApprovedFirst: false });
    const auto = await po({ flour: 1 });
    expect((await getPurchaseOrder(prisma, managerA, auto.id)).approval).toMatchObject({ autoApproved: true, needed: 0 });
    const single = await po({ flour: 10 });
    expect((await getPurchaseOrder(prisma, managerA, single.id)).approval).toMatchObject({ plan: "SINGLE", needed: 1, done: 0 });
  });

  it("R5 the procurement queue and the owner's phone show the same progress", async () => {
    await setRules({ autoApproveBelow: null, dualApprovalAtOrAbove: 5000 });
    const big = await po({ flour: 70 });
    await transitionPurchaseOrder(managerA, big.id, "APPROVED");
    const q = await procurementQueue(prisma, managerB, { outletId: env.outletA, tab: "needs-approval", take: 100 });
    expect(q.items.find((i) => i.id === big.id)).toMatchObject({ kind: "PURCHASE_ORDER", approval: { needed: 2, done: 1, autoApproved: false } });
    const phone = (await managerSummary(prisma, managerA, env.outletA)).approvals!;
    const mine = phone.purchaseOrders.find((p) => p.id === big.id)!;
    expect(mine.approval).toMatchObject({ needed: 2, done: 1, youApprovedFirst: true });
    const theirs = (await managerSummary(prisma, managerB, env.outletA)).approvals!.purchaseOrders.find((p) => p.id === big.id)!;
    expect(theirs.approval).toMatchObject({ needed: 2, done: 1, youApprovedFirst: false });
  });
});
