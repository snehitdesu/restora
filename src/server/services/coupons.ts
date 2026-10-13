/**
 * Coupons and offers (proposal p. 17: coupons, first-order offers).
 *
 * A coupon is a code with rules: percentage or fixed amount (percentage with an optional cap), a minimum order,
 * validity dates, a total usage limit, a per-guest limit, first order only, a minimum loyalty tier, the channels and
 * outlets it works at, and whether it stacks with a manual discount. The server prices it: the client only ever sends
 * a code. It is applied through the order's own discount column and the order's totals function, so GST is computed on
 * the discounted value like any other discount, and the redemption (one per order) is the audit trail. Cancelled or
 * fully refunded orders release their coupon; changing the order's lines re-prices it (couponPricing.ts).
 *
 * Guests never learn why a code failed beyond what they can act on: unknown, inactive, expired, wrong outlet or wrong
 * channel all read "this code can't be used here".
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { OrderChannel } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { textContains } from "@/server/db/search";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { assertTotalCoversPaymentsTx, recomputeTotals } from "@/server/services/orders";
import { couponDiscount } from "@/server/services/couponPricing";
import { activeTiers, tierForSpend, tierRank, trailingSpend } from "@/server/services/loyaltyTiers";
import { D, money } from "@/domain/money";

type Dec = Prisma.Decimal;

export const COUPON_REASONS = ["NOT_VALID", "NOT_STARTED", "EXPIRED", "MIN_ORDER", "USAGE_LIMIT", "CUSTOMER_LIMIT", "FIRST_ORDER_ONLY", "TIER", "NEEDS_CUSTOMER", "NOT_STACKABLE", "NO_DISCOUNT"] as const;
export type CouponReason = (typeof COUPON_REASONS)[number];

export type CouponView = {
  id: string; code: string; name: string; description: string | null; kind: "PERCENT" | "FIXED"; value: number; maxDiscount: number | null; minOrderValue: number | null;
  validFrom: Date | null; validTo: Date | null; usageLimit: number | null; perCustomerLimit: number | null; firstOrderOnly: boolean; minTier: string | null;
  channels: string[]; outletIds: string[]; stackable: boolean; active: boolean; createdAt: Date;
  redeemed?: number; discountGiven?: number;
};

type CouponRow = Prisma.CouponGetPayload<object>;
const csv = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);
const toView = (c: CouponRow): CouponView => ({
  id: c.id, code: c.code, name: c.name, description: c.description, kind: c.kind as "PERCENT" | "FIXED", value: money(c.value).toNumber(),
  maxDiscount: c.maxDiscount == null ? null : money(c.maxDiscount).toNumber(), minOrderValue: c.minOrderValue == null ? null : money(c.minOrderValue).toNumber(),
  validFrom: c.validFrom, validTo: c.validTo, usageLimit: c.usageLimit, perCustomerLimit: c.perCustomerLimit, firstOrderOnly: c.firstOrderOnly, minTier: c.minTier,
  channels: csv(c.channels), outletIds: csv(c.outletIds), stackable: c.stackable, active: c.active, createdAt: c.createdAt,
});

const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/, "3-20 letters or digits"),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullish(),
  kind: z.enum(["PERCENT", "FIXED"]),
  value: z.number().positive().max(1_000_000),
  maxDiscount: z.number().positive().max(1_000_000).nullish(),
  minOrderValue: z.number().min(0).max(1_000_000).nullish(),
  validFrom: z.coerce.date().nullish(),
  validTo: z.coerce.date().nullish(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullish(),
  perCustomerLimit: z.number().int().min(1).max(1000).nullish(),
  firstOrderOnly: z.boolean().default(false),
  minTier: z.string().trim().toUpperCase().max(20).nullish(),
  channels: z.array(OrderChannel.zod).max(6).default([]),
  outletIds: z.array(z.string().min(1)).max(100).default([]),
  stackable: z.boolean().default(false),
  active: z.boolean().default(true),
});

async function validateCoupon(tx: Tx | PrismaClient, ctx: AccessContext, d: z.output<typeof couponSchema>) {
  if (d.kind === "PERCENT" && d.value > 100) throw new ValidationError("A percentage coupon is at most 100%", { fieldErrors: { value: ["At most 100"] } });
  if (d.kind === "FIXED" && d.maxDiscount != null) throw new ValidationError("A cap only applies to a percentage coupon", { fieldErrors: { maxDiscount: ["Only for percentage coupons"] } });
  if (d.validFrom && d.validTo && d.validTo <= d.validFrom) throw new ValidationError("The end must be after the start", { fieldErrors: { validTo: ["Must be after the start"] } });
  if (d.minTier) {
    const tiers = await activeTiers(tx, ctx.organizationId);
    if (!tiers.some((t) => t.code === d.minTier)) throw new ValidationError("That tier does not exist; set up tiers first", { fieldErrors: { minTier: ["Unknown tier"] } });
  }
  if (d.outletIds.length) {
    const found = await tx.outlet.count({ where: { organizationId: ctx.organizationId, id: { in: d.outletIds } } });
    if (found !== new Set(d.outletIds).size) throw new ValidationError("An outlet in the list is not this restaurant's", { fieldErrors: { outletIds: ["Unknown outlet"] } });
  }
}

const dataOf = (d: z.output<typeof couponSchema>) => ({
  code: d.code, name: d.name, description: d.description ?? null, kind: d.kind, value: d.value, maxDiscount: d.maxDiscount ?? null, minOrderValue: d.minOrderValue ?? null,
  validFrom: d.validFrom ?? null, validTo: d.validTo ?? null, usageLimit: d.usageLimit ?? null, perCustomerLimit: d.perCustomerLimit ?? null, firstOrderOnly: d.firstOrderOnly,
  minTier: d.minTier ?? null, channels: d.channels.length ? [...new Set(d.channels)].join(",") : null, outletIds: d.outletIds.length ? [...new Set(d.outletIds)].join(",") : null,
  stackable: d.stackable, active: d.active,
});

export async function createCoupon(ctx: AccessContext, input: z.input<typeof couponSchema>, db: Client = prisma): Promise<CouponView> {
  assertCan(ctx, "growth.manage");
  const d = couponSchema.parse(input);
  return runInTx(db, async (tx) => {
    await validateCoupon(tx, ctx, d);
    if (await tx.coupon.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code: d.code } } })) throw new ConflictError("A coupon with this code already exists");
    const row = await tx.coupon.create({ data: { organizationId: ctx.organizationId, createdById: ctx.userId === "system" ? null : ctx.userId, ...dataOf(d) } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Coupon", entityId: row.id, after: toView(row) });
    return toView(row);
  });
}

/** Rules can change any time; the code only until it has been used (a printed / sent code must keep meaning the same). */
export async function updateCoupon(ctx: AccessContext, couponId: string, patch: Partial<z.input<typeof couponSchema>>, db: Client = prisma): Promise<CouponView> {
  assertCan(ctx, "growth.manage");
  return runInTx(db, async (tx) => {
    const c = await tx.coupon.findUnique({ where: { id: couponId } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Coupon not found");
    const merged = couponSchema.parse({ ...toView(c), ...patch, channels: patch.channels ?? csv(c.channels), outletIds: patch.outletIds ?? csv(c.outletIds) });
    await validateCoupon(tx, ctx, merged);
    if (merged.code !== c.code) {
      if ((await tx.couponRedemption.count({ where: { couponId } })) > 0) throw new ValidationError("This code has been used; deactivate it and create a new one instead", { fieldErrors: { code: ["Already used"] } });
      if (await tx.coupon.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code: merged.code } } })) throw new ConflictError("A coupon with this code already exists");
    }
    const row = await tx.coupon.update({ where: { id: couponId }, data: dataOf(merged) });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Coupon", entityId: couponId, before: toView(c), after: toView(row) });
    return toView(row);
  });
}

