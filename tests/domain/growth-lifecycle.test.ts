/**
 * Growth automations against the real services and database (the mock messaging provider is the outbox the tests read):
 * birthday / anniversary / win-back offers, booking confirmation and reminder, the nightly tier refresh, the 9 AM
 * summary, and the orchestrator (one run per organization per day, failures isolated).
 *
 *  L1 date offers: once per year, consented, coupon-gated, 29 February
 *  L2 win-back: lapsed guests only, once per cooldown window
 *  L3 booking confirmation and reminder
 *  L4 tier refresh   L5 daily summary   L6 orchestrator
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { createCoupon } from "@/server/services/coupons";
import { saveTier } from "@/server/services/loyaltyTiers";
import { getGrowthSettings, saveGrowthSettings } from "@/server/services/growthSettings";
import { createReservation, cancelReservation } from "@/server/services/reservations";
import { setConsent } from "@/server/services/consent";
import { dateMatchesToday, JOBS, refreshTiers, runBookingMessages, runGrowthJobs, sendDateOffers, sendDigest, sendWinback } from "@/server/services/lifecycle";
import { localDate } from "@/domain/time";
import { makeEnv, connectMock, guest, paidOrder, deliveries, uniq, type Env } from "./growthSupport";

const NOON = new Date("2026-10-07T08:00:00Z"); // 13:30 in Kolkata, outside the default 21:00-09:00 quiet hours
const NIGHT = new Date("2026-10-07T17:30:00Z"); // 23:00 in Kolkata

/** `days` from now, at 13:30 Kolkata time, so marketing is never in quiet hours. */
const daytime = (days: number) => {
  const d = new Date(Date.now() + days * 86400_000);
  d.setUTCHours(8, 0, 0, 0);
  return d;
};
const body = (d: { payload: string }) => (JSON.parse(d.payload) as { body: string }).body;

afterAll(async () => { await prisma.$disconnect(); });
beforeAll(() => { process.env.PUBLIC_BASE_URL = "https://restora.test"; });

