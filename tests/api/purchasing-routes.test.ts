/**
 * The purchasing rules, line review, expiry list, master-data import and vendor contacts over HTTP (real handlers, sessions,
 * services): 401 without a session, 403 for roles without the permission, 404 across organizations, 422 for bad input, the
 * password step-up for changing the rules, and the shape of each answer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/constants/auth";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/server/services/procurement";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";
import * as Inventory from "@/app/api/inventory/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";
import { makeEnv, uniq, type Env } from "../domain/growthSupport";
import { call, sessionFor } from "./routeSupport";

const PW = "Purchasing#Pass123";
let env: Env;
let vendor: string;
let flour: string;
let kgCode: string;
const s: Record<string, string> = {};

async function ownerSession() {
  const u = await prisma.user.create({ data: { organizationId: env.orgId, email: `owner-${uniq()}@pur.test`, name: "Owner", passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: env.orgId, userId: u.id, outletId: null, role: "OWNER" } });
  return (await createSession(prisma, u.id)).token;
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.7`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}
async function submittedOrder(qty = 2) {
  const made = await createPurchaseOrder(env.owner, { outletId: env.outletA, vendorId: vendor, number: `PO-RT-${uniq()}`, lines: [{ materialId: flour, qty, rate: 100, taxPct: 0 }, { materialId: flour, qty: 1, rate: 50, taxPct: 0 }] });
  await transitionPurchaseOrder(env.owner, made.id, "SUBMITTED");
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.id }, include: { lines: { orderBy: { id: "asc" } } } });
}

beforeAll(async () => {
  env = await makeEnv("Gpt");
  kgCode = `kg${uniq()}`;
  const unit = await prisma.unit.create({ data: { organizationId: env.orgId, code: kgCode, name: "Kilogram", kind: "WEIGHT" } });
  flour = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `FL-${uniq()}`, name: "Flour", baseUnitId: unit.id } })).id;
  vendor = (await prisma.vendor.create({ data: { organizationId: env.orgId, name: `Vendor ${uniq()}`, status: "ACTIVE", active: true } })).id;
  s.owner = await ownerSession();
  s.manager = await sessionFor(env.orgId, "MANAGER", env.outletA);
  s.store = await sessionFor(env.orgId, "STORE", env.outletA);
  s.kitchen = await sessionFor(env.orgId, "KITCHEN", env.outletA);
  s.cashier = await sessionFor(env.orgId, "CASHIER", env.outletA);
  s.foreign = await sessionFor((await prisma.organization.create({ data: { name: `Other ${uniq()}` } })).id, "OWNER", null);
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("/api/procurement/rules", () => {
  it("buyers and approvers read the rules; the kitchen and strangers cannot; no session is a 401", async () => {
    expect((await call(Procurement, "GET", "rules")).status).toBe(401);
    expect((await call(Procurement, "GET", "rules", { session: s.kitchen })).status).toBe(403);
    expect((await call(Procurement, "GET", "rules", { session: s.cashier })).status).toBe(403);
    for (const role of ["store", "manager", "owner"]) {
      const r = await call(Procurement, "GET", "rules", { session: s[role] });
      expect(r.status, role).toBe(200);
      expect(r.json.data).toHaveProperty("autoApproveBelow");
    }
  });

  it("changing them needs the owner and a fresh password; bad amounts are a 422", async () => {
    const body = { autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 };
    expect((await call(Procurement, "POST", "rules", { body })).status).toBe(401);
    // A manager may read but cannot change: no org.manage (and no fresh password either).
    expect((await call(Procurement, "POST", "rules", { session: s.manager, body })).status).toBe(403);
    const stale = await call(Procurement, "POST", "rules", { session: s.owner, body });
    expect([stale.status, stale.json.error.code]).toEqual([403, "ReauthRequiredError"]);
    expect(await reauth(s.owner, "settings.manage")).toBe(200);
    const bad = await call(Procurement, "POST", "rules", { session: s.owner, body: { autoApproveBelow: 6000, dualApprovalAtOrAbove: 5000 } });
    expect(bad.status).toBe(422);
    expect((await call(Procurement, "POST", "rules", { session: s.owner, body: { autoApproveBelow: -5 } })).status).toBe(422);
    expect((await call(Procurement, "POST", "rules", { session: s.owner, body: { surprise: 1 } })).status).toBe(422);
    const ok = await call(Procurement, "POST", "rules", { session: s.owner, body });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toEqual(body);
    expect((await call(Procurement, "GET", "rules", { session: s.store })).json.data).toEqual(body);
    // Another organization has its own (empty) rules.
    expect((await call(Procurement, "GET", "rules", { session: s.foreign })).json.data).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: null });
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "ProcurementSettings" }, orderBy: { createdAt: "desc" } });
    expect(audit?.action).toBe("UPDATE");
  });
});

describe("POST /api/procurement/purchase-orders/:id/review", () => {
  it("an approver changes a quantity and takes a line off; the answer carries the recomputed order", async () => {
    const po = await submittedOrder(10); // ₹1,050: above the small-order limit set earlier, below the two-approver one
    const [a, b] = po.lines;
    const path = `purchase-orders/${po.id}/review`;
    const body = { lines: [{ lineId: a.id, action: "KEEP", qty: 2 }, { lineId: b.id, action: "REJECT" }], note: "too much" };
    expect((await call(Procurement, "POST", path, { body })).status).toBe(401);
    for (const role of ["store", "kitchen", "cashier"]) expect((await call(Procurement, "POST", path, { session: s[role], body })).status, role).toBe(403);
    expect((await call(Procurement, "POST", path, { session: s.foreign, body })).status).toBe(404);
    expect((await call(Procurement, "POST", path, { session: s.manager, body: { lines: [] } })).status).toBe(422);
    expect((await call(Procurement, "POST", path, { session: s.manager, body: { lines: [{ lineId: a.id, action: "SKIP" }] } })).status).toBe(422);
    expect((await call(Procurement, "POST", path, { session: s.manager, body: { lines: [{ lineId: a.id, action: "REJECT" }, { lineId: b.id, action: "REJECT" }] } })).status).toBe(422); // at least one line must stay
    const r = await call(Procurement, "POST", path, { session: s.manager, body });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { id: "asc" } } } });
    expect(Number(after.total)).toBe(200);
    expect(after.lines.map((l) => l.lineStatus)).toEqual(["ACTIVE", "REJECTED"]);
    expect(Number(after.lines[0].requestedQty)).toBe(10);
  });
});

describe("GET /api/inventory/expiring", () => {
  it("lists what is about to expire for the outlet; needs inventory.view and a real outlet", async () => {
    const query = `expiring?outletId=${env.outletA}&days=14`;
    expect((await call(Inventory, "GET", query)).status).toBe(401);
    expect((await call(Inventory, "GET", `expiring?outletId=${env.outletA}`, { session: s.cashier })).status).toBe(403);
    expect((await call(Inventory, "GET", "expiring", { session: s.store })).status).toBe(422); // outlet is required
    expect((await call(Inventory, "GET", `expiring?outletId=${env.outletA}&days=9999`, { session: s.store })).status).toBe(422);
    expect((await call(Inventory, "GET", query, { session: s.foreign })).status).toBeGreaterThanOrEqual(403);
    await prisma.inventoryLedger.create({ data: { organizationId: env.orgId, outletId: env.outletA, materialId: flour, txnType: "PURCHASE_RECEIPT", qty: 10, rate: 20, amount: 200, sourceRef: `exp-${uniq()}`, batchNo: "B-1", fssaiLot: "FSSAI-77", expiryDate: new Date(Date.now() + 2 * 86_400_000) } });
    const r = await call(Inventory, "GET", query, { session: s.store });
    expect(r.status).toBe(200);
    expect(r.json.data.counts.soon + r.json.data.counts.today).toBe(1);
    expect(r.json.data.rows[0]).toMatchObject({ batchNo: "B-1", fssaiLot: "FSSAI-77" });
    expect(r.json.data.basis).toMatch(/earliest expiry/);
    expect(JSON.stringify(r.json.data)).not.toMatch(/rate|amount|cost/i); // quantities only
  });
});

describe("POST /api/master/import/:kind", () => {
  it("checks without writing, then imports; only organization-wide managers of master data may", async () => {
    const csv = `Name,SKU,Unit,Category\nImport Rt A,IRT-${uniq()},${kgCode},Spices\nImport Rt B,IRT-${uniq()},${kgCode},Spices\n`;
    expect((await call(Master, "POST", "import/materials", { body: { csv } })).status).toBe(401);
    for (const role of ["manager", "store", "cashier", "kitchen"]) expect((await call(Master, "POST", "import/materials", { session: s[role], body: { csv } })).status, role).toBe(403);
    expect((await call(Master, "POST", "import/materials", { session: s.foreign, body: { csv } })).status).toBe(200); // its own organization has no such unit: every row is an error, nothing is written
    expect((await call(Master, "POST", "import/plants", { session: s.owner, body: { csv } })).status).toBe(422);
    expect((await call(Master, "POST", "import/materials", { session: s.owner, body: { csv: "" } })).status).toBe(422);
    expect((await call(Master, "POST", "import/materials", { session: s.owner, body: { csv, commit: "yes" } })).status).toBe(422);

    const dry = await call(Master, "POST", "import/materials", { session: s.owner, body: { csv } });
    expect(dry.status).toBe(200);
    expect(dry.json.data).toMatchObject({ committed: false, counts: { create: 2, skip: 0, error: 0 }, newCategories: ["Spices"] });
    expect(await prisma.material.count({ where: { organizationId: env.orgId, name: { startsWith: "Import Rt" } } })).toBe(0);

    const done = await call(Master, "POST", "import/materials", { session: s.owner, body: { csv, commit: true } });
    expect(done.status).toBe(200);
    expect(done.json.data).toMatchObject({ committed: true, counts: { create: 2 } });
    expect(await prisma.material.count({ where: { organizationId: env.orgId, name: { startsWith: "Import Rt" } } })).toBe(2);
    const again = await call(Master, "POST", "import/materials", { session: s.owner, body: { csv, commit: true } });
    expect(again.json.data).toMatchObject({ committed: false, counts: { create: 0, skip: 2 } });

    const bad = await call(Master, "POST", "import/materials", { session: s.owner, body: { csv: `Name,Unit\nFine,${kgCode}\nBroken,nope\n`, commit: true } });
    expect(bad.json.data).toMatchObject({ committed: false, counts: { create: 1, error: 1 } });
    expect(await prisma.material.count({ where: { organizationId: env.orgId, name: "Fine" } })).toBe(0); // all or nothing
  });

  it("vendors come in pending, awaiting an approver", async () => {
    const r = await call(Master, "POST", "import/vendors", { session: s.owner, body: { csv: `Name,Phone\nImport Vendor ${uniq()},9876543210\n`, commit: true } });
    expect(r.status).toBe(200);
    expect(r.json.data.committed).toBe(true);
    const v = await prisma.vendor.findFirstOrThrow({ where: { organizationId: env.orgId, name: { startsWith: "Import Vendor" } } });
    expect(v.status).toBe("PENDING");
    expect(v.active).toBe(false);
  });
});

describe("vendor contacts", () => {
  it("add, list, change and remove; tenant-scoped; the first contact is the main one", async () => {
    const base = `vendors/${vendor}/contacts`;
    expect((await call(Master, "GET", base)).status).toBe(401);
    expect((await call(Master, "POST", base, { session: s.manager, body: { name: "Meera" } })).status).toBe(403);
    expect((await call(Master, "POST", base, { session: s.foreign, body: { name: "Meera" } })).status).toBe(404);
    expect((await call(Master, "POST", base, { session: s.owner, body: { name: "" } })).status).toBe(422);
    expect((await call(Master, "POST", base, { session: s.owner, body: { name: "Meera", phone: "abc" } })).status).toBe(422);
    expect((await call(Master, "POST", base, { session: s.owner, body: { name: "Meera", extra: 1 } })).status).toBe(422);
    const first = await call(Master, "POST", base, { session: s.owner, body: { name: "Meera", role: "Accounts", phone: "+91 98765 43210", email: "Meera@Example.com" } });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ name: "Meera", isPrimary: true, email: "meera@example.com" });
    const second = await call(Master, "POST", base, { session: s.owner, body: { name: "Rahul", role: "Delivery", isPrimary: true } });
    expect(second.json.data.isPrimary).toBe(true);
    const list = await call(Master, "GET", base, { session: s.manager });
    expect(list.status).toBe(200);
    expect(list.json.data.map((c: { name: string; isPrimary: boolean }) => [c.name, c.isPrimary])).toEqual([["Rahul", true], ["Meera", false]]); // one main contact at a time
    expect((await call(Master, "PATCH", `vendor-contacts/${first.json.data.id}`, { session: s.foreign, body: { role: "x" } })).status).toBe(404);
    expect((await call(Master, "PATCH", `vendor-contacts/${first.json.data.id}`, { session: s.owner, body: { role: "Finance" } })).json.data.role).toBe("Finance");
    expect((await call(Master, "DELETE", `vendor-contacts/${second.json.data.id}`, { session: s.manager })).status).toBe(403);
    expect((await call(Master, "DELETE", `vendor-contacts/${second.json.data.id}`, { session: s.owner })).status).toBe(200);
    expect((await call(Master, "GET", base, { session: s.owner })).json.data).toHaveLength(1);
  });
});
