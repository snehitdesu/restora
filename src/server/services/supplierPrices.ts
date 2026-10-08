/**
 * Supplier price-comparison board (proposal p. 17, "Supplier price-comparison
 * board"; module 01 "default vendor & last purchase price").
 *
 * One row per material that at least one vendor supplies, every vendor side
 * by side, always per BASE unit so different pack sizes compare fairly:
 *   quoted rate      VendorMaterial.lastRate (per base unit), and per purchase
 *                    unit (x the material's purchase-unit factor)
 *   last received    the most recent posted GRN line from that vendor, its
 *                    rate converted to the base unit through the unit rules
 *                    (a line in a unit with no conversion is left out, never
 *                    compared as if it were the base unit)
 *   lead time, preferred (link or the material's default vendor), vendor
 *   status: only ACTIVE vendors can be bought from (Group 1), so "cheapest"
 *   is the lowest quoted base-unit rate among ACTIVE vendors with a rate.
 * Read with purchase.view (vendor pricing); costs never reach the kitchen.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { resolveUnit } from "@/server/services/inventory";
import { textContains } from "@/server/db/search";
import { D, money, num } from "@/domain/money";

const querySchema = z.object({
  outletId: z.string().min(1),
  search: z.string().trim().max(100).optional(),
  materialId: z.string().optional(),
  /** Only materials where two or more vendors can be compared. */
  comparableOnly: z.enum(["true", "false"]).optional().transform((v) => v === "true"),
});

export type SupplierQuote = {
  vendorId: string;
  vendor: string;
  status: string;
  buyable: boolean;
  preferred: boolean;
  ratePerBase: number | null;
  ratePerPurchaseUnit: number | null;
  leadTimeDays: number;
  lastReceived: { ratePerBase: number; receivedAt: string; grnNumber: string } | null;
  cheapest: boolean;
  /** % above the cheapest buyable quote (null for the cheapest or without a quote). */
  aboveCheapestPct: number | null;
};

