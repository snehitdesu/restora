/**
 * The feedback loop (CM-05, RV-01, RV-02, RV-03) against the real services and database.
 *
 *  F1 requests: created on payment, sent once after the delay through a consented channel, expire, are skipped honestly
 *  F2 the guest's answer: by link and by the order page; once only; happy -> public review link, unhappy -> private
 *  F3 working a private item: NEW -> ACKNOWLEDGED -> RESOLVED, permissions, audit
 *  F4 trends by dish, day-part and staff
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/server/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { feedbackAttention, feedbackInbox, feedbackLinkInfo, feedbackTrends, handleFeedback, runFeedbackRequests, submitFeedbackByToken, submitOrderFeedback, dayPartOf, FEEDBACK_REQUEST_TTL_DAYS } from "@/server/services/feedbackLoop";
import { saveGrowthSettings } from "@/server/services/growthSettings";
import { setConsent } from "@/server/services/consent";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { settleAfterCommit } from "@/server/services/afterCommit";
import { listNotifications } from "@/server/services/notifications";
import { localHour } from "@/domain/time";
import { makeEnv, connectMock, guest, deliveries, type Env } from "./growthSupport";

let env: Env;
const BASE = "https://restora.test";

async function paidDish(customerId: string | undefined, dish: string, amount = 400, opts: { source?: string; actor?: typeof env.owner } = {}) {
  const who = opts.actor ?? env.owner;
  const o = await createOrder(who, { outletId: env.outletA, customerId, channel: opts.source === "QR" ? "QR" : "TAKEAWAY", source: (opts.source ?? "POS") as never });
  await addOrderItem(who, o.id, { name: dish, qty: 1, unitPrice: amount });
  const p = await createPayment(who, o.id, { method: "UPI", amount });
  await verifyPayment(who, p.id);
  await settleAfterCommit();
  return o.id;
}
const reqOf = (orderId: string) => prisma.feedbackRequest.findUnique({ where: { orderId } });

beforeAll(async () => {
  env = await makeEnv("Gfb");
  process.env.PUBLIC_BASE_URL = BASE;
  await connectMock(env.orgId);
});
afterEach(() => { process.env.PUBLIC_BASE_URL = BASE; });
afterAll(async () => { await prisma.$disconnect(); });

describe("F1. requests", () => {
  it("F1 nothing is scheduled until the restaurant turns feedback on; then one request per paid order, due after the delay", async () => {
    const g = await guest(env, "Ananya");
    const before = await paidDish(g.id, "Dosa");
    expect(await reqOf(before)).toBeNull();

    await saveGrowthSettings(env.manager, { feedbackEnabled: true, feedbackDelayMinutes: 120, lowRatingMax: 3, googleReviewUrl: "https://g.page/r/abc/review" });
    const id = await paidDish(g.id, "Dosa");
    const r = (await reqOf(id))!;
    expect(r).toMatchObject({ status: "PENDING", customerId: g.id, outletId: env.outletA });
    expect(r.token).toMatch(/^[\w-]{20,}$/);
    const paidAt = (await prisma.order.findUniqueOrThrow({ where: { id } })).paidAt!;
    expect(r.dueAt.getTime() - paidAt.getTime()).toBe(120 * 60_000);

    // not due yet: nothing is sent, nothing changes
    expect(await runFeedbackRequests(prisma, new Date(paidAt.getTime() + 60 * 60_000), env.orgId)).toMatchObject({ due: 0, sent: 0 });
    expect((await reqOf(id))!.status).toBe("PENDING");
  });

  it("F1b once due it is sent through the first consented channel with the link; sending twice sends once", async () => {
    const g = await guest(env, "Bhavna");
    const id = await paidDish(g.id, "Idli");
    const due = new Date((await reqOf(id))!.dueAt.getTime() + 1000);
    const res = await runFeedbackRequests(prisma, due, env.orgId);
    expect(res.sent).toBeGreaterThanOrEqual(1);
    const r = (await reqOf(id))!;
    expect(r.status).toBe("SENT");
    expect(r.sentAt).not.toBeNull();
    const d = (await deliveries(env.orgId, { idempotencyKey: { startsWith: `fbreq:${r.id}` } }))[0];
    expect(d).toMatchObject({ status: "SENT", mode: "MOCK" });
    const body = JSON.parse(d.payload).body as string;
    expect(body).toContain(`${BASE}/f/${r.token}`);
    expect(body).toContain("Bhavna");
    expect(JSON.parse(d.payload).purpose).toBe("TRANSACTIONAL"); // a question about their own visit, not an offer
    const again = await runFeedbackRequests(prisma, new Date(due.getTime() + 60_000), env.orgId);
    expect(again.sent).toBe(0);
    expect(await deliveries(env.orgId, { idempotencyKey: { startsWith: `fbreq:${r.id}` } })).toHaveLength(1);
  });

  it("F1c honest skips: no guest record, no base URL, opted out, already answered; old requests expire", async () => {
    const noGuest = await paidDish(undefined, "Tea");
    const g = await guest(env, "Chitra");
    const noBase = await paidDish(g.id, "Tea");
    const out = await guest(env, "Dilip");
    await setConsent(env.manager, out.id, [{ channel: "SMS", transactional: false }, { channel: "WHATSAPP", transactional: false }, { channel: "EMAIL", transactional: false }]);
    const optedOut = await paidDish(out.id, "Tea");
    const answered = await paidDish(g.id, "Tea");
    await submitFeedbackByToken((await reqOf(answered))!.token, { rating: 5 });
    const old = await paidDish(g.id, "Tea");

    const later = new Date(Date.now() + 3 * 3600_000);
    await runFeedbackRequests(prisma, later, env.orgId); // sends/skips the batch above, including noBase's guest: base URL is set here...
    // ...so re-create the no-base case explicitly
    const g2 = await guest(env, "Esha");
    const noBase2 = await paidDish(g2.id, "Tea");
    process.env.PUBLIC_BASE_URL = "";
    await runFeedbackRequests(prisma, later, env.orgId);
    expect(await reqOf(noBase2)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("PUBLIC_BASE_URL") });
    expect(await reqOf(noGuest)).toMatchObject({ status: "SKIPPED", skipReason: "The order has no guest record" });
    expect(await reqOf(optedOut)).toMatchObject({ status: "SKIPPED", skipReason: expect.stringContaining("No channel") });
    expect(await reqOf(answered)).toMatchObject({ status: "ANSWERED" });
    void noBase;

    // a request left for more than a week is closed, not sent
    process.env.PUBLIC_BASE_URL = BASE;
    const g3 = await guest(env, "Farah");
    const stale = await paidDish(g3.id, "Tea");
    const way = new Date(Date.now() + (FEEDBACK_REQUEST_TTL_DAYS + 1) * 86400_000);
    expect((await runFeedbackRequests(prisma, way, env.orgId)).expired).toBeGreaterThanOrEqual(1);
    expect((await reqOf(stale))!.status).toBe("EXPIRED");
    void old;
  });
});

describe("F2. the guest's answer", () => {
  it("F2 a rating of 4-5 is shown the owner's review link, 1-3 goes privately to the manager and never to a public site; one answer per order", async () => {
    const g = await guest(env, "Gauri");
    const happy = await paidDish(g.id, "Thali");
    const t1 = (await reqOf(happy))!.token;
    expect(await feedbackLinkInfo(t1)).toMatchObject({ answered: false, restaurant: expect.stringContaining("Gfb") });
    const r1 = await submitFeedbackByToken(t1, { rating: 5, comment: "  Lovely  " });
    expect(r1).toEqual({ thanks: true, routedTo: "GOOGLE", reviewUrl: "https://g.page/r/abc/review", alreadyAnswered: false });
    const fb1 = await prisma.feedback.findFirstOrThrow({ where: { orderId: happy } });
    expect(fb1).toMatchObject({ rating: 5, comment: "Lovely", source: "GUEST", status: "RESOLVED", routedTo: "GOOGLE", customerId: g.id });
    // answering again returns the same routing and creates nothing
    expect(await submitFeedbackByToken(t1, { rating: 1 })).toMatchObject({ routedTo: "GOOGLE", alreadyAnswered: true });
    expect(await prisma.feedback.count({ where: { orderId: happy } })).toBe(1);
    expect(await feedbackLinkInfo(t1)).toMatchObject({ answered: true });

    const sad = await paidDish(g.id, "Thali");
    const r2 = await submitFeedbackByToken((await reqOf(sad))!.token, { rating: 2, comment: "Cold food" });
    expect(r2).toEqual({ thanks: true, routedTo: "PRIVATE", reviewUrl: null, alreadyAnswered: false });
    expect(await prisma.feedback.findFirstOrThrow({ where: { orderId: sad } })).toMatchObject({ status: "NEW", routedTo: "PRIVATE" });
    // the managers' alert centre shows it
    const alerts = await listNotifications(prisma, env.manager, { outletId: env.outletA, take: 20 } as never);
    expect(JSON.stringify(alerts)).toContain("2-star feedback");

    // 3 stars with lowRatingMax = 3 is private; 4 with a stricter line (lowRatingMax = 4) is private too
    const mid = await paidDish(g.id, "Thali");
    expect(await submitFeedbackByToken((await reqOf(mid))!.token, { rating: 3 })).toMatchObject({ routedTo: "PRIVATE" });
    await saveGrowthSettings(env.manager, { lowRatingMax: 4 });
    const four = await paidDish(g.id, "Thali");
    expect(await submitFeedbackByToken((await reqOf(four))!.token, { rating: 4 })).toMatchObject({ routedTo: "PRIVATE", reviewUrl: null });
    await saveGrowthSettings(env.manager, { lowRatingMax: 3 });
    // no review link configured -> a happy guest simply gets thanks
    await saveGrowthSettings(env.manager, { googleReviewUrl: null });
    const noLink = await paidDish(g.id, "Thali");
    expect(await submitFeedbackByToken((await reqOf(noLink))!.token, { rating: 5 })).toMatchObject({ routedTo: null, reviewUrl: null });
    await saveGrowthSettings(env.manager, { googleReviewUrl: "https://g.page/r/abc/review" });
  });

  it("F2b bad input and bad links: ratings out of range, long comments, unknown or malformed tokens, unpaid orders", async () => {
    const g = await guest(env, "Harsh");
    const id = await paidDish(g.id, "Roti");
    const token = (await reqOf(id))!.token;
    for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: "5" }, { rating: 5, comment: "x".repeat(1001) }, { rating: 5, extra: 1 }, {}]) {
      await expect(submitFeedbackByToken(token, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(await prisma.feedback.count({ where: { orderId: id } })).toBe(0); // nothing half-recorded
    for (const t of ["short", "x".repeat(60), "../../etc/passwd", "a".repeat(24), 42, null, undefined]) await expect(submitFeedbackByToken(t, { rating: 5 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(feedbackLinkInfo("nonexistent-token-aaaaaa")).rejects.toBeInstanceOf(NotFoundError);
    // an order that is not paid has no feedback link and no order-page form
    const open = await createOrder(env.owner, { outletId: env.outletA, customerId: g.id, channel: "QR", source: "QR" });
    await expect(submitOrderFeedback(open.id, { rating: 5 })).rejects.toBeInstanceOf(ValidationError);
    await expect(submitOrderFeedback("missing", { rating: 5 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(submitOrderFeedback(id, { rating: 5 })).rejects.toBeInstanceOf(NotFoundError); // a POS order has no guest order page
  });

  it("F2c the order page's form works for a QR order without any message having been sent, and shares the one-answer rule with the link", async () => {
    const g = await guest(env, "Indu");
    const id = await paidDish(g.id, "Pizza", 500, { source: "QR" });
    const viaPage = await submitOrderFeedback(id, { rating: 4 });
    expect(viaPage).toMatchObject({ routedTo: "GOOGLE", alreadyAnswered: false });
    const token = (await reqOf(id))!.token;
    expect(await submitFeedbackByToken(token, { rating: 1 })).toMatchObject({ alreadyAnswered: true, routedTo: "GOOGLE" });
    expect(await prisma.feedback.count({ where: { orderId: id } })).toBe(1);
    // a guest without a record can still answer (the order page has no login)
    const anon = await paidDish(undefined, "Pizza", 500, { source: "QR" });
    expect(await submitOrderFeedback(anon, { rating: 5 })).toMatchObject({ thanks: true });
    expect((await prisma.feedback.findFirstOrThrow({ where: { orderId: anon } })).customerId).toBeNull();
  });
});

describe("F3. working a private item", () => {
  it("F3 NEW -> ACKNOWLEDGED -> RESOLVED with a note; staff permissions and tenants; the inbox filters and counts", async () => {
    const g = await guest(env, "Jaya");
    const id = await paidDish(g.id, "Biryani");
    await submitFeedbackByToken((await reqOf(id))!.token, { rating: 1, comment: "Hair in food" });
    const item = await prisma.feedback.findFirstOrThrow({ where: { orderId: id } });
    expect((await feedbackAttention(prisma, env.manager)).new).toBeGreaterThanOrEqual(1);

    await expect(handleFeedback(env.cashier, item.id, { status: "ACKNOWLEDGED" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(handleFeedback(env.foreign, item.id, { status: "ACKNOWLEDGED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(handleFeedback(env.manager, item.id, { status: "RESOLVED" })).rejects.toThrow(/Say what was done/);
    const ack = await handleFeedback(env.manager, item.id, { status: "ACKNOWLEDGED" });
    expect(ack).toMatchObject({ status: "ACKNOWLEDGED", handledById: env.manager.userId });
    await expect(handleFeedback(env.manager, item.id, { status: "ACKNOWLEDGED" })).rejects.toThrow(/Only new/);
    const done = await handleFeedback(env.manager, item.id, { status: "RESOLVED", resolution: "Called the guest, refunded, retrained the kitchen" });
    expect(done).toMatchObject({ status: "RESOLVED", resolution: "Called the guest, refunded, retrained the kitchen" });
    await expect(handleFeedback(env.manager, item.id, { status: "RESOLVED", resolution: "again" })).rejects.toBeInstanceOf(ConflictError);
    const audit = await prisma.auditLog.findMany({ where: { entityType: "Feedback", entityId: item.id, action: "UPDATE" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => JSON.parse(a.after!).status)).toEqual(["ACKNOWLEDGED", "RESOLVED"]);

    const guestOnly = await feedbackInbox(prisma, env.manager, { source: "GUEST", maxRating: 2 });
    expect(guestOnly.items.every((x) => x.source === "GUEST" && x.rating <= 2)).toBe(true);
    expect(guestOnly.items.find((x) => x.id === item.id)).toMatchObject({ customerName: "Jaya", status: "RESOLVED" });
    expect((await feedbackInbox(prisma, env.manager, { status: "NEW" })).items.every((x) => x.status === "NEW")).toBe(true);
    await expect(feedbackInbox(prisma, env.kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await feedbackInbox(prisma, env.foreign, {})).items).toEqual([]); // another restaurant sees none of it
  });
});

describe("F4. trends", () => {
  it("F4 by dish (worst first, ranked after 3 answers), by day-part, by staff, with the low-rating line", async () => {
    const trendEnv = await makeEnv("Gtr");
    const saved = env;
    env = trendEnv;
    try {
      await connectMock(env.orgId);
      await saveGrowthSettings(env.manager, { feedbackEnabled: true, lowRatingMax: 3 });
      const staffA = { ...env.owner, userId: "staff-a" }, staffB = { ...env.owner, userId: "staff-b" };
      const rate = async (dish: string, rating: number, actor = staffA) => {
        const g = await guest(env, `G-${dish}-${Math.random()}`);
        const id = await paidDish(g.id, dish, 300, { actor });
        await submitFeedbackByToken((await reqOf(id))!.token, { rating });
      };
      for (const r of [1, 2, 2]) await rate("Biryani", r, staffA);
      for (const r of [5, 4, 5, 5]) await rate("Dosa", r, staffB);
      await rate("Pasta", 1, staffB); // one answer only: listed after the ranked dishes

      const t = await feedbackTrends(prisma, env.manager, { outletId: env.outletA, from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 86400_000) });
      expect(t.overall).toMatchObject({ answers: 8, low: 4 });
      expect(t.overall.average).toBeCloseTo((1 + 2 + 2 + 5 + 4 + 5 + 5 + 1) / 8, 2);
      expect(t.overall.distribution.find((d) => d.rating === 5)!.count).toBe(3);
      expect(t.byDish.map((d) => [d.name, d.answers, d.ranked])).toEqual([["Biryani", 3, true], ["Dosa", 4, true], ["Pasta", 1, false]]);
      expect(t.byDish[0]).toMatchObject({ lowShare: 100, average: 1.67 });
      expect(t.byStaff.map((s) => [s.userId, s.answers])).toEqual([["staff-a", 3], ["staff-b", 5]]); // lowest average first
      const part = dayPartOf(localHour(new Date(), "Asia/Kolkata"));
      expect(t.byDayPart).toEqual([expect.objectContaining({ key: part.key, answers: 8 })]);
      expect(t.byDay).toHaveLength(1);

      await expect(feedbackTrends(prisma, env.cashier, { outletId: env.outletA, from: new Date(), to: new Date() })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(feedbackTrends(prisma, env.manager, { outletId: env.outletA, from: new Date(), to: new Date(Date.now() + 400 * 86400_000) })).rejects.toThrow(/one year/);
      await expect(feedbackTrends(prisma, env.manager, { outletId: env.outletB, from: new Date(), to: new Date() })).rejects.toThrow(); // not this manager's outlet
      expect((await feedbackTrends(prisma, env.owner, { outletId: env.outletB, from: new Date(Date.now() - 86400_000), to: new Date() })).overall.answers).toBe(0);
    } finally {
      env = saved;
    }
  });
});
