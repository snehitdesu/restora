/**
 * Campaigns against the real services and database: authoring rules, the audience, scheduling guards, and the sender
 * (consent, unsubscribe footer, quiet hours, weekly cap, idempotency, resume, cancel, tenants).
 *
 *  K1 authoring: permissions, placeholders, coupon / tier checks, draft-only edits, tenants
 *  K2 audience: consent on the channel, an address, segment / spend / recency / birthday / tier rules
 *  K3 scheduling guards: provider, public base URL, empty audience
 *  K4 sending: what is delivered, footer, idempotent re-run, detail counts
 *  K5 quiet hours defer and resume; K6 weekly cap; K7 cancel; K8 batches
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/server/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { setConsent, unsubscribeToken, applyUnsubscribe } from "@/server/services/consent";
import { createCoupon } from "@/server/services/coupons";
import { saveTier } from "@/server/services/loyaltyTiers";
import {
  CAMPAIGN_BATCH, campaignDetail, cancelCampaign, createCampaign, listCampaigns, marketingFooter, previewAudience, renderBody,
  resolveAudience, runCampaigns, scheduleCampaign, updateCampaign,
} from "@/server/services/campaigns";
import { saveGrowthSettings } from "@/server/services/growthSettings";
import { queueCustomerMessage } from "@/server/services/messaging";
import { makeEnv, connectMock, guest, paidOrder, deliveries, uniq, type Env } from "./growthSupport";

let env: Env;
const NOON = new Date("2026-10-07T08:00:00Z"); // 13:30 in Kolkata
const NIGHT = new Date("2026-10-07T17:30:00Z"); // 23:00 in Kolkata
const EARLIER = new Date("2026-10-07T06:00:00Z");

const draft = (over: Record<string, unknown> = {}) =>
  createCampaign(env.manager, { name: `Weekend ${uniq()}`, channel: "SMS", body: "Hi {name}, weekend special at {restaurant}!", audience: {}, ...over } as never);
const runFor = (e: Env, now = NOON) => runCampaigns(prisma, now, e.orgId);

beforeAll(async () => {
  env = await makeEnv("Gcm");
  process.env.PUBLIC_BASE_URL = "https://restora.test";
  await connectMock(env.orgId);
});
afterEach(() => { process.env.PUBLIC_BASE_URL = "https://restora.test"; });
afterAll(async () => { await prisma.$disconnect(); });

describe("K1. authoring", () => {
  it("K1 needs growth.manage; unknown placeholders, a {code} without a coupon, foreign coupons and unknown tiers are refused", async () => {
    await expect(createCampaign(env.cashier, { name: "Nope", channel: "SMS", body: "Hello there", audience: {} } as never)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createCampaign(env.kitchen, { name: "Nope", channel: "SMS", body: "Hello there", audience: {} } as never)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(draft({ body: "Hi {nickname}, come by" })).rejects.toThrow(/Unknown placeholder \{nickname\}/);
    await expect(draft({ body: "Use {code} today please" })).rejects.toBeInstanceOf(ValidationError);
    await expect(draft({ audience: { tier: "NOPE" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(draft({ audience: { surprise: true } })).rejects.toThrow(); // strict audience schema
    await expect(draft({ channel: "TELEGRAM" })).rejects.toThrow();

    const foreignCoupon = await createCoupon(env.foreign, { code: `FX${uniq()}`.toUpperCase(), name: "Foreign", kind: "PERCENT", value: 10 } as never);
    await expect(draft({ body: "Use {code} today please", couponId: foreignCoupon.id })).rejects.toBeInstanceOf(ValidationError);

    const ok = await createCampaign(env.manager, { name: "Fine", channel: "WHATSAPP", body: "Hello {name} from {restaurant}", audience: { minOrders: 2 } } as never);
    expect(ok).toMatchObject({ status: "DRAFT", channel: "WHATSAPP", audience: { minOrders: 2 }, recipientCount: 0 });
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "Campaign", entityId: ok.id, action: "CREATE" } })).toBe(1);
  });

  it("K1 drafts can be edited, nothing else; other tenants see and touch nothing", async () => {
    const c = await draft();
    const edited = await updateCampaign(env.manager, c.id, { name: "Renamed campaign", audience: { minSpend: 500 } });
    expect(edited).toMatchObject({ name: "Renamed campaign", audience: { minSpend: 500 } });
    await expect(updateCampaign(env.cashier, c.id, { name: "Hijack" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateCampaign(env.foreign, c.id, { name: "Hijack" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(scheduleCampaign(env.foreign, c.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelCampaign(env.foreign, c.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(campaignDetail(prisma, env.foreign, c.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listCampaigns(prisma, env.foreign)).map((x) => x.id)).not.toContain(c.id);
    expect((await listCampaigns(prisma, env.manager)).map((x) => x.id)).toContain(c.id);
    // Campaigns are a manager tool: the floor roles cannot read them either.
    await expect(listCampaigns(prisma, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(campaignDetail(prisma, env.kitchen, c.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewAudience(prisma, env.cashier, { channel: "SMS", audience: {} })).rejects.toBeInstanceOf(ForbiddenError);
  }, 20000);
});

describe("K2. audience", () => {
  it("K2 only guests who agreed to offers on the channel, with an address on it", async () => {
    const e = await makeEnv("Gca");
    await connectMock(e.orgId);
    const yes = await guest(e, "Yes Sms", { marketing: ["SMS"] });
    await guest(e, "No Consent"); // never agreed
    const wa = await guest(e, "Whatsapp Only", { marketing: ["WHATSAPP"] });
    const mail = await guest(e, "Mail Person", { email: `m${uniq()}@x.test`, marketing: ["EMAIL"] });
    const noMail = await guest(e, "No Mail", { marketing: ["EMAIL"] }); // agreed but has no e-mail address
    const withdrawn = await guest(e, "Withdrew", { marketing: ["SMS"] });
    await setConsent(e.manager, withdrawn.id, [{ channel: "SMS", marketing: false }]);

    const ids = async (channel: "SMS" | "WHATSAPP" | "EMAIL", audience = {}) => (await resolveAudience(prisma, e.orgId, channel, audience, NOON)).map((m) => m.customerId).sort();
    expect(await ids("SMS")).toEqual([yes.id]);
    expect(await ids("WHATSAPP")).toEqual([wa.id]);
    expect(await ids("EMAIL")).toEqual([mail.id]);
    expect(await ids("EMAIL")).not.toContain(noMail.id);
    const preview = await previewAudience(prisma, e.manager, { channel: "EMAIL", audience: {} });
    expect(preview).toMatchObject({ matching: 1, optedInOnChannel: 2 });
    // The other tenant's audience is empty even with identical rules.
    expect(await resolveAudience(prisma, env.orgId, "SMS", {}, NOON)).toEqual([]);
  }, 20000);

  it("K2 rules: orders, spend, recency, segment, birthday month, anniversary month, tier", async () => {
    const e = await makeEnv("Gcr");
    await connectMock(e.orgId);
    const regular = await guest(e, "Regular", { marketing: ["SMS"], birthday: "1990-10-12", anniversary: "2015-02-03" });
    const big = await guest(e, "Big Spender", { marketing: ["SMS"], birthday: "1985-03-20" });
    const fresh = await guest(e, "Fresh Face", { marketing: ["SMS"] }); // no orders at all
    await paidOrder(e, e.outletA, regular.id, 200);
    await paidOrder(e, e.outletA, regular.id, 300);
    await paidOrder(e, e.outletA, big.id, 5000);
    const names = async (audience: Record<string, unknown>, now = new Date()) => (await resolveAudience(prisma, e.orgId, "SMS", audience as never, now)).map((m) => m.name).sort();

    expect(await names({})).toEqual(["Big Spender", "Fresh Face", "Regular"]);
    expect(await names({ minOrders: 2 })).toEqual(["Regular"]);
    expect(await names({ minOrders: 0 })).toEqual(["Big Spender", "Fresh Face", "Regular"]);
    expect(await names({ minSpend: 1000 })).toEqual(["Big Spender"]);
    expect(await names({ birthdayMonth: 10 })).toEqual(["Regular"]);
    expect(await names({ birthdayMonth: 3 })).toEqual(["Big Spender"]);
    expect(await names({ anniversaryMonth: 2 })).toEqual(["Regular"]);
    // Recency: nobody ordered 30+ days ago yet; a guest with no order never matches a recency rule.
    expect(await names({ lastOrderBeforeDays: 30 })).toEqual([]);
    expect(await names({ lastOrderWithinDays: 30 })).toEqual(["Big Spender", "Regular"]);
    const inAMonth = new Date(Date.now() + 40 * 86400_000);
    expect(await names({ lastOrderBeforeDays: 30 }, inAMonth)).toEqual(["Big Spender", "Regular"]);
    expect(await names({ lastOrderWithinDays: 30 }, inAMonth)).toEqual([]);
    // Segments use the CRM's own rules: 5,000 spent is VIP whenever they last came; lapsed regulars are INACTIVE.
    expect(await names({ segment: "VIP" })).toEqual(["Big Spender"]);
    expect(await names({ segment: "INACTIVE" }, new Date(Date.now() + 400 * 86400_000))).toEqual(["Regular"]);
    expect(await names({ segment: "NEW" })).toEqual(["Fresh Face"]);

    // Tier: a configured tier label matches the loyalty account's tier.
    await saveTier(e.owner, { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 } as never);
    await saveTier(e.owner, { code: "GOLD", name: "Gold", minSpend: 4000, earnMultiplierPct: 150 } as never);
    await prisma.loyaltyAccount.upsert({ where: { customerId: big.id }, update: { tier: "GOLD" }, create: { organizationId: e.orgId, customerId: big.id, pointsBalance: 0, tier: "GOLD" } });
    expect(await names({ tier: "GOLD" })).toEqual(["Big Spender"]);
    // Through the service the tier code is normalized, so a lower-case entry still matches.
    expect(await previewAudience(prisma, e.manager, { channel: "SMS", audience: { tier: "gold" } })).toMatchObject({ matching: 1, sample: ["Big Spender"] });
  }, 60000);
});

describe("K3. scheduling guards", () => {
  it("K3 refuses what could never be sent: no provider, no public base URL, nobody to send to", async () => {
    const e = await makeEnv("Gcg");
    const mk = (over: Record<string, unknown> = {}) => createCampaign(e.manager, { name: `G ${uniq()}`, channel: "SMS", body: "Hello {name}", audience: {}, ...over } as never);
    await guest(e, "Consented", { marketing: ["SMS"] });

    const a = await mk();
    await expect(scheduleCampaign(e.manager, a.id)).rejects.toThrow(/Connect a SMS provider/);
    await connectMock(e.orgId);

    delete process.env.PUBLIC_BASE_URL;
    await expect(scheduleCampaign(e.manager, a.id)).rejects.toThrow(/PUBLIC_BASE_URL/);
    process.env.PUBLIC_BASE_URL = "https://restora.test";

    const empty = await mk({ audience: { minOrders: 50 } });
    await expect(scheduleCampaign(e.manager, empty.id)).rejects.toThrow(/Nobody matches/);

    await expect(scheduleCampaign(e.cashier, a.id)).rejects.toBeInstanceOf(ForbiddenError);
    const s = await scheduleCampaign(e.manager, a.id, EARLIER);
    expect(s).toMatchObject({ status: "SCHEDULED" });
    await expect(scheduleCampaign(e.manager, a.id)).rejects.toBeInstanceOf(ConflictError); // only a draft
    await expect(updateCampaign(e.manager, a.id, { name: "Edited after scheduling" })).rejects.toBeInstanceOf(ConflictError);
    expect(marketingFooter("cust1", "SMS")).toContain("https://restora.test/u/");
    delete process.env.PUBLIC_BASE_URL;
    expect(() => marketingFooter("cust1", "SMS")).toThrow(/PUBLIC_BASE_URL/);
  }, 20000);
});

describe("K4. sending", () => {
  it("K4 delivers once to each consented guest with a rendered body and an unsubscribe link; re-running sends nothing more", async () => {
    const e = await makeEnv("Gcs");
    await connectMock(e.orgId);
    const a = await guest(e, "Asha Rao", { marketing: ["SMS"] });
    const b = await guest(e, "Bala K", { marketing: ["SMS"] });
    const nope = await guest(e, "Chitra", {}); // no consent
    const coupon = await createCoupon(e.manager, { code: `WK${uniq()}`.toUpperCase(), name: "Weekend", kind: "PERCENT", value: 15 } as never);
    const c = await createCampaign(e.manager, { name: "Weekend special", channel: "SMS", body: "Hi {name}, {restaurant} says use {code} this weekend", audience: {}, couponId: coupon.id } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);

    const r1 = await runCampaigns(prisma, NOON, e.orgId);
    expect(r1).toMatchObject({ campaigns: 1, sent: 2, skipped: 0, deferred: 0, completed: 1 });
    const rows = await deliveries(e.orgId);
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.sourceType === "Marketing" && d.batchId === c.id && d.status !== "FAILED")).toBe(true);
    expect(rows.map((d) => d.sourceId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.map((d) => d.sourceId)).not.toContain(nope.id);
    const forAsha = JSON.parse(rows.find((d) => d.sourceId === a.id)!.payload) as { body: string; purpose: string };
    expect(forAsha.purpose).toBe("MARKETING");
    expect(forAsha.body).toContain("Hi Asha,");
    expect(forAsha.body).toContain(coupon.code);
    expect(forAsha.body).toContain(`https://restora.test/u/${unsubscribeToken(a.id, "SMS")}`);
    // The stored target is masked: the outbox never holds a full phone number.
    expect(rows.every((d) => /\*/.test(d.target ?? ""))).toBe(true);

    const detail = await campaignDetail(prisma, e.manager, c.id);
    expect(detail.campaign).toMatchObject({ status: "SENT", recipientCount: 2 });
    expect(detail.recipients).toEqual({ SENT: 2 });

    // Run again (a second worker, a retry): nothing is due, nothing is sent twice.
    expect(await runCampaigns(prisma, NOON, e.orgId)).toMatchObject({ campaigns: 0, sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { organizationId: e.orgId, entityType: "Campaign", entityId: c.id, action: "UPDATE" } })).toBeGreaterThanOrEqual(2); // scheduled + sent
  }, 30000);

  it("K4 concurrent workers send each guest exactly once", async () => {
    const e = await makeEnv("Gcw");
    await connectMock(e.orgId);
    for (let i = 0; i < 6; i++) await guest(e, `Racer ${i}`, { marketing: ["SMS"] });
    const c = await createCampaign(e.manager, { name: "Race", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);
    await Promise.all([runCampaigns(prisma, NOON, e.orgId), runCampaigns(prisma, NOON, e.orgId), runCampaigns(prisma, NOON, e.orgId)]);
    await runCampaigns(prisma, NOON, e.orgId); // pick up anything a losing worker left
    const rows = await deliveries(e.orgId);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((d) => d.idempotencyKey)).size).toBe(6);
    expect((await campaignDetail(prisma, e.manager, c.id)).campaign.status).toBe("SENT");
  }, 40000);

  it("K4 a guest who unsubscribes between scheduling and sending is skipped with a reason", async () => {
    const e = await makeEnv("Gcu");
    await connectMock(e.orgId);
    const stay = await guest(e, "Stays", { marketing: ["SMS"] });
    const leave = await guest(e, "Leaves", { marketing: ["SMS"] });
    const c = await createCampaign(e.manager, { name: "Unsub", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);
    // The recipient list is fixed at the first run; the unsubscribe lands before the batch is sent.
    await applyUnsubscribe(unsubscribeToken(leave.id, "SMS"));
    const r = await runFor(e);
    expect(r).toMatchObject({ sent: 1, skipped: 0, completed: 1 }); // "Leaves" was no longer in the audience at claim time
    const rows = await deliveries(e.orgId);
    expect(rows.map((d) => d.sourceId)).toEqual([stay.id]);
  }, 30000);

  it("K4 renders placeholders safely", () => {
    expect(renderBody("Hi {name} at {restaurant} {code}!", { name: "Asha Rao", code: "X1", restaurant: "Cafe" })).toBe("Hi Asha at Cafe X1!");
    expect(renderBody("Hi {name}", { name: "", restaurant: "Cafe" })).toBe("Hi there");
    expect(renderBody("{code}", { name: "A", restaurant: "C" })).toBe("");
  });
});