describe("L1. birthday and anniversary offers", () => {
  it("L1 sent on the day to guests who agreed, once per year, only when the offer coupon is set", async () => {
    const e = await makeEnv("Gla");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `BD${uniq()}`.toUpperCase(), name: "Birthday treat", kind: "PERCENT", value: 20 } as never);
    const today = "2026-10-08";
    const bday = await guest(e, "Birthday Girl", { marketing: ["SMS"], birthday: "1990-10-08" });
    await guest(e, "Other Day", { marketing: ["SMS"], birthday: "1990-10-09" });
    await guest(e, "No Consent", { birthday: "1990-10-08" });
    const settings = async () => getGrowthSettings(prisma, e.orgId);

    // Off until an offer coupon is chosen.
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", today, await settings(), NOON)).toEqual({ eligible: 0, sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);

    await saveGrowthSettings(e.owner, { birthdayCouponId: coupon.id });
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", today, await settings(), NOON)).toEqual({ eligible: 1, sent: 1 });
    const rows = await deliveries(e.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: "Marketing", sourceId: bday.id });
    expect(body(rows[0])).toContain("Happy birthday, Birthday!");
    expect(body(rows[0])).toContain(coupon.code);
    expect(body(rows[0])).toMatch(/Unsubscribe: https:\/\/restora\.test\/u\//);

    // Re-running the same day (a restart, a second worker) sends nothing more; next year it does.
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", today, await settings(), NOON)).toEqual({ eligible: 1, sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(1);
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", "2027-10-08", await settings(), NOON)).toEqual({ eligible: 1, sent: 1 });
    expect(await deliveries(e.orgId)).toHaveLength(2);

    // A deactivated coupon stops the offer; the anniversary offer is separate.
    await prisma.coupon.update({ where: { id: coupon.id }, data: { active: false } });
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", "2028-10-08", await settings(), NOON)).toEqual({ eligible: 0, sent: 0 });
    expect(await sendDateOffers(prisma, e.orgId, "ANNIVERSARY", today, await settings(), NOON)).toEqual({ eligible: 0, sent: 0 });
  }, 40000);

  it("L1 anniversary offers use the anniversary date and a guest's own channel preference", async () => {
    const e = await makeEnv("Glb");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `AN${uniq()}`.toUpperCase(), name: "Anniversary", kind: "FIXED", value: 100 } as never);
    await saveGrowthSettings(e.owner, { anniversaryCouponId: coupon.id });
    const g = await guest(e, "Couple One", { marketing: ["WHATSAPP"], anniversary: "2015-10-08" });
    const settings = await getGrowthSettings(prisma, e.orgId);
    expect(await sendDateOffers(prisma, e.orgId, "ANNIVERSARY", "2026-10-08", settings, NOON)).toEqual({ eligible: 1, sent: 1 });
    const rows = await deliveries(e.orgId);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ channel: "WHATSAPP", template: "LIFECYCLE_ANNIVERSARY" });
    expect(rows[0].sourceId).toBe(g.id);
  }, 20000);

  it("L1 during quiet hours nothing goes out", async () => {
    const e = await makeEnv("Glq");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `QH${uniq()}`.toUpperCase(), name: "Quiet", kind: "PERCENT", value: 10 } as never);
    await saveGrowthSettings(e.owner, { birthdayCouponId: coupon.id });
    await guest(e, "Late Birthday", { marketing: ["SMS"], birthday: "1991-10-07" });
    const settings = await getGrowthSettings(prisma, e.orgId);
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", "2026-10-07", settings, NIGHT)).toEqual({ eligible: 1, sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);
    expect(await sendDateOffers(prisma, e.orgId, "BIRTHDAY", "2026-10-07", settings, NOON)).toEqual({ eligible: 1, sent: 1 }); // morning: still due, now sent
  }, 20000);

  it("L1 29 February is celebrated on 28 February in other years and on the 29th in leap years", () => {
    const leapDay = new Date("2000-02-29T00:00:00Z");
    expect(dateMatchesToday(leapDay, "2027-02-28")).toBe(true);
    expect(dateMatchesToday(leapDay, "2027-03-01")).toBe(false);
    expect(dateMatchesToday(leapDay, "2028-02-29")).toBe(true);
    expect(dateMatchesToday(leapDay, "2028-02-28")).toBe(false);
    expect(dateMatchesToday(new Date("1990-10-08T00:00:00Z"), "2026-10-08")).toBe(true);
    expect(dateMatchesToday(new Date("1990-10-08T00:00:00Z"), "2026-10-09")).toBe(false);
  });
});

describe("L2. win-back", () => {
  it("L2 only lapsed guests who agreed; once per cooldown window; the message carries the code and the unsubscribe link", async () => {
    const e = await makeEnv("Gwb");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `WB${uniq()}`.toUpperCase(), name: "Come back", kind: "PERCENT", value: 25 } as never);
    await saveGrowthSettings(e.owner, { winbackCouponId: coupon.id, winbackAfterDays: 45, winbackCooldownDays: 90 });
    const settings = await getGrowthSettings(prisma, e.orgId);
    const lapsed = await guest(e, "Lapsed Lata", { marketing: ["SMS"] });
    const loyal = await guest(e, "Loyal Lal", { marketing: ["SMS"] });
    const silent = await guest(e, "Silent Sam", {}); // lapsed but never agreed
    await paidOrder(e, e.outletA, lapsed.id, 400);
    await paidOrder(e, e.outletA, silent.id, 400);
    await paidOrder(e, e.outletA, loyal.id, 400);

    // Ten days on nobody is lapsed. Sixty days on everyone is, but only the consented guests are written to.
    expect(await sendWinback(prisma, e.orgId, settings, daytime(10))).toEqual({ eligible: 0, sent: 0 });
    const t60 = daytime(60);
    const first = await sendWinback(prisma, e.orgId, settings, t60);
    expect(first).toEqual({ eligible: 2, sent: 2 }); // lapsed + loyal both consented, both past 45 days at +60d
    const rows = await deliveries(e.orgId);
    expect(rows.map((d) => d.sourceId).sort()).toEqual([lapsed.id, loyal.id].sort());
    expect(rows.map((d) => d.sourceId)).not.toContain(silent.id);
    expect(body(rows[0])).toContain(coupon.code);
    expect(body(rows[0])).toMatch(/Unsubscribe: https:\/\/restora\.test\/u\//);

    // Same window: nothing again. A full cooldown later: a new reminder.
    expect(await sendWinback(prisma, e.orgId, settings, t60)).toEqual({ eligible: 2, sent: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(2);
    expect(await sendWinback(prisma, e.orgId, settings, daytime(60 + 91))).toEqual({ eligible: 2, sent: 2 });
    expect(await deliveries(e.orgId)).toHaveLength(4);
  }, 60000);

  it("L2 a guest inside the inactivity window is not lapsed; with no coupon chosen the automation is off", async () => {
    const e = await makeEnv("Gwr");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `WR${uniq()}`.toUpperCase(), name: "Come back", kind: "PERCENT", value: 25 } as never);
    await saveGrowthSettings(e.owner, { winbackCouponId: coupon.id });
    const settings = await getGrowthSettings(prisma, e.orgId);
    const g = await guest(e, "Returning Rani", { marketing: ["SMS"] });
    await paidOrder(e, e.outletA, g.id, 300);
    expect(await sendWinback(prisma, e.orgId, settings, daytime(50))).toMatchObject({ eligible: 1 });
    expect((await deliveries(e.orgId)).length).toBe(1);
    // Without a coupon configured the automation is off, whatever the data says.
    const none = await makeEnv("Gwn");
    await connectMock(none.orgId);
    const lapsed = await guest(none, "Would Qualify", { marketing: ["SMS"] });
    await paidOrder(none, none.outletA, lapsed.id, 300);
    expect(await sendWinback(prisma, none.orgId, await getGrowthSettings(prisma, none.orgId), daytime(90))).toEqual({ eligible: 0, sent: 0 });
    expect(await deliveries(none.orgId)).toHaveLength(0);
  }, 30000);
});

