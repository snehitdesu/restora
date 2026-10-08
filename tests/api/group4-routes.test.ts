/**
 * Group 4 over HTTP (real handlers, sessions, services): menu engineering,
 * department P&L, the stock matrix, the supplier price board and price
 * history, the count variance trend, QR stock labels and a CSV export.
 * Auth (401), RBAC (403: the kitchen never reads vendor prices, costs or
 * margins), tenant scope (another organization's outlet), and values left out
 * of what the kitchen may read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Inventory from "@/app/api/inventory/[[...path]]/route";
import * as Analytics from "@/app/api/analytics/[[...path]]/route";
import * as Procurement from "@/app/api/procurement/[[...path]]/route";
import * as Exports from "@/app/api/exports/[[...path]]/route";

const RUN = Date.now().toString(36);
const SKU = `G4R-${RUN.toUpperCase()}`;
let orgId: string, A: string, rice: string;
let manager: string, kitchen: string, cashier: string, foreign: string;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, json, text };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@g4.test`, name: role, passwordHash: await hashPassword("Group4#Pass123") } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `G4 API ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `G4${RUN}`, name: "G4", timezone: "Asia/Kolkata" } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  rice = (await prisma.material.create({ data: { organizationId: orgId, sku: SKU, name: `=Rice ${RUN}`, baseUnitId: kg } })).id;
  const vendor = (await prisma.vendor.create({ data: { organizationId: orgId, name: `Grains ${RUN}` } })).id;
  await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId: vendor, materialId: rice, lastRate: 52 } });
  await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, materialId: rice, txnType: "PURCHASE_RECEIPT", qty: 100, rate: 50, amount: 5000, sourceRef: `g4-seed-${RUN}` } });
  await prisma.outletMaterialCost.create({ data: { organizationId: orgId, outletId: A, materialId: rice, avgCost: 50, lastCost: 50 } });
  manager = await session(orgId, "MANAGER", A);
  kitchen = await session(orgId, "KITCHEN", A);
  cashier = await session(orgId, "CASHIER", A);
  foreign = await session((await prisma.organization.create({ data: { name: `G4 API other ${RUN}` } })).id, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("costing and menu reads", () => {
  it("menu engineering and department P&L: reports access only; another organization's outlet is not found", async () => {
    const q = { outletId: A };
    expect((await call(Analytics, "GET", "menu-engineering", { query: q })).status).toBe(401);
    expect((await call(Analytics, "GET", "menu-engineering", { token: kitchen, query: q })).status).toBe(403);
    expect((await call(Analytics, "GET", "menu-engineering", { token: cashier, query: q })).status).toBe(403);
    const ok = await call(Analytics, "GET", "menu-engineering", { token: manager, query: q });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ sufficient: false, rows: [] });
    expect((await call(Analytics, "GET", "menu-engineering", { token: foreign, query: q })).status).toBe(404);
    const range = { outletId: A, from: "2026-10-01", to: "2026-10-08" };
    expect((await call(Analytics, "GET", "department-pnl", { token: manager, query: range })).status).toBe(200);
    expect((await call(Analytics, "GET", "department-pnl", { token: kitchen, query: range })).status).toBe(403);
    expect((await call(Analytics, "GET", "count-variance-trend", { token: kitchen, query: q })).status).toBe(403);
    expect((await call(Analytics, "GET", "count-variance-trend", { token: manager, query: q })).status).toBe(200);
  });
});

describe("inventory reads", () => {
  it("the stock matrix gives the kitchen quantities without values", async () => {
    const asKitchen = await call(Inventory, "GET", "matrix", { token: kitchen, query: { outletId: A } });
    expect(asKitchen.status).toBe(200);
    expect(asKitchen.json.data.showValue).toBe(false);
    expect(JSON.stringify(asKitchen.json.data)).not.toMatch(/"value"|"avgCost"|"totalValue"/);
    const asManager = await call(Inventory, "GET", "matrix", { token: manager, query: { outletId: A } });
    expect(asManager.json.data.rows[0]).toMatchObject({ total: 100, value: 5000 });
  });

  it("stock labels: the sheet carries SKUs; a scan resolves within the organization, without values for the kitchen", async () => {
    const sheet = await call(Inventory, "GET", "labels", { token: kitchen, query: { outletId: A } });
    expect(sheet.json.data).toEqual([expect.objectContaining({ sku: SKU, payload: `RESTORA-STOCK:${SKU}` })]);
    const scan = await call(Inventory, "GET", "labels/lookup", { token: kitchen, query: { outletId: A, code: `RESTORA-STOCK:${SKU}` } });
    expect(scan.status).toBe(200);
    expect(scan.json.data).toMatchObject({ materialId: rice, onHand: 100 });
    expect(scan.json.data).not.toHaveProperty("value");
    expect((await call(Inventory, "GET", "labels/lookup", { token: manager, query: { outletId: A, code: SKU } })).json.data.value).toBe(5000);
    expect((await call(Inventory, "GET", "labels/lookup", { token: manager, query: { outletId: A, code: "RESTORA-STOCK:NOPE" } })).status).toBe(404);
    expect((await call(Inventory, "GET", "labels/lookup", { token: foreign, query: { outletId: A, code: SKU } })).status).toBe(404);
    expect((await call(Inventory, "GET", "labels/lookup", { query: { outletId: A, code: SKU } })).status).toBe(401);
  });
});

describe("vendor pricing", () => {
  it("the supplier board and price history need purchase access: never the kitchen or a cashier", async () => {
    const board = await call(Procurement, "GET", "supplier-prices", { token: manager, query: { outletId: A } });
    expect(board.status).toBe(200);
    expect(board.json.data.rows[0].quotes[0]).toMatchObject({ ratePerBase: 52, buyable: true, cheapest: true });
    for (const t of [kitchen, cashier]) {
      expect((await call(Procurement, "GET", "supplier-prices", { token: t, query: { outletId: A } })).status).toBe(403);
      expect((await call(Procurement, "GET", "price-history", { token: t, query: { outletId: A, materialId: rice } })).status).toBe(403);
    }
    expect((await call(Procurement, "GET", "supplier-prices", { token: foreign, query: { outletId: A } })).status).toBe(404);
    const h = await call(Procurement, "GET", "price-history", { token: manager, query: { outletId: A, materialId: rice, from: "2026-01-01" } });
    expect(h.status).toBe(200);
    expect(h.json.data.receipts).toHaveLength(1);
  });
});

describe("tenant guard on every route", () => {
  it("an owner of another organization cannot write into this organization's outlet (404, nothing created)", async () => {
    // A stock count needs nothing but an outlet: before the guard, an org-wide owner of another organization
    // could create one (owned by THEIR organization) on this outlet, because the role passes every outlet check.
    const before = await prisma.stockCount.count({ where: { outletId: A } });
    const res = await call(Inventory, "POST", "counts", { token: foreign, body: { outletId: A } });
    expect(res.status).toBe(404);
    expect(await prisma.stockCount.count({ where: { outletId: A } })).toBe(before);
    // The same request from this organization's manager works: the guard checks ownership, not the body shape.
    expect((await call(Inventory, "POST", "counts", { token: manager, body: { outletId: A } })).status).toBe(200);
    expect(await prisma.stockCount.count({ where: { outletId: A } })).toBe(before + 1);
  });
});

describe("exports", () => {
  it("a supplier price CSV over HTTP neutralises a formula in a material name", async () => {
    const res = await call(Exports, "POST", "", { token: manager, body: { report: "SUPPLIER_PRICES", filters: { outletId: A } } });
    expect(res.status).toBe(200);
    const [header, line] = res.text.split("\r\n");
    expect(header.startsWith("Material,SKU,Base unit,Vendor")).toBe(true);
    expect(line.startsWith(`'=Rice ${RUN}`)).toBe(true);
    expect((await call(Exports, "POST", "", { token: kitchen, body: { report: "SUPPLIER_PRICES", filters: { outletId: A } } })).status).toBe(403);
  });
});
