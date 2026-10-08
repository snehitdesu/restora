/**
 * Advanced inventory reads (group 4), all derived from the append-only ledger
 * and the documents behind it:
 *
 *  - materialPriceHistory (proposal p. 4 "last purchase price", p. 11 "vendor
 *    price spike", p. 17 supplier price board): every purchase receipt of a
 *    material at an outlet, newest first, at its rate per BASE unit (the ledger
 *    rate), with the vendor and document, the change against the previous
 *    receipt, and the quantity-weighted average / low / high over the window.
 *    Vendor pricing: purchase.view.
 *  - countVarianceTrend (p. 6 "variance trends over time tell you whether the
 *    leak is closing"): one row per approved stock count, oldest first, with
 *    the rupee value it found missing (loss) or extra (surplus) at the cost
 *    the corrections were posted at. Reports access (values).
 *  - labelSheet (p. 17 "Barcode / QR stock labels"): the materials to print
 *    labels for, by SKU (the label carries the SKU, never an internal id).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { textContains } from "@/server/db/search";
import { labelPayload } from "@/server/services/stockLabels";
import { D, money, num, qty as roundQty } from "@/domain/money";

type Dec = Prisma.Decimal;

/** Vendor names by id, within the caller's organization. */
export async function vendorNames(db: PrismaClient, ctx: AccessContext, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await db.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: unique } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map((v) => [v.id, v.name]));
}

