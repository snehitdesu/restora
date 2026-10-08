/**
 * The growth programme's rules in one row per organization: referral rewards, birthday / win-back / feedback timing,
 * quiet hours and frequency cap for marketing, the public review link, the 9 AM summary. Reading needs growth.view,
 * changing needs growth.manage and is audited with before / after. Nothing here sends anything: it only decides
 * whether the scheduled jobs and campaigns may.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";
import { normalizePhone } from "@/integrations/messaging";
import { money } from "@/domain/money";

export type GrowthSettingsView = {
  referralEnabled: boolean; referrerPoints: number; refereePoints: number; referralMinOrderValue: number; referralMonthlyCap: number;
  birthdayCouponId: string | null; anniversaryCouponId: string | null; winbackCouponId: string | null; winbackAfterDays: number; winbackCooldownDays: number;
  feedbackEnabled: boolean; feedbackDelayMinutes: number; googleReviewUrl: string | null; lowRatingMax: number;
  quietHoursStart: number; quietHoursEnd: number; marketingWeeklyCap: number;
  bookingMessagesEnabled: boolean; bookingReminderHours: number;
  digestEnabled: boolean; digestHour: number; digestPhone: string | null;
};

export const DEFAULT_GROWTH_SETTINGS: GrowthSettingsView = {
  referralEnabled: false, referrerPoints: 100, refereePoints: 50, referralMinOrderValue: 0, referralMonthlyCap: 20,
  birthdayCouponId: null, anniversaryCouponId: null, winbackCouponId: null, winbackAfterDays: 45, winbackCooldownDays: 90,
  feedbackEnabled: false, feedbackDelayMinutes: 120, googleReviewUrl: null, lowRatingMax: 3,
  quietHoursStart: 21, quietHoursEnd: 9, marketingWeeklyCap: 2,
  bookingMessagesEnabled: false, bookingReminderHours: 2,
  digestEnabled: false, digestHour: 9, digestPhone: null,
};

/** Review sites a happy guest may be sent to. The owner picks the exact page; anything else is refused. */
const REVIEW_HOSTS = ["google.com", "g.page", "goo.gl", "zomato.com", "swiggy.com", "tripadvisor.com", "tripadvisor.in", "justdial.com"];
export function isReviewUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    return REVIEW_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

const hour = z.number().int().min(0).max(23);
const patchSchema = z.object({
  referralEnabled: z.boolean(),
  referrerPoints: z.number().int().min(0).max(100000),
  refereePoints: z.number().int().min(0).max(100000),
  referralMinOrderValue: z.number().min(0).max(1_000_000),
  referralMonthlyCap: z.number().int().min(1).max(1000),
  birthdayCouponId: z.string().min(1).nullable(),
  anniversaryCouponId: z.string().min(1).nullable(),
  winbackCouponId: z.string().min(1).nullable(),
  winbackAfterDays: z.number().int().min(7).max(730),
  winbackCooldownDays: z.number().int().min(7).max(730),
  feedbackEnabled: z.boolean(),
  feedbackDelayMinutes: z.number().int().min(15).max(24 * 60),
  googleReviewUrl: z.string().trim().max(500).refine(isReviewUrl, "An https link to Google, Zomato, Swiggy, TripAdvisor or Justdial").nullable(),
  lowRatingMax: z.number().int().min(1).max(4),
  quietHoursStart: hour,
  quietHoursEnd: hour,
  marketingWeeklyCap: z.number().int().min(1).max(14),
  bookingMessagesEnabled: z.boolean(),
  bookingReminderHours: z.number().int().min(1).max(48),
  digestEnabled: z.boolean(),
  digestHour: hour,
  digestPhone: z.string().trim().max(20).nullable(),
}).partial().strict();

export async function getGrowthSettings(db: PrismaClient, organizationId: string): Promise<GrowthSettingsView> {
  const r = await db.growthSettings.findUnique({ where: { organizationId } });
  if (!r) return { ...DEFAULT_GROWTH_SETTINGS };
  return {
    referralEnabled: r.referralEnabled, referrerPoints: r.referrerPoints, refereePoints: r.refereePoints, referralMinOrderValue: money(r.referralMinOrderValue).toNumber(), referralMonthlyCap: r.referralMonthlyCap,
    birthdayCouponId: r.birthdayCouponId, anniversaryCouponId: r.anniversaryCouponId, winbackCouponId: r.winbackCouponId, winbackAfterDays: r.winbackAfterDays, winbackCooldownDays: r.winbackCooldownDays,
    feedbackEnabled: r.feedbackEnabled, feedbackDelayMinutes: r.feedbackDelayMinutes, googleReviewUrl: r.googleReviewUrl, lowRatingMax: r.lowRatingMax,
    quietHoursStart: r.quietHoursStart, quietHoursEnd: r.quietHoursEnd, marketingWeeklyCap: r.marketingWeeklyCap,
    bookingMessagesEnabled: r.bookingMessagesEnabled, bookingReminderHours: r.bookingReminderHours,
    digestEnabled: r.digestEnabled, digestHour: r.digestHour, digestPhone: r.digestPhone,
  };
}

export async function viewGrowthSettings(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "growth.view");
  return getGrowthSettings(db, ctx.organizationId);
}

export async function saveGrowthSettings(ctx: AccessContext, input: z.input<typeof patchSchema>, db: Client = prisma): Promise<GrowthSettingsView> {
  assertCan(ctx, "growth.manage");
  const patch = patchSchema.parse(input);
  if (patch.digestPhone !== undefined && patch.digestPhone !== null && !normalizePhone(patch.digestPhone)) throw new ValidationError("Enter the number as 10 digits or +country code", { fieldErrors: { digestPhone: ["Not a valid mobile number"] } });
  return runInTx(db, async (tx) => {
    const before = await getGrowthSettings(tx as PrismaClient, ctx.organizationId);
    const next = { ...before, ...patch } as GrowthSettingsView;
    if (next.digestPhone) next.digestPhone = normalizePhone(next.digestPhone);
    if (next.winbackCooldownDays < next.winbackAfterDays) throw new ValidationError("The win-back cooldown cannot be shorter than the inactivity period", { fieldErrors: { winbackCooldownDays: ["Must be at least the inactivity period"] } });
    for (const [field, id] of [["birthdayCouponId", next.birthdayCouponId], ["anniversaryCouponId", next.anniversaryCouponId], ["winbackCouponId", next.winbackCouponId]] as const) {
      if (!id) continue;
      const c = await tx.coupon.findUnique({ where: { id }, select: { organizationId: true, active: true } });
      if (!c || c.organizationId !== ctx.organizationId || !c.active) throw new ValidationError("Choose an active coupon of this restaurant", { fieldErrors: { [field]: ["Unknown or inactive coupon"] } });
    }
    const data = { ...next, referralMinOrderValue: next.referralMinOrderValue, updatedById: ctx.userId === "system" ? null : ctx.userId };
    await tx.growthSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "GrowthSettings", entityId: ctx.organizationId, before, after: next });
    return next;
  });
}
