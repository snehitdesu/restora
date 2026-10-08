/**
 * Group 3 over HTTP (real handlers, sessions, services): the money desk,
 * deposits, close / reopen (step-up re-auth), the production worksheet,
 * worksheet wastage, production batches, the manual sales log, the
 * consumption-variance report and the batch-produced flag on recipes.
 * Auth (401), RBAC (403), tenant scope (404), validation (422), required
 * Idempotency-Key, replay, a closed day (409) and an impossible date (422, not 500).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { hashPassword } from "@/server/auth/password";
import { SESSION_COOKIE } from "@/constants/auth";
import * as Finance from "@/app/api/finance/[[...path]]/route";
import * as Inventory from "@/app/api/inventory/[[...path]]/route";
import * as Analytics from "@/app/api/analytics/[[...path]]/route";
import * as Recipes from "@/app/api/recipes/[[...path]]/route";
import { POST as reauthRoute } from "@/app/api/auth/reauth/route";
import { businessDayRange } from "@/domain/time";

const RUN = Date.now().toString(36);
const PW = "Group3#Pass123";
const TZ = "Asia/Kolkata";
let orgId: string, A: string, dish: string, mRice: string, prepRecipe: string;
let manager: string, cashier: string, kitchen: string, owner: string, foreign: string;
let n = 0;
const key = () => `g3-${RUN}-${++n}`;
const today = () => businessDayRange(new Date(), TZ).date;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { token?: string; body?: unknown; key?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost" };
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.key) headers["idempotency-key"] = opts.key;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 6)}@g3.test`, name: role, passwordHash: await hashPassword(PW) } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}
async function reauth(token: string, scope: string) {
  const req = new NextRequest("http://localhost/api/auth/reauth", { method: "POST", body: JSON.stringify({ password: PW, scope }), headers: { host: "localhost", "x-forwarded-for": `10.33.${Math.floor(Math.random() * 250)}.7`, cookie: `${SESSION_COOKIE}=${token}` } });
  return (await reauthRoute(req)).status;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `G3 API ${RUN}`, timezone: TZ } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `G3${RUN}`, name: "G3", timezone: TZ } })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  mRice = (await prisma.material.create({ data: { organizationId: orgId, sku: `G3R-${RUN}`, name: `Rice ${RUN}`, baseUnitId: kg } })).id;
  const mPrep = (await prisma.material.create({ data: { organizationId: orgId, sku: `G3P-${RUN}`, name: `Rice prep ${RUN}`, baseUnitId: kg } })).id;
  dish = (await prisma.menuItem.create({ data: { organizationId: orgId, name: `Bowl ${RUN}`, price: 100, taxPct: 0, station: "KITCHEN" } })).id;
  const recipe = await prisma.recipe.create({ data: { organizationId: orgId, name: `Bowl r ${RUN}`, outputType: "MENU_ITEM", menuItemId: dish } });
  const v = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: 1 } });
  await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: v.id, componentType: "MATERIAL", materialId: mRice, qty: 0.2 } });
  const prep = await prisma.recipe.create({ data: { organizationId: orgId, name: `Prep r ${RUN}`, outputType: "SUB_RECIPE", outputMaterialId: mPrep } });
  const pv = await prisma.recipeVersion.create({ data: { organizationId: orgId, recipeId: prep.id, version: 1, status: "APPROVED", yieldQty: 1 } });
  await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: pv.id, componentType: "MATERIAL", materialId: mRice, qty: 1 } });
  prepRecipe = prep.id;
  await prisma.inventoryLedger.create({ data: { organizationId: orgId, outletId: A, materialId: mRice, txnType: "PURCHASE_RECEIPT", qty: 100, rate: 50, amount: 5000, sourceRef: `g3-seed-${RUN}` } });
  await prisma.outletMaterialCost.create({ data: { organizationId: orgId, outletId: A, materialId: mRice, avgCost: 50, lastCost: 50 } });
  manager = await session(orgId, "MANAGER", A);
  cashier = await session(orgId, "CASHIER", A);
  kitchen = await session(orgId, "KITCHEN", A);
  owner = await session(orgId, "OWNER", null);
  foreign = await session((await prisma.organization.create({ data: { name: `G3 API other ${RUN}` } })).id, "OWNER", null);
});

afterAll(async () => { await prisma.$disconnect(); });

describe("kitchen production routes", () => {
  it("worksheet, worksheet wastage, batches and the manual sales log", async () => {
    const q = { outletId: A, businessDate: today() };
    expect((await call(Inventory, "GET", "worksheet", { query: q })).status).toBe(401);
    expect((await call(Inventory, "GET", "worksheet", { token: foreign, query: q })).status).toBe(404);
    expect((await call(Inventory, "GET", "worksheet", { token: kitchen, query: { ...q, businessDate: "2026-02-30" } })).status).toBe(422);
    expect((await call(Inventory, "POST", "worksheet", { token: cashier, body: { ...q, menuItemId: dish, preparedQty: 5 } })).status).toBe(403);
    expect((await call(Inventory, "POST", "worksheet", { token: kitchen, body: { ...q, menuItemId: dish, preparedQty: 5, extra: 1 } })).status).toBe(422);
    expect((await call(Inventory, "POST", "worksheet", { token: kitchen, body: { ...q, menuItemId: dish, preparedQty: 5 } })).status).toBe(200);

    const wbody = { ...q, menuItemId: dish, qty: 1 };
    expect((await call(Inventory, "POST", "worksheet/wastage", { token: kitchen, body: wbody })).status).toBe(422); // no key
    const k = key();
    const w1 = await call(Inventory, "POST", "worksheet/wastage", { token: kitchen, body: wbody, key: k });
    const w2 = await call(Inventory, "POST", "worksheet/wastage", { token: kitchen, body: wbody, key: k });
    expect(w1.status).toBe(200);
    expect(w1.json.data).toMatchObject({ posted: true });
    expect(w1.json.data.totalCost).toBeUndefined();
    expect(w1.json.data.wastage.lines[0].estCost).toBeNull();
    expect(w2.json.data.wastage.id).toBe(w1.json.data.wastage.id);

    const ms = { ...q, lines: [{ menuItemId: dish, qty: 2 }] };
    const m1 = await call(Inventory, "POST", "manual-sales", { token: kitchen, body: ms, key: key() });
    expect(m1.status).toBe(200);
    const sheet = await call(Inventory, "GET", "worksheet", { token: kitchen, query: q });
    expect(sheet.json.data.rows[0]).toMatchObject({ prepared: 5, sold: 2, wasted: 1, variance: 2 });
    expect(sheet.json.data.rows[0].plateCost).toBeUndefined();
    const forManager = await call(Inventory, "GET", "worksheet", { token: manager, query: q });
    expect(forManager.json.data.rows[0]).toMatchObject({ plateCost: 10, varianceCost: 20 });

    // Batches: the batch-produced flag is org-wide; a double submit is one batch.
    expect((await call(Inventory, "POST", "production", { token: kitchen, body: { outletId: A, recipeId: prepRecipe, plannedQty: 1 }, key: key() })).status).toBe(422);
    expect((await call(Recipes, "POST", `${prepRecipe}/stocked`, { token: manager, body: { stocked: true } })).status).toBe(403);
    expect((await call(Recipes, "POST", `${prepRecipe}/stocked`, { token: owner, body: { stocked: true } })).status).toBe(200);
    const bk = key();
    const b1 = await call(Inventory, "POST", "production", { token: kitchen, body: { outletId: A, recipeId: prepRecipe, plannedQty: 1.5 }, key: bk });
    const b2 = await call(Inventory, "POST", "production", { token: kitchen, body: { outletId: A, recipeId: prepRecipe, plannedQty: 1.5 }, key: bk });
    expect(b1.status).toBe(200);
    expect(b2.json.data).toMatchObject({ id: b1.json.data.id, replayed: true });
  });

  it("the variance report needs reports access", async () => {
    expect((await call(Analytics, "GET", "consumption-variance", { token: kitchen, query: { outletId: A } })).status).toBe(403);
    const r = await call(Analytics, "GET", "consumption-variance", { token: manager, query: { outletId: A, from: today(), to: today() } });
    expect(r.status).toBe(200);
    expect(r.json.data.rows.find((x: { materialId: string }) => x.materialId === mRice)).toMatchObject({ expectedQty: 0.4, wastageQty: 0.2 });
    expect(r.json.data.leakage).toHaveProperty("leakage");
  });
});

describe("money desk routes", () => {
  it("read, declare, deposit, close (409 after), reopen behind re-auth", async () => {
    const q = { outletId: A, businessDate: today() };
    expect((await call(Finance, "GET", "money-desk", { query: q })).status).toBe(401);
    expect((await call(Finance, "GET", "money-desk", { token: kitchen, query: q })).status).toBe(403);
    expect((await call(Finance, "GET", "money-desk", { token: foreign, query: q })).status).toBe(404);
    expect((await call(Finance, "GET", "money-desk", { token: manager, query: { ...q, businessDate: "2026-02-30" } })).status).toBe(422);
    const d = await call(Finance, "GET", "money-desk", { token: cashier, query: q });
    expect(d.status).toBe(200);
    expect(d.json.data).toMatchObject({ status: "OPEN", channels: [{ key: "DINE_IN", billed: 200 }] });

    expect((await call(Finance, "POST", "money-desk/declare", { token: cashier, body: { ...q, declared: [{ channel: "DINE_IN", amount: 200 }] } })).status).toBe(403);
    expect((await call(Finance, "POST", "money-desk/declare", { token: manager, body: { ...q, declared: [{ channel: "DINE_IN", amount: 200.001 }] } })).status).toBe(422);
    expect((await call(Finance, "POST", "money-desk/declare", { token: manager, body: { ...q, declared: [{ channel: "DINE_IN", amount: 200 }] } })).status).toBe(200);
    expect((await call(Finance, "POST", "reconciliations/daily", { token: manager, body: { ...q, actuals: [{ method: "CASH", actual: 0 }] } })).status).toBe(200);

    const dep = { ...q, method: "CASH", amount: 0, reference: "SLIP-0", depositedAt: new Date().toISOString() };
    expect((await call(Finance, "POST", "money-desk/deposits", { token: manager, body: { ...dep, amount: 50 } })).status).toBe(422); // no key
    expect((await call(Finance, "POST", "money-desk/deposits", { token: manager, body: dep, key: key() })).status).toBe(422); // zero
    const k = key();
    const d1 = await call(Finance, "POST", "money-desk/deposits", { token: manager, body: { ...dep, amount: 50 }, key: k });
    const d2 = await call(Finance, "POST", "money-desk/deposits", { token: manager, body: { ...dep, amount: 50 }, key: k });
    expect(d1.status).toBe(200);
    expect(d2.json.data).toMatchObject({ id: d1.json.data.id, replayed: true });
    const denied = await call(Finance, "POST", `money-desk/deposits/${d1.json.data.id}/void`, { token: manager, body: { reason: "wrong slip" } });
    expect([denied.status, denied.json.error.code]).toEqual([403, "ReauthRequiredError"]);

    expect((await call(Finance, "POST", "money-desk/close", { token: cashier, body: q })).status).toBe(403);
    const closed = await call(Finance, "POST", "money-desk/close", { token: manager, body: q });
    expect(closed.status).toBe(200);
    expect(closed.json.data.close).toMatchObject({ revision: 1, status: "CLOSED" });
    expect((await call(Finance, "POST", "money-desk/close", { token: manager, body: q })).status).toBe(409);
    expect((await call(Finance, "POST", "money-desk/declare", { token: manager, body: { ...q, declared: [{ channel: "DINE_IN", amount: 1 }] } })).status).toBe(409);
    expect((await call(Inventory, "POST", "worksheet", { token: kitchen, body: { ...q, menuItemId: dish, preparedQty: 9 } })).status).toBe(409);

    const reopen = { ...q, reason: "recount the cash" };
    const noAuth = await call(Finance, "POST", "money-desk/reopen", { token: manager, body: reopen });
    expect([noAuth.status, noAuth.json.error.code]).toEqual([403, "ReauthRequiredError"]);
    // A grant for voiding documents does not reopen a day: reopening has its own scope.
    expect(await reauth(manager, "finance.void")).toBe(200);
    expect((await call(Finance, "POST", "money-desk/reopen", { token: manager, body: reopen })).status).toBe(403);
    expect(await reauth(manager, "finance.reopen")).toBe(200);
    expect((await call(Finance, "POST", "money-desk/reopen", { token: manager, body: reopen })).status).toBe(200);
    expect((await call(Finance, "POST", "money-desk/reopen", { token: manager, body: reopen })).status).toBe(409);
    expect(await reauth(manager, "finance.void")).toBe(200); // one scope per confirmation
    expect((await call(Finance, "POST", `money-desk/deposits/${d1.json.data.id}/void`, { token: manager, body: { reason: "wrong slip" } })).status).toBe(200);
    const closes = await call(Finance, "GET", "money-desk/closes", { token: cashier, query: { outletId: A } });
    expect(closes.json.data.map((c: { revision: number; status: string }) => [c.revision, c.status])).toEqual([[1, "REOPENED"]]);
  });
});
