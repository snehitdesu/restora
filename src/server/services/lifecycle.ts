/**
 * Growth automations run by the worker (proposal p. 17): birthday and anniversary offers, win-back, booking
 * confirmation and reminder, feedback requests, scheduled campaigns, the 9 AM summary and the nightly loyalty-tier
 * refresh. Nothing here sends on its own authority: every guest message goes through `queueCustomerMessage`
 * (consent, channel, quiet hours, weekly cap, outbox idempotency), and each automation is switched on by a setting
 * (a coupon for the offers, a flag for the rest) that defaults to off.
 *
 * Per-tick work (campaigns, feedback requests, booking messages) is idempotent by state and keys. Daily work claims a
 * JobRun per organization per local day (see ops/scheduled.ts), so any number of app instances run it once.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { claimJobRun, finishJobRun } from "@/server/ops/scheduled";
import { getGrowthSettings, type GrowthSettingsView } from "@/server/services/growthSettings";
import { inQuietHours, queueCustomerMessage, queueDigestMessage, type QueueResult } from "@/server/services/messaging";
import { marketingFooter, renderBody, runCampaigns, type CampaignRunResult } from "@/server/services/campaigns";
import { runFeedbackRequests, type FeedbackRunResult } from "@/server/services/feedbackLoop";
import { buildDigest } from "@/server/services/digest";
import { createNotificationTx } from "@/server/services/notifications";
import { activeTiers, tierForSpend, trailingSpend } from "@/server/services/loyaltyTiers";
import { localDate, localHour } from "@/domain/time";
import { safeMessage } from "@/integrations/http";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";
import type { MessageChannel } from "@/integrations/messaging";

export const JOBS = { BIRTHDAY: "GROWTH_BIRTHDAY", ANNIVERSARY: "GROWTH_ANNIVERSARY", WINBACK: "GROWTH_WINBACK", DIGEST: "GROWTH_DIGEST", TIERS: "GROWTH_TIERS" } as const;
export const CHANNEL_ORDER: MessageChannel[] = ["WHATSAPP", "SMS", "EMAIL"];
const MAX_PER_RUN = 2000;

/** First channel that takes the message. DEFERRED (quiet hours) stops everything: try again later. */
async function sendFirstChannel(db: PrismaClient, organizationId: string, customerId: string, mk: (channel: MessageChannel) => Parameters<typeof queueCustomerMessage>[1]): Promise<QueueResult["status"] | "NONE"> {
  const ctx = systemContext(organizationId);
  for (const channel of CHANNEL_ORDER) {
    const r = await queueCustomerMessage(ctx, mk(channel), db);
    if (r.status === "QUEUED" || r.status === "DUPLICATE" || r.status === "DEFERRED") return r.status;
  }
  return "NONE";
}

// ---------------------------------------------------------------- birthday / anniversary / win-back

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Month-day of a stored date matches today's local date (a 29 February date is celebrated on 28 February in other years). */
export function dateMatchesToday(stored: Date, today: string): boolean {
  const [y, m, d] = today.split("-").map(Number);
  const sm = stored.getUTCMonth() + 1, sd = stored.getUTCDate();
  if (sm === m && sd === d) return true;
  return sm === 2 && sd === 29 && !isLeap(y) && m === 2 && d === 28;
}

async function couponCode(db: PrismaClient, organizationId: string, couponId: string | null) {
  if (!couponId) return null;
  const c = await db.coupon.findUnique({ where: { id: couponId } });
  return c && c.organizationId === organizationId && c.active ? c : null;
}

async function marketingCustomers(db: PrismaClient, organizationId: string) {
  const ids = [...new Set((await db.customerConsent.findMany({ where: { organizationId, marketing: true }, select: { customerId: true }, take: MAX_PER_RUN * 3 })).map((c) => c.customerId))];
  return ids;
}

