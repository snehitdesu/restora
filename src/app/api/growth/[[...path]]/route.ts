import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { viewGrowthSettings, saveGrowthSettings } from "@/server/services/growthSettings";
import { listTiers, saveTier, loyaltySummary } from "@/server/services/loyaltyTiers";
import { createCoupon, updateCoupon, listCoupons, couponRedemptions, applyCoupon, removeCoupon, orderCoupon } from "@/server/services/coupons";
import { getOrCreateReferralCode, attachReferral, listReferrals, referralSummary, customerReferrals } from "@/server/services/referrals";
import { getConsent, setConsent, consentSummary } from "@/server/services/consent";
import { createCampaign, updateCampaign, listCampaigns, campaignDetail, previewAudience, scheduleCampaign, cancelCampaign } from "@/server/services/campaigns";
import { feedbackInbox, handleFeedback, feedbackTrends, feedbackAttention } from "@/server/services/feedbackLoop";
import { digestPreview } from "@/server/services/digest";

export const runtime = "nodejs";

const take = z.coerce.number().int().positive().max(200).optional();
const bool = z.enum(["true", "false"]).transform((v) => v === "true").optional();

// Group 6: coupons, tiers, referrals, consent, campaigns, feedback handling, the morning summary. Thin handlers: the
// services check permissions, tenancy and rules.
export const { GET, POST, PATCH } = createRouter([
  { method: "GET", path: "settings", handler: ({ ctx }) => viewGrowthSettings(prisma, ctx) },
  { method: "PATCH", path: "settings", handler: ({ ctx, body }) => saveGrowthSettings(ctx, body as never) },

  { method: "GET", path: "tiers", handler: ({ ctx }) => listTiers(prisma, ctx) },
  { method: "POST", path: "tiers", handler: ({ ctx, body }) => saveTier(ctx, body as never) },

  { method: "GET", path: "coupons", handler: ({ ctx, query }) => listCoupons(prisma, ctx, z.object({ active: bool, search: z.string().max(40).optional(), take }).parse(query)) },
  { method: "POST", path: "coupons", handler: ({ ctx, body }) => createCoupon(ctx, body as never) },
  { method: "PATCH", path: "coupons/:id", handler: ({ ctx, params, body }) => updateCoupon(ctx, params.id, body as never) },
  { method: "GET", path: "coupons/:id/redemptions", handler: ({ ctx, params, query }) => couponRedemptions(prisma, ctx, params.id, z.object({ take }).parse(query).take) },

  { method: "GET", path: "orders/:orderId/coupon", handler: ({ ctx, params }) => orderCoupon(prisma, ctx, params.orderId) },
  { method: "POST", path: "orders/:orderId/coupon", handler: ({ ctx, params, body }) => applyCoupon(ctx, params.orderId, z.object({ code: z.string().trim().min(1).max(40) }).parse(body).code) },
  { method: "POST", path: "orders/:orderId/coupon/remove", handler: ({ ctx, params }) => removeCoupon(ctx, params.orderId) },

  { method: "GET", path: "customers/:id/consent", handler: ({ ctx, params }) => getConsent(prisma, ctx, params.id) },
  { method: "POST", path: "customers/:id/consent", handler: ({ ctx, params, body }) => setConsent(ctx, params.id, z.array(z.unknown()).parse((body as { channels?: unknown }).channels) as never) },
  { method: "GET", path: "customers/:id/loyalty", handler: ({ ctx, params }) => loyaltySummary(prisma, ctx, params.id) },
  { method: "GET", path: "customers/:id/referrals", handler: ({ ctx, params }) => customerReferrals(prisma, ctx, params.id) },
  { method: "POST", path: "customers/:id/referral-code", handler: ({ ctx, params }) => getOrCreateReferralCode(ctx, params.id) },
  { method: "POST", path: "customers/:id/referral", handler: ({ ctx, params, body }) => attachReferral(ctx, params.id, z.object({ code: z.string().min(4).max(20) }).parse(body).code) },
  { method: "GET", path: "consent/summary", handler: ({ ctx }) => consentSummary(prisma, ctx) },

  { method: "GET", path: "referrals", handler: ({ ctx, query }) => listReferrals(prisma, ctx, z.object({ status: z.enum(["PENDING", "REWARDED", "REJECTED"]).optional(), take }).parse(query)) },
  { method: "GET", path: "referrals/summary", handler: ({ ctx }) => referralSummary(prisma, ctx) },

  { method: "GET", path: "campaigns", handler: ({ ctx, query }) => listCampaigns(prisma, ctx, z.object({ status: z.string().max(20).optional(), take }).parse(query)) },
  { method: "POST", path: "campaigns", handler: ({ ctx, body }) => createCampaign(ctx, body as never) },
  { method: "POST", path: "campaigns/preview", handler: ({ ctx, body }) => previewAudience(prisma, ctx, body as never) },
  { method: "GET", path: "campaigns/:id", handler: ({ ctx, params }) => campaignDetail(prisma, ctx, params.id) },
  { method: "PATCH", path: "campaigns/:id", handler: ({ ctx, params, body }) => updateCampaign(ctx, params.id, body as never) },
  { method: "POST", path: "campaigns/:id/schedule", handler: ({ ctx, params, body }) => scheduleCampaign(ctx, params.id, (body as { at?: string } | undefined)?.at) },
  { method: "POST", path: "campaigns/:id/cancel", handler: ({ ctx, params }) => cancelCampaign(ctx, params.id) },

  { method: "GET", path: "feedback", handler: ({ ctx, query }) => feedbackInbox(prisma, ctx, z.object({ outletId: z.string().optional(), status: z.enum(["NEW", "ACKNOWLEDGED", "RESOLVED"]).optional(), maxRating: z.coerce.number().int().min(1).max(5).optional(), source: z.enum(["STAFF", "GUEST"]).optional(), take, cursor: z.string().optional() }).parse(query)) },
  { method: "GET", path: "feedback/attention", handler: ({ ctx }) => feedbackAttention(prisma, ctx) },
  { method: "GET", path: "feedback/trends", handler: ({ ctx, query }) => feedbackTrends(prisma, ctx, query as never) },
  { method: "POST", path: "feedback/:id/handle", handler: ({ ctx, params, body }) => handleFeedback(ctx, params.id, body as never) },

  { method: "GET", path: "digest", handler: ({ ctx, query }) => digestPreview(prisma, ctx, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(query).date) },
]);
