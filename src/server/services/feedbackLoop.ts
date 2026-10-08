/**
 * Guest feedback loop (proposal p. 17: feedback request after the visit, happy guests to a public review site,
 * unhappy ones privately to the manager, complaint trends).
 *
 *  - A request is created when an order is paid (if the restaurant turned feedback on) and sent once, after the
 *    configured delay, through the guest's consented channel. It carries an unguessable link; the order page has the
 *    same form behind the order's own access key.
 *  - One answer per order. A rating above the low-rating line AND of 4 or 5 is shown the owner's review link
 *    (allowlisted hosts, https); anything at or below the line is private: a NEW feedback item and an in-app alert for
 *    the managers, and the guest is never sent to a public site.
 *  - Staff work a private item NEW -> ACKNOWLEDGED -> RESOLVED (a resolution note is required).
 *  - Trends read the answers back against what was ordered, when and by whom: by dish, by day-part and by the staff
 *    member who took the order.
 */
import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { getGrowthSettings } from "@/server/services/growthSettings";
import { createNotificationTx } from "@/server/services/notifications";
import { queueCustomerMessage } from "@/server/services/messaging";
import { systemContext } from "@/server/auth/context";
import { orgTimeZone } from "@/server/services/businessDay";
import { utcOffsetMinutes } from "@/domain/time";
import type { MessageChannel } from "@/integrations/messaging";

const token = () => randomBytes(18).toString("base64url");
export const FEEDBACK_REQUEST_TTL_DAYS = 7;

// ---------------------------------------------------------------- requests

/** Called inside the settlement transaction once an order is PAID. Idempotent (one request per order). */
export async function scheduleFeedbackRequestTx(tx: Tx, ctx: AccessContext, orderId: string): Promise<boolean> {
  const settings = await getGrowthSettings(tx as unknown as PrismaClient, ctx.organizationId);
  if (!settings.feedbackEnabled) return false;
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, organizationId: true, outletId: true, customerId: true, paidAt: true, status: true } });
  if (!order || order.organizationId !== ctx.organizationId || order.status !== "PAID") return false;
  if (await tx.feedbackRequest.findUnique({ where: { orderId } })) return false;
  const base = order.paidAt ?? new Date();
  await tx.feedbackRequest.create({ data: { organizationId: ctx.organizationId, outletId: order.outletId, orderId, customerId: order.customerId, token: token(), dueAt: new Date(base.getTime() + settings.feedbackDelayMinutes * 60_000) } });
  return true;
}

export type FeedbackRunResult = { due: number; sent: number; skipped: number; deferred: number; expired: number };
const CHANNEL_ORDER: MessageChannel[] = ["WHATSAPP", "SMS", "EMAIL"];

/** Send the due requests (scheduled job). Safe to run repeatedly: each request is sent at most once. */
export async function runFeedbackRequests(db: PrismaClient = prisma, now = new Date(), organizationId?: string): Promise<FeedbackRunResult> {
  const out: FeedbackRunResult = { due: 0, sent: 0, skipped: 0, deferred: 0, expired: 0 };
  const where: Prisma.FeedbackRequestWhereInput = { status: "PENDING", dueAt: { lte: now }, ...(organizationId ? { organizationId } : {}) };
  const due = await db.feedbackRequest.findMany({ where, orderBy: { dueAt: "asc" }, take: 200 });
  out.due = due.length;
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  for (const r of due) {
    const ctx = systemContext(r.organizationId, [r.outletId]);
    if (now.getTime() - r.dueAt.getTime() > FEEDBACK_REQUEST_TTL_DAYS * 86400_000) {
      await db.feedbackRequest.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "EXPIRED" } });
      out.expired++;
      continue;
    }
    const skip = async (reason: string) => { await db.feedbackRequest.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "SKIPPED", skipReason: reason } }); out.skipped++; };
    if (await db.feedback.count({ where: { organizationId: r.organizationId, orderId: r.orderId, source: "GUEST" } })) { await skip("Already answered"); continue; }
    if (!r.customerId) { await skip("The order has no guest record"); continue; }
    if (!base) { await skip("PUBLIC_BASE_URL is not set, so there is no link to send"); continue; }
    const customer = await db.customer.findUnique({ where: { id: r.customerId }, select: { name: true } });
    const outlet = await db.outlet.findUnique({ where: { id: r.outletId }, select: { name: true } });
    const body = `Hi ${customer?.name?.split(" ")[0] || "there"}, thank you for dining at ${outlet?.name ?? "us"}. How was it? Tell us in 20 seconds: ${base}/f/${r.token}`;
    let result: Awaited<ReturnType<typeof queueCustomerMessage>> | null = null;
    for (const channel of CHANNEL_ORDER) {
      const res = await queueCustomerMessage(ctx, { customerId: r.customerId, channel, purpose: "TRANSACTIONAL", key: `fbreq:${r.id}:${channel}`, template: "FEEDBACK_REQUEST", subject: `How was your visit to ${outlet?.name ?? "us"}?`, body, outletId: r.outletId, about: { type: "Customer", id: r.customerId } }, db);
      if (res.status === "QUEUED" || res.status === "DUPLICATE") { result = res; break; }
    }
    if (result) {
      await db.feedbackRequest.updateMany({ where: { id: r.id, status: "PENDING" }, data: { status: "SENT", sentAt: now } });
      out.sent++;
    } else await skip("No channel could reach the guest (no provider, no consent or no address)");
  }
  return out;
}