export async function sendDateOffers(db: PrismaClient, organizationId: string, kind: "BIRTHDAY" | "ANNIVERSARY", today: string, settings: GrowthSettingsView, now = new Date()) {
  const coupon = await couponCode(db, organizationId, kind === "BIRTHDAY" ? settings.birthdayCouponId : settings.anniversaryCouponId);
  if (!coupon) return { eligible: 0, sent: 0 };
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  const ids = await marketingCustomers(db, organizationId);
  const year = today.slice(0, 4);
  const field = kind === "BIRTHDAY" ? "birthday" : "anniversary";
  let eligible = 0, sent = 0;
  for (let i = 0; i < ids.length && eligible < MAX_PER_RUN; i += 500) {
    const customers = await db.customer.findMany({ where: { organizationId, id: { in: ids.slice(i, i + 500) }, [field]: { not: null } }, select: { id: true, name: true, birthday: true, anniversary: true } });
    for (const c of customers) {
      const d = kind === "BIRTHDAY" ? c.birthday : c.anniversary;
      if (!d || !dateMatchesToday(d, today)) continue;
      eligible++;
      const text = kind === "BIRTHDAY" ? "Happy birthday, {name}! Here is a treat from {restaurant}: use code {code} on your next visit." : "Happy anniversary, {name}! Celebrate with us at {restaurant}: use code {code}.";
      const st = await sendFirstChannel(db, organizationId, c.id, (channel) => ({
        customerId: c.id, channel, purpose: "MARKETING", key: `life:${kind}:${c.id}:${year}`, template: `LIFECYCLE_${kind}`, subject: kind === "BIRTHDAY" ? "Happy birthday!" : "Happy anniversary!",
        body: renderBody(text, { name: c.name, code: coupon.code, restaurant: org?.name ?? "" }) + marketingFooter(c.id, channel), now,
      }));
      if (st === "QUEUED") sent++;
      if (st === "DEFERRED") return { eligible, sent };
    }
  }
  return { eligible, sent };
}

export async function sendWinback(db: PrismaClient, organizationId: string, settings: GrowthSettingsView, now = new Date()) {
  const coupon = await couponCode(db, organizationId, settings.winbackCouponId);
  if (!coupon) return { eligible: 0, sent: 0 };
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  const ids = await marketingCustomers(db, organizationId);
  const cutoff = new Date(now.getTime() - settings.winbackAfterDays * 86400_000);
  // One message per guest per cooldown window: the key names the window.
  const window = Math.floor(now.getTime() / (settings.winbackCooldownDays * 86400_000));
  let eligible = 0, sent = 0;
  for (let i = 0; i < ids.length && eligible < MAX_PER_RUN; i += 500) {
    const slice = ids.slice(i, i + 500);
    const g = await db.order.groupBy({ by: ["customerId"], where: { organizationId, status: "PAID", customerId: { in: slice } }, _max: { paidAt: true, createdAt: true } });
    const lapsed = g.filter((r) => r.customerId && (r._max.paidAt ?? r._max.createdAt ?? now) < cutoff).map((r) => r.customerId as string);
    if (!lapsed.length) continue;
    const customers = await db.customer.findMany({ where: { id: { in: lapsed } }, select: { id: true, name: true } });
    for (const c of customers) {
      eligible++;
      const st = await sendFirstChannel(db, organizationId, c.id, (channel) => ({
        customerId: c.id, channel, purpose: "MARKETING", key: `life:WINBACK:${c.id}:${window}`, template: "LIFECYCLE_WINBACK", subject: `We miss you at ${org?.name ?? "the restaurant"}`,
        body: renderBody("Hi {name}, we have missed you at {restaurant}. Come back and use code {code}.", { name: c.name, code: coupon.code, restaurant: org?.name ?? "" }) + marketingFooter(c.id, channel), now,
      }));
      if (st === "QUEUED") sent++;
      if (st === "DEFERRED") return { eligible, sent };
    }
  }
  return { eligible, sent };
}

// ---------------------------------------------------------------- booking confirmation and reminder

export type BookingRunResult = { confirmations: number; reminders: number };

