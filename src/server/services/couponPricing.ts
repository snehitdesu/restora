/**
 * Coupon arithmetic and the repricing hook used by orders.ts. Kept free of any import from orders.ts so the order
 * service can call it while recomputing totals (no cycle). The order's single `discount` column holds the guest-visible
 * total discount; the applied coupon's share of it is the redemption's `amount`, the rest is a manual discount.
 */
import type { Prisma } from "@prisma/client";
import { D, money } from "@/domain/money";

type Dec = Prisma.Decimal;
type Tx = Prisma.TransactionClient;

export type CouponRule = { kind: string; value: unknown; maxDiscount: unknown | null; minOrderValue: unknown | null };

/** The discount a coupon gives on this (pre-tax, after line discounts) subtotal; never more than the subtotal. */
export function couponDiscount(c: CouponRule, subtotal: Dec | number | string): Dec {
  const sub = D(subtotal);
  if (sub.lte(0)) return D(0);
  let amount = c.kind === "PERCENT" ? sub.times(D(c.value as never)).div(100) : D(c.value as never);
  if (c.kind === "PERCENT" && c.maxDiscount != null) amount = amount.lt(D(c.maxDiscount as never)) ? amount : D(c.maxDiscount as never);
  amount = amount.lt(sub) ? amount : sub;
  return money(amount);
}

/**
 * After an order's lines changed: re-price its applied coupon on the new subtotal and return the order's new total
 * discount (manual share unchanged), or null when no coupon is applied. A coupon whose minimum is no longer met is
 * released (the redemption is REVERSED with the reason) so the guest never keeps a discount the rules do not allow.
 */
export async function repriceAppliedCoupon(tx: Tx, order: { id: string; discount: unknown }, subtotal: Dec): Promise<{ discount: Dec } | null> {
  const r = await tx.couponRedemption.findFirst({ where: { orderId: order.id, status: "APPLIED" }, include: { coupon: true } });
  if (!r) return null;
  const manual = D(order.discount as never).minus(D(r.amount)).lt(0) ? D(0) : D(order.discount as never).minus(D(r.amount));
  const min = r.coupon.minOrderValue == null ? null : D(r.coupon.minOrderValue);
  if (min && subtotal.lt(min)) {
    await tx.couponRedemption.update({ where: { id: r.id }, data: { status: "REVERSED", reversedAt: new Date(), reverseReason: "The order fell below the coupon's minimum after a change", amount: 0 } });
    return { discount: money(manual) };
  }
  const amount = couponDiscount(r.coupon, subtotal);
  if (!amount.eq(D(r.amount))) await tx.couponRedemption.update({ where: { id: r.id }, data: { amount } });
  return { discount: money(manual.plus(amount)) };
}