const historySchema = z.object({
  outletId: z.string().min(1),
  materialId: z.string().min(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  take: z.coerce.number().int().min(1).max(500).default(100),
});

export async function materialPriceHistory(db: PrismaClient, ctx: AccessContext, input: z.input<typeof historySchema>) {
  const q = historySchema.parse(input);
  if (q.from && q.to && q.from > q.to) throw new ValidationError("'from' must be before 'to'");
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "purchase.view", q.outletId);
  const material = await db.material.findUnique({ where: { id: q.materialId }, select: { organizationId: true, sku: true, name: true, baseUnit: { select: { code: true } } } });
  if (!material || material.organizationId !== ctx.organizationId) throw new NotFoundError("Material not found");
  const createdAt = q.from || q.to ? { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } : undefined;
  const rows = await db.inventoryLedger.findMany({
    where: { organizationId: ctx.organizationId, outletId: q.outletId, materialId: q.materialId, txnType: "PURCHASE_RECEIPT", ...(createdAt ? { createdAt } : {}) },
    select: { id: true, qty: true, rate: true, createdAt: true, sourceType: true, sourceId: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.take,
  });
  const grnIds = [...new Set(rows.filter((r) => r.sourceType === "GRN" && r.sourceId).map((r) => r.sourceId!))];
  const grns = grnIds.length ? await db.goodsReceipt.findMany({ where: { organizationId: ctx.organizationId, id: { in: grnIds } }, select: { id: true, number: true, vendorId: true } }) : [];
  const vendors = await vendorNames(db, ctx, grns.map((g) => g.vendorId));
  const grnBy = new Map(grns.map((g) => [g.id, { number: g.number, vendor: { id: g.vendorId, name: vendors.get(g.vendorId) ?? "Vendor" } }]));
  const cost = await db.outletMaterialCost.findUnique({ where: { outletId_materialId: { outletId: q.outletId, materialId: q.materialId } }, select: { avgCost: true, lastCost: true } });

  // Oldest first to measure each receipt against the one before it.
  const chronological = [...rows].reverse();
  let prev: Dec | null = null;
  let qtySum = D(0), valueSum = D(0), low: Dec | null = null, high: Dec | null = null;
  const out = chronological.map((r) => {
    const rate = D(r.rate);
    const change = prev && prev.gt(0) ? rate.minus(prev).div(prev).times(100) : null;
    prev = rate;
    qtySum = qtySum.plus(D(r.qty));
    valueSum = valueSum.plus(D(r.qty).times(rate));
    low = low === null || rate.lt(low) ? rate : low;
    high = high === null || rate.gt(high) ? rate : high;
    const g = r.sourceId ? grnBy.get(r.sourceId) : undefined;
    return {
      id: r.id, receivedAt: r.createdAt.toISOString(), qty: num(roundQty(D(r.qty))), ratePerBase: num(rate.toDecimalPlaces(6)),
      vendorId: g?.vendor.id ?? null, vendor: g?.vendor.name ?? null, document: g?.number ?? null, source: r.sourceType ?? "PURCHASE",
      changePct: change ? num(money(change)) : null,
    };
  });
  return {
    materialId: q.materialId, sku: material.sku, name: material.name, unit: material.baseUnit.code,
    avgCost: cost ? num(D(cost.avgCost).toDecimalPlaces(6)) : null, lastCost: cost ? num(D(cost.lastCost).toDecimalPlaces(6)) : null,
    window: qtySum.gt(0) ? { receipts: out.length, qty: num(roundQty(qtySum)), weightedRate: num(valueSum.div(qtySum).toDecimalPlaces(6)), low: num(D(low!).toDecimalPlaces(6)), high: num(D(high!).toDecimalPlaces(6)) } : null,
    receipts: out.reverse(),
  };
}

const trendSchema = z.object({ outletId: z.string().min(1), from: z.coerce.date().optional(), to: z.coerce.date().optional(), departmentId: z.string().optional() });

export async function countVarianceTrend(db: PrismaClient, ctx: AccessContext, input: z.input<typeof trendSchema>) {
  const q = trendSchema.parse(input);
  if (q.from && q.to && q.from > q.to) throw new ValidationError("'from' must be before 'to'");
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "reports.view", q.outletId);
  const approvedAt = q.from || q.to ? { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } : { not: null };
  const counts = await db.stockCount.findMany({
    where: { organizationId: ctx.organizationId, outletId: q.outletId, status: "APPROVED", approvedAt, ...(q.departmentId ? { departmentId: q.departmentId } : {}) },
    select: { id: true, number: true, approvedAt: true, departmentId: true, _count: { select: { lines: true } } },
    orderBy: [{ approvedAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  const ids = counts.map((c) => c.id);
  const [posted, departments] = await Promise.all([
    ids.length ? db.inventoryLedger.findMany({ where: { organizationId: ctx.organizationId, sourceType: "COUNT", sourceId: { in: ids } }, select: { sourceId: true, amount: true } }) : [],
    db.department.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId }, select: { id: true, name: true } }),
  ]);
  const by = new Map<string, { loss: Dec; surplus: Dec; lines: number }>();
  for (const p of posted) {
    const a = by.get(p.sourceId!) ?? by.set(p.sourceId!, { loss: D(0), surplus: D(0), lines: 0 }).get(p.sourceId!)!;
    const amt = D(p.amount);
    if (amt.lt(0)) a.loss = a.loss.plus(amt.neg()); else a.surplus = a.surplus.plus(amt);
    a.lines++;
  }
  const rows = counts.map((c) => {
    const a = by.get(c.id) ?? { loss: D(0), surplus: D(0), lines: 0 };
    return {
      countId: c.id, number: c.number, approvedAt: c.approvedAt!.toISOString(),
      departmentId: c.departmentId, department: c.departmentId ? departments.find((d) => d.id === c.departmentId)?.name ?? "Department" : "Whole outlet",
      itemsCounted: c._count.lines, itemsAdjusted: a.lines,
      loss: num(money(a.loss)), surplus: num(money(a.surplus)), net: num(money(a.surplus.minus(a.loss))),
    };
  });
  const half = Math.floor(rows.length / 2);
  const avg = (xs: typeof rows) => (xs.length ? xs.reduce((s, r) => s.plus(r.loss), D(0)).div(xs.length) : null);
  const earlier = rows.length >= 2 ? avg(rows.slice(0, half)) : null;
  const later = rows.length >= 2 ? avg(rows.slice(rows.length - half)) : null;
  return {
    outletId: q.outletId, rows,
    // The leak closing or not: average loss per count, later half against earlier half (needs two counts).
    trend: earlier !== null && later !== null ? { earlierAvgLoss: num(money(earlier)), laterAvgLoss: num(money(later)), direction: later.lt(earlier) ? "CLOSING" : later.gt(earlier) ? "WIDENING" : "FLAT" } : null,
  };
}

const sheetSchema = z.object({ outletId: z.string().min(1), search: z.string().trim().max(100).optional(), categoryId: z.string().optional(), materialIds: z.string().optional(), take: z.coerce.number().int().min(1).max(500).default(120) });

export async function labelSheet(db: PrismaClient, ctx: AccessContext, input: z.input<typeof sheetSchema>) {
  const q = sheetSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "inventory.view", q.outletId);
  const ids = q.materialIds ? q.materialIds.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500) : undefined;
  const materials = await db.material.findMany({
    where: {
      organizationId: ctx.organizationId, active: true,
      ...(ids ? { id: { in: ids } } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.search ? { OR: [{ name: textContains(q.search) }, { sku: textContains(q.search) }] } : {}),
    },
    select: { id: true, sku: true, name: true, baseUnit: { select: { code: true } }, category: { select: { name: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: q.take,
  });
  return materials.map((m) => ({ materialId: m.id, sku: m.sku, name: m.name, unit: m.baseUnit.code, category: m.category?.name ?? null, payload: labelPayload(m.sku) }));
}
