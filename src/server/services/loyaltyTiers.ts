/**
 * Loyalty tiers with perks (proposal p. 17: "tiers (silver, gold) with perks").
 *
 * An organization defines its tiers: a code and name, the spend over the last 365 days that reaches it, an earn
 * multiplier (150 = 1.5x points on every paid order) and the perks in words. One tier must start at 0 spend so
 * nobody is left without one. A guest's tier is derived from what they really paid (paid orders minus refunds), never
 * typed in. Without any configured tier the legacy lifetime-points thresholds in loyalty.ts apply, so existing
 * installations behave as before.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { D, money } from "@/domain/money";

export type TierView = { id: string; code: string; name: string; minSpend: number; earnMultiplierPct: number; perks: string | null; sortOrder: number; active: boolean };

const view = (r: { id: string; code: string; name: string; minSpend: unknown; earnMultiplierPct: unknown; perks: string | null; sortOrder: number; active: boolean }): TierView => ({
  id: r.id, code: r.code, name: r.name, minSpend: money(r.minSpend as never).toNumber(), earnMultiplierPct: D(r.earnMultiplierPct as never).toNumber(), perks: r.perks, sortOrder: r.sortOrder, active: r.active,
});

const tierSchema = z.object({
  id: z.string().min(1).optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{1,19}$/, "2-20 letters, digits or _, starting with a letter"),
  name: z.string().trim().min(2).max(40),
  minSpend: z.number().min(0).max(100_000_000),
  earnMultiplierPct: z.number().min(50).max(500).default(100),
  perks: z.string().trim().max(300).nullish(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  active: z.boolean().default(true),
});

export async function listTiers(db: PrismaClient, ctx: AccessContext): Promise<TierView[]> {
  assertCan(ctx, "customer.view");
  return (await db.loyaltyTier.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ minSpend: "asc" }, { sortOrder: "asc" }] })).map(view);
}

/** Active tiers, lowest spend first. Internal. */
export async function activeTiers(db: PrismaClient | Tx, organizationId: string): Promise<TierView[]> {
  return (await db.loyaltyTier.findMany({ where: { organizationId, active: true }, orderBy: [{ minSpend: "asc" }, { sortOrder: "asc" }] })).map(view);
}

export async function saveTier(ctx: AccessContext, input: z.input<typeof tierSchema>, db: Client = prisma): Promise<TierView> {
  assertCan(ctx, "growth.manage");
  const d = tierSchema.parse(input);
  return runInTx(db, async (tx) => {
    const all = await tx.loyaltyTier.findMany({ where: { organizationId: ctx.organizationId } });
    const existing = d.id ? all.find((t) => t.id === d.id) : undefined;
    if (d.id && !existing) throw new NotFoundError("Tier not found");
    if (all.some((t) => t.code === d.code && t.id !== d.id)) throw new ValidationError("A tier with this code exists", { fieldErrors: { code: ["Already used"] } });
    // After the change, the active tiers must still include one that starts at 0 and no two may share a threshold.
    const after = all.filter((t) => t.id !== d.id).map((t) => ({ active: t.active, minSpend: money(t.minSpend).toNumber() })).concat([{ active: d.active, minSpend: d.minSpend }]);
    const active = after.filter((t) => t.active);
    if (active.length && !active.some((t) => t.minSpend === 0)) throw new ValidationError("One active tier must start at 0 spend so every guest has a tier", { fieldErrors: { minSpend: ["Keep a tier that starts at 0"] } });
    if (new Set(active.map((t) => t.minSpend)).size !== active.length) throw new ValidationError("Two active tiers cannot start at the same spend", { fieldErrors: { minSpend: ["Another active tier has this threshold"] } });
    const data = { code: d.code, name: d.name, minSpend: d.minSpend, earnMultiplierPct: d.earnMultiplierPct, perks: d.perks ?? null, sortOrder: d.sortOrder, active: d.active };
    const row = existing
      ? await tx.loyaltyTier.update({ where: { id: existing.id }, data })
      : await tx.loyaltyTier.create({ data: { organizationId: ctx.organizationId, ...data } });
    await writeAudit(tx, ctx, { action: existing ? "UPDATE" : "CREATE", entityType: "LoyaltyTier", entityId: row.id, before: existing ? view(existing) : undefined, after: view(row) });
    return view(row);
  });
}

/** Net spend on paid orders over the last 365 days: paid orders minus what was refunded on them. */
export async function trailingSpend(db: PrismaClient | Tx, organizationId: string, customerId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 365 * 86400_000);
  const where = { organizationId, customerId, status: "PAID", paidAt: { gte: since } };
  const paid = await db.order.aggregate({ where, _sum: { total: true } });
  const refunded = await db.refund.aggregate({ where: { payment: { order: where } }, _sum: { amount: true } });
  return Math.max(0, money(D(paid._sum.total ?? 0).minus(D(refunded._sum.amount ?? 0))).toNumber());
}

/** The highest tier whose threshold the spend reaches (tiers sorted by minSpend ascending). */
export function tierForSpend(tiers: TierView[], spend: number): TierView | null {
  let found: TierView | null = null;
  for (const t of tiers) if (spend >= t.minSpend) found = t;
  return found;
}

/** Rank of a tier code in the organization's ladder (higher = better); -1 when unknown. */
export function tierRank(tiers: TierView[], code: string | null | undefined): number {
  return code ? tiers.findIndex((t) => t.code === code) : -1;
}

export type LoyaltySummary = {
  tier: { code: string; name: string; perks: string | null; earnMultiplierPct: number } | null;
  spend: number;
  next: { code: string; name: string; remaining: number } | null;
  configured: boolean;
};

/** What the guest's tier is, what it gives, and what is missing for the next one. */
export async function loyaltySummary(db: PrismaClient, ctx: AccessContext, customerId: string, now = new Date()): Promise<LoyaltySummary> {
  assertCan(ctx, "customer.view");
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { organizationId: true } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  const tiers = await activeTiers(db, ctx.organizationId);
  const spend = await trailingSpend(db, ctx.organizationId, customerId, now);
  if (!tiers.length) return { tier: null, spend, next: null, configured: false };
  const t = tierForSpend(tiers, spend);
  const idx = t ? tiers.indexOf(t) : -1;
  const nx = idx >= 0 ? tiers[idx + 1] : tiers[0];
  return {
    tier: t ? { code: t.code, name: t.name, perks: t.perks, earnMultiplierPct: t.earnMultiplierPct } : null,
    spend,
    next: nx ? { code: nx.code, name: nx.name, remaining: Math.max(0, money(D(nx.minSpend).minus(D(spend))).toNumber()) } : null,
    configured: true,
  };
}
