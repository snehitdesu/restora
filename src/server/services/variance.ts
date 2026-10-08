/**
 * Consumption variance (proposal p. 4 "theoretical consumption per dish sold
 * feeds the variance report: what you should have used versus what actually
 * left the shelf", and p. 11 "the gap between what should have happened and
 * what did").
 *
 * Per material, for a date range, from the append-only ledger:
 *   expected (theoretical) = sale consumption (recipes x dishes sold, POS,
 *                            QR and manual sales log)
 *   wastage                = recorded wastage, spoilage and staff meals
 *   count loss             = stock counts that found less than the books
 *                            (a count surplus is shown as a negative loss)
 *   actual usage           = expected + wastage + count loss
 *   variance               = actual - expected, in quantity and in rupees at
 *                            the cost each row was posted at, and as % of the
 *                            expected cost
 * Production consumption is a transformation (raw material into prepared
 * stock that sales then consume), not usage, so it is left out.
 * No threshold is applied: rows are ranked by rupee variance, largest first.
 * The summary is the leakage report (p. 11) for the same range and outlet
 * (it is outlet-wide even when the rows are filtered to one department).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { authorizedOutletIds } from "@/server/services/analytics";
import { foodCostLeakage } from "@/server/services/menuEngineering";
import { D, money, num, qty as roundQty } from "@/domain/money";

type Dec = Prisma.Decimal;
const TYPES = ["SALE_CONSUMPTION", "WASTAGE", "SPOILAGE", "STAFF_MEAL", "COUNT_ADJUSTMENT"];

const filterSchema = z.object({
  outletId: z.string().min(1),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  departmentId: z.string().optional(),
});

export type VarianceRow = {
  materialId: string;
  sku: string;
  name: string;
  unit: string | null;
  category: string | null;
  expectedQty: number;
  expectedCost: number;
  wastageQty: number;
  wastageCost: number;
  countLossQty: number;
  countLossCost: number;
  actualQty: number;
  actualCost: number;
  varianceQty: number;
  varianceCost: number;
  /** variance cost as % of expected cost; null when nothing was expected (pure loss). */
  variancePct: number | null;
};

export async function consumptionVariance(db: PrismaClient, ctx: AccessContext, input: z.input<typeof filterSchema>) {
  const f = filterSchema.parse(input);
  if (f.from && f.to && f.from > f.to) throw new ValidationError("'from' must be before 'to'");
  authorizedOutletIds(ctx, { outletId: f.outletId }, "reports.view");
  const createdAt = f.from || f.to ? { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } : undefined;
  const grouped = await db.inventoryLedger.groupBy({
    by: ["materialId", "txnType"],
    where: { organizationId: ctx.organizationId, outletId: f.outletId, txnType: { in: TYPES }, ...(f.departmentId ? { departmentId: f.departmentId } : {}), ...(createdAt ? { createdAt } : {}) },
    _sum: { qty: true, amount: true },
  });
  const acc = new Map<string, { eq: Dec; ec: Dec; wq: Dec; wc: Dec; cq: Dec; cc: Dec }>();
  for (const g of grouped) {
    const a = acc.get(g.materialId) ?? { eq: D(0), ec: D(0), wq: D(0), wc: D(0), cq: D(0), cc: D(0) };
    const q = D(g._sum.qty ?? 0), c = D(g._sum.amount ?? 0);
    if (g.txnType === "SALE_CONSUMPTION") { a.eq = a.eq.plus(q.neg()); a.ec = a.ec.plus(c.neg()); }
    else if (g.txnType === "COUNT_ADJUSTMENT") { a.cq = a.cq.plus(q.neg()); a.cc = a.cc.plus(c.neg()); }
    else { a.wq = a.wq.plus(q.neg()); a.wc = a.wc.plus(c.neg()); }
    acc.set(g.materialId, a);
  }
  const ids = [...acc.keys()];
  const materials = ids.length
    ? await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: ids } }, select: { id: true, sku: true, name: true, baseUnit: { select: { code: true } }, category: { select: { name: true } } } })
    : [];
  const byId = new Map(materials.map((m) => [m.id, m]));
  const rows: VarianceRow[] = [];
  let tExpected = D(0), tWaste = D(0), tCount = D(0);
  for (const [materialId, a] of acc) {
    const m = byId.get(materialId);
    if (!m) continue;
    const actualQty = a.eq.plus(a.wq).plus(a.cq);
    const actualCost = a.ec.plus(a.wc).plus(a.cc);
    const varianceCost = actualCost.minus(a.ec);
    tExpected = tExpected.plus(a.ec); tWaste = tWaste.plus(a.wc); tCount = tCount.plus(a.cc);
    rows.push({
      materialId, sku: m.sku, name: m.name, unit: m.baseUnit?.code ?? null, category: m.category?.name ?? null,
      expectedQty: num(roundQty(a.eq)), expectedCost: num(money(a.ec)),
      wastageQty: num(roundQty(a.wq)), wastageCost: num(money(a.wc)),
      countLossQty: num(roundQty(a.cq)), countLossCost: num(money(a.cc)),
      actualQty: num(roundQty(actualQty)), actualCost: num(money(actualCost)),
      varianceQty: num(roundQty(actualQty.minus(a.eq))), varianceCost: num(money(varianceCost)),
      variancePct: a.ec.gt(0) ? num(money(varianceCost.div(a.ec).times(100))) : null,
    });
  }
  rows.sort((x, y) => y.varianceCost - x.varianceCost || x.name.localeCompare(y.name));
  const leakage = await foodCostLeakage(db, ctx, { outletId: f.outletId, from: f.from, to: f.to });
  const tVariance = tWaste.plus(tCount);
  return {
    outletId: f.outletId,
    from: f.from?.toISOString() ?? null,
    to: f.to?.toISOString() ?? null,
    departmentId: f.departmentId ?? null,
    rows,
    totals: {
      expectedCost: num(money(tExpected)), wastageCost: num(money(tWaste)), countLossCost: num(money(tCount)),
      actualCost: num(money(tExpected.plus(tVariance))), varianceCost: num(money(tVariance)),
      variancePct: tExpected.gt(0) ? num(money(tVariance.div(tExpected).times(100))) : null,
    },
    leakage,
  };
}