export async function listCoupons(db: PrismaClient, ctx: AccessContext, filter: { active?: boolean; search?: string; take?: number } = {}): Promise<CouponView[]> {
  assertCan(ctx, "growth.view");
  const rows = await db.coupon.findMany({
    where: { organizationId: ctx.organizationId, ...(filter.active === undefined ? {} : { active: filter.active }), ...(filter.search ? { OR: [{ code: textContains(filter.search.toUpperCase()) }, { name: textContains(filter.search) }] } : {}) },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }], take: Math.min(filter.take ?? 100, 200),
  });
  const stats = await db.couponRedemption.groupBy({ by: ["couponId"], where: { organizationId: ctx.organizationId, status: "APPLIED", couponId: { in: rows.map((r) => r.id) } }, _count: { _all: true }, _sum: { amount: true } });
  return rows.map((r) => {
    const st = stats.find((x) => x.couponId === r.id);
    return { ...toView(r), redeemed: st?._count._all ?? 0, discountGiven: st ? money(st._sum.amount ?? 0).toNumber() : 0 };
  });
}

export async function couponRedemptions(db: PrismaClient, ctx: AccessContext, couponId: string, take = 50) {
  assertCan(ctx, "growth.view");
  const c = await db.coupon.findUnique({ where: { id: couponId }, select: { organizationId: true } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Coupon not found");
  const rows = await db.couponRedemption.findMany({ where: { couponId }, orderBy: { createdAt: "desc" }, take: Math.min(take, 200) });
  return rows.map((r) => ({ id: r.id, orderId: r.orderId, customerId: r.customerId, amount: money(r.amount).toNumber(), status: r.status, reverseReason: r.reverseReason, createdAt: r.createdAt }));
}

// ---------------------------------------------------------------- evaluation

export type Evaluation = { ok: true; coupon: CouponRow; discount: Dec } | { ok: false; reason: CouponReason; message: string };
const no = (reason: CouponReason, message: string): Evaluation => ({ ok: false, reason, message });

/** What a guest is told: only reasons they can act on; everything else reads the same. */
export function guestMessage(e: Extract<Evaluation, { ok: false }>): string {
  switch (e.reason) {
    case "MIN_ORDER": case "FIRST_ORDER_ONLY": case "NEEDS_CUSTOMER": case "USAGE_LIMIT": case "CUSTOMER_LIMIT": case "TIER": return e.message;
    default: return "This code can't be used here.";
  }
}

export type EvaluateArgs = {
  organizationId: string; outletId: string; channel: string; code: string;
  /** Pre-tax subtotal after line discounts. */
  subtotal: Dec | number | string;
  customerId?: string | null;
  /** The order the coupon would go on: its own redemption and manual discount are not counted against it. */
  orderId?: string;
  /** Manual discount already on the order (without a coupon's share). */
  manualDiscount?: Dec | number | string;
  now?: Date;
};

/** Decide whether the code works for this order and what it is worth. Read-only. */
export async function evaluateCoupon(db: PrismaClient | Tx, a: EvaluateArgs): Promise<Evaluation> {
  const now = a.now ?? new Date();
  const code = a.code.trim().toUpperCase();
  const c = code ? await db.coupon.findUnique({ where: { organizationId_code: { organizationId: a.organizationId, code } } }) : null;
  if (!c || !c.active) return no("NOT_VALID", "This code can't be used here.");
  if (c.channels && !csv(c.channels).includes(a.channel)) return no("NOT_VALID", "This code can't be used for this kind of order.");
  if (c.outletIds && !csv(c.outletIds).includes(a.outletId)) return no("NOT_VALID", "This code is not valid at this outlet.");
  if (c.validFrom && now < c.validFrom) return no("NOT_STARTED", "This code is not active yet.");
  if (c.validTo && now > c.validTo) return no("EXPIRED", "This code has expired.");
  const sub = D(a.subtotal);
  if (c.minOrderValue != null && sub.lt(D(c.minOrderValue))) return no("MIN_ORDER", `Add ₹${money(D(c.minOrderValue).minus(sub)).toFixed(2)} more to use this code.`);
  if (D(a.manualDiscount ?? 0).gt(0) && !c.stackable) return no("NOT_STACKABLE", `Coupon ${c.code} does not combine with another discount.`);
  const others = a.orderId ? { orderId: { not: a.orderId } } : {};
  if (c.usageLimit != null && (await db.couponRedemption.count({ where: { couponId: c.id, status: "APPLIED", ...others } })) >= c.usageLimit) return no("USAGE_LIMIT", "This code has been fully used.");
  if (c.perCustomerLimit != null || c.firstOrderOnly || c.minTier) {
    if (!a.customerId) return no("NEEDS_CUSTOMER", c.firstOrderOnly ? "Enter your mobile number to use this first-order code." : "Enter your mobile number to use this code.");
    if (c.perCustomerLimit != null && (await db.couponRedemption.count({ where: { couponId: c.id, customerId: a.customerId, status: "APPLIED", ...others } })) >= c.perCustomerLimit) return no("CUSTOMER_LIMIT", "You have already used this code.");
    if (c.firstOrderOnly && (await db.order.count({ where: { organizationId: a.organizationId, customerId: a.customerId, status: "PAID", ...(a.orderId ? { id: { not: a.orderId } } : {}) } })) > 0) return no("FIRST_ORDER_ONLY", "This code is for a first order only.");
    if (c.minTier) {
      const tiers = await activeTiers(db, a.organizationId);
      const spend = await trailingSpend(db, a.organizationId, a.customerId, now);
      const have = tierForSpend(tiers, spend)?.code;
      if (tierRank(tiers, have) < tierRank(tiers, c.minTier)) return no("TIER", `This code is for ${tiers.find((t) => t.code === c.minTier)?.name ?? c.minTier} members.`);
    }
  }
  const discount = couponDiscount(c, sub);
  if (discount.lte(0)) return no("NO_DISCOUNT", "This code gives no discount on this order.");
  return { ok: true, coupon: c, discount };
}

// ---------------------------------------------------------------- applying to an order

const CLOSED = ["PAID", "CANCELLED", "REFUNDED"];

/**
 * Put a coupon on an open order (replacing another coupon it carried). Internal: the caller authorized the action
 * (staff: order.discount; the guest QR flow: its own checks). Throws ValidationError with the guest-safe message.
 */
export async function applyCouponTx(tx: Tx, ctx: AccessContext, orderId: string, code: string): Promise<{ discount: number; coupon: CouponView }> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  if (CLOSED.includes(order.status)) throw new ValidationError(`Cannot change the discount of a ${order.status} order`);
  const current = await tx.couponRedemption.findFirst({ where: { orderId, status: "APPLIED" } });
  const manual = D(order.discount).minus(current ? D(current.amount) : 0);
  const ev = await evaluateCoupon(tx, { organizationId: ctx.organizationId, outletId: order.outletId, channel: order.channel, code, subtotal: order.subtotal, customerId: order.customerId, orderId, manualDiscount: manual.lt(0) ? 0 : manual });
  if (!ev.ok) throw new ValidationError(ev.message, { fieldErrors: { couponCode: [ev.message] }, reason: ev.reason } as never);
  if (current && current.couponId === ev.coupon.id) return { discount: money(current.amount).toNumber(), coupon: toView(ev.coupon) };
  if (current) await tx.couponRedemption.update({ where: { id: current.id }, data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "Replaced by another coupon" } });
  const prior = await tx.couponRedemption.findUnique({ where: { orderId_couponId: { orderId, couponId: ev.coupon.id } } });
  if (prior) await tx.couponRedemption.update({ where: { id: prior.id }, data: { status: "APPLIED", amount: ev.discount, reversedAt: null, reverseReason: null, customerId: order.customerId } });
  else await tx.couponRedemption.create({ data: { organizationId: ctx.organizationId, couponId: ev.coupon.id, orderId, customerId: order.customerId, amount: ev.discount } });
  await tx.order.update({ where: { id: orderId }, data: { discount: money((manual.lt(0) ? D(0) : manual).plus(ev.discount)) } });
  const updated = await recomputeTotals(tx, orderId);
  await assertTotalCoversPaymentsTx(tx, orderId, D(updated.total));
  await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { discount: money(order.discount).toFixed(2) }, after: { coupon: ev.coupon.code, couponDiscount: ev.discount.toFixed(2), discount: money(updated.discount).toFixed(2), total: money(updated.total).toFixed(2) } });
  return { discount: ev.discount.toNumber(), coupon: toView(ev.coupon) };
}

