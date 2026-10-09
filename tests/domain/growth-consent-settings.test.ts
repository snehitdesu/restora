/**
 * Group 6 foundations against the real services and database: consent (who may be messaged), the growth settings,
 * the consent-gated message path (queueCustomerMessage) and the signed one-click unsubscribe.
 *
 *  C1 consent defaults, changes, audit, permissions, tenants
 *  C2 unsubscribe token: one-click, forged / foreign tokens
 *  S1 growth settings: validation, audit, tenants
 *  M1 queueCustomerMessage: provider, address, consent, quiet hours, weekly cap, idempotency, secrets
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { getConsent, setConsent, mayMessage, unsubscribeToken, unsubscribeInfo, applyUnsubscribe, consentSummary } from "@/server/services/consent";
import { getGrowthSettings, saveGrowthSettings, viewGrowthSettings, isReviewUrl, DEFAULT_GROWTH_SETTINGS } from "@/server/services/growthSettings";
import { queueCustomerMessage, inQuietHours } from "@/server/services/messaging";
import { createCoupon } from "@/server/services/coupons";
import { makeEnv, connectMock, guest, deliveries, uniq, type Env } from "./growthSupport";

let env: Env;
const NOON = new Date("2026-10-07T08:00:00Z"); // 13:30 in Kolkata
const NIGHT = new Date("2026-10-07T17:30:00Z"); // 23:00 in Kolkata

beforeAll(async () => {
  env = await makeEnv("Gcs");
  process.env.PUBLIC_BASE_URL = "https://restora.test";
});
afterEach(() => { process.env.PUBLIC_BASE_URL = "https://restora.test"; });
afterAll(async () => { await prisma.$disconnect(); });

describe("C1. consent", () => {
  it("C1 a guest with no row has not agreed to marketing and has not opted out of order messages; changes are audited", async () => {
    const g = await guest(env, "Asha");
    expect(await getConsent(prisma, env.cashier, g.id)).toEqual([
      { channel: "SMS", marketing: false, transactional: true, source: null, updatedAt: null },
      { channel: "WHATSAPP", marketing: false, transactional: true, source: null, updatedAt: null },
      { channel: "EMAIL", marketing: false, transactional: true, source: null, updatedAt: null },
    ]);
    expect(await mayMessage(prisma, env.orgId, g.id, "SMS", "MARKETING")).toBe(false);
    expect(await mayMessage(prisma, env.orgId, g.id, "SMS", "TRANSACTIONAL")).toBe(true);

    await setConsent(env.cashier, g.id, [{ channel: "SMS", marketing: true }, { channel: "EMAIL", transactional: false }]);
    expect(await mayMessage(prisma, env.orgId, g.id, "SMS", "MARKETING")).toBe(true);
    expect(await mayMessage(prisma, env.orgId, g.id, "EMAIL", "TRANSACTIONAL")).toBe(false);
    expect(await mayMessage(prisma, env.orgId, g.id, "WHATSAPP", "MARKETING")).toBe(false);
    const sms = (await getConsent(prisma, env.cashier, g.id)).find((c) => c.channel === "SMS")!;
    expect(sms).toMatchObject({ marketing: true, transactional: true, source: "STAFF" });

    // Saying the same thing again changes and records nothing; withdrawing is recorded with before / after.
    const before = await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "CustomerConsent" } });
    await setConsent(env.cashier, g.id, [{ channel: "SMS", marketing: true }]);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "CustomerConsent" } })).toBe(before);
    await setConsent(env.cashier, g.id, [{ channel: "SMS", marketing: false }]);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "CustomerConsent" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(audit!.before!)).toMatchObject({ marketing: true });
    expect(JSON.parse(audit!.after!)).toMatchObject({ channel: "SMS", marketing: false, source: "STAFF" });
  });

  it("C1b needs customer.manage, rejects empty or unknown input, and never crosses tenants", async () => {
    const g = await guest(env, "Ravi");
    await expect(setConsent(env.kitchen, g.id, [{ channel: "SMS", marketing: true }])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setConsent(env.cashier, g.id, [])).rejects.toThrow();
    await expect(setConsent(env.cashier, g.id, [{ channel: "SMS" }] as never)).rejects.toThrow(/Nothing to change/);
    await expect(setConsent(env.cashier, g.id, [{ channel: "FAX", marketing: true }] as never)).rejects.toThrow();
    await expect(setConsent(env.foreign, g.id, [{ channel: "SMS", marketing: true }])).rejects.toBeInstanceOf(NotFoundError);
    await expect(getConsent(prisma, env.foreign, g.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(consentSummary(prisma, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
    const sum = await consentSummary(prisma, env.manager);
    expect(sum.customers).toBeGreaterThan(0);
  });
});

describe("C2. unsubscribe", () => {
  it("C2 a token turns marketing off for that guest on that channel only; forged and foreign tokens do nothing", async () => {
    const g = await guest(env, "Meera", { marketing: ["SMS", "WHATSAPP"] });
    const token = unsubscribeToken(g.id, "SMS");
    expect(await unsubscribeInfo(prisma, token)).toMatchObject({ customerId: g.id, channel: "SMS", organizationId: env.orgId });

    for (const bad of [token.slice(0, -2) + "xx", `${g.id}.WHATSAPP.${token.split(".")[2]}`, `other.SMS.${token.split(".")[2]}`, "", "a.b.c", "x".repeat(300), 42, null]) {
      expect(await unsubscribeInfo(prisma, bad)).toBeNull();
      expect((await applyUnsubscribe(bad)).ok).toBe(false);
    }
    expect(await mayMessage(prisma, env.orgId, g.id, "SMS", "MARKETING")).toBe(true); // nothing happened yet

    expect((await applyUnsubscribe(token)).ok).toBe(true);
    expect((await applyUnsubscribe(token)).ok).toBe(true); // idempotent
    expect(await mayMessage(prisma, env.orgId, g.id, "SMS", "MARKETING")).toBe(false);
    expect(await mayMessage(prisma, env.orgId, g.id, "WHATSAPP", "MARKETING")).toBe(true); // other channel untouched
    const row = await prisma.customerConsent.findUniqueOrThrow({ where: { customerId_channel: { customerId: g.id, channel: "SMS" } } });
    expect(row.source).toBe("GUEST_REPLY");
    expect(row.transactional).toBe(true); // an unsubscribe is about offers, not about receipts
  });
});

describe("S1. growth settings", () => {
  it("S1 defaults off; changes need growth.manage, are validated, normalized and audited with before / after", async () => {
    expect(await getGrowthSettings(prisma, env.orgId)).toEqual(DEFAULT_GROWTH_SETTINGS);
    await expect(saveGrowthSettings(env.cashier, { feedbackEnabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(viewGrowthSettings(prisma, env.kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    for (const bad of [{ winbackAfterDays: 3 }, { quietHoursStart: 24 }, { marketingWeeklyCap: 0 }, { lowRatingMax: 5 }, { googleReviewUrl: "http://google.com/r" }, { googleReviewUrl: "https://evil.example/google.com" }, { googleReviewUrl: "https://user:pw@g.page/r/x" }, { digestPhone: "123" }, { unknown: 1 }]) {
      await expect(saveGrowthSettings(env.manager, bad as never), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(saveGrowthSettings(env.manager, { winbackAfterDays: 60, winbackCooldownDays: 30 })).rejects.toThrow(/cooldown/);
    await expect(saveGrowthSettings(env.manager, { birthdayCouponId: "nope" })).rejects.toThrow(/active coupon/);

    const saved = await saveGrowthSettings(env.manager, { feedbackEnabled: true, feedbackDelayMinutes: 90, googleReviewUrl: "https://g.page/r/abc123/review", digestPhone: "98765 43210", referralEnabled: true });
    expect(saved).toMatchObject({ feedbackEnabled: true, feedbackDelayMinutes: 90, digestPhone: "+919876543210", referralEnabled: true, winbackAfterDays: 45 });
    expect((await viewGrowthSettings(prisma, env.manager)).googleReviewUrl).toBe("https://g.page/r/abc123/review");
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "GrowthSettings" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(audit!.before!)).toMatchObject({ feedbackEnabled: false });
    expect(JSON.parse(audit!.after!)).toMatchObject({ feedbackEnabled: true, feedbackDelayMinutes: 90 });
    // another tenant has its own (default) settings
    expect((await getGrowthSettings(prisma, env.foreign.organizationId)).feedbackEnabled).toBe(false);

    // A coupon id must be an active coupon of THIS restaurant
    const c = await createCoupon(env.manager, { code: `WEL${uniq()}`.toUpperCase().slice(0, 12), name: "Welcome", kind: "FIXED", value: 50 });
    expect((await saveGrowthSettings(env.manager, { birthdayCouponId: c.id })).birthdayCouponId).toBe(c.id);
    const other = await createCoupon(env.foreign, { code: `FRN${uniq()}`.toUpperCase().slice(0, 12), name: "Foreign coupon", kind: "FIXED", value: 10 });
    await expect(saveGrowthSettings(env.manager, { anniversaryCouponId: other.id })).rejects.toThrow(/active coupon/);
  });

  it("S1b the review link allowlist accepts only https on known review sites", () => {
    for (const ok of ["https://g.page/r/abc/review", "https://search.google.com/local/writereview?placeid=X", "https://www.zomato.com/hyderabad/x", "https://www.tripadvisor.in/Restaurant_Review-x"]) expect(isReviewUrl(ok), ok).toBe(true);
    for (const bad of ["http://g.page/r/x", "https://g.page.evil.com/r", "https://evilgoogle.com/x", "javascript:alert(1)", "https://x.example/https://g.page", "not a url", ""]) expect(isReviewUrl(bad), bad).toBe(false);
  });
});

describe("M1. the consent-gated message path", () => {
  it("M1 needs a provider for the channel, an address, and the guest's yes; marketing also respects quiet hours and the weekly cap", async () => {
    const g = await guest(env, "Kiran", { email: "kiran@example.com" });
    const base = { customerId: g.id, channel: "SMS" as const, purpose: "MARKETING" as const, template: "T", body: "Offer", now: NOON };

    expect(await queueCustomerMessage(env.owner, { ...base, key: `k1-${uniq()}` })).toMatchObject({ status: "SKIPPED", reason: expect.stringContaining("No SMS provider") });
    await connectMock(env.orgId);
    expect(await queueCustomerMessage(env.owner, { ...base, key: `k2-${uniq()}` })).toMatchObject({ status: "SKIPPED", reason: expect.stringContaining("not agreed") });
    expect(await queueCustomerMessage(env.owner, { ...base, channel: "EMAIL", key: `k3-${uniq()}` })).toMatchObject({ status: "SKIPPED" }); // no e-mail consent

    await setConsent(env.manager, g.id, [{ channel: "SMS", marketing: true }, { channel: "EMAIL", marketing: true }]);
    const key = `k4-${uniq()}`;
    const first = await queueCustomerMessage(env.owner, { ...base, key });
    expect(first.status).toBe("QUEUED");
    const d = (await deliveries(env.orgId, { idempotencyKey: key }))[0];
    expect(d).toMatchObject({ status: "SENT", mode: "MOCK", provider: "mock", sourceType: "Marketing", sourceId: g.id });
    expect(d.target).toMatch(/^\+91\*+\d{4}$/); // masked: the full number is never stored
    expect(JSON.parse(d.payload)).toMatchObject({ channel: "SMS", purpose: "MARKETING", body: "Offer" });
    expect(d.payload).not.toContain("kiran@example.com");

    // the same event again is a no-op
    expect(await queueCustomerMessage(env.owner, { ...base, key })).toMatchObject({ status: "DUPLICATE", deliveryId: d.id });

    // e-mail needs its own provider connection (the mock carries every channel, so it works here) and an address
    const mail = await queueCustomerMessage(env.owner, { ...base, channel: "EMAIL", key: `k5-${uniq()}`, subject: "Hello" });
    expect(mail.status).toBe("QUEUED");
    const md = await prisma.integrationDelivery.findUniqueOrThrow({ where: { id: mail.deliveryId! } });
    expect(md.target).toBe("k***@example.com");
    expect(JSON.parse(md.payload).subject).toBe("Hello");

    // quiet hours defer marketing, never transactional messages
    expect(await queueCustomerMessage(env.owner, { ...base, key: `k6-${uniq()}`, now: NIGHT })).toMatchObject({ status: "DEFERRED", reason: "Quiet hours" });
    expect((await queueCustomerMessage(env.owner, { ...base, purpose: "TRANSACTIONAL", key: `k7-${uniq()}`, now: NIGHT })).status).toBe("QUEUED");
  });

  it("M1b the weekly cap counts marketing per guest; a guest without an address or tenant mix-ups never get a message", async () => {
    const g = await guest(env, "Latha", { marketing: ["SMS"] });
    await saveGrowthSettings(env.manager, { marketingWeeklyCap: 2 });
    const send = (n: number, now = NOON) => queueCustomerMessage(env.owner, { customerId: g.id, channel: "SMS", purpose: "MARKETING", template: "T", body: "x", key: `cap-${g.id}-${n}`, now });
    const r1 = await send(1); expect(r1, JSON.stringify(r1)).toMatchObject({ status: "QUEUED" });
    expect((await send(2)).status).toBe("QUEUED");
    expect(await send(3)).toMatchObject({ status: "SKIPPED", reason: expect.stringContaining("Weekly") });
    // eight days after the sends (their rows carry the real clock) the window has moved on; 13:30 local, outside quiet hours
    const later = new Date(Date.now() + 8 * 86400_000);
    later.setUTCHours(8, 0, 0, 0);
    expect((await send(4, later)).status).toBe("QUEUED");

    const noPhone = await prisma.customer.create({ data: { organizationId: env.orgId, name: "No phone" } });
    await setConsent(env.manager, noPhone.id, [{ channel: "SMS", marketing: true }]);
    expect(await queueCustomerMessage(env.owner, { customerId: noPhone.id, channel: "SMS", purpose: "MARKETING", template: "T", body: "x", key: `np-${uniq()}`, now: NOON })).toMatchObject({ status: "SKIPPED", reason: expect.stringContaining("no mobile") });
    await expect(queueCustomerMessage(env.foreign, { customerId: g.id, channel: "SMS", purpose: "TRANSACTIONAL", template: "T", body: "x", key: `fx-${uniq()}`, now: NOON })).resolves.toMatchObject({ status: "SKIPPED" }); // no provider for the other tenant
    await connectMock(env.foreign.organizationId);
    await expect(queueCustomerMessage(env.foreign, { customerId: g.id, channel: "SMS", purpose: "TRANSACTIONAL", template: "T", body: "x", key: `fy-${uniq()}`, now: NOON })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("M1c quiet hours wrap midnight and an equal start and end means no quiet hours", () => {
    expect(inQuietHours(NIGHT, "Asia/Kolkata", 21, 9)).toBe(true);
    expect(inQuietHours(NOON, "Asia/Kolkata", 21, 9)).toBe(false);
    expect(inQuietHours(new Date("2026-10-07T03:00:00Z"), "Asia/Kolkata", 21, 9)).toBe(true); // 08:30
    expect(inQuietHours(new Date("2026-10-07T03:30:00Z"), "Asia/Kolkata", 21, 9)).toBe(false); // 09:00 exactly: the window has ended
    expect(inQuietHours(NIGHT, "Asia/Kolkata", 9, 9)).toBe(false);
    expect(inQuietHours(new Date("2026-10-07T06:30:00Z"), "Asia/Kolkata", 12, 14)).toBe(true); // plain window, 12:00
  });
});
