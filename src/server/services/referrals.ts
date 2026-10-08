/**
 * Referrals (proposal p. 17: "referral codes that track").
 *
 * Every guest can have one code. A new guest who arrives with a friend's code is recorded as referred, once, ever.
 * Nothing is paid out at that moment: when the referred guest's FIRST order is paid (and is worth at least the
 * configured minimum) both guests get points in the loyalty ledger. Abuse is closed off by rules, not hope: a guest
 * cannot refer themselves, only a guest with no paid order can be referred, one referral per referred guest, a monthly
 * cap on rewards per referrer, and a refund of the qualifying order takes the points back.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { grantPointsTx } from "@/server/services/loyalty";
import { getGrowthSettings } from "@/server/services/growthSettings";
import { D } from "@/domain/money";

// Crockford base32 without the look-alikes: easy to read out over a counter.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const REFERRAL_CODE = /^RF[0-9A-HJKMNP-TV-Z]{6}$/;
const newCode = () => "RF" + Array.from(randomBytes(6), (b) => ALPHABET[b % 32]).join("");

export const normalizeReferralCode = (raw: string) => raw.trim().toUpperCase().replace(/[\s-]/g, "");

async function loadCustomer(db: PrismaClient | Tx, ctx: AccessContext, customerId: string) {
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, organizationId: true, name: true } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  return c;
}

/** The guest's code, created on first ask. */
export async function getOrCreateReferralCode(ctx: AccessContext, customerId: string, db: Client = prisma): Promise<{ code: string }> {
  assertCan(ctx, "customer.manage");
  return runInTx(db, async (tx) => {
    await loadCustomer(tx, ctx, customerId);
    const existing = await tx.referralCode.findUnique({ where: { organizationId_customerId: { organizationId: ctx.organizationId, customerId } } });
    if (existing) return { code: existing.code };
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      if (await tx.referralCode.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } })) continue;
      const row = await tx.referralCode.create({ data: { organizationId: ctx.organizationId, customerId, code } });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "ReferralCode", entityId: row.id, after: { customerId, code } });
      return { code };
    }
    throw new ValidationError("Could not allocate a referral code; try again");
  });
}

export type AttachResult = { status: "ATTACHED" | "IGNORED"; reason?: string; referralId?: string };

/**
 * Record that `referredCustomerId` came with a friend's code. Internal (guest checkout, staff attach). Never throws for a
 * bad code: the order must not fail because of a referral, so the reason is returned for the caller to show or ignore.
 */
export async function attachReferralTx(tx: Tx, ctx: AccessContext, referredCustomerId: string, rawCode: string): Promise<AttachResult> {
  const settings = await getGrowthSettings(tx as unknown as PrismaClient, ctx.organizationId);
  if (!settings.referralEnabled) return { status: "IGNORED", reason: "Referrals are not enabled" };
  const code = normalizeReferralCode(rawCode);
  if (!REFERRAL_CODE.test(code)) return { status: "IGNORED", reason: "That referral code is not valid" };
  const rc = await tx.referralCode.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } } });
  if (!rc) return { status: "IGNORED", reason: "That referral code is not valid" };
  if (rc.customerId === referredCustomerId) return { status: "IGNORED", reason: "You cannot use your own code" };
  if (await tx.referral.findUnique({ where: { organizationId_referredCustomerId: { organizationId: ctx.organizationId, referredCustomerId } } })) return { status: "IGNORED", reason: "A referral code was already used" };
  if ((await tx.order.count({ where: { organizationId: ctx.organizationId, customerId: referredCustomerId, status: { in: ["PAID", "REFUNDED"] } } })) > 0) return { status: "IGNORED", reason: "Referral codes are for new guests" };
  const row = await tx.referral.create({ data: { organizationId: ctx.organizationId, referrerCustomerId: rc.customerId, referredCustomerId, codeId: rc.id } });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "Referral", entityId: row.id, after: { referrerCustomerId: rc.customerId, referredCustomerId } });
  return { status: "ATTACHED", referralId: row.id };
}

/** Staff: record a walk-in friend's code against their guest record (customer.manage). */
export async function attachReferral(ctx: AccessContext, referredCustomerId: string, code: string, db: Client = prisma): Promise<AttachResult> {
  assertCan(ctx, "customer.manage");
  return runInTx(db, async (tx) => {
    await loadCustomer(tx, ctx, referredCustomerId);
    return attachReferralTx(tx, ctx, referredCustomerId, z.string().min(4).max(20).parse(code));
  });
}

/**
 * After an order is paid: if it is the referred guest's first paid order and meets the minimum, pay both sides once.
 * Idempotent: the status flips PENDING -> REWARDED in one guarded update, so a replayed settlement pays nothing.
 */