// ---------------------------------------------------------------- the guest's answer

const answerSchema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() }).strict();
export type GuestFeedbackResult = { thanks: true; routedTo: "GOOGLE" | "PRIVATE" | null; reviewUrl: string | null; alreadyAnswered: boolean };

async function recordAnswerTx(tx: Tx, ctx: AccessContext, order: { id: string; outletId: string; customerId: string | null }, input: z.output<typeof answerSchema>): Promise<GuestFeedbackResult> {
  const settings = await getGrowthSettings(tx as unknown as PrismaClient, ctx.organizationId);
  // The first answer wins; the request row is the lock (created on demand for the order-page form).
  let req = await tx.feedbackRequest.findUnique({ where: { orderId: order.id } });
  if (!req) req = await tx.feedbackRequest.create({ data: { organizationId: ctx.organizationId, outletId: order.outletId, orderId: order.id, customerId: order.customerId, token: token(), dueAt: new Date() } });
  const claimed = await tx.feedbackRequest.updateMany({ where: { id: req.id, status: { not: "ANSWERED" } }, data: { status: "ANSWERED", answeredAt: new Date() } });
  if (claimed.count !== 1) {
    const prior = await tx.feedback.findFirst({ where: { organizationId: ctx.organizationId, orderId: order.id, source: "GUEST" }, orderBy: { createdAt: "asc" } });
    return { thanks: true, routedTo: (prior?.routedTo as "GOOGLE" | "PRIVATE" | null) ?? null, reviewUrl: prior?.routedTo === "GOOGLE" ? settings.googleReviewUrl : null, alreadyAnswered: true };
  }
  const low = input.rating <= settings.lowRatingMax;
  const routedTo = low ? "PRIVATE" : input.rating >= 4 && settings.googleReviewUrl ? "GOOGLE" : null;
  const fb = await tx.feedback.create({
    data: {
      organizationId: ctx.organizationId, outletId: order.outletId, customerId: order.customerId, orderId: order.id, rating: input.rating, comment: input.comment || null,
      source: "GUEST", status: low ? "NEW" : "RESOLVED", routedTo, resolution: low ? null : "No action needed",
    },
  });
  await tx.feedbackRequest.update({ where: { id: req.id }, data: { feedbackId: fb.id } });
  if (low) {
    await createNotificationTx(tx, ctx, { outletId: order.outletId, type: "LOW_RATING", title: `${input.rating}-star feedback`, body: [input.comment ? `“${input.comment.slice(0, 140)}”` : "No comment", "Open Customers › Feedback to follow up."].join(" "), dedupeWindowMinutes: 1 });
  }
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "Feedback", entityId: fb.id, outletId: order.outletId, after: { via: "guest", rating: input.rating, routedTo } });
  return { thanks: true, routedTo, reviewUrl: routedTo === "GOOGLE" ? settings.googleReviewUrl : null, alreadyAnswered: false };
}

/** The feedback link (`/f/<token>`): the token is the credential. */
export async function submitFeedbackByToken(tokenValue: unknown, input: unknown, db: Client = prisma): Promise<GuestFeedbackResult> {
  const t = z.string().min(20).max(40).regex(/^[\w-]+$/).safeParse(tokenValue);
  if (!t.success) throw new NotFoundError("This feedback link is not valid");
  const a = answerSchema.parse(input);
  return runInTx(db, async (tx) => {
    const req = await tx.feedbackRequest.findUnique({ where: { token: t.data } });
    if (!req) throw new NotFoundError("This feedback link is not valid");
    const order = await tx.order.findUnique({ where: { id: req.orderId }, select: { id: true, outletId: true, customerId: true, status: true } });
    if (!order || !["PAID", "SERVED", "BILLED"].includes(order.status)) throw new NotFoundError("This feedback link is not valid");
    return recordAnswerTx(tx, systemContext(req.organizationId, [order.outletId]), order, a);
  });
}