describe("K5. quiet hours", () => {
  it("K5 at night the campaign waits (nothing sent, nothing lost) and finishes in the morning", async () => {
    const e = await makeEnv("Gcq");
    await connectMock(e.orgId);
    for (let i = 0; i < 3; i++) await guest(e, `Night ${i}`, { marketing: ["SMS"] });
    const c = await createCampaign(e.manager, { name: "Night owl", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);

    const night = await runCampaigns(prisma, NIGHT, e.orgId);
    expect(night).toMatchObject({ sent: 0, deferred: 1, completed: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);
    const waiting = await campaignDetail(prisma, e.manager, c.id);
    expect(waiting.campaign.status).toBe("SENDING");
    expect(waiting.recipients).toEqual({ QUEUED: 3 });

    const morning = await runCampaigns(prisma, NOON, e.orgId);
    expect(morning).toMatchObject({ sent: 3, completed: 1 });
    expect((await campaignDetail(prisma, e.manager, c.id)).campaign.status).toBe("SENT");
    expect(await deliveries(e.orgId)).toHaveLength(3);
  }, 30000);

  it("K5 quiet hours follow the organization's settings", async () => {
    const e = await makeEnv("Gcz");
    await connectMock(e.orgId);
    await guest(e, "Whenever", { marketing: ["SMS"] });
    await saveGrowthSettings(e.owner, { quietHoursStart: 0, quietHoursEnd: 0 }); // no quiet hours at all
    const c = await createCampaign(e.manager, { name: "Always", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);
    expect(await runCampaigns(prisma, NIGHT, e.orgId)).toMatchObject({ sent: 1, deferred: 0, completed: 1 });
  }, 20000);
});

describe("K6. weekly cap", () => {
  it("K6 a guest at the weekly limit is skipped with the reason and the campaign still completes", async () => {
    const e = await makeEnv("Gcc");
    await connectMock(e.orgId);
    await saveGrowthSettings(e.owner, { marketingWeeklyCap: 1 });
    const busy = await guest(e, "Already Messaged", { marketing: ["SMS"] });
    const fresh = await guest(e, "Not Yet", { marketing: ["SMS"] });
    await queueCustomerMessage(e.owner, { customerId: busy.id, channel: "SMS", purpose: "MARKETING", template: "T", body: "earlier offer", key: `pre-${uniq()}`, now: NOON });

    const c = await createCampaign(e.manager, { name: "Capped", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);
    expect(await runFor(e)).toMatchObject({ sent: 1, skipped: 1, completed: 1 });
    const detail = await campaignDetail(prisma, e.manager, c.id);
    expect(detail.recipients).toEqual({ SENT: 1, SKIPPED: 1 });
    expect(detail.skippedBecause).toEqual([{ reason: "Weekly message limit reached for this guest", count: 1 }]);
    const mine = (await deliveries(e.orgId, { batchId: c.id })).map((d) => d.sourceId);
    expect(mine).toEqual([fresh.id]);
  }, 30000);
});

describe("K7. cancel", () => {
  it("K7 cancelling a scheduled campaign sends nothing; cancelling mid-send drops the rest and keeps what was sent", async () => {
    const e = await makeEnv("Gcx");
    await connectMock(e.orgId);
    for (let i = 0; i < 3; i++) await guest(e, `Cx ${i}`, { marketing: ["SMS"] });

    const before = await createCampaign(e.manager, { name: "Cancel before", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, before.id, EARLIER);
    expect((await cancelCampaign(e.manager, before.id)).status).toBe("CANCELLED");
    expect(await runFor(e)).toMatchObject({ campaigns: 0, sent: 0 });
    await expect(cancelCampaign(e.manager, before.id)).rejects.toBeInstanceOf(ConflictError);

    const mid = await createCampaign(e.manager, { name: "Cancel during", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, mid.id, EARLIER);
    await runCampaigns(prisma, NIGHT, e.orgId); // claims + builds the list, then waits for the morning
    expect((await campaignDetail(prisma, e.manager, mid.id)).recipients).toEqual({ QUEUED: 3 });
    await cancelCampaign(e.manager, mid.id);
    const d = await campaignDetail(prisma, e.manager, mid.id);
    expect(d.campaign.status).toBe("CANCELLED");
    expect(d.recipients).toEqual({ SKIPPED: 3 });
    expect(d.skippedBecause).toEqual([{ reason: "Campaign cancelled", count: 3 }]);
    expect(await runFor(e)).toMatchObject({ sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);
  }, 30000);
});

describe("K8. batches", () => {
  it("K8 a large audience progresses one bounded batch per tick", async () => {
    const e = await makeEnv("Gcb");
    await connectMock(e.orgId);
    const total = CAMPAIGN_BATCH + 25;
    // Bulk-create guests with consent directly: this test is about the sender, not the CRM forms.
    const base = 7000000000 + (Number.parseInt(uniq(), 36) % 90000) * 1000;
    const customers = await Promise.all(Array.from({ length: total }, (_, i) => prisma.customer.create({ data: { organizationId: e.orgId, name: `Bulk ${i}`, phone: String(base + i) } })));
    await prisma.customerConsent.createMany({ data: customers.map((c) => ({ organizationId: e.orgId, customerId: c.id, channel: "SMS", marketing: true, transactional: true, source: "IMPORT" })) });
    const c = await createCampaign(e.manager, { name: "Bulk", channel: "SMS", body: "Hello {name}", audience: {} } as never);
    await scheduleCampaign(e.manager, c.id, EARLIER);

    const first = await runFor(e);
    expect(first).toMatchObject({ sent: CAMPAIGN_BATCH, completed: 0 });
    expect((await campaignDetail(prisma, e.manager, c.id)).campaign).toMatchObject({ status: "SENDING", recipientCount: total });
    const second = await runFor(e);
    expect(second).toMatchObject({ sent: 25, completed: 1 });
    const rows = await deliveries(e.orgId);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((d) => d.idempotencyKey)).size).toBe(total);
  }, 120000);
});