export async function rewardReferralTx(tx: Tx, ctx: AccessContext, orderId: string): Promise<{ rewarded: boolean; reason?: string }> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, organizationId: true, outletId: true, customerId: true, total: true, status: true } });
  if (!order || order.organizationId !== ctx.organizationId || !order.customerId || order.status !== "PAID") return { rewarded: false };
  const ref = await tx.referral.findUnique({ where: { organizationId_referredCustomerId: { organizationId: ctx.organizationId, referredCustomerId: order.customerId } } });
  if (!ref || ref.status !== "PENDING") return { rewarded: false };
  const settings = await getGrowthSettings(tx as unknown as PrismaClient, ctx.organizationId);
  if (!settings.referralEnabled) return { rewarded: false, reason: "Referrals are not enabled" };
  const paidBefore = await tx.order.count({ where: { organizationId: ctx.organizationId, customerId: order.customerId, status: { in: ["PAID", "REFUNDED"] }, id: { not: orderId } } });
  if (paidBefore > 0) {
    await tx.referral.updateMany({ where: { id: ref.id, status: "PENDING" }, data: { status: "REJECTED", rejectReason: "Not the guest's first order" } });
    return { rewarded: false, reason: "Not the guest's first order" };
  }
  if (D(order.total).lt(D(settings.referralMinOrderValue))) {
    // The first order decides: a referral is not kept waiting for a bigger one.
    await tx.referral.updateMany({ where: { id: ref.id, status: "PENDING" }, data: { status: "REJECTED", rejectReason: "The first order was below the minimum order value" } });
    return { rewarded: false, reason: "Below the minimum order value" };
  }
  const since = new Date(Date.now() - 30 * 86400_000);
  const rewardedThisMonth = await tx.referral.count({ where: { organizationId: ctx.organizationId, referrerCustomerId: ref.referrerCustomerId, status: "REWARDED", rewardedAt: { gte: since } } });
  if (rewardedThisMonth >= settings.referralMonthlyCap) {
    await tx.referral.updateMany({ where: { id: ref.id, status: "PENDING" }, data: { status: "REJECTED", rejectReason: "The referrer reached the monthly limit" } });
    return { rewarded: false, reason: "The referrer reached the monthly limit" };
  }
  const claimed = await tx.referral.updateMany({ where: { id: ref.id, status: "PENDING" }, data: { status: "REWARDED", rewardedAt: new Date(), qualifyingOrderId: orderId, referrerPoints: settings.referrerPoints, refereePoints: settings.refereePoints } });
  if (claimed.count !== 1) return { rewarded: false }; // a concurrent settlement already paid it
  if (settings.referrerPoints > 0) await grantPointsTx(tx, ctx, ref.referrerCustomerId, settings.referrerPoints, `Referral reward (${ref.id})`, order.outletId);
  if (settings.refereePoints > 0) await grantPointsTx(tx, ctx, order.customerId, settings.refereePoints, `Welcome points (referral ${ref.id})`, order.outletId);
  await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Referral", entityId: ref.id, outletId: order.outletId, before: { status: "PENDING" }, after: { status: "REWARDED", orderId, referrerPoints: settings.referrerPoints, refereePoints: settings.refereePoints } });
  return { rewarded: true };
}

/** The qualifying order was fully refunded: take the points back (capped at what each guest still has). Idempotent. */
export async function reverseReferralRewardTx(tx: Tx, ctx: AccessContext, orderId: string): Promise<boolean> {
  const ref = await tx.referral.findFirst({ where: { organizationId: ctx.organizationId, qualifyingOrderId: orderId, status: "REWARDED" } });
  if (!ref) return false;
  const claimed = await tx.referral.updateMany({ where: { id: ref.id, status: "REWARDED" }, data: { status: "REJECTED", rejectReason: "The qualifying order was refunded" } });
  if (claimed.count !== 1) return false;
  if (ref.referrerPoints) await grantPointsTx(tx, ctx, ref.referrerCustomerId, -ref.referrerPoints, `Referral reward reversed (${ref.id})`);
  if (ref.refereePoints) await grantPointsTx(tx, ctx, ref.referredCustomerId, -ref.refereePoints, `Welcome points reversed (${ref.id})`);
  await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Referral", entityId: ref.id, before: { status: "REWARDED" }, after: { status: "REJECTED", reason: "refunded" } });
  return true;
}

export async function listReferrals(db: PrismaClient, ctx: AccessContext, filter: { status?: string; take?: number } = {}) {
  assertCan(ctx, "growth.view");
  const rows = await db.referral.findMany({ where: { organizationId: ctx.organizationId, ...(filter.status ? { status: filter.status } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(filter.take ?? 100, 200) });
  const ids = [...new Set(rows.flatMap((r) => [r.referrerCustomerId, r.referredCustomerId]))];
  const names = new Map((await db.customer.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ id: r.id, referrer: { id: r.referrerCustomerId, name: names.get(r.referrerCustomerId) ?? "" }, referred: { id: r.referredCustomerId, name: names.get(r.referredCustomerId) ?? "" }, status: r.status, rejectReason: r.rejectReason, referrerPoints: r.referrerPoints, refereePoints: r.refereePoints, createdAt: r.createdAt, rewardedAt: r.rewardedAt }));
}

export async function referralSummary(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "growth.view");
  const g = await db.referral.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId }, _count: { _all: true }, _sum: { referrerPoints: true, refereePoints: true } });
  const by = (s: string) => g.find((x) => x.status === s);
  return { pending: by("PENDING")?._count._all ?? 0, rewarded: by("REWARDED")?._count._all ?? 0, rejected: by("REJECTED")?._count._all ?? 0, pointsGiven: (by("REWARDED")?._sum.referrerPoints ?? 0) + (by("REWARDED")?._sum.refereePoints ?? 0) };
}

/** A customer's own code and who they brought (profile). */
export async function customerReferrals(db: PrismaClient, ctx: AccessContext, customerId: string) {
  assertCan(ctx, "customer.view");
  await loadCustomer(db, ctx, customerId);
  const code = await db.referralCode.findUnique({ where: { organizationId_customerId: { organizationId: ctx.organizationId, customerId } } });
  const brought = await db.referral.findMany({ where: { organizationId: ctx.organizationId, referrerCustomerId: customerId }, orderBy: { createdAt: "desc" }, take: 50 });
  const cameWith = await db.referral.findUnique({ where: { organizationId_referredCustomerId: { organizationId: ctx.organizationId, referredCustomerId: customerId } } });
  return { code: code?.code ?? null, brought: brought.map((b) => ({ id: b.id, referredCustomerId: b.referredCustomerId, status: b.status, rewardedAt: b.rewardedAt })), cameWith: cameWith ? { status: cameWith.status, referrerCustomerId: cameWith.referrerCustomerId } : null };
}
