/**
 * Group 2 reorder engine over HTTP (real handlers, sessions, services):
 * GET /api/procurement/reorder and POST reorder/purchase-orders | reorder/indents.
 * Auth (401), RBAC (403), malformed query / body / missing Idempotency-Key (400),
 * business validation incl. the Group 1 vendor gate (422), stale screen and key
 * reuse (409), replay, and the response shape.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";

const RUN = Date.now().toString(36);
let orgId: string, A: string, kg: string, kase: string, vendor: string, pendingVendor: string, paneer: string, salt: string;
let manager: string, store: string, kitchen: string, accountant: string, foreign: string;
let n = 0;
const key = () => `rr-${RUN}-${++n}`;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(method: string, path: string, opts: { token?: string; body?: unknown; key?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/procurement/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (Procurement as unknown as Mod)[method](req, { params: Promise.resolve({ path: path.split("/") }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@ro.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Reorder API ${RUN}` } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RR${RUN}`, name: "RR" } })).id;
  kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg", kind: "WEIGHT" } })).id;
  kase = (await prisma.unit.create({ data: { organizationId: orgId, code: `case${RUN}`, name: "case", kind: "COUNT" } })).id;
  vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RR vendor ${RUN}` } })).id;
  pendingVendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `RR pending ${RUN}`, status: "PENDING", active: false } })).id;
  paneer = (await prisma.material.create({ data: { organizationId: orgId, sku: `RR-P-${RUN}`, name: `Paneer ${RUN}`, baseUnitId: kg, purchaseUnitId: kase, reorderLevel: 10, parLevel: 24 } })).id;
  salt = (await prisma.material.create({ data: { organizationId: orgId, sku: `RR-S-${RUN}`, name: `Salt ${RUN}`, baseUnitId: kg, reorderLevel: 2, parLevel: 5 } })).id;
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: kase, toUnitId: kg, factor: 12, materialId: paneer } });
  await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId: vendor, materialId: paneer, lastRate: 100, leadTimeDays: 0 } });
  await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId: pendingVendor, materialId: salt, lastRate: 20, preferred: true } });
  manager = await session(orgId, "MANAGER", A);
  store = await session(orgId, "STORE", A);
  kitchen = await session(orgId, "KITCHEN", A);
  accountant = await session(orgId, "ACCOUNTANT", A);
  const org2 = (await prisma.organization.create({ data: { name: `Reorder API 2 ${RUN}` } })).id;
  foreign = await session(org2, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("GET /api/procurement/reorder", () => {
  it("401 / 403 / 400 / 200 with the full row shape", async () => {
    expect((await call("GET", "reorder", { query: { outletId: A } })).status).toBe(401);
    expect((await call("GET", "reorder", { token: kitchen, query: { outletId: A } })).status).toBe(403);
    expect((await call("GET", "reorder", { token: foreign, query: { outletId: A } })).status).toBe(404);
    expect((await call("GET", "reorder", { token: store })).status).toBe(400);
    for (const q of [{ asOf: "garbage" }, { asOf: new Date(Date.now() + 3_600_000).toISOString() }, { lookbackDays: "3" }, { lookbackDays: "x" }] as Array<Record<string, string>>) {
      const r = await call("GET", "reorder", { token: store, query: { outletId: A, ...q } });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("BadRequestError");
    }
    expect((await call("GET", "reorder", { token: accountant, query: { outletId: A } })).status).toBe(200);

    const res = await call("GET", "reorder", { token: store, query: { outletId: A, lookbackDays: "14" } });
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d).toMatchObject({ outletId: A, lookbackDays: 14, summary: { items: 2, critical: 2, noVendor: 1 } });
    expect(Date.parse(d.asOf)).toBeLessThanOrEqual(Date.now());
    const p = d.rows.find((r: { materialId: string }) => r.materialId === paneer);
    expect(p).toMatchObject({
      priority: "CRITICAL", onHand: 0, incoming: 0, reorderPoint: 10, target: 24, suggestedBaseQty: 24, leadTimeDays: 1,
      order: { unitId: kase, qty: 2, packFactor: 12 }, poRate: 1200,
      vendor: { id: vendor, rate: 100, leadTimeDays: 0, selectedBecause: "ONLY_ELIGIBLE" },
      incomingDocs: [], includesDrafts: false, blockedVendorNote: null,
    });
    const s = d.rows.find((r: { materialId: string }) => r.materialId === salt);
    expect(s).toMatchObject({ vendor: null, alternatives: [], blockedVendorNote: expect.stringMatching(/awaiting approval/) });
    expect(s.reasons).toEqual(expect.arrayContaining(["NO_VENDOR", "PREFERRED_VENDOR_BLOCKED"]));
    expect(d.needsSetup).toEqual(expect.arrayContaining([expect.objectContaining({ materialId: salt, reason: "NO_ELIGIBLE_VENDOR" })]));
  });
});

describe("POST /api/procurement/reorder/purchase-orders and /indents", () => {
  const poBody = (asOf: string, extra: object = {}) => ({ outletId: A, asOf, lines: [{ materialId: paneer, vendorId: vendor, qty: 2, unitId: kase, expectedIncoming: 0 }], ...extra });

  it("400 without a key or with a malformed body; 403 without purchase.create; 422 for an unapproved vendor", async () => {
    const asOf = new Date().toISOString();
    expect((await call("POST", "reorder/purchase-orders", { token: store, body: poBody(asOf) })).status).toBe(400);
    expect((await call("POST", "reorder/indents", { token: store, body: { outletId: A, asOf, lines: [{ materialId: salt, qty: 5, expectedIncoming: 0 }] } })).status).toBe(400);
    expect((await call("POST", "reorder/purchase-orders", { token: store, key: key(), body: { outletId: A, asOf, lines: [] } })).status).toBe(400);
    expect((await call("POST", "reorder/purchase-orders", { token: store, key: key(), body: poBody("2026-99-99") })).status).toBe(400);
    expect((await call("POST", "reorder/purchase-orders", { token: accountant, key: key(), body: poBody(asOf) })).status).toBe(403);
    expect((await call("POST", "reorder/purchase-orders", { token: kitchen, key: key(), body: poBody(asOf) })).status).toBe(403);
    const blocked = await call("POST", "reorder/purchase-orders", { token: manager, key: key(), body: { outletId: A, asOf, lines: [{ materialId: salt, vendorId: pendingVendor, qty: 5, rate: 20, expectedIncoming: 0 }] } });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error.message).toMatch(/awaiting approval/);
    expect(await prisma.purchaseOrder.count({ where: { organizationId: orgId } })).toBe(0);
  });

  it("200 creates DRAFT POs in purchase units at base rate x factor; replay; 409 on key reuse and on a stale screen", async () => {
    const asOf = new Date().toISOString();
    const k = key();
    const first = await call("POST", "reorder/purchase-orders", { token: store, key: k, body: poBody(asOf) });
    expect(first.status).toBe(200);
    expect(first.json.data.replayed).toBe(false);
    const [p] = first.json.data.purchaseOrders;
    expect(p).toMatchObject({ status: "DRAFT", source: "REORDER", vendorId: vendor });
    expect(p.lines[0]).toMatchObject({ unitId: kase });
    expect(Number(p.lines[0].qty)).toBe(2);
    expect(Number(p.lines[0].rate)).toBe(1200);
    const again = await call("POST", "reorder/purchase-orders", { token: store, key: k, body: poBody(asOf) });
    expect(again.json.data).toMatchObject({ replayed: true, purchaseOrders: [{ id: p.id }] });
    expect((await call("POST", "reorder/purchase-orders", { token: store, key: k, body: poBody(asOf, { notes: "other" }) })).status).toBe(409);
    const stale = await call("POST", "reorder/purchase-orders", { token: manager, key: key(), body: poBody(asOf) });
    expect(stale.status).toBe(409);
    expect(stale.json.error.message).toMatch(/ordered since you loaded this screen/);
    expect(stale.json.error.details.changed[0]).toMatchObject({ materialId: paneer, expectedIncoming: 0, incoming: 24 });

    // The screen now shows the draft PO as incoming (visible, never silently hidden).
    const screen = await call("GET", "reorder", { token: store, query: { outletId: A } });
    expect(screen.json.data.rows.find((r: { materialId: string }) => r.materialId === paneer)).toBeUndefined();
  });

  it("purchase request for an item with no eligible vendor; department must belong to the outlet", async () => {
    const asOf = new Date().toISOString();
    const other = (await prisma.outlet.create({ data: { organizationId: orgId, code: `RR2${RUN}`, name: "RR2" } })).id;
    const dept = (await prisma.department.create({ data: { organizationId: orgId, outletId: other, name: "Elsewhere" } })).id;
    const bad = await call("POST", "reorder/indents", { token: store, key: key(), body: { outletId: A, asOf, departmentId: dept, lines: [{ materialId: salt, qty: 5, expectedIncoming: 0 }] } });
    expect(bad.status).toBe(422);
    const ok = await call("POST", "reorder/indents", { token: store, key: key(), body: { outletId: A, asOf, lines: [{ materialId: salt, qty: 5, expectedIncoming: 0 }] } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ replayed: false, indent: { status: "DRAFT", source: "REORDER" } });
    const screen = await call("GET", "reorder", { token: store, query: { outletId: A } });
    expect(screen.json.data.rows.find((r: { materialId: string }) => r.materialId === salt)).toBeUndefined();
  });
});
