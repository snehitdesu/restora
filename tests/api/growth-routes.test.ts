/**
 * Group 6 over HTTP: real route handlers, real services, real database.
 *
 *  R1 staff API: sign-in required, the permission matrix per role, cross-tenant 404s, same-origin writes
 *  R2 a manager runs coupons, tiers, settings and a campaign through the API
 *  R3 the guest journey: quote with a code, order with code + referral + offers opt-in, pay, rate the meal
 *  R4 the feedback link and the one-click unsubscribe link (public, token is the credential)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { systemContext } from "@/server/auth/context";
import { SESSION_COOKIE } from "@/constants/auth";
import { rotateTableQr } from "@/server/services/masterData";
import { createMenuItem } from "@/server/services/menu";
import { runFeedbackRequests } from "@/server/services/feedbackLoop";
import { runCampaigns } from "@/server/services/campaigns";
import { unsubscribeToken } from "@/server/services/consent";
import { getRateLimitStore, RATE_POLICIES } from "@/server/api/rateLimit";
import * as Growth from "@/app/api/growth/[[...path]]/route";
import * as Guest from "@/app/api/qr/[[...path]]/route";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { phone as newPhone } from "../domain/growthSupport";

const RUN = Date.now().toString(36);
const ORIGIN = "http://localhost";
let orgId: string, outletId: string, token: string, dish: string, customerId: string;
const sessions: Record<string, string> = {};

type Mod = Record<string, (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>>;
async function call(module: object, method: string, path: string, opts: { as?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": `203.0.113.${(RUN.length % 200) + 1}`, ...(opts.headers ?? {}) };
  if (opts.as) headers.cookie = `${SESSION_COOKIE}=${sessions[opts.as]}`;
  if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
  const req = new NextRequest(new URL(`http://localhost/api/x/${path}`), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const segments = path.split("?")[0];
  const res = await (module as unknown as Mod)[method](req, { params: Promise.resolve({ path: segments ? segments.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
const staff = (method: string, path: string, as: string, body?: unknown) => call(Growth, method, path, { as, body });

async function session(org: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: org, email: `${role.toLowerCase()}-${RUN}-${Math.random().toString(36).slice(2, 7)}@growth.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: org, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}

beforeAll(async () => {
  process.env.PUBLIC_BASE_URL = "https://restora.test";
  orgId = (await prisma.organization.create({ data: { name: `Growth API ${RUN}`, timezone: "Asia/Kolkata" } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `GR${RUN}`, name: "Growth Outlet" } })).id;
  const ctx = systemContext(orgId, [outletId]);
  const table = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: "T1" } });
  token = (await rotateTableQr(ctx, table.id)).qrToken!;
  dish = (await createMenuItem(ctx, { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  await prisma.integrationConnection.create({ data: { organizationId: orgId, kind: "MESSAGING", provider: "mock", status: "CONNECTED", config: "{}" } });
  sessions.owner = await session(orgId, "OWNER", null);
  sessions.manager = await session(orgId, "MANAGER", outletId);
  sessions.cashier = await session(orgId, "CASHIER", outletId);
  sessions.kitchen = await session(orgId, "KITCHEN", outletId);
  sessions.captain = await session(orgId, "CAPTAIN", outletId);
  const org2 = (await prisma.organization.create({ data: { name: `Growth API other ${RUN}` } })).id;
  sessions.foreign = await session(org2, "OWNER", null);
  customerId = (await prisma.customer.create({ data: { organizationId: orgId, name: "Route Guest", phone: newPhone(), email: `route${RUN}@guest.test` } })).id;
});
afterAll(async () => { await prisma.$disconnect(); });

describe("R1. staff API: sign-in, roles, tenants, origin", () => {
  const reads = ["settings", "tiers", "coupons", "referrals", "referrals/summary", "campaigns", "feedback", "feedback/attention", "consent/summary", "digest"];

  it("R1 needs a session for everything", async () => {
    for (const p of reads) expect((await call(Growth, "GET", p)).status, p).toBe(401);
    expect((await call(Growth, "POST", "coupons", { body: {} })).status).toBe(401);
  });

  it("R1 the floor roles cannot read or change the growth tools; managers and owners can", async () => {
    for (const role of ["cashier", "kitchen", "captain"]) {
      for (const p of ["settings", "coupons", "referrals", "campaigns", "feedback/attention", "consent/summary", "digest"]) expect((await staff("GET", p, role)).status, `${role} GET ${p}`).toBe(403);
      expect((await staff("PATCH", "settings", role, { referralEnabled: true })).status, `${role} PATCH settings`).toBe(403);
      expect((await staff("POST", "coupons", role, { code: "NOPE10", name: "Nope", kind: "PERCENT", value: 10 })).status, `${role} POST coupons`).toBe(403);
      expect((await staff("POST", "campaigns", role, { name: "No", channel: "SMS", body: "Hello there", audience: {} })).status, `${role} POST campaigns`).toBe(403);
      expect((await staff("POST", "tiers", role, { code: "X", name: "X", minSpend: 0, earnMultiplierPct: 100 })).status).toBe(403);
    }
    for (const role of ["manager", "owner"]) {
      for (const p of reads) expect((await staff("GET", p, role)).status, `${role} GET ${p}`).toBe(200);
    }
    // The people at the counter can still see and keep a guest's consent (customer.view / customer.manage), not kitchen.
    expect((await staff("GET", `customers/${customerId}/consent`, "cashier")).status).toBe(200);
    expect((await staff("POST", `customers/${customerId}/consent`, "cashier", { channels: [{ channel: "SMS", marketing: true }] })).status).toBe(200);
    expect((await staff("GET", `customers/${customerId}/consent`, "kitchen")).status).toBe(403);
    expect((await staff("POST", `customers/${customerId}/consent`, "kitchen", { channels: [{ channel: "SMS", marketing: false }] })).status).toBe(403);
    expect((await staff("GET", `customers/${customerId}/loyalty`, "cashier")).status).toBe(200);
  });

  it("R1 another restaurant's data is a 404 and its coupons and campaigns stay out of lists", async () => {
    const mine = await staff("POST", "coupons", "manager", { code: `TENANT${RUN}`.toUpperCase().slice(0, 20), name: "Mine", kind: "PERCENT", value: 10 });
    expect(mine.status).toBe(200);
    const camp = await staff("POST", "campaigns", "manager", { name: `Mine ${RUN}`, channel: "SMS", body: "Hello there", audience: {} });
    expect(camp.status).toBe(200);
    expect((await staff("GET", `campaigns/${camp.json.data.id}`, "foreign")).status).toBe(404);
    expect((await staff("PATCH", `campaigns/${camp.json.data.id}`, "foreign", { name: "Stolen" })).status).toBe(404);
    expect((await staff("POST", `campaigns/${camp.json.data.id}/cancel`, "foreign")).status).toBe(404);
    expect((await staff("PATCH", `coupons/${mine.json.data.id}`, "foreign", { active: false })).status).toBe(404);
    expect((await staff("GET", `coupons/${mine.json.data.id}/redemptions`, "foreign")).status).toBe(404);
    expect((await staff("GET", `customers/${customerId}/consent`, "foreign")).status).toBe(404);
    expect((await staff("POST", `customers/${customerId}/referral-code`, "foreign")).status).toBe(404);
    expect((await staff("GET", "coupons", "foreign")).json.data.map((c: { id: string }) => c.id)).not.toContain(mine.json.data.id);
    expect((await staff("GET", "campaigns", "foreign")).json.data).toEqual([]);
  });

  it("R1 writes from another site are refused (requests without an Origin header are non-browser clients and need the session cookie like any other)", async () => {
    const r = await call(Growth, "PATCH", "settings", { as: "manager", origin: "https://evil.example", body: { referralEnabled: true } });
    expect(r.status).toBe(403);
    expect((await staff("GET", "settings", "manager")).json.data.referralEnabled).toBe(false);
  });

  it("R1 unknown paths and methods are errors, not guesses", async () => {
    expect((await staff("GET", "nothing-here", "owner")).status).toBe(404);
    expect((await staff("GET", "campaigns/preview", "owner")).status).toBe(404); // preview is a POST; as an id it matches nothing
    expect((await staff("POST", "campaigns/preview", "owner", { channel: "SMS", audience: { surprise: 1 } })).status).toBe(422);
  });
});

describe("R2. a manager runs the growth tools through the API", () => {
  it("R2 settings: validated, audited, with field errors", async () => {
    const bad = await staff("PATCH", "settings", "manager", { googleReviewUrl: "http://evil.example/review", quietHoursStart: 25 });
    expect(bad.status).toBe(422);
    const ok = await staff("PATCH", "settings", "manager", { referralEnabled: true, referrerPoints: 120, refereePoints: 60, feedbackEnabled: true, googleReviewUrl: "https://g.page/r/abc/review", marketingWeeklyCap: 3 });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ referralEnabled: true, referrerPoints: 120, feedbackEnabled: true, googleReviewUrl: "https://g.page/r/abc/review", marketingWeeklyCap: 3 });
    expect((await staff("GET", "settings", "cashier")).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "GrowthSettings" } })).toBeGreaterThanOrEqual(1);
  });

  it("R2 tiers, coupons: create, duplicate code is a conflict, a used code cannot be renamed", async () => {
    expect((await staff("POST", "tiers", "manager", { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 })).status).toBe(200);
    expect((await staff("POST", "tiers", "manager", { code: "GOLD", name: "Gold", minSpend: 3000, earnMultiplierPct: 150 })).status).toBe(200);
    const tiers = await staff("GET", "tiers", "cashier");
    expect(tiers.status, JSON.stringify(tiers.json)).toBe(200);
    expect(tiers.json.data.map((t: { code: string }) => t.code)).toEqual(["BASE", "GOLD"]);
    const code = `WELCOME${RUN}`.toUpperCase().slice(0, 20);
    const created = await staff("POST", "coupons", "manager", { code, name: "Welcome", kind: "PERCENT", value: 10, maxDiscount: 50, minOrderValue: 100 });
    expect(created.status).toBe(200);
    expect(created.json.data).toMatchObject({ code, kind: "PERCENT", active: true });
    expect((await staff("POST", "coupons", "manager", { code, name: "Again", kind: "PERCENT", value: 5 })).status).toBe(409);
    expect((await staff("POST", "coupons", "manager", { code: "x", name: "Short", kind: "PERCENT", value: 5 })).status).toBe(422);
    expect((await staff("POST", "coupons", "manager", { code: "OVER100", name: "Too much", kind: "PERCENT", value: 150 })).status).toBe(422);
    const list = await staff("GET", "coupons?search=WELCOME", "manager");
    expect(list.json.data.map((c: { code: string }) => c.code)).toContain(code);
  });

  it("R2 a campaign: draft, preview the audience, schedule, run, read the result", async () => {
    // Two guests who agreed to SMS offers, one who did not.
    for (const [name, marketing] of [["Camp A", true], ["Camp B", true], ["Camp C", false]] as const) {
      const c = await prisma.customer.create({ data: { organizationId: orgId, name, phone: newPhone() } });
      if (marketing) expect((await staff("POST", `customers/${c.id}/consent`, "cashier", { channels: [{ channel: "SMS", marketing: true }] })).status).toBe(200);
    }
    const created = await staff("POST", "campaigns", "manager", { name: `Weekend ${RUN}`, channel: "SMS", body: "Hi {name}, weekend special at {restaurant}", audience: {} });
    expect(created.status).toBe(200);
    const id = created.json.data.id as string;
    const preview = await staff("POST", "campaigns/preview", "manager", { channel: "SMS", audience: {} });
    expect(preview.json.data.matching).toBeGreaterThanOrEqual(2);
    expect((await staff("POST", `campaigns/${id}/schedule`, "cashier")).status).toBe(403);
    const scheduled = await staff("POST", `campaigns/${id}/schedule`, "manager", { at: new Date(Date.now() - 60_000).toISOString() });
    expect(scheduled.json.data.status).toBe("SCHEDULED");
    expect((await staff("PATCH", `campaigns/${id}`, "manager", { name: "Too late" })).status).toBe(409);
    // The worker's pass (afternoon in Kolkata so quiet hours do not apply).
    const noon = new Date(); noon.setUTCHours(8, 0, 0, 0);
    await runCampaigns(prisma, new Date(Math.max(noon.getTime(), Date.now() + 1000)), orgId);
    const detail = await staff("GET", `campaigns/${id}`, "manager");
    expect(["SENDING", "SENT"]).toContain(detail.json.data.campaign.status);
    expect(Object.keys(detail.json.data.recipients).length).toBeGreaterThan(0);
  });

  it("R2 referral codes and consent summary", async () => {
    const code1 = await staff("POST", `customers/${customerId}/referral-code`, "cashier");
    expect(code1.status).toBe(200);
    expect(code1.json.data.code).toMatch(/^RF[0-9A-Z]{6}$/);
    expect((await staff("POST", `customers/${customerId}/referral-code`, "cashier")).json.data.code).toBe(code1.json.data.code); // stable
    const summary = await staff("GET", "consent/summary", "manager");
    expect(summary.json.data).toBeTruthy();
    expect((await staff("GET", "referrals/summary", "manager")).status).toBe(200);
  });
});

describe("R2b. the till", () => {
  it("R2b a cashier applies a code to an open order, sees it, removes it; a kitchen login and another restaurant cannot", async () => {
    const owner = { ...systemContext(orgId, [outletId]), userId: `owner-${RUN}`, roles: ["OWNER"], orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
    const order = await createOrder(owner, { outletId, channel: "TAKEAWAY" });
    await addOrderItem(owner, order.id, { name: "Meal", qty: 1, unitPrice: 400, taxPct: 0 });
    const code = `TILL${RUN}`.toUpperCase().slice(0, 20);
    expect((await staff("POST", "coupons", "manager", { code, name: "Till", kind: "PERCENT", value: 10, maxDiscount: 25 })).status).toBe(200);

    // "No coupon" is an object, not a bare null (the client unwraps `data ?? envelope`).
    const none = await staff("GET", `orders/${order.id}/coupon`, "cashier");
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ ok: true, data: { coupon: null } });

    expect((await staff("POST", `orders/${order.id}/coupon`, "kitchen", { code })).status).toBe(403);
    expect((await staff("POST", `orders/${order.id}/coupon`, "foreign", { code })).status).toBe(404);
    expect((await staff("POST", `orders/${order.id}/coupon`, "cashier", { code: "NOSUCHCODE" })).status).toBe(422);
    const applied = await staff("POST", `orders/${order.id}/coupon`, "cashier", { code: code.toLowerCase() });
    expect(applied.status).toBe(200);
    expect(applied.json.data).toMatchObject({ discount: 25 }); // 10% of 400 = 40, capped at 25
    expect((await staff("GET", `orders/${order.id}/coupon`, "cashier")).json.data.coupon).toMatchObject({ code, amount: 25 });
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total)).toBe(375);
    // Typing the same code again changes nothing (one use, counted once).
    expect((await staff("POST", `orders/${order.id}/coupon`, "cashier", { code })).json.data).toMatchObject({ discount: 25 });
    expect(await prisma.couponRedemption.count({ where: { orderId: order.id, status: "APPLIED" } })).toBe(1);

    expect((await staff("POST", `orders/${order.id}/coupon/remove`, "cashier")).json.data).toEqual({ removed: true });
    expect((await staff("GET", `orders/${order.id}/coupon`, "cashier")).json.data).toEqual({ coupon: null });
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).total)).toBe(400);
    expect((await staff("POST", `orders/${order.id}/coupon/remove`, "cashier")).json.data).toEqual({ removed: false });
  });
});

describe("R3. the guest journey", () => {
  const guestCall = (method: string, path: string, opts: { body?: unknown; key?: string; orderKey?: string } = {}) =>
    call(Guest, method, path, { body: opts.body, origin: ORIGIN, headers: { ...(opts.key ? { "idempotency-key": opts.key } : {}), ...(opts.orderKey ? { "x-order-key": opts.orderKey } : {}) } });

  it("R3 quote shows what a code is worth; a wrong code is a polite message, never a failure", async () => {
    const code = `QUOTE${RUN}`.toUpperCase().slice(0, 20);
    expect((await staff("POST", "coupons", "manager", { code, name: "Quote", kind: "FIXED", value: 20, minOrderValue: 150 })).status).toBe(200);
    const items = [{ menuItemId: dish, qty: 2 }];
    const usesBefore = await prisma.couponRedemption.count({ where: { organizationId: orgId } });
    const q = await guestCall("POST", `t/${token}/quote`, { body: { items, couponCode: code } });
    expect(q.status).toBe(200);
    expect(q.json.data.coupon).toMatchObject({ ok: true, code, discount: "20.00" });
    expect(q.json.data.discount).toBe("20.00");
    // 200 subtotal at 5% tax on (200 - 20): 180 + 9 = 189.00
    expect(q.json.data.total).toBe("189.00");
    const under = await guestCall("POST", `t/${token}/quote`, { body: { items: [{ menuItemId: dish, qty: 1 }], couponCode: code } });
    expect(under.json.data.coupon).toMatchObject({ ok: false });
    expect(under.json.data.total).toBe("105.00");
    const unknown = await guestCall("POST", `t/${token}/quote`, { body: { items, couponCode: "NOSUCHCODE" } });
    expect(unknown.status).toBe(200);
    expect(unknown.json.data.coupon).toMatchObject({ ok: false });
    expect(await prisma.couponRedemption.count({ where: { organizationId: orgId } })).toBe(usesBefore); // a quote counts nothing
  });

  it("R3 order with code + referral + offers opt-in, paid online: discount, redemption, consent, loyalty and the referral reward all follow the server", async () => {
    const code = `ORDER${RUN}`.toUpperCase().slice(0, 20);
    expect((await staff("POST", "coupons", "manager", { code, name: "Order", kind: "PERCENT", value: 10, maxDiscount: 30 })).status).toBe(200);
    const referrerCode = (await staff("POST", `customers/${customerId}/referral-code`, "cashier")).json.data.code as string;
    const guestPhone = newPhone();
    const placed = await guestCall("POST", `t/${token}/orders`, {
      key: `gr-${RUN}-1`,
      body: { items: [{ menuItemId: dish, qty: 3 }], customer: { name: "New Friend", phone: guestPhone }, paymentMethod: "ONLINE", couponCode: code, referralCode: referrerCode, marketingOptIn: true },
    });
    expect(placed.status).toBe(200);
    expect(placed.json.data.coupon).toMatchObject({ applied: true, code, discount: "30.00" }); // 10% of 300 = 30 (cap 30)
    expect(placed.json.data.referral).toMatchObject({ attached: true });
    const { orderId, accessKey } = placed.json.data as { orderId: string; accessKey: string };

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(Number(order.discount)).toBe(30);
    expect(Number(order.total)).toBe(283.5); // (300 - 30) + 5% = 283.50
    const friend = await prisma.customer.findFirstOrThrow({ where: { organizationId: orgId, name: "New Friend" } });
    const consents = await prisma.customerConsent.findMany({ where: { customerId: friend.id, marketing: true } });
    expect(consents.map((c) => c.channel).sort()).toEqual(["SMS", "WHATSAPP"]);
    expect(consents.every((c) => c.source === "GUEST_QR")).toBe(true);

    // The same idempotency key replays the order and does not redeem the code again.
    const replay = await guestCall("POST", `t/${token}/orders`, { key: `gr-${RUN}-1`, body: { items: [{ menuItemId: dish, qty: 3 }], customer: { name: "New Friend", phone: guestPhone }, paymentMethod: "ONLINE", couponCode: code, referralCode: referrerCode, marketingOptIn: true } });
    expect(replay.json.data).toMatchObject({ orderId, replayed: true });
    expect(await prisma.couponRedemption.count({ where: { orderId, status: "APPLIED" } })).toBe(1);

    // A wrong code and a bad referral never block an order.
    const lenient = await guestCall("POST", `t/${token}/orders`, { key: `gr-${RUN}-2`, body: { items: [{ menuItemId: dish, qty: 1 }], couponCode: "NOSUCHCODE", referralCode: "RFNOPE00" } });
    expect(lenient.status).toBe(200);
    expect(lenient.json.data.coupon).toMatchObject({ applied: false });

    // Pay online (server amount) and confirm through the gateway.
    const start = await guestCall("POST", `orders/${orderId}/payments`, { key: `gp-${RUN}-1`, orderKey: accessKey });
    expect(start.json.data).toMatchObject({ amount: "283.50" });
    const done = await guestCall("POST", `orders/${orderId}/payments/confirm`, { body: { paymentId: start.json.data.paymentId }, orderKey: accessKey });
    expect(done.json.data).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID" });

    // After PAID: the referral rewarded exactly once, a feedback request scheduled, loyalty awarded.
    const ref = await prisma.referral.findFirstOrThrow({ where: { organizationId: orgId, referredCustomerId: friend.id } });
    expect(ref.status).toBe("REWARDED");
    expect(await prisma.feedbackRequest.count({ where: { orderId } })).toBe(1);
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: friend.id } })).toBeGreaterThan(0);
    expect((await staff("GET", `customers/${customerId}/loyalty`, "cashier")).json.data).toBeTruthy();

    // Rate the meal from the order page: the order's key is the credential.
    expect((await guestCall("POST", `orders/${orderId}/feedback`, { body: { rating: 5, comment: "Lovely" } })).status).toBe(404);
    expect((await guestCall("POST", `orders/${orderId}/feedback`, { orderKey: "forged", body: { rating: 5 } })).status).toBe(404);
    expect((await guestCall("POST", `orders/${orderId}/feedback`, { orderKey: accessKey, body: { rating: 9 } })).status).toBe(422);
    const rated = await guestCall("POST", `orders/${orderId}/feedback`, { orderKey: accessKey, body: { rating: 5, comment: "Lovely" } });
    expect(rated.status).toBe(200);
    expect(rated.json.data).toMatchObject({ thanks: true, routedTo: "GOOGLE", reviewUrl: "https://g.page/r/abc/review", alreadyAnswered: false });
    const again = await guestCall("POST", `orders/${orderId}/feedback`, { orderKey: accessKey, body: { rating: 1, comment: "changed my mind" } });
    expect(again.json.data).toMatchObject({ alreadyAnswered: true }); // one answer per order; the first stands
    const stored = await prisma.feedback.findMany({ where: { orderId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ rating: 5, source: "GUEST" });
  }, 40000);
});

describe("R4. public links", () => {
  it("R4 the feedback link we send works once; a low rating lands in the staff inbox and raises an alert", async () => {
    const guestPhone = newPhone();
    const placed = await call(Guest, "POST", `t/${token}/orders`, { origin: ORIGIN, headers: { "idempotency-key": `gr-${RUN}-link` }, body: { items: [{ menuItemId: dish, qty: 1 }], customer: { name: "Link Guest", phone: guestPhone }, paymentMethod: "ONLINE" } });
    const { orderId, accessKey } = placed.json.data as { orderId: string; accessKey: string };
    const start = await call(Guest, "POST", `orders/${orderId}/payments`, { origin: ORIGIN, headers: { "x-order-key": accessKey, "idempotency-key": `gp-${RUN}-link` } });
    await call(Guest, "POST", `orders/${orderId}/payments/confirm`, { origin: ORIGIN, headers: { "x-order-key": accessKey }, body: { paymentId: start.json.data.paymentId } });

    // Not due yet; two hours on, the worker sends the link (guest agreed to order messages by default).
    expect(await runFeedbackRequests(prisma, new Date(), orgId)).toMatchObject({ sent: 0 });
    const run = await runFeedbackRequests(prisma, new Date(Date.now() + 3 * 3600_000), orgId);
    expect(run.sent).toBeGreaterThanOrEqual(1);
    const request = await prisma.feedbackRequest.findUniqueOrThrow({ where: { orderId } });
    expect(request.status).toBe("SENT");
    const sent = await prisma.integrationDelivery.findFirstOrThrow({ where: { organizationId: orgId, idempotencyKey: { startsWith: `fbreq:${request.id}:` } } });
    const link = /https:\/\/restora\.test\/f\/([\w-]+)/.exec((JSON.parse(sent.payload) as { body: string }).body);
    expect(link).toBeTruthy();
    const feedbackToken = link![1];

    const info = await call(Guest, "GET", `feedback/${feedbackToken}`);
    expect(info.status).toBe(200);
    expect(info.json.data).toEqual({ restaurant: "Growth Outlet", answered: false });
    expect(JSON.stringify(info.json)).not.toContain(guestPhone);
    expect((await call(Guest, "GET", "feedback/not-a-real-token-at-all-x")).status).toBe(404);
    expect((await call(Guest, "POST", "feedback/not-a-real-token-at-all-x", { origin: ORIGIN, body: { rating: 3 } })).status).toBe(404);
    expect((await call(Guest, "POST", `feedback/${feedbackToken}`, { origin: "https://evil.example", body: { rating: 2 } })).status).toBe(403);

    const answer = await call(Guest, "POST", `feedback/${feedbackToken}`, { origin: ORIGIN, body: { rating: 2, comment: "Cold food" } });
    expect(answer.json.data).toMatchObject({ thanks: true, routedTo: "PRIVATE", reviewUrl: null }); // unhappy guests are never sent to a public review page
    expect((await call(Guest, "POST", `feedback/${feedbackToken}`, { origin: ORIGIN, body: { rating: 5 } })).json.data).toMatchObject({ alreadyAnswered: true });

    const inbox = await staff("GET", "feedback?maxRating=3&status=NEW", "manager");
    const item = (inbox.json.data.items as Array<{ id: string; rating: number; comment: string }>).find((f) => f.comment === "Cold food");
    expect(item).toMatchObject({ rating: 2 });
    expect((await staff("GET", "feedback/attention", "manager")).json.data).toBeTruthy();
    expect((await staff("POST", `feedback/${item!.id}/handle`, "cashier", { status: "ACKNOWLEDGED" })).status).toBe(403);
    expect((await staff("POST", `feedback/${item!.id}/handle`, "manager", { status: "RESOLVED" })).status).toBe(422); // a resolution note is required
    const handled = await staff("POST", `feedback/${item!.id}/handle`, "manager", { status: "RESOLVED", resolution: "Called the guest and refunded the dish" });
    expect(handled.status).toBe(200);
    expect((await staff("GET", "feedback?status=NEW", "foreign")).json.data.items).toEqual([]);
  }, 40000);

  it("R4 one-click unsubscribe: signed token, idempotent, only that channel, forged links are 404", async () => {
    const c = await prisma.customer.create({ data: { organizationId: orgId, name: "Unsub Guest", phone: newPhone() } });
    expect((await staff("POST", `customers/${c.id}/consent`, "cashier", { channels: [{ channel: "SMS", marketing: true }, { channel: "WHATSAPP", marketing: true }] })).status).toBe(200);
    const t = unsubscribeToken(c.id, "SMS");
    const get = await call(Guest, "GET", `unsubscribe/${t}`);
    expect(get.json.data).toEqual({ restaurant: `Growth API ${RUN}`, channel: "SMS" });
    const consent = async () => (await prisma.customerConsent.findMany({ where: { customerId: c.id } })).reduce<Record<string, boolean>>((a, x) => ({ ...a, [x.channel]: x.marketing }), {});
    expect(await consent()).toMatchObject({ SMS: true, WHATSAPP: true });
    expect((await call(Guest, "GET", `unsubscribe/${t}`)).status).toBe(200); // a GET (link preview, scanner) changes nothing
    expect(await consent()).toMatchObject({ SMS: true });
    const done = await call(Guest, "POST", `unsubscribe/${t}`, { origin: ORIGIN });
    expect(done.json.data).toMatchObject({ done: true });
    expect(await consent()).toMatchObject({ SMS: false, WHATSAPP: true });
    expect((await call(Guest, "POST", `unsubscribe/${t}`, { origin: ORIGIN })).json.data).toMatchObject({ done: true }); // idempotent
    // Forged: another guest's id with this signature; a different channel with this signature; garbage.
    const [id, , sig] = t.split(".");
    for (const bad of [`${c.id}.WHATSAPP.${sig}`, `${id}x.SMS.${sig}`, `${id}.SMS.${"A".repeat(22)}`, "garbage", "a.b.c"]) {
      expect((await call(Guest, "GET", `unsubscribe/${bad}`)).status, bad).toBe(404);
      expect((await call(Guest, "POST", `unsubscribe/${bad}`, { origin: ORIGIN })).status, bad).toBe(404);
    }
    expect(await consent()).toMatchObject({ WHATSAPP: true });
    expect(RATE_POLICIES.guestUnsubscribePerIp.limit).toBeGreaterThan(0);
    const store = getRateLimitStore();
    await store.reset(`${RATE_POLICIES.guestUnsubscribePerIp.name}:203.0.113.${(RUN.length % 200) + 1}`);
  });
});