/** Staff: type the guest's code at the POS. Needs the same right as any discount, at the order's outlet. */
export async function applyCoupon(ctx: AccessContext, orderId: string, code: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { organizationId: true, outletId: true } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.discount", order.outletId);
    return applyCouponTx(tx, ctx, orderId, z.string().trim().min(1).max(40).parse(code));
  });
}

/** Staff: take the coupon off an open order (its discount goes with it; any manual discount stays). */
export async function removeCoupon(ctx: AccessContext, orderId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
    assertOutletAccess(ctx, order.outletId);
    assertCan(ctx, "order.discount", order.outletId);
    if (CLOSED.includes(order.status)) throw new ValidationError(`Cannot change the discount of a ${order.status} order`);
    const r = await tx.couponRedemption.findFirst({ where: { orderId, status: "APPLIED" } });
    if (!r) return { removed: false };
    await tx.couponRedemption.update({ where: { id: r.id }, data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "Removed by staff" } });
    const rest = D(order.discount).minus(D(r.amount));
    await tx.order.update({ where: { id: orderId }, data: { discount: money(rest.lt(0) ? D(0) : rest) } });
    await recomputeTotals(tx, orderId);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { couponDiscount: money(r.amount).toFixed(2) }, after: { couponRemoved: true } });
    return { removed: true };
  });
}