export async function runBookingMessages(db: PrismaClient = prisma, now = new Date(), organizationId?: string): Promise<BookingRunResult> {
  const out: BookingRunResult = { confirmations: 0, reminders: 0 };
  const orgs = await db.growthSettings.findMany({ where: { bookingMessagesEnabled: true, ...(organizationId ? { organizationId } : {}) }, select: { organizationId: true, bookingReminderHours: true } });
  for (const o of orgs) {
    const ctx = systemContext(o.organizationId);
    const org = await db.organization.findUnique({ where: { id: o.organizationId }, select: { name: true, timezone: true } });
    const tz = org?.timezone ?? "Asia/Kolkata";
    const fmt = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
    const upcoming = await db.reservation.findMany({
      where: { organizationId: o.organizationId, customerId: { not: null }, status: { in: ["BOOKED", "CONFIRMED"] }, reservedAt: { gt: now, lte: new Date(now.getTime() + 14 * 86400_000) }, createdAt: { gte: new Date(now.getTime() - 3 * 86400_000) } },
      take: 500,
    });
    const soon = await db.reservation.findMany({
      where: { organizationId: o.organizationId, customerId: { not: null }, status: { in: ["BOOKED", "CONFIRMED"] }, reservedAt: { gt: now, lte: new Date(now.getTime() + o.bookingReminderHours * 3600_000) } },
      take: 500,
    });
    const send = async (r: { id: string; customerId: string | null; outletId: string; partySize: number; reservedAt: Date }, kind: "CONFIRM" | "REMIND") => {
      const text = kind === "CONFIRM"
        ? `Your table for ${r.partySize} at ${org?.name ?? "the restaurant"} is booked for ${fmt(r.reservedAt)}. See you then!`
        : `Reminder: your table for ${r.partySize} at ${org?.name ?? "the restaurant"} is ${fmt(r.reservedAt)}. Reply to the restaurant if plans change.`;
      for (const channel of CHANNEL_ORDER) {
        const res = await queueCustomerMessage(ctx, { customerId: r.customerId!, channel, purpose: "TRANSACTIONAL", key: `resv:${r.id}:${kind}`, template: kind === "CONFIRM" ? "BOOKING_CONFIRMED" : "BOOKING_REMINDER", subject: kind === "CONFIRM" ? "Your booking" : "Booking reminder", body: text, outletId: r.outletId, about: { type: "Reservation", id: r.id }, now }, db);
        if (res.status === "QUEUED") { out[kind === "CONFIRM" ? "confirmations" : "reminders"]++; return; }
        if (res.status === "DUPLICATE") return;
      }
    };
    for (const r of upcoming) await send(r, "CONFIRM");
    for (const r of soon) await send(r, "REMIND");
  }
  return out;
}

// ---------------------------------------------------------------- tiers, digest

/** Re-derive every loyalty account's tier from the last 365 days (spend ages out of the window as time passes). */
export async function refreshTiers(db: PrismaClient, organizationId: string, now = new Date()): Promise<{ checked: number; changed: number }> {
  const tiers = await activeTiers(db, organizationId);
  if (!tiers.length) return { checked: 0, changed: 0 };
  const accounts = await db.loyaltyAccount.findMany({ where: { organizationId }, select: { customerId: true, tier: true }, take: 50000 });
  let changed = 0;
  for (const a of accounts) {
    const next = tierForSpend(tiers, await trailingSpend(db, organizationId, a.customerId, now))?.code ?? tiers[0].code;
    if (next !== a.tier) {
      await db.loyaltyAccount.update({ where: { customerId: a.customerId }, data: { tier: next } });
      await db.auditLog.create({ data: { organizationId, actorId: null, action: "UPDATE", entityType: "LoyaltyAccount", entityId: a.customerId, before: JSON.stringify({ tier: a.tier }), after: JSON.stringify({ tier: next, via: "nightly refresh" }) } });
      changed++;
    }
  }
  return { checked: accounts.length, changed };
}

