/**
 * Loyalty tiers with perks (CR-02) against the real services and database.
 *
 *  T1 tier rules: validation, the base tier, audit, permissions, tenants
 *  T2 tier from real spend: paid orders minus refunds; earn multiplier; legacy thresholds when no tier is configured
 *  T3 the nightly refresh ages spend out of the 365-day window
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { saveTier, listTiers, loyaltySummary, tierForSpend, trailingSpend, activeTiers } from "@/server/services/loyaltyTiers";
import { loyaltyBalance } from "@/server/services/loyalty";
import { refundPayment } from "@/server/services/payment";
import { refreshTiers } from "@/server/services/lifecycle";
import { makeEnv, guest, paidOrder, type Env } from "./growthSupport";

let env: Env;
beforeAll(async () => { env = await makeEnv("Glt"); });
afterAll(async () => { await prisma.$disconnect(); });

const tierOf = async (customerId: string) => (await prisma.loyaltyAccount.findUnique({ where: { customerId } }))?.tier;

describe("T1. tier rules", () => {
  it("T1 a tier needs growth.manage; one active tier must start at 0; thresholds are distinct; every change is audited", async () => {
    await expect(saveTier(env.cashier, { code: "SILVER", name: "Silver", minSpend: 0 })).rejects.toBeInstanceOf(ForbiddenError);
    // the first tier must be the base
    await expect(saveTier(env.manager, { code: "GOLD", name: "Gold", minSpend: 5000 })).rejects.toThrow(/start at 0/);
    await expect(saveTier(env.manager, { code: "bad code", name: "X", minSpend: 0 })).rejects.toThrow();
    await expect(saveTier(env.manager, { code: "BASE", name: "Base", minSpend: -1 })).rejects.toThrow();
    await expect(saveTier(env.manager, { code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 10 })).rejects.toThrow();
    const base = await saveTier(env.manager, { code: "base", name: "Member", minSpend: 0, perks: "Birthday offer" });
    expect(base).toMatchObject({ code: "BASE", name: "Member", minSpend: 0, earnMultiplierPct: 100, perks: "Birthday offer", active: true });
    await saveTier(env.manager, { code: "GOLD", name: "Gold", minSpend: 5000, earnMultiplierPct: 150, perks: "1.5x points, free dessert on Fridays" });
    await saveTier(env.manager, { code: "PLATINUM", name: "Platinum", minSpend: 20000, earnMultiplierPct: 200 });
    await expect(saveTier(env.manager, { code: "GOLD2", name: "Gold 2", minSpend: 5000 })).rejects.toThrow(/same spend/);
    await expect(saveTier(env.manager, { code: "GOLD", name: "Clash", minSpend: 7000 })).rejects.toThrow(); // code taken (a new row with an existing code)

    // cannot remove the base: it is the only active tier starting at 0
    await expect(saveTier(env.manager, { id: base.id, code: "BASE", name: "Member", minSpend: 0, active: false })).rejects.toThrow(/start at 0/);
    const upd = await saveTier(env.manager, { id: base.id, code: "BASE", name: "Member", minSpend: 0, perks: "Birthday offer, priority booking" });
    expect(upd.perks).toBe("Birthday offer, priority booking");
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "LoyaltyTier", entityId: base.id, action: "UPDATE" } });
    expect(JSON.parse(audit!.before!).perks).toBe("Birthday offer");

    expect((await listTiers(prisma, env.cashier)).map((t) => t.code)).toEqual(["BASE", "GOLD", "PLATINUM"]); // cashiers see tiers (perks at the till)
    await expect(saveTier(env.manager, { id: "missing", code: "ZZ", name: "ZZ", minSpend: 1 })).rejects.toBeInstanceOf(NotFoundError);
    // tenants: the other restaurant has none
    expect(await listTiers(prisma, env.foreign)).toEqual([]);
    expect(tierForSpend(await activeTiers(prisma, env.orgId), 4999.99)?.code).toBe("BASE");
    expect(tierForSpend(await activeTiers(prisma, env.orgId), 5000)?.code).toBe("GOLD");
  });
});

describe("T2. tier from real spend", () => {
  it("T2 spend is paid orders minus refunds; the multiplier of the tier held BEFORE an order applies to it; summary shows perks and the gap", async () => {
    const g = await guest(env, "Divya");
    // 3000 at the base tier: 30 points, no multiplier yet
    const a = await paidOrder(env, env.outletA, g.id, 3000);
    expect(await loyaltyBalance(prisma, env.owner, g.id)).toBe(30);
    expect(await tierOf(g.id)).toBe("BASE");
    // 3000 more: base multiplier (100%) for this order, and the guest crosses 5000 -> GOLD
    await paidOrder(env, env.outletA, g.id, 3000);
    expect(await loyaltyBalance(prisma, env.owner, g.id)).toBe(60);
    expect(await tierOf(g.id)).toBe("GOLD");
    // now at GOLD: 1000 earns 10 * 1.5 = 15
    await paidOrder(env, env.outletA, g.id, 1000);
    expect(await loyaltyBalance(prisma, env.owner, g.id)).toBe(75);

    const sum = await loyaltySummary(prisma, env.cashier, g.id);
    expect(sum).toMatchObject({ configured: true, spend: 7000, tier: { code: "GOLD", name: "Gold", earnMultiplierPct: 150 }, next: { code: "PLATINUM", remaining: 13000 } });
    expect(sum.tier!.perks).toContain("free dessert");

    // a full refund of the first order takes its spend out: 7000 - 3000 = 4000 -> back to BASE
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: a.orderId } });
    await refundPayment(env.owner, pay.id, { amount: 3000, reason: "test" } as never);
    expect(await trailingSpend(prisma, env.orgId, g.id)).toBe(4000);
    const earn = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { customerId: g.id, orderId: a.orderId, type: "ADJUST" } });
    expect(earn.points).toBe(-30);
    expect(await tierOf(g.id)).toBe("BASE"); // the reversal re-derived the tier
    const change = await prisma.auditLog.findFirst({ where: { organizationId: env.orgId, entityType: "LoyaltyAccount", entityId: g.id }, orderBy: { createdAt: "desc" } });
    expect(JSON.parse(change!.after!).tier).toBe("BASE");

    await expect(loyaltySummary(prisma, env.foreign, g.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("T2b without any configured tier the legacy thresholds still apply (installations upgrade unchanged)", async () => {
    const legacy = await makeEnv("Glu");
    const g = await guest(legacy, "Old");
    await paidOrder(legacy, legacy.outletA, g.id, 120000); // 1200 points >= 1000 -> GOLD by the legacy rule
    expect(await tierOf(g.id)).toBe("GOLD");
    expect(await loyaltySummary(prisma, legacy.cashier, g.id)).toMatchObject({ configured: false, tier: null });
  });
});

describe("T3. the nightly refresh", () => {
  it("T3 spend older than 365 days ages out; an unchanged tier writes nothing", async () => {
    const g = await guest(env, "Esha");
    await paidOrder(env, env.outletA, g.id, 6000);
    expect(await tierOf(g.id)).toBe("GOLD"); // the tier is derived once the order counts
    // drift (a manual fix gone wrong) is healed by the refresh; an unchanged tier writes nothing
    await prisma.loyaltyAccount.update({ where: { customerId: g.id }, data: { tier: "PLATINUM" } });
    const first = await refreshTiers(prisma, env.orgId);
    expect(first.checked).toBeGreaterThan(0);
    expect(await tierOf(g.id)).toBe("GOLD");
    expect((await refreshTiers(prisma, env.orgId)).changed).toBe(0);

    // a year and a bit later the spend is gone
    const later = new Date(Date.now() + 400 * 86400_000);
    const r = await refreshTiers(prisma, env.orgId, later);
    expect(r.changed).toBeGreaterThan(0);
    expect(await tierOf(g.id)).toBe("BASE");
  });
});
