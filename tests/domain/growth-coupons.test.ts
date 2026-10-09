/**
 * Coupons and offers (QR-10) against the real services and database.
 *
 *  K1 managing coupons: validation, duplicates, code locked after use, stats, audit, permissions, tenants
 *  K2 the rules matrix: window, channel, outlet, minimum, limits, first order, tier, stacking, caps
 *  K3 applying to an order: GST on the discounted value, replacement, removal, authorization
 *  K4 the order changes after the coupon: re-pricing, release below the minimum, manual discounts
 *  K5 lifecycle: paid consumes, cancelled and refunded release
 *  K6 two orders race for the last use
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { applyCoupon, couponRedemptions, createCoupon, evaluateCoupon, guestMessage, listCoupons, orderCoupon, removeCoupon, updateCoupon } from "@/server/services/coupons";
import { couponDiscount } from "@/server/services/couponPricing";
import { saveTier } from "@/server/services/loyaltyTiers";
import { addOrderItem, applyDiscount, cancelOrder, createOrder, removeOrderItem } from "@/server/services/orders";
import { createPayment, refundPayment, verifyPayment } from "@/server/services/payment";
import { makeEnv, guest, paidOrder, uniq, type Env } from "./growthSupport";

let env: Env;
const code = (p: string) => `${p}${uniq()}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
const base = (over: Record<string, unknown> = {}) => ({ code: code("C"), name: "Test coupon", kind: "PERCENT" as const, value: 10, ...over });

async function openOrder(amount: number, opts: { customerId?: string; outletId?: string; taxPct?: number; channel?: string } = {}) {
  const o = await createOrder(env.owner, { outletId: opts.outletId ?? env.outletA, customerId: opts.customerId, channel: (opts.channel ?? "TAKEAWAY") as never });
  const item = await addOrderItem(env.owner, o.id, { name: "Meal", qty: 1, unitPrice: amount, taxPct: opts.taxPct ?? 0 });
  return { id: o.id, itemId: (item as { id: string }).id as string };
}
const totals = async (orderId: string) => { const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId } }); return { subtotal: Number(o.subtotal), discount: Number(o.discount), tax: Number(o.tax), total: Number(o.total) }; };

beforeAll(async () => { env = await makeEnv("Gcp"); });
afterAll(async () => { await prisma.$disconnect(); });

describe("K1. managing coupons", () => {
  it("K1 growth.manage creates, validates, audits; duplicates are refused; the code is locked once used; tenants are separate", async () => {
    await expect(createCoupon(env.cashier, base())).rejects.toBeInstanceOf(ForbiddenError);
    for (const bad of [base({ value: 101 }), base({ value: 0 }), base({ kind: "FIXED", maxDiscount: 50 }), base({ code: "ab" }), base({ code: "has space" }), base({ validFrom: new Date("2026-02-01"), validTo: new Date("2026-01-01") }), base({ minTier: "NOPE" }), base({ outletIds: ["not-mine"] }), base({ channels: ["PIGEON"] }), base({ usageLimit: 0 })]) {
      await expect(createCoupon(env.manager, bad as never), JSON.stringify(bad)).rejects.toThrow();
    }
    const c = await createCoupon(env.manager, base({ code: "welcome10", name: " Welcome ", maxDiscount: 150, minOrderValue: 200, usageLimit: 100, perCustomerLimit: 1, firstOrderOnly: true, channels: ["QR", "DINE_IN"], outletIds: [env.outletA] }));
    expect(c).toMatchObject({ code: "WELCOME10", name: "Welcome", kind: "PERCENT", value: 10, maxDiscount: 150, minOrderValue: 200, usageLimit: 100, perCustomerLimit: 1, firstOrderOnly: true, channels: ["QR", "DINE_IN"], outletIds: [env.outletA], stackable: false, active: true });
    await expect(createCoupon(env.manager, base({ code: "Welcome10" }))).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.auditLog.count({ where: { organizationId: env.orgId, entityType: "Coupon", entityId: c.id, action: "CREATE" } })).toBe(1);
    // the other tenant may use the same code
    await expect(createCoupon(env.foreign, base({ code: "WELCOME10" }))).resolves.toMatchObject({ code: "WELCOME10" });

    const upd = await updateCoupon(env.manager, c.id, { value: 15, active: false });
    expect(upd).toMatchObject({ value: 15, active: false });
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Coupon", entityId: c.id, action: "UPDATE" } });
    expect(JSON.parse(audit!.before!)).toMatchObject({ value: 10, active: true });
    await expect(updateCoupon(env.cashier, c.id, { value: 5 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateCoupon(env.foreign, c.id, { value: 5 })).rejects.toBeInstanceOf(NotFoundError);

    // a used code can be switched off but not renamed
    const used = await createCoupon(env.manager, base({ code: code("USED") }));
    const o = await openOrder(1000);
    await applyCoupon(env.owner, o.id, used.code);
    await expect(updateCoupon(env.manager, used.id, { code: code("NEWC") })).rejects.toThrow(/has been used/);
    await expect(updateCoupon(env.manager, used.id, { name: "Renamed" })).resolves.toMatchObject({ name: "Renamed" });
    const listed = (await listCoupons(prisma, env.manager)).find((x) => x.id === used.id)!;
    expect(listed).toMatchObject({ redeemed: 1, discountGiven: 100 });
    expect((await couponRedemptions(prisma, env.manager, used.id))[0]).toMatchObject({ orderId: o.id, amount: 100, status: "APPLIED" });
    expect((await listCoupons(prisma, env.manager, { search: "renamed" })).map((x) => x.id)).toContain(used.id);
    await expect(listCoupons(prisma, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("K1b the discount arithmetic: percentage with a cap, fixed, never more than the subtotal, in paise", () => {
    expect(couponDiscount({ kind: "PERCENT", value: 10, maxDiscount: null, minOrderValue: null }, 1234.5).toFixed(2)).toBe("123.45");
    expect(couponDiscount({ kind: "PERCENT", value: 10, maxDiscount: 100, minOrderValue: null }, 5000).toFixed(2)).toBe("100.00");
    expect(couponDiscount({ kind: "PERCENT", value: 33.33, maxDiscount: null, minOrderValue: null }, 99.99).toFixed(2)).toBe("33.33");
    expect(couponDiscount({ kind: "FIXED", value: 250, maxDiscount: null, minOrderValue: null }, 180).toFixed(2)).toBe("180.00");
    expect(couponDiscount({ kind: "FIXED", value: 50, maxDiscount: null, minOrderValue: null }, 0).toFixed(2)).toBe("0.00");
    expect(couponDiscount({ kind: "PERCENT", value: 100, maxDiscount: null, minOrderValue: null }, 80).toFixed(2)).toBe("80.00");
  });
});

describe("K2. the rules matrix", () => {
  const ev = (c: string, over: Record<string, unknown> = {}) => evaluateCoupon(prisma, { organizationId: env.orgId, outletId: env.outletA, channel: "QR", code: c, subtotal: 1000, ...over } as never);

  it("K2 unknown, inactive, wrong channel / outlet, not started, expired read as NOT_VALID-style refusals; guests are told only what they can act on", async () => {
    expect(await ev("NOPE")).toMatchObject({ ok: false, reason: "NOT_VALID" });
    const off = await createCoupon(env.manager, base({ active: false }));
    expect(await ev(off.code)).toMatchObject({ ok: false, reason: "NOT_VALID" });
    const ch = await createCoupon(env.manager, base({ channels: ["DINE_IN"] }));
    expect(await ev(ch.code)).toMatchObject({ ok: false, reason: "NOT_VALID" });
    expect(await ev(ch.code, { channel: "DINE_IN" })).toMatchObject({ ok: true });
    const out = await createCoupon(env.manager, base({ outletIds: [env.outletB] }));
    expect(await ev(out.code)).toMatchObject({ ok: false, reason: "NOT_VALID" });
    expect(await ev(out.code, { outletId: env.outletB })).toMatchObject({ ok: true });
    const future = await createCoupon(env.manager, base({ validFrom: new Date(Date.now() + 86400_000) }));
    expect(await ev(future.code)).toMatchObject({ ok: false, reason: "NOT_STARTED" });
    const past = await createCoupon(env.manager, base({ validTo: new Date(Date.now() - 86400_000) }));
    const e = await ev(past.code);
    expect(e).toMatchObject({ ok: false, reason: "EXPIRED" });
    expect(await ev(past.code, { now: new Date(Date.now() - 2 * 86400_000) })).toMatchObject({ ok: true }); // valid then

    // a guest is never told whether a code exists, only what they can act on
    const msgs = [await ev("NOPE"), await ev(off.code), await ev(ch.code), await ev(past.code)].map((x) => guestMessage(x as never));
    expect(new Set(msgs)).toEqual(new Set(["This code can't be used here."]));
    const min = await createCoupon(env.manager, base({ minOrderValue: 500 }));
    expect(guestMessage((await ev(min.code, { subtotal: 300 })) as never)).toBe("Add ₹200.00 more to use this code.");
  });

  it("K2b minimum order, usage limit, per-guest limit, first order only, tier, needs a guest", async () => {
    const min = await createCoupon(env.manager, base({ minOrderValue: 500 }));
    expect(await ev(min.code, { subtotal: 499.99 })).toMatchObject({ ok: false, reason: "MIN_ORDER" });
    expect(await ev(min.code, { subtotal: 500 })).toMatchObject({ ok: true });

    const cap = await createCoupon(env.manager, base({ usageLimit: 1, perCustomerLimit: 1 }));
    const g = await guest(env, "Neha");
    const g2 = await guest(env, "Omar");
    expect(await ev(cap.code, { customerId: g.id })).toMatchObject({ ok: true }); // a per-guest limit needs the guest to be known; here they are
    const o1 = await openOrder(1000, { customerId: g.id });
    await applyCoupon(env.owner, o1.id, cap.code);
    expect(await ev(cap.code, { customerId: g2.id })).toMatchObject({ ok: false, reason: "USAGE_LIMIT" });
    // the order that holds it can look again (its own use does not count against it)
    expect(await ev(cap.code, { customerId: g.id, orderId: o1.id })).toMatchObject({ ok: true });

    const per = await createCoupon(env.manager, base({ perCustomerLimit: 1 }));
    expect(await ev(per.code)).toMatchObject({ ok: false, reason: "NEEDS_CUSTOMER" });
    const o2 = await openOrder(1000, { customerId: g2.id });
    await applyCoupon(env.owner, o2.id, per.code);
    const o3 = await openOrder(1000, { customerId: g2.id });
    await expect(applyCoupon(env.owner, o3.id, per.code)).rejects.toThrow(/already used/);

    const first = await createCoupon(env.manager, base({ firstOrderOnly: true }));
    const veteran = await guest(env, "Pia");
    await paidOrder(env, env.outletA, veteran.id, 100);
    expect(await ev(first.code, { customerId: veteran.id })).toMatchObject({ ok: false, reason: "FIRST_ORDER_ONLY" });
    const newbie = await guest(env, "Quin");
    expect(await ev(first.code, { customerId: newbie.id })).toMatchObject({ ok: true });
    expect(await ev(first.code)).toMatchObject({ ok: false, reason: "NEEDS_CUSTOMER" });

    await saveTier(env.manager, { code: "BASE", name: "Member", minSpend: 0 });
    await saveTier(env.manager, { code: "GOLD", name: "Gold", minSpend: 5000 });
    const gold = await createCoupon(env.manager, base({ minTier: "gold" }));
    expect(await ev(gold.code, { customerId: newbie.id })).toMatchObject({ ok: false, reason: "TIER" });
    expect(guestMessage((await ev(gold.code, { customerId: newbie.id })) as never)).toBe("This code is for Gold members.");
    const big = await guest(env, "Ria");
    await paidOrder(env, env.outletA, big.id, 6000);
    expect(await ev(gold.code, { customerId: big.id })).toMatchObject({ ok: true });
  });

  it("K2c stacking: a coupon that does not stack refuses an order that already has a manual discount", async () => {
    const plain = await createCoupon(env.manager, base());
    const stack = await createCoupon(env.manager, base({ stackable: true }));
    expect(await ev(plain.code, { manualDiscount: 20 })).toMatchObject({ ok: false, reason: "NOT_STACKABLE" });
    expect(await ev(stack.code, { manualDiscount: 20 })).toMatchObject({ ok: true });
    expect(await ev(plain.code, { manualDiscount: 0 })).toMatchObject({ ok: true });
  });
});

describe("K3. applying to an order", () => {
  it("K3 GST is levied on the discounted value; the redemption and audit say what happened; the same code twice changes nothing", async () => {
    const c = await createCoupon(env.manager, base({ value: 10 }));
    const o = await openOrder(1000, { taxPct: 5 });
    expect(await totals(o.id)).toEqual({ subtotal: 1000, discount: 0, tax: 50, total: 1050 });
    const r = await applyCoupon(env.cashier, o.id, ` ${c.code.toLowerCase()} `);
    expect(r).toMatchObject({ discount: 100, coupon: { code: c.code } });
    expect(await totals(o.id)).toEqual({ subtotal: 1000, discount: 100, tax: 45, total: 945 }); // 900 + 5% GST
    expect(await orderCoupon(prisma, env.cashier, o.id)).toMatchObject({ code: c.code, amount: 100 });
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "Order", entityId: o.id, action: "UPDATE" }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(audit!.after!)).toMatchObject({ coupon: c.code, couponDiscount: "100.00", discount: "100.00", total: "945.00" });

    await applyCoupon(env.cashier, o.id, c.code); // again: same state
    expect(await totals(o.id)).toEqual({ subtotal: 1000, discount: 100, tax: 45, total: 945 });
    expect(await prisma.couponRedemption.count({ where: { orderId: o.id } })).toBe(1);

    // another coupon replaces it (the first is REVERSED, not deleted)
    const c2 = await createCoupon(env.manager, base({ kind: "FIXED", value: 200 }));
    await applyCoupon(env.cashier, o.id, c2.code);
    expect(await totals(o.id)).toEqual({ subtotal: 1000, discount: 200, tax: 40, total: 840 });
    expect((await prisma.couponRedemption.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } })).map((x) => [x.status, Number(x.amount)])).toEqual([["REVERSED", 100], ["APPLIED", 200]]);

    // taking it off restores the bill
    expect(await removeCoupon(env.cashier, o.id)).toEqual({ removed: true });
    expect(await totals(o.id)).toEqual({ subtotal: 1000, discount: 0, tax: 50, total: 1050 });
    expect(await removeCoupon(env.cashier, o.id)).toEqual({ removed: false });
    // and the first one can be applied again (its row is revived)
    await applyCoupon(env.cashier, o.id, c.code);
    expect(await prisma.couponRedemption.count({ where: { orderId: o.id, couponId: c.id } })).toBe(1);
    expect((await totals(o.id)).total).toBe(945);
  });

  it("K3b needs order.discount at the order's outlet; unknown codes and closed orders are refused; tenants are separate", async () => {
    const c = await createCoupon(env.manager, base());
    const o = await openOrder(500);
    await expect(applyCoupon(env.kitchen, o.id, c.code)).rejects.toBeInstanceOf(ForbiddenError);
    const otherOutlet = { ...env.cashier, outletIds: [env.outletB], outletRoles: { [env.outletB]: ["CASHIER"] } };
    await expect(applyCoupon(otherOutlet, o.id, c.code)).rejects.toThrow();
    await expect(applyCoupon(env.cashier, o.id, "NOSUCHCODE")).rejects.toThrow(/can't be used here/);
    await expect(applyCoupon(env.foreign, o.id, c.code)).rejects.toBeInstanceOf(NotFoundError);
    await expect(applyCoupon(env.cashier, "missing", c.code)).rejects.toBeInstanceOf(NotFoundError);
    await expect(applyCoupon(env.cashier, o.id, "")).rejects.toThrow();

    const paid = await paidOrder(env, env.outletA, undefined, 400);
    await expect(applyCoupon(env.cashier, paid.orderId, c.code)).rejects.toThrow(/PAID/);
    await expect(removeCoupon(env.cashier, paid.orderId)).rejects.toThrow(/PAID/);
    // a discount that would take the total below what was already paid is refused
    const p = await openOrder(1000);
    const pay = await createPayment(env.owner, p.id, { method: "UPI", amount: 600 });
    await verifyPayment(env.owner, pay.id);
    await expect(applyCoupon(env.cashier, p.id, (await createCoupon(env.manager, base({ kind: "FIXED", value: 700 }))).code)).rejects.toThrow(/already paid/);
  });
});

describe("K4. the order changes after the coupon", () => {
  it("K4 a percentage coupon follows the lines; falling below the minimum releases it; manual discounts follow the stacking rule", async () => {
    const c = await createCoupon(env.manager, base({ value: 10, minOrderValue: 500 }));
    const o = await openOrder(600);
    await applyCoupon(env.owner, o.id, c.code);
    expect(await totals(o.id)).toMatchObject({ subtotal: 600, discount: 60, total: 540 });
    const extra = await addOrderItem(env.owner, o.id, { name: "Drink", qty: 1, unitPrice: 400 });
    expect(await totals(o.id)).toMatchObject({ subtotal: 1000, discount: 100, total: 900 }); // 10% of the new subtotal
    expect(Number((await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: o.id } })).amount)).toBe(100);

    await removeOrderItem(env.owner, (extra as { id: string }).id);
    expect(await totals(o.id)).toMatchObject({ discount: 60, total: 540 });
    await removeOrderItem(env.owner, o.itemId); // nothing left: below the minimum
    const r = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: o.id } });
    expect(r).toMatchObject({ status: "REVERSED" });
    expect(r.reverseReason).toMatch(/minimum/);
    expect((await totals(o.id)).discount).toBe(0);

    // non-stacking coupon: any manual discount on top is refused; and it cannot be lowered below the coupon
    const plain = await createCoupon(env.manager, base({ value: 10 }));
    const o2 = await openOrder(1000);
    await applyCoupon(env.owner, o2.id, plain.code);
    await expect(applyDiscount(env.owner, o2.id, 150)).rejects.toThrow(/does not combine/);
    await expect(applyDiscount(env.owner, o2.id, 50)).rejects.toThrow(/cannot be lower/);
    await applyDiscount(env.owner, o2.id, 100); // restating the coupon's own amount is fine
    expect((await totals(o2.id)).discount).toBe(100);

    // stackable: the manual discount is the order's TOTAL discount, coupon share included
    const stack = await createCoupon(env.manager, base({ value: 10, stackable: true }));
    const o3 = await openOrder(1000);
    await applyDiscount(env.owner, o3.id, 30); // manual first
    await applyCoupon(env.owner, o3.id, stack.code);
    expect((await totals(o3.id)).discount).toBe(130);
    await applyDiscount(env.owner, o3.id, 150); // 100 coupon + 50 manual
    expect((await totals(o3.id)).discount).toBe(150);
    await removeCoupon(env.owner, o3.id);
    expect((await totals(o3.id)).discount).toBe(50); // the manual share stays
    await addOrderItem(env.owner, o3.id, { name: "More", qty: 1, unitPrice: 1000 });
    expect((await totals(o3.id)).discount).toBe(50);
  });
});

describe("K5. lifecycle", () => {
  it("K5 paying consumes the use; cancelling or fully refunding releases it", async () => {
    const c = await createCoupon(env.manager, base({ usageLimit: 1 }));
    const g = await guest(env, "Sara");
    const paid = await paidOrder(env, env.outletA, g.id, 1000, { couponCode: c.code });
    expect(paid.total).toBe(900);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.id, status: "APPLIED" } })).toBe(1);
    const o2 = await openOrder(1000);
    await expect(applyCoupon(env.owner, o2.id, c.code)).rejects.toThrow(/fully used/);

    // a full refund frees the use: the order no longer stands
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: paid.orderId } });
    await refundPayment(env.owner, pay.id, { amount: 900, reason: "test" } as never);
    expect((await prisma.couponRedemption.findFirstOrThrow({ where: { couponId: c.id } })).reverseReason).toBe("Order refunded");
    await applyCoupon(env.owner, o2.id, c.code);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.id, status: "APPLIED" } })).toBe(1);

    // cancelling the order that holds it frees it again
    await cancelOrder(env.owner, o2.id, "changed mind");
    expect((await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: o2.id } })).reverseReason).toBe("Order cancelled");
    const o3 = await openOrder(1000);
    await applyCoupon(env.owner, o3.id, c.code);
  });
});

describe("K6. a race for the last use", () => {
  it("K6 two orders applying the single-use coupon at the same moment: exactly one wins", async () => {
    const c = await createCoupon(env.manager, base({ usageLimit: 1 }));
    const [a, b] = [await openOrder(1000), await openOrder(1000)];
    const results = await Promise.allSettled([applyCoupon(env.owner, a.id, c.code), applyCoupon(env.owner, b.id, c.code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.couponRedemption.count({ where: { couponId: c.id, status: "APPLIED" } })).toBe(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ValidationError);
  });
});
