/**
 * The restaurant's common QR over HTTP (docs/common-qr-ordering.md): who may
 * manage it and assign tables (session, role, outlet, organization, same-origin
 * writes), and the guest order limit at the real route — keyed by the client
 * address the trusted proxy reports, so a forged X-Forwarded-For prefix does not
 * reset it; 19 → 20 → 21; the window expiring; independent phones; invalid
 * codes consuming nothing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { systemContext } from "@/server/auth/context";
import { SESSION_COOKIE } from "@/constants/auth";
import { rotateOutletCommonQr } from "@/server/services/masterData";
import { createMenuItem } from "@/server/services/menu";
import { getRateLimitStore, RATE_POLICIES, rateLimitKey } from "@/server/api/rateLimit";
import * as Guest from "@/app/api/qr/[[...path]]/route";
import * as Orders from "@/app/api/orders/[[...path]]/route";
import * as Master from "@/app/api/master/[[...path]]/route";

const RUN = Date.now().toString(36);
const ORIGIN = "http://localhost";
let orgId: string, outletA: string, outletB: string, common: string, dish: string;
let mgrA: string, mgrB: string, cashierA: string, kitchenA: string, foreign: string;
let seq = 0;

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string; xff?: string; query?: Record<string, string> } = {}) {
  const url = new URL(`http://localhost/api/x/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": opts.xff ?? "203.0.113.200" };
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  if (opts.origin) headers.origin = opts.origin;
  if (method === "POST" && path.endsWith("/orders")) headers["idempotency-key"] = `cqr-${RUN}-${++seq}-abcdef`;
  const req = new NextRequest(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: path ? path.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const orderBody = () => ({ items: [{ menuItemId: dish, qty: 1 }], paymentMethod: "ONLINE" });
const placeFrom = (xff: string, token = common) => call(Guest, "POST", `t/${token}/orders`, { body: orderBody(), origin: ORIGIN, xff });

async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role}-${RUN}-${Math.random().toString(36).slice(2, 7)}@cqr.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `CQR API ${RUN}` } })).id;
  outletA = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QA${RUN}`.slice(0, 20), name: "A" } })).id;
  outletB = (await prisma.outlet.create({ data: { organizationId: orgId, code: `QB${RUN}`.slice(0, 20), name: "B" } })).id;
  const sys = systemContext(orgId, [outletA, outletB]);
  common = (await rotateOutletCommonQr(sys, outletA)).qrToken!;
  dish = (await createMenuItem(sys, { name: `Idli ${RUN}`, price: 60, taxPct: 5 })).id;
  mgrA = await session(orgId, "MANAGER", outletA);
  mgrB = await session(orgId, "MANAGER", outletB);
  cashierA = await session(orgId, "CASHIER", outletA);
  kitchenA = await session(orgId, "KITCHEN", outletA);
  foreign = await session((await prisma.organization.create({ data: { name: `CQR other ${RUN}` } })).id, "OWNER", null);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await prisma.$disconnect(); });

describe("managing the restaurant QR", () => {
  const path = () => `outlets/${outletA}/common-qr`;
  it("needs a session, the outlet's manager role, and a same-origin write", async () => {
    expect((await call(Master, "GET", path())).status).toBe(401);
    expect((await call(Master, "POST", path(), { origin: ORIGIN })).status).toBe(401);
    expect((await call(Master, "GET", path(), { cookie: cashierA })).status).toBe(403);
    expect((await call(Master, "POST", path(), { cookie: kitchenA, origin: ORIGIN })).status).toBe(403);
    expect([403, 404]).toContain((await call(Master, "POST", path(), { cookie: mgrB, origin: ORIGIN })).status);
    expect((await call(Master, "POST", path(), { cookie: foreign, origin: ORIGIN })).status).toBe(404);
    expect((await call(Master, "POST", path(), { cookie: mgrA, origin: "https://evil.example" })).status).toBe(403);
    // None of the refusals changed the code.
    expect((await call(Master, "GET", path(), { cookie: mgrA })).json.data.qrToken).toBe(common);
  });

  it("a manager rotates it: the old code is dead at the guest route at once", async () => {
    const r = await call(Master, "POST", path(), { cookie: mgrA, origin: ORIGIN });
    expect(r.status).toBe(200);
    const fresh = r.json.data.qrToken as string;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await call(Guest, "GET", `t/${common}`)).status).toBe(404);
    expect((await call(Guest, "GET", `t/${fresh}`)).status).toBe(200);
    common = fresh;
  });

  it("guests cannot tell a disabled code from one that never existed", async () => {
    const o = await prisma.outlet.create({ data: { organizationId: orgId, code: `QD${RUN}`.slice(0, 20), name: "D" } });
    const t = (await rotateOutletCommonQr(systemContext(orgId, [o.id]), o.id)).qrToken!;
    await call(Master, "POST", `outlets/${o.id}/common-qr/revoke`, { cookie: await session(orgId, "MANAGER", o.id), origin: ORIGIN });
    const disabled = await call(Guest, "GET", `t/${t}`);
    const never = await call(Guest, "GET", `t/${"Z".repeat(24)}`);
    expect(disabled.status).toBe(404);
    expect(disabled.json.error).toEqual(never.json.error);
  });
});

describe("assigning a table over HTTP", () => {
  it("cashier yes; kitchen, another outlet's manager, no session and cross-origin no", async () => {
    const placed = await placeFrom("198.51.100.10");
    expect(placed.status).toBe(200);
    const orderId = placed.json.data.orderId as string;
    const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: outletA, code: `H${RUN}` } });
    const body = { tableId: table.id };
    expect((await call(Orders, "POST", `${orderId}/table`, { body, origin: ORIGIN })).status).toBe(401);
    expect((await call(Orders, "POST", `${orderId}/table`, { cookie: kitchenA, body, origin: ORIGIN })).status).toBe(403);
    expect([403, 404]).toContain((await call(Orders, "POST", `${orderId}/table`, { cookie: mgrB, body, origin: ORIGIN })).status);
    expect((await call(Orders, "POST", `${orderId}/table`, { cookie: cashierA, body, origin: "https://evil.example" })).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tableId).toBeNull();
    // Refusals left no "table assigned" audit row behind.
    expect(await prisma.auditLog.count({ where: { entityType: "Order", entityId: orderId, action: "UPDATE" } })).toBe(0);
    const ok = await call(Orders, "POST", `${orderId}/table`, { cookie: cashierA, body, origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityType: "Order", entityId: orderId, action: "UPDATE" } })).toBe(1);
    expect((await call(Orders, "GET", "qr-tables", { cookie: cashierA, query: { outletId: outletA } })).status).toBe(200);
    expect([403, 404]).toContain((await call(Orders, "GET", "qr-tables", { cookie: mgrB, query: { outletId: outletA } })).status);
  });

  it("past the table's guest limits: 409 TableGuestLimit with the numbers; the explicit override goes through; kitchen still cannot", async () => {
    const placed = await placeFrom("198.51.100.11");
    const orderId = placed.json.data.orderId as string;
    const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: outletA, code: `HL${RUN}` } });
    await prisma.order.createMany({ data: Array.from({ length: 3 }, () => ({ organizationId: orgId, outletId: outletA, tableId: table.id, source: "QR", channel: "QR", status: "OPEN" })) });
    const refused = await call(Orders, "POST", `${orderId}/table`, { cookie: cashierA, body: { tableId: table.id }, origin: ORIGIN });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "TableGuestLimit", details: { table: table.code, waiting: 4, waitingLimit: 3 } });
    expect((await call(Orders, "POST", `${orderId}/table`, { cookie: kitchenA, body: { tableId: table.id, overrideGuestLimits: true }, origin: ORIGIN })).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).tableId).toBeNull();
    const ok = await call(Orders, "POST", `${orderId}/table`, { cookie: cashierA, body: { tableId: table.id, overrideGuestLimits: true }, origin: ORIGIN });
    expect(ok.status).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "Order", entityId: orderId, action: "UPDATE" } });
    expect(audit.actorId).toBeTruthy();
    expect(audit.after).toContain("guestLimitOverride");
  });
});

describe("rate-limit storage failure", () => {
  it("a failing shared store degrades to counting in this process: still enforced, counted in metrics, never an error to the guest", async () => {
    const { DatabaseRateLimitStore } = await import("@/server/api/rateLimitDb");
    const { counterValue } = await import("@/server/observability/metrics");
    const broken = { $queryRaw: async () => { throw new Error("database unavailable"); } } as never;
    const store = new DatabaseRateLimitStore(broken);
    const before = counterValue("restora_rate_limit_store_errors_total");
    const k = `cqr-broken-${RUN}`;
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) counts.push((await store.hit(k, 60_000)).count);
    expect(counts).toEqual([1, 2, 3]);
    expect(counterValue("restora_rate_limit_store_errors_total")).toBe(before + 3);
  });
});

describe("order limit on the common code, at the route", () => {
  const keyFor = (ip: string) => rateLimitKey(RATE_POLICIES.guestOrderPerTable, `${common}:${ip}`);
  const prefill = async (ip: string, n: number, at = Date.now()) => {
    const store = getRateLimitStore();
    for (let i = 0; i < n; i++) await store.hit(keyFor(ip), RATE_POLICIES.guestOrderPerTable.windowMs, at);
  };

  it("19 → 20 allowed, 21 refused with Retry-After; another phone is unaffected", async () => {
    const ip = "198.51.100.21";
    await prefill(ip, RATE_POLICIES.guestOrderPerTable.limit - 1); // 19 earlier orders
    expect((await placeFrom(ip)).status).toBe(200); // the 20th
    expect((await placeFrom(ip)).status).toBe(429); // the 21st
    expect((await placeFrom("198.51.100.22")).status).toBe(200);
    await getRateLimitStore().reset(keyFor(ip));
  });

  it("a forged X-Forwarded-For prefix does not make a new phone (one trusted proxy hop)", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const real = "198.51.100.31";
    await prefill(real, RATE_POLICIES.guestOrderPerTable.limit);
    for (const forged of ["1.2.3.4", "5.6.7.8, 9.9.9.9"]) expect((await placeFrom(`${forged}, ${real}`)).status).toBe(429);
    await getRateLimitStore().reset(keyFor(real));
  });

  it("the window expiring lets the phone order again", async () => {
    const ip = "198.51.100.41";
    await prefill(ip, RATE_POLICIES.guestOrderPerTable.limit, Date.now() - RATE_POLICIES.guestOrderPerTable.windowMs - 1000);
    expect((await placeFrom(ip)).status).toBe(200);
    await getRateLimitStore().reset(keyFor(ip));
  });

  it("an invalid or unknown code is refused before it can count against anyone's allowance", async () => {
    const ip = "198.51.100.51";
    for (const bad of ["Z".repeat(24), "short", "%2e%2e"]) expect((await placeFrom(ip, bad)).status).toBe(404);
    const { count } = await getRateLimitStore().hit(keyFor(ip), RATE_POLICIES.guestOrderPerTable.windowMs);
    expect(count).toBe(1); // only this probe: the refused requests counted nothing
    await getRateLimitStore().reset(keyFor(ip));
  });
});