/** What the feedback page shows before the guest answers (no personal data beyond the restaurant's name). */
export async function feedbackLinkInfo(tokenValue: unknown, db: PrismaClient = prisma) {
  const t = z.string().min(20).max(40).regex(/^[\w-]+$/).safeParse(tokenValue);
  if (!t.success) throw new NotFoundError("This feedback link is not valid");
  const req = await db.feedbackRequest.findUnique({ where: { token: t.data } });
  if (!req) throw new NotFoundError("This feedback link is not valid");
  const outlet = await db.outlet.findUnique({ where: { id: req.outletId }, select: { name: true } });
  return { restaurant: outlet?.name ?? "", answered: req.status === "ANSWERED" };
}

/** The order page's form: the order's own access key (checked by the caller, as for every guest order action) is the credential. */
export async function submitOrderFeedback(orderId: string, input: unknown, db: Client = prisma): Promise<GuestFeedbackResult> {
  const a = answerSchema.parse(input);
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, organizationId: true, outletId: true, customerId: true, status: true, source: true } });
    if (!order || order.source !== "QR") throw new NotFoundError("Order not found");
    if (!["PAID", "SERVED", "BILLED"].includes(order.status)) throw new ValidationError("You can leave feedback once your order has been served");
    return recordAnswerTx(tx, systemContext(order.organizationId, [order.outletId]), order, a);
  });
}

// ---------------------------------------------------------------- staff

const SOURCES = ["STAFF", "GUEST"] as const;
export type FeedbackFilter = { outletId?: string; status?: string; maxRating?: number; source?: string; take?: number; cursor?: string };

