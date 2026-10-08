/**
 * Proposal core gaps closed on 2026-10-07 (docs/master-feature-audit.md), each
 * against the real services and the test database:
 *  - MD-16 vendor approval lifecycle; buying from a non-ACTIVE vendor is blocked
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ForbiddenError, ValidationError } from "@/server/db/scope";
import { createVendor, setVendorStatus, updateVendor, listVendors, getVendor } from "@/server/services/masterData";
import { createPurchaseOrder, transitionPurchaseOrder, createGRN, postGRN, createPurchaseBill, payVendor } from "@/server/services/procurement";

const RUN = Date.now().toString(36);
let orgId: string, A: string;
let sys: AccessContext, owner: AccessContext, admin: AccessContext, mgrA: AccessContext, storeA: AccessContext, foreign: AccessContext;
let kg: string, tomato: string;
let n = 0;
const key = () => `cg-${RUN}-${++n}`;

const member = (role: string, outletId: string): AccessContext => ({ userId: `${role}-${outletId}`, organizationId: orgId, outletIds: [outletId], roles: [role], outletRoles: { [outletId]: [role] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });
const orgWide = (role: string): AccessContext => ({ userId: `${role.toLowerCase()}-${RUN}`, organizationId: orgId, outletIds: [A], roles: [role], outletRoles: {}, orgRoles: [role], isOrgWide: true, isSuperAdmin: false });

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Core gaps ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `CG${RUN}`, name: "CG A", timezone: "Asia/Kolkata" } })).id;
  sys = systemContext(orgId, [A]);
  owner = orgWide("OWNER");
  admin = orgWide("ADMIN");
  mgrA = member("MANAGER", A);
  storeA = member("STORE", A);
  foreign = systemContext((await prisma.organization.create({ data: { name: `CG foreign ${RUN}` } })).id, []);
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  tomato = (await prisma.material.create({ data: { organizationId: orgId, sku: `TOM-${RUN}`, name: `Tomato ${RUN}`, baseUnitId: kg, reorderLevel: 20 } })).id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("MD-16 vendor approval lifecycle", () => {
  it("a new vendor starts PENDING and cannot be bought from until approved", async () => {
    const v = await createVendor(admin, { name: `Fresh Farms ${RUN}`, upiId: "freshfarms@okaxis" });
    expect(v).toMatchObject({ status: "PENDING", active: false });
    await expect(createPurchaseOrder(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 10, rate: 32 }] })).rejects.toThrow(/awaiting approval/);
    await expect(createGRN(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 10, rate: 32 }] })).rejects.toThrow(/awaiting approval/);
    await expect(createPurchaseBill(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 10, rate: 32 }] })).rejects.toThrow(/awaiting approval/);

    // An outlet manager is not an org-wide approver; a STORE login cannot approve either.
    await expect(setVendorStatus(mgrA, v.id, { status: "ACTIVE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setVendorStatus(storeA, v.id, { status: "ACTIVE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setVendorStatus(foreign, v.id, { status: "ACTIVE" })).rejects.toThrow();

    const approved = await setVendorStatus(owner, v.id, { status: "ACTIVE" });
    expect(approved).toMatchObject({ status: "ACTIVE", active: true, approvedById: owner.userId });
    expect(approved.approvedAt).toBeInstanceOf(Date);
    const po = await createPurchaseOrder(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 10, rate: 32 }] });
    expect(po.status).toBe("DRAFT");

    const audit = await prisma.auditLog.findMany({ where: { organizationId: orgId, entityType: "Vendor", entityId: v.id }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action)).toEqual(["CREATE", "APPROVE"]);
  });

  it("blacklisting needs a reason, blocks buying and in-flight POs, and lifting it requires re-approval", async () => {
    const v = await createVendor(admin, { name: `Spice Co ${RUN}` });
    await setVendorStatus(owner, v.id, { status: "ACTIVE" });
    const po = await createPurchaseOrder(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 5, rate: 30 }] });
    // A received delivery is billed while the vendor is still active.
    const grn = await createGRN(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 5, rate: 30 }] });
    await postGRN(owner, grn.id);

    await expect(setVendorStatus(owner, v.id, { status: "BLACKLISTED" })).rejects.toBeInstanceOf(ValidationError);
    const bl = await setVendorStatus(owner, v.id, { status: "BLACKLISTED", reason: "Short deliveries twice" });
    expect(bl).toMatchObject({ status: "BLACKLISTED", active: false, statusReason: "Short deliveries twice" });

    await expect(transitionPurchaseOrder(owner, po.id, "SUBMITTED")).rejects.toThrow(/blacklisted: buying from this vendor is blocked/);
    await expect(createPurchaseOrder(owner, { outletId: A, vendorId: v.id, lines: [{ materialId: tomato, qty: 1, rate: 30 }] })).rejects.toThrow(/blacklisted/);
    // Money already owed for goods received can still be billed and paid.
    const bill = await createPurchaseBill(owner, { outletId: A, vendorId: v.id, grnId: grn.id, lines: [{ materialId: tomato, qty: 5, rate: 30 }] });
    const paid = await payVendor(owner, { outletId: A, vendorId: v.id, billId: bill.id, amount: 150, method: "UPI", reference: "UTR1", idempotencyKey: key() });
    expect(Number(paid.amount)).toBe(150);

    // BLACKLISTED -> ACTIVE directly is illegal; it goes back to PENDING first.
    await expect(setVendorStatus(owner, v.id, { status: "ACTIVE" })).rejects.toThrow(/Illegal vendor status transition/);
    expect((await setVendorStatus(admin, v.id, { status: "PENDING", reason: "Re-evaluating" })).status).toBe("PENDING");
    expect((await setVendorStatus(owner, v.id, { status: "ACTIVE" })).status).toBe("ACTIVE");
  });

  it("the legacy active switch follows the lifecycle; bank and UPI are masked without vendor.manage", async () => {
    const v = await createVendor(admin, { name: `Dairy ${RUN}`, bankAccount: "123456789012", bankIfsc: "HDFC0001234", upiId: "dairy@okhdfc" });
    await expect(updateVendor(admin, v.id, { active: true })).rejects.toThrow(/approve it instead/);
    await setVendorStatus(owner, v.id, { status: "ACTIVE" });
    expect((await updateVendor(admin, v.id, { active: false })).status).toBe("INACTIVE");
    expect((await updateVendor(owner, v.id, { active: true })).status).toBe("ACTIVE");

    const forStore = await getVendor(prisma, storeA, v.id);
    expect(forStore).toMatchObject({ bankAccount: "••••9012", bankIfsc: "••••", upiId: "••••" });
    expect((await getVendor(prisma, admin, v.id)).upiId).toBe("dairy@okhdfc");
    await expect(createVendor(admin, { name: `Bad UPI ${RUN}`, upiId: "not a upi" })).rejects.toThrow();

    const pending = await listVendors(prisma, admin, { status: "PENDING", search: RUN });
    expect(pending.items.every((x) => x.status === "PENDING")).toBe(true);
  });
});