describe("L3. booking confirmation and reminder", () => {
  it("L3 off by default; on, a booking is confirmed once and reminded once", async () => {
    const e = await makeEnv("Gbk");
    await connectMock(e.orgId);
    const g = await guest(e, "Booker", {});
    const soon = await createReservation(e.manager, { outletId: e.outletA, customerId: g.id, partySize: 4, reservedAt: new Date(Date.now() + 60 * 60_000) });
    const later = await createReservation(e.manager, { outletId: e.outletA, customerId: g.id, partySize: 2, reservedAt: new Date(Date.now() + 30 * 3600_000) });
    const walkIn = await createReservation(e.manager, { outletId: e.outletA, partySize: 2, reservedAt: new Date(Date.now() + 2 * 3600_000) }); // no guest record
    const cancelled = await createReservation(e.manager, { outletId: e.outletA, customerId: g.id, partySize: 2, reservedAt: new Date(Date.now() + 90 * 60_000) });
    await cancelReservation(e.manager, cancelled.id);

    expect(await runBookingMessages(prisma, new Date(), e.orgId)).toEqual({ confirmations: 0, reminders: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);

    await saveGrowthSettings(e.owner, { bookingMessagesEnabled: true, bookingReminderHours: 2 });
    const r1 = await runBookingMessages(prisma, new Date(), e.orgId);
    expect(r1).toEqual({ confirmations: 2, reminders: 1 }); // soon + later confirmed; only "soon" is inside the 2 h reminder window
    const rows = await deliveries(e.orgId);
    const keys = rows.map((d) => d.idempotencyKey).sort();
    expect(keys).toEqual([`resv:${later.id}:CONFIRM`, `resv:${soon.id}:CONFIRM`, `resv:${soon.id}:REMIND`].sort());
    expect(rows.every((d) => d.sourceType === "Reservation")).toBe(true);
    expect(keys.some((k) => k.includes(walkIn.id) || k.includes(cancelled.id))).toBe(false);
    const confirm = rows.find((d) => d.idempotencyKey === `resv:${soon.id}:CONFIRM`)!;
    expect(body(confirm)).toMatch(/table for 4/);
    expect(JSON.parse(confirm.payload)).toMatchObject({ purpose: "TRANSACTIONAL" }); // not marketing: no unsubscribe footer or cap

    // The next tick repeats nothing.
    expect(await runBookingMessages(prisma, new Date(), e.orgId)).toEqual({ confirmations: 0, reminders: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(3);
  }, 40000);

  it("L3 a guest who opted out of order messages is not messaged about the booking", async () => {
    const e = await makeEnv("Gbo");
    await connectMock(e.orgId);
    await saveGrowthSettings(e.owner, { bookingMessagesEnabled: true });
    const g = await guest(e, "Opted Out", {});
    await setConsent(e.manager, g.id, [{ channel: "SMS", transactional: false }, { channel: "WHATSAPP", transactional: false }, { channel: "EMAIL", transactional: false }]);
    await createReservation(e.manager, { outletId: e.outletA, customerId: g.id, partySize: 2, reservedAt: new Date(Date.now() + 60 * 60_000) });
    expect(await runBookingMessages(prisma, new Date(), e.orgId)).toEqual({ confirmations: 0, reminders: 0 });
    expect(await deliveries(e.orgId)).toHaveLength(0);
  }, 20000);
});

describe("L4. tier refresh", () => {
  it("L4 tiers follow trailing spend: a stale tier is corrected and the change is audited", async () => {
    const e = await makeEnv("Gtr");
    await connectMock(e.orgId);
    await saveTier(e.owner, { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 } as never);
    await saveTier(e.owner, { code: "GOLD", name: "Gold", minSpend: 4000, earnMultiplierPct: 150 } as never);
    const stale = await guest(e, "Stale Gold", {});
    const real = await guest(e, "Real Gold", {});
    await paidOrder(e, e.outletA, real.id, 5000);
    await prisma.loyaltyAccount.upsert({ where: { customerId: stale.id }, update: { tier: "GOLD" }, create: { organizationId: e.orgId, customerId: stale.id, pointsBalance: 0, tier: "GOLD" } });
    await prisma.loyaltyAccount.update({ where: { customerId: real.id }, data: { tier: "BASE" } }); // as if the nightly job had not run yet

    const res = await refreshTiers(prisma, e.orgId, new Date());
    expect(res.changed).toBe(2);
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { customerId: stale.id } })).tier).toBe("BASE");
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { customerId: real.id } })).tier).toBe("GOLD");
    const audits = await prisma.auditLog.findMany({ where: { organizationId: e.orgId, entityType: "LoyaltyAccount", action: "UPDATE" } });
    expect(audits.filter((a) => JSON.parse(a.after ?? "{}").via === "nightly refresh")).toHaveLength(2);
    expect((await refreshTiers(prisma, e.orgId, new Date())).changed).toBe(0); // idempotent
    // Spend ages out of the 365-day window.
    const nextYear = new Date(Date.now() + 400 * 86400_000);
    expect((await refreshTiers(prisma, e.orgId, nextYear)).changed).toBe(1);
    expect((await prisma.loyaltyAccount.findUniqueOrThrow({ where: { customerId: real.id } })).tier).toBe("BASE");
    // No tiers configured: the legacy ladder is untouched.
    const none = await makeEnv("Gtn");
    expect(await refreshTiers(prisma, none.orgId)).toEqual({ checked: 0, changed: 0 });
  }, 40000);
});