export async function feedbackInbox(db: PrismaClient, ctx: AccessContext, f: FeedbackFilter = {}) {
  if (f.outletId) assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "customer.view", f.outletId);
  const outletWhere = f.outletId ? { outletId: f.outletId } : ctx.isOrgWide || ctx.isSuperAdmin ? {} : { outletId: { in: ctx.outletIds } };
  const take = Math.min(f.take ?? 50, 200);
  const rows = await db.feedback.findMany({
    where: { organizationId: ctx.organizationId, ...outletWhere, ...(f.status ? { status: f.status } : {}), ...(f.maxRating ? { rating: { lte: f.maxRating } } : {}), ...(f.source && (SOURCES as readonly string[]).includes(f.source) ? { source: f.source } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  const customers = new Map((await db.customer.findMany({ where: { id: { in: items.map((x) => x.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  return { items: items.map((x) => ({ ...x, customerName: x.customerId ? customers.get(x.customerId)?.name ?? null : null })), nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

const handleSchema = z.object({ status: z.enum(["ACKNOWLEDGED", "RESOLVED"]), resolution: z.string().trim().max(500).optional() });
export async function handleFeedback(ctx: AccessContext, feedbackId: string, input: z.input<typeof handleSchema>, db: Client = prisma) {
  const d = handleSchema.parse(input);
  return runInTx(db, async (tx) => {
    const fb = await tx.feedback.findUnique({ where: { id: feedbackId } });
    if (!fb || fb.organizationId !== ctx.organizationId) throw new NotFoundError("Feedback not found");
    if (fb.outletId) assertOutletAccess(ctx, fb.outletId);
    assertCan(ctx, "growth.manage", fb.outletId ?? undefined);
    if (fb.status === "RESOLVED") throw new ConflictError("This feedback is already resolved");
    if (d.status === "ACKNOWLEDGED" && fb.status !== "NEW") throw new ValidationError("Only new feedback can be acknowledged");
    if (d.status === "RESOLVED" && !d.resolution) throw new ValidationError("Say what was done", { fieldErrors: { resolution: ["Required"] } });
    const row = await tx.feedback.update({ where: { id: fb.id }, data: { status: d.status, handledById: ctx.userId === "system" ? null : ctx.userId, handledAt: new Date(), ...(d.resolution ? { resolution: d.resolution } : {}) } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Feedback", entityId: fb.id, outletId: fb.outletId, before: { status: fb.status }, after: { status: row.status, resolution: row.resolution } });
    return row;
  });
}

// ---------------------------------------------------------------- trends

const DAY_PARTS = [
  { key: "LATE_NIGHT", label: "Late night", from: 0, to: 5 }, { key: "BREAKFAST", label: "Breakfast", from: 5, to: 11 }, { key: "LUNCH", label: "Lunch", from: 11, to: 16 },
  { key: "SNACKS", label: "Snacks", from: 16, to: 19 }, { key: "DINNER", label: "Dinner", from: 19, to: 24 },
] as const;
export const dayPartOf = (hour: number) => DAY_PARTS.find((p) => hour >= p.from && hour < p.to) ?? DAY_PARTS[4];
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

/** Dishes need this many answered orders before they are ranked (one bad night is not a trend). */
export const TREND_MIN_ORDERS = 3;

const trendSchema = z.object({ outletId: z.string().min(1), from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.from <= r.to, { message: "`from` must be on or before `to`", path: ["from"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 366 * 86400_000, { message: "At most one year", path: ["to"] });

export async function feedbackTrends(db: PrismaClient, ctx: AccessContext, input: z.input<typeof trendSchema>, now = new Date()) {
  const f = trendSchema.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "growth.view", f.outletId);
  const settings = await getGrowthSettings(db, ctx.organizationId);
  const tz = await orgTimeZone(db, ctx);
  void now;
  const rows = await db.feedback.findMany({ where: { organizationId: ctx.organizationId, outletId: f.outletId, createdAt: { gte: f.from, lte: f.to } }, orderBy: { createdAt: "asc" }, take: 5000 });
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
  const orders = orderIds.length ? await db.order.findMany({ where: { organizationId: ctx.organizationId, id: { in: orderIds } }, select: { id: true, createdById: true, createdAt: true, paidAt: true, items: { select: { name: true, menuItemId: true } } } }) : [];
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const userIds = [...new Set(orders.map((o) => o.createdById).filter((x): x is string => !!x))];
  const users = userIds.length ? new Map((await db.user.findMany({ where: { organizationId: ctx.organizationId, id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name])) : new Map<string, string>();

  const ratings = rows.map((r) => r.rating);
  const dish = new Map<string, { name: string; ratings: number[] }>();
  const part = new Map<string, number[]>();
  const staff = new Map<string, number[]>();
  const day = new Map<string, number[]>();
  for (const r of rows) {
    const d = new Date(r.createdAt.getTime() + utcOffsetMinutes(r.createdAt, tz) * 60000).toISOString().slice(0, 10);
    (day.get(d) ?? day.set(d, []).get(d)!).push(r.rating);
    const o = r.orderId ? byOrder.get(r.orderId) : undefined;
    if (!o) continue;
    const at = o.paidAt ?? o.createdAt;
    const hour = Math.floor((((at.getTime() + utcOffsetMinutes(at, tz) * 60000) % 86400000) + 86400000) % 86400000 / 3600000);
    const p = dayPartOf(hour).key;
    (part.get(p) ?? part.set(p, []).get(p)!).push(r.rating);
    if (o.createdById) (staff.get(o.createdById) ?? staff.set(o.createdById, []).get(o.createdById)!).push(r.rating);
    for (const name of new Set(o.items.map((i) => i.name))) (dish.get(name) ?? dish.set(name, { name, ratings: [] }).get(name)!).ratings.push(r.rating);
  }
  const low = (xs: number[]) => xs.filter((x) => x <= settings.lowRatingMax).length;
  const summarize = (xs: number[]) => ({ answers: xs.length, average: avg(xs), low: low(xs) });
  return {
    outletId: f.outletId, lowRatingMax: settings.lowRatingMax, minOrdersForRanking: TREND_MIN_ORDERS,
    overall: { ...summarize(ratings), distribution: [1, 2, 3, 4, 5].map((n) => ({ rating: n, count: ratings.filter((x) => x === n).length })) },
    byDay: [...day.entries()].map(([date, xs]) => ({ date, ...summarize(xs) })),
    byDayPart: DAY_PARTS.map((p) => ({ key: p.key, label: p.label, ...summarize(part.get(p.key) ?? []) })).filter((p) => p.answers > 0),
    byStaff: [...staff.entries()].map(([id, xs]) => ({ userId: id, name: users.get(id) ?? "Unknown", ...summarize(xs) })).sort((a, b) => (a.average ?? 5) - (b.average ?? 5)),
    // Worst first: the dishes that keep showing up on unhappy orders.
    byDish: [...dish.values()].map((d) => ({ name: d.name, ...summarize(d.ratings), lowShare: d.ratings.length ? Math.round((low(d.ratings) / d.ratings.length) * 100) : 0, ranked: d.ratings.length >= TREND_MIN_ORDERS }))
      .sort((a, b) => Number(b.ranked) - Number(a.ranked) || (a.average ?? 5) - (b.average ?? 5) || b.answers - a.answers).slice(0, 50),
  };
}

/** Counts for the Growth overview: what needs attention now. */
export async function feedbackAttention(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "growth.view");
  const { lowRatingMax } = await getGrowthSettings(db, ctx.organizationId);
  const [newCount, ackCount] = await Promise.all([
    db.feedback.count({ where: { organizationId: ctx.organizationId, status: "NEW", rating: { lte: lowRatingMax } } }),
    db.feedback.count({ where: { organizationId: ctx.organizationId, status: "ACKNOWLEDGED" } }),
  ]);
  return { new: newCount, acknowledged: ackCount };
}