export async function sendDigest(db: PrismaClient, organizationId: string, today: string, now = new Date()) {
  const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
  const digest = await buildDigest(db, organizationId, y);
  const ctx = systemContext(organizationId);
  let notified = 0;
  for (const o of digest.outlets) {
    await db.$transaction(async (tx) => {
      const line = `${o.orders} orders, Rs.${o.revenue.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      await createNotificationTx(tx, ctx, { outletId: o.outletId, type: "DAILY_SUMMARY", title: `${o.name}: ${line}`, body: digest.text, dedupeWindowMinutes: 600 });
    });
    notified++;
  }
  let message: QueueResult["status"] | "NONE" = "NONE";
  for (const channel of ["WHATSAPP", "SMS"] as const) {
    const r = await queueDigestMessage(ctx, { date: y, channel, body: digest.text.slice(0, 900) }, db);
    if (r.status === "QUEUED" || r.status === "DUPLICATE") { message = r.status; break; }
  }
  void now;
  return { outlets: digest.outlets.length, notified, message };
}

// ---------------------------------------------------------------- orchestration

export type GrowthTickResult = { campaigns: CampaignRunResult; feedback: FeedbackRunResult; booking: BookingRunResult; daily: Array<{ organizationId: string; job: string; status: string }> };

/** One pass from the worker tick. Cheap when nothing is due. Failures of one job never stop the others. */
export async function runGrowthJobs(db: PrismaClient = prisma, now = new Date(), onlyOrganizationId?: string): Promise<GrowthTickResult> {
  const result: GrowthTickResult = { campaigns: { campaigns: 0, sent: 0, skipped: 0, deferred: 0, completed: 0 }, feedback: { due: 0, sent: 0, skipped: 0, deferred: 0, expired: 0 }, booking: { confirmations: 0, reminders: 0 }, daily: [] };
  const guard = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (e) { inc("restora_job_failures_total", { type: "growth" }); log.error("growth job failed", { event: "growth_job_failed", job: name, error: e }); return fallback; }
  };
  result.campaigns = await guard("campaigns", () => runCampaigns(db, now, onlyOrganizationId), result.campaigns);
  result.feedback = await guard("feedback", () => runFeedbackRequests(db, now, onlyOrganizationId), result.feedback);
  result.booking = await guard("booking", () => runBookingMessages(db, now, onlyOrganizationId), result.booking);

  const orgs = await db.growthSettings.findMany({ where: onlyOrganizationId ? { organizationId: onlyOrganizationId } : {}, select: { organizationId: true } });
  for (const { organizationId } of orgs) {
    const org = await db.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
    const tz = org?.timezone ?? "Asia/Kolkata";
    const date = localDate(now, tz);
    const settings = await getGrowthSettings(db, organizationId);
    const run = async (job: string, fn: () => Promise<Record<string, unknown>>) => {
      if (!(await claimJobRun(db, job, organizationId, date, now))) return;
      try {
        const detail = await fn();
        await finishJobRun(db, job, organizationId, date, "SUCCESS", detail, now);
        result.daily.push({ organizationId, job, status: "SUCCESS" });
      } catch (e) {
        inc("restora_job_failures_total", { type: "growth" });
        log.error("growth daily job failed", { event: "growth_job_failed", job, organizationId, error: e });
        await finishJobRun(db, job, organizationId, date, "FAILED", { error: safeMessage(e) }, now);
        result.daily.push({ organizationId, job, status: "FAILED" });
      }
    };
    // Offers go out in the guest's day, never in the quiet hours.
    if (!inQuietHours(now, tz, settings.quietHoursStart, settings.quietHoursEnd)) {
      if (settings.birthdayCouponId) await run(JOBS.BIRTHDAY, () => sendDateOffers(db, organizationId, "BIRTHDAY", date, settings, now));
      if (settings.anniversaryCouponId) await run(JOBS.ANNIVERSARY, () => sendDateOffers(db, organizationId, "ANNIVERSARY", date, settings, now));
      if (settings.winbackCouponId) await run(JOBS.WINBACK, () => sendWinback(db, organizationId, settings, now));
    }
    await run(JOBS.TIERS, () => refreshTiers(db, organizationId, now));
    if (settings.digestEnabled && localHour(now, tz) >= settings.digestHour) await run(JOBS.DIGEST, () => sendDigest(db, organizationId, date, now));
  }
  return result;
}