describe("L5. daily summary", () => {
  it("L5 one notification per outlet and one message to the configured number, once per day", async () => {
    const e = await makeEnv("Gds");
    await connectMock(e.orgId);
    const tz = "Asia/Kolkata";
    const g = await guest(e, "Spender", {});
    await paidOrder(e, e.outletA, g.id, 1500);
    await paidOrder(e, e.outletA, g.id, 500);
    const reportedDay = localDate(new Date(), tz);
    const today = localDate(new Date(Date.now() + 86400_000), tz); // the digest covers "yesterday" = the day the orders were paid

    const noNumber = await sendDigest(prisma, e.orgId, today, new Date());
    expect(noNumber).toMatchObject({ outlets: 2, notified: 2, message: "NONE" });
    const notes = await prisma.notification.findMany({ where: { organizationId: e.orgId, type: "DAILY_SUMMARY" } });
    expect(notes).toHaveLength(2);
    expect(notes.some((n) => /2 orders, Rs\.2,000\.00/.test(n.title))).toBe(true);
    expect(await deliveries(e.orgId)).toHaveLength(0);

    await saveGrowthSettings(e.owner, { digestPhone: "9876543210" });
    const withNumber = await sendDigest(prisma, e.orgId, today, new Date());
    expect(withNumber.message).toBe("QUEUED");
    const rows = await deliveries(e.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceType: "Digest", sourceId: e.orgId, idempotencyKey: `digest:${e.orgId}:${reportedDay}` });
    expect(rows[0].target).toMatch(/\*/);
    expect(body(rows[0])).toContain("2 orders");
    expect((await sendDigest(prisma, e.orgId, today, new Date())).message).toBe("DUPLICATE");
    expect(await deliveries(e.orgId)).toHaveLength(1);
    // Notifications are de-duplicated inside their window.
    expect(await prisma.notification.count({ where: { organizationId: e.orgId, type: "DAILY_SUMMARY" } })).toBe(2);
  }, 40000);
});