/** The coupon (if any) on an order, for the POS and the bill. */
export async function orderCoupon(db: PrismaClient, ctx: AccessContext, orderId: string) {
  assertCan(ctx, "order.view");
  const o = await db.order.findUnique({ where: { id: orderId }, select: { organizationId: true, outletId: true } });
  if (!o || o.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, o.outletId);
  const r = await db.couponRedemption.findFirst({ where: { orderId, status: "APPLIED" }, include: { coupon: { select: { code: true, name: true, stackable: true } } } });
  return r ? { code: r.coupon.code, name: r.coupon.name, amount: money(r.amount).toNumber(), stackable: r.coupon.stackable } : null;
}

/**
 * Guest-safe preview for the cart: what this code would be worth on this subtotal, or why not (in words a guest may
 * see). Nothing is created or counted. `customerId` is resolved by the caller from a phone the guest typed.
 */
export async function previewCoupon(db: PrismaClient, a: EvaluateArgs): Promise<{ ok: true; code: string; name: string; discount: string } | { ok: false; message: string }> {
  const ev = await evaluateCoupon(db, a);
  if (!ev.ok) return { ok: false, message: guestMessage(ev) };
  return { ok: true, code: ev.coupon.code, name: ev.coupon.name, discount: ev.discount.toFixed(2) };
}
