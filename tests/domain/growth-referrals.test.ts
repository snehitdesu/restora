/**
 * Referrals (CR-06) against the real services and database.
 *
 *  R1 codes: one per guest, unambiguous alphabet, permissions, tenants
 *  R2 attribution rules: self-referral, existing guests, once ever, disabled programme, bad codes
 *  R3 the reward: on the first paid order only, minimum value, idempotent, monthly cap, refund claws back
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/db/scope";
import { attachReferral, customerReferrals, getOrCreateReferralCode, listReferrals, normalizeReferralCode, referralSummary, REFERRAL_CODE } from "@/server/services/referrals";
import { saveGrowthSettings } from "@/server/services/growthSettings";
import { loyaltyBalance } from "@/server/services/loyalty";
import { refundPayment } from "@/server/services/payment";
import { makeEnv, guest, paidOrder, type Env } from "./growthSupport";

let env: Env;
beforeAll(async () => {
  env = await makeEnv("Grf");
  await saveGrowthSettings(env.manager, { referralEnabled: true, referrerPoints: 100, refereePoints: 50, referralMinOrderValue: 300, referralMonthlyCap: 2 });
});
afterAll(async () => { await prisma.$disconnect(); });

describe("R1. codes", () => {
  it("R1 one code per guest, readable alphabet, stable on repeat; needs customer.manage; tenants", async () => {
    const g = await guest(env, "Anu");
    await expect(getOrCreateReferralCode(env.kitchen, g.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrCreateReferralCode(env.foreign, g.id)).rejects.toBeInstanceOf(NotFoundError);
    const { code } = await getOrCreateReferralCode(env.cashier, g.id);
    expect(code).toMatch(REFERRAL_CODE);
    expect(code).not.toMatch(/[ILOU]/); // no look-alikes to read over a counter
    expect((await getOrCreateReferralCode(env.cashier, g.id)).code).toBe(code);
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await getOrCreateReferralCode(env.cashier, (await guest(env, `G${i}`)).id)).code);
    expect(codes.size).toBe(20);
    expect(normalizeReferralCode(` rf-${code.slice(2).toLowerCase()} `)).toBe(code);
    expect((await customerReferrals(prisma, env.cashier, g.id)).code).toBe(code);
  });
});

describe("R2. attribution", () => {
  it("R2 a friend's code is recorded once for a new guest; own code, existing guests and bad codes are ignored with a reason", async () => {
    const referrer = await guest(env, "Bela");
    const { code } = await getOrCreateReferralCode(env.cashier, referrer.id);
    const friend = await guest(env, "Chirag");
    expect(await attachReferral(env.cashier, referrer.id, code)).toMatchObject({ status: "IGNORED", reason: "You cannot use your own code" });
    expect(await attachReferral(env.cashier, friend.id, "RFXXXXXX")).toMatchObject({ status: "IGNORED", reason: "That referral code is not valid" });
    expect(await attachReferral(env.cashier, friend.id, "hello")).toMatchObject({ status: "IGNORED" });
    const ok = await attachReferral(env.cashier, friend.id, code.toLowerCase());
    expect(ok.status).toBe("ATTACHED");
    expect(await attachReferral(env.cashier, friend.id, code)).toMatchObject({ status: "IGNORED", reason: "A referral code was already used" });
    // a guest who already ate here is not "new"
    const regular = await guest(env, "Dev");
    await paidOrder(env, env.outletA, regular.id, 500);
    expect(await attachReferral(env.cashier, regular.id, code)).toMatchObject({ status: "IGNORED", reason: "Referral codes are for new guests" });
    await expect(attachReferral(env.kitchen, friend.id, code)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await customerReferrals(prisma, env.cashier, referrer.id)).brought).toHaveLength(1);
    expect((await customerReferrals(prisma, env.cashier, friend.id)).cameWith).toMatchObject({ status: "PENDING", referrerCustomerId: referrer.id });

    // switched off: nothing is recorded
    const off = await makeEnv("Grx");
    const a = await guest(off, "A"), b = await guest(off, "B");
    const { code: c2 } = await getOrCreateReferralCode(off.cashier, a.id);
    expect(await attachReferral(off.cashier, b.id, c2)).toMatchObject({ status: "IGNORED", reason: "Referrals are not enabled" });
  });
});

describe("R3. the reward", () => {
  it("R3 paid only on the referred guest's first PAID order of at least the minimum; both sides get points once; a refund takes them back", async () => {
    const referrer = await guest(env, "Esha");
    const { code } = await getOrCreateReferralCode(env.cashier, referrer.id);
    const friend = await guest(env, "Farhan");
    await attachReferral(env.cashier, friend.id, code);

    // the FIRST order decides: below the minimum, the referral is closed (it does not wait for a bigger order)
    await paidOrder(env, env.outletA, friend.id, 200);
    expect(await prisma.referral.findFirstOrThrow({ where: { referredCustomerId: friend.id } })).toMatchObject({ status: "REJECTED", rejectReason: "The first order was below the minimum order value" });
    expect(await loyaltyBalance(prisma, env.owner, referrer.id)).toBe(0);
    await paidOrder(env, env.outletA, friend.id, 1000);
    expect(await loyaltyBalance(prisma, env.owner, referrer.id)).toBe(0); // a later big order does not revive it

    // the happy path
    const r2 = await guest(env, "Gita");
    const { code: code2 } = await getOrCreateReferralCode(env.cashier, r2.id);
    const f2 = await guest(env, "Hari");
    await attachReferral(env.cashier, f2.id, code2);
    const order = await paidOrder(env, env.outletA, f2.id, 500);
    const rw = await prisma.referral.findFirstOrThrow({ where: { referredCustomerId: f2.id } });
    expect(rw).toMatchObject({ status: "REWARDED", qualifyingOrderId: order.orderId, referrerPoints: 100, refereePoints: 50 });
    expect(await loyaltyBalance(prisma, env.owner, r2.id)).toBe(100);
    expect(await loyaltyBalance(prisma, env.owner, f2.id)).toBe(5 + 50); // 5 from the order itself + the welcome points
    // replaying the settlement pays nothing more
    const { earnPoints } = await import("@/server/services/loyalty");
    await earnPoints(env.owner, { orderId: order.orderId });
    expect(await loyaltyBalance(prisma, env.owner, r2.id)).toBe(100);
    expect(await referralSummary(prisma, env.manager)).toMatchObject({ rewarded: 1, rejected: 1, pointsGiven: 150 });
    expect((await listReferrals(prisma, env.manager, { status: "REWARDED" }))[0]).toMatchObject({ referrer: { name: "Gita" }, referred: { name: "Hari" } });

    // refunding the qualifying order takes the reward back (capped at what each still has)
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.orderId } });
    await refundPayment(env.owner, pay.id, { amount: 500, reason: "test" } as never);
    expect((await prisma.referral.findUniqueOrThrow({ where: { id: rw.id } })).status).toBe("REJECTED");
    expect(await loyaltyBalance(prisma, env.owner, r2.id)).toBe(0);
    expect(await loyaltyBalance(prisma, env.owner, f2.id)).toBe(0);
    await expect(listReferrals(prisma, env.cashier)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("R3b the monthly cap on rewards per referrer and the minimum order value", async () => {
    const referrer = await guest(env, "Isha");
    const { code } = await getOrCreateReferralCode(env.cashier, referrer.id);
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await guest(env, `Friend ${i}`);
      await attachReferral(env.cashier, f.id, code);
      await paidOrder(env, env.outletA, f.id, 400);
      results.push((await prisma.referral.findFirstOrThrow({ where: { referredCustomerId: f.id } })).status);
    }
    expect(results).toEqual(["REWARDED", "REWARDED", "REJECTED"]); // cap = 2
    expect((await prisma.referral.findFirst({ where: { referrerCustomerId: referrer.id, status: "REJECTED" } }))!.rejectReason).toMatch(/monthly limit/);
    expect(await loyaltyBalance(prisma, env.owner, referrer.id)).toBe(200);
  });
});