describe("L6. orchestrator", () => {
  it("L6 each daily job runs once per organization per local day; a restart or second worker repeats nothing", async () => {
    const e = await makeEnv("Gor");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `OR${uniq()}`.toUpperCase(), name: "Birthday", kind: "PERCENT", value: 10 } as never);
    await saveGrowthSettings(e.owner, { birthdayCouponId: coupon.id });
    await saveTier(e.owner, { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 } as never);
    const tz = "Asia/Kolkata";
    const now = daytime(0);
    const date = localDate(now, tz);
    const monthDay = date.slice(5);
    await guest(e, "Born Today", { marketing: ["SMS"], birthday: `1990-${monthDay}` });

    const first = await runGrowthJobs(prisma, now, e.orgId);
    expect(first.daily.filter((d) => d.organizationId === e.orgId).map((d) => d.job).sort()).toEqual([JOBS.BIRTHDAY, JOBS.TIERS].sort());
    expect(first.daily.every((d) => d.status === "SUCCESS")).toBe(true);
    expect(await deliveries(e.orgId)).toHaveLength(1);

    const second = await runGrowthJobs(prisma, now, e.orgId);
    expect(second.daily).toEqual([]);
    expect(await deliveries(e.orgId)).toHaveLength(1);
    const claims = await prisma.jobRun.findMany({ where: { scopeKey: e.orgId } });
    expect(claims.map((c) => `${c.name}:${c.runDate}:${c.status}`).sort()).toEqual([`${JOBS.BIRTHDAY}:${date}:SUCCESS`, `${JOBS.TIERS}:${date}:SUCCESS`].sort());

    // Two workers at once: exactly one wins each claim.
    const tomorrow = new Date(now.getTime() + 86400_000);
    const racing = await Promise.all([runGrowthJobs(prisma, tomorrow, e.orgId), runGrowthJobs(prisma, tomorrow, e.orgId), runGrowthJobs(prisma, tomorrow, e.orgId)]);
    const ran = racing.flatMap((r) => r.daily.filter((d) => d.organizationId === e.orgId).map((d) => d.job));
    expect(ran.filter((j) => j === JOBS.TIERS)).toHaveLength(1);
  }, 60000);

  it("L6 quiet hours hold the offer jobs back but not the nightly tier refresh", async () => {
    const e = await makeEnv("Gqh");
    await connectMock(e.orgId);
    const coupon = await createCoupon(e.manager, { code: `QJ${uniq()}`.toUpperCase(), name: "Birthday", kind: "PERCENT", value: 10 } as never);
    await saveGrowthSettings(e.owner, { birthdayCouponId: coupon.id });
    await saveTier(e.owner, { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 } as never);
    const night = new Date("2026-10-07T18:00:00Z"); // 23:30 Kolkata
    const r = await runGrowthJobs(prisma, night, e.orgId);
    expect(r.daily.map((d) => d.job)).toEqual([JOBS.TIERS]);
    // Next morning the birthday job runs (its claim was never taken).
    const morning = new Date("2026-10-08T05:00:00Z"); // 10:30 Kolkata
    const r2 = await runGrowthJobs(prisma, morning, e.orgId);
    expect(r2.daily.map((d) => d.job).sort()).toEqual([JOBS.BIRTHDAY, JOBS.TIERS].sort());
  }, 30000);
});