export async function supplierPriceComparison(db: PrismaClient, ctx: AccessContext, input: z.input<typeof querySchema>) {
  const q = querySchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "purchase.view", q.outletId);
  const materials = await db.material.findMany({
    where: {
      organizationId: ctx.organizationId, active: true, vendorLinks: { some: {} },
      ...(q.materialId ? { id: q.materialId } : {}),
      ...(q.search ? { OR: [{ name: textContains(q.search) }, { sku: textContains(q.search) }] } : {}),
    },
    select: {
      id: true, sku: true, name: true, baseUnitId: true, purchaseUnitId: true, preferredVendorId: true,
      baseUnit: { select: { code: true } }, category: { select: { name: true } },
      vendorLinks: { select: { vendorId: true, lastRate: true, leadTimeDays: true, preferred: true, vendor: { select: { name: true, status: true } } } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
  });
  const ids = materials.map((m) => m.id);
  const [costs, receipts] = await Promise.all([
    db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId, materialId: { in: ids } }, select: { materialId: true, avgCost: true, lastCost: true } }),
    db.goodsReceiptLine.findMany({
      where: { organizationId: ctx.organizationId, materialId: { in: ids }, grn: { status: "POSTED", outletId: q.outletId } },
      select: { materialId: true, rate: true, unitId: true, grn: { select: { vendorId: true, number: true, receivedAt: true } } },
      orderBy: { grn: { receivedAt: "desc" } },
    }),
  ]);
  const costBy = new Map(costs.map((c) => [c.materialId, c]));
  const unitIds = [...new Set(materials.map((m) => m.purchaseUnitId).filter((x): x is string => Boolean(x)))];
  const unitCode = new Map((unitIds.length ? await db.unit.findMany({ where: { organizationId: ctx.organizationId, id: { in: unitIds } }, select: { id: true, code: true } }) : []).map((u) => [u.id, u.code]));
  const lastBy = new Map<string, { ratePerBase: Prisma.Decimal; receivedAt: Date; grnNumber: string }>();
  for (const r of receipts) {
    const k = `${r.materialId}|${r.grn.vendorId}`;
    if (lastBy.has(k)) continue; // newest first
    try {
      const { factor } = await resolveUnit(db, ctx, r.materialId, r.unitId);
      lastBy.set(k, { ratePerBase: D(r.rate).div(factor), receivedAt: r.grn.receivedAt, grnNumber: r.grn.number });
    } catch {
      // No conversion for that unit: not comparable, left out.
    }
  }

  const rows = [];
  for (const m of materials) {
    let packFactor: Prisma.Decimal | null = null;
    if (m.purchaseUnitId && m.purchaseUnitId !== m.baseUnitId) {
      try { packFactor = (await resolveUnit(db, ctx, m.id, m.purchaseUnitId)).factor; } catch { packFactor = null; }
    }
    const quotes = m.vendorLinks.map((v) => {
      const rate = D(v.lastRate).gt(0) ? D(v.lastRate) : null;
      const last = lastBy.get(`${m.id}|${v.vendorId}`) ?? null;
      return {
        vendorId: v.vendorId, vendor: v.vendor.name, status: v.vendor.status, buyable: v.vendor.status === "ACTIVE",
        preferred: v.preferred || m.preferredVendorId === v.vendorId,
        rate, ratePerPurchaseUnit: rate && packFactor ? money(rate.times(packFactor)) : null, leadTimeDays: v.leadTimeDays, last,
      };
    });
    const buyableRates = quotes.filter((x) => x.buyable && x.rate).map((x) => x.rate!);
    const cheapest = buyableRates.length ? buyableRates.reduce((a, b) => (b.lt(a) ? b : a)) : null;
    const out: SupplierQuote[] = quotes
      .map((x) => ({
        vendorId: x.vendorId, vendor: x.vendor, status: x.status, buyable: x.buyable, preferred: x.preferred,
        ratePerBase: x.rate ? num(x.rate.toDecimalPlaces(6)) : null,
        ratePerPurchaseUnit: x.ratePerPurchaseUnit ? num(x.ratePerPurchaseUnit) : null,
        leadTimeDays: x.leadTimeDays,
        lastReceived: x.last ? { ratePerBase: num(x.last.ratePerBase.toDecimalPlaces(6)), receivedAt: x.last.receivedAt.toISOString(), grnNumber: x.last.grnNumber } : null,
        cheapest: Boolean(cheapest && x.buyable && x.rate && x.rate.eq(cheapest)),
        aboveCheapestPct: cheapest && x.rate && cheapest.gt(0) && !x.rate.eq(cheapest) ? num(money(x.rate.minus(cheapest).div(cheapest).times(100))) : null,
      }))
      .sort((a, b) => Number(b.buyable) - Number(a.buyable) || (a.ratePerBase ?? Infinity) - (b.ratePerBase ?? Infinity) || a.vendor.localeCompare(b.vendor));
    const comparable = out.filter((x) => x.buyable && x.ratePerBase !== null).length;
    if (q.comparableOnly && comparable < 2) continue;
    const c = costBy.get(m.id);
    const top = out.filter((x) => x.buyable && x.ratePerBase !== null);
    rows.push({
      materialId: m.id, sku: m.sku, name: m.name, category: m.category?.name ?? null,
      baseUnit: m.baseUnit.code, purchaseUnit: m.purchaseUnitId ? unitCode.get(m.purchaseUnitId) ?? null : null, packFactor: packFactor ? num(packFactor) : null,
      avgCost: c ? num(D(c.avgCost).toDecimalPlaces(6)) : null, lastCost: c ? num(D(c.lastCost).toDecimalPlaces(6)) : null,
      comparable,
      /** Highest minus lowest buyable quote, per base unit. */
      spread: top.length >= 2 ? num(D(top[top.length - 1].ratePerBase!).minus(top[0].ratePerBase!).toDecimalPlaces(6)) : null,
      quotes: out,
    });
  }
  return { outletId: q.outletId, rows, basis: "Rates per base unit. Quoted = the vendor's current rate on its material link; last received = the latest posted goods receipt from that vendor at this outlet, converted to the base unit. Only ACTIVE vendors can be bought from, so only they can be the cheapest." };
}
