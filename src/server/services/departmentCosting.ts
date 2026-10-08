/**
 * Department-level stock and costing (proposal modules 03 and 05), all derived
 * from the append-only ledger:
 *
 *  - stockMatrix: every material down the side, every department across the
 *    top (plus stock not yet assigned to a department), quantity on hand and,
 *    for logins that may see costs, the value at weighted-average cost.
 *  - departmentPnl: per department for a period: sales value of the dishes it
 *    owns (item station -> department kind), cost issued in (net stock moved or
 *    bought into it), item wastage, gross margin and margin %, plus the recipe
 *    (theoretical) cost of what it sold.
 *  - dailyCosting: one row per business day per department: opening value,
 *    receipts, issues out, consumption, wastage, adjustments, closing value.
 *
 * Sales are attributed with the menu item's CURRENT station; a dish whose
 * station has no department of that kind at the outlet is "Unattributed".
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { itemSales } from "@/server/services/analytics";
import { outletTimeZone } from "@/server/services/businessDay";
import { businessDayRange } from "@/domain/time";
import { D, dMul, money, num } from "@/domain/money";
import { canSeeStockValue } from "@/server/services/costVisibility";

type Dec = ReturnType<typeof D>;
const UNASSIGNED = "";
const WASTE = new Set(["WASTAGE", "SPOILAGE", "STAFF_MEAL"]);
const CONSUMPTION = new Set(["SALE_CONSUMPTION", "PRODUCTION_CONSUMPTION", "PRODUCTION_OUTPUT"]);
const ADJUST = new Set(["COUNT_ADJUSTMENT", "OTHER_ADJUSTMENT", "RETURN"]);
/** Stock entering / leaving a department other than by use: purchases, moves, opening. */
const MOVES = new Set(["PURCHASE_RECEIPT", "OPENING_BALANCE", "ISSUE", "TRANSFER_IN", "TRANSFER_OUT"]);

export { canSeeStockValue };

async function outletDepartments(db: PrismaClient, ctx: AccessContext, outletId: string) {
  return db.department.findMany({ where: { organizationId: ctx.organizationId, outletId }, select: { id: true, name: true, kind: true, active: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
}

// ---------------- live stock matrix ----------------

export async function stockMatrix(db: PrismaClient, ctx: AccessContext, input: { outletId: string }) {
  const { outletId } = z.object({ outletId: z.string().min(1) }).parse(input);
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "inventory.view", outletId);
  const showValue = canSeeStockValue(ctx, outletId);
  const [departments, grouped, costs] = await Promise.all([
    outletDepartments(db, ctx, outletId),
    db.inventoryLedger.groupBy({ by: ["materialId", "departmentId"], where: { organizationId: ctx.organizationId, outletId }, _sum: { qty: true } }),
    db.outletMaterialCost.findMany({ where: { organizationId: ctx.organizationId, outletId }, select: { materialId: true, avgCost: true } }),
  ]);
  const materialIds = [...new Set(grouped.map((g) => g.materialId))];
  const materials = materialIds.length
    ? await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: materialIds } }, select: { id: true, sku: true, name: true, reorderLevel: true, baseUnit: { select: { code: true } }, category: { select: { name: true } } } })
    : [];
  const cost = new Map(costs.map((c) => [c.materialId, D(c.avgCost)]));
  const cells = new Map<string, Map<string, Dec>>();
  for (const g of grouped) {
    const m = cells.get(g.materialId) ?? cells.set(g.materialId, new Map()).get(g.materialId)!;
    m.set(g.departmentId ?? UNASSIGNED, D(g._sum.qty ?? 0));
  }
  const usedCols = new Set(grouped.map((g) => g.departmentId ?? UNASSIGNED));
  const columns = [
    ...(usedCols.has(UNASSIGNED) ? [{ id: UNASSIGNED, name: "Unassigned", kind: "UNASSIGNED" }] : []),
    ...departments.filter((d) => d.active || usedCols.has(d.id)).map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
  ];
  const valueByCategory = new Map<string, Dec>();
  const rows = materials
    .map((m) => {
      const byDept = cells.get(m.id) ?? new Map<string, Dec>();
      const total = [...byDept.values()].reduce((a, b) => a.plus(b), D(0));
      const value = money(dMul(total, cost.get(m.id) ?? D(0)));
      const cat = m.category?.name ?? "Uncategorized";
      valueByCategory.set(cat, (valueByCategory.get(cat) ?? D(0)).plus(value));
      return {
        materialId: m.id, sku: m.sku, name: m.name, category: m.category?.name ?? null, unit: m.baseUnit.code,
        quantities: Object.fromEntries(columns.map((c) => [c.id, num((byDept.get(c.id) ?? D(0)).toDecimalPlaces(3))])),
        total: num(total.toDecimalPlaces(3)),
        par: num(D(m.reorderLevel)),
        belowPar: D(m.reorderLevel).gt(0) && total.lt(D(m.reorderLevel)),
        negative: total.lt(0) || [...byDept.values()].some((q) => q.lt(0)),
        ...(showValue ? { avgCost: num(cost.get(m.id) ?? D(0)), value: num(value) } : {}),
      };
    })
    .sort((a, b) => Number(b.negative) - Number(a.negative) || Number(b.belowPar) - Number(a.belowPar) || a.name.localeCompare(b.name));
  return {
    outletId,
    columns,
    rows,
    showValue,
    ...(showValue ? {
      totalValue: num(money([...valueByCategory.values()].reduce((a, b) => a.plus(b), D(0)))),
      valueByCategory: [...valueByCategory.entries()].map(([category, v]) => ({ category, value: num(money(v)) })).sort((a, b) => b.value - a.value),
    } : {}),
  };
}

// ---------------- department P&L ----------------

const rangeSchema = z.object({ outletId: z.string().min(1), from: z.coerce.date(), to: z.coerce.date() }).refine((r) => r.from <= r.to, { message: "`from` must be on or before `to`", path: ["from"] });

export type DepartmentPnlRow = {
  departmentId: string | null;
  department: string;
  kind: string;
  sales: number;
  costIssuedIn: number;
  wastage: number;
  grossMargin: number;
  marginPct: number;
  recipeCostOfSales: number;
};

export async function departmentPnl(db: PrismaClient, ctx: AccessContext, input: z.input<typeof rangeSchema>) {
  const f = rangeSchema.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "reports.view", f.outletId);
  const departments = await outletDepartments(db, ctx, f.outletId);
  const firstOfKind = (kind: string) => departments.find((d) => d.active && d.kind === kind)?.id ?? null;

  // Sales: each dish to the department that owns its station.
  const lines = await itemSales(db, ctx, { outletId: f.outletId, from: f.from, to: f.to });
  const itemIds = lines.map((l) => l.menuItemId).filter((x): x is string => Boolean(x));
  const stations = new Map((itemIds.length ? await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, id: { in: itemIds } }, select: { id: true, station: true } }) : []).map((m) => [m.id, m.station]));
  const sales = new Map<string, Dec>();
  for (const l of lines) {
    const dept = (l.menuItemId && firstOfKind(stations.get(l.menuItemId) ?? "")) || UNASSIGNED;
    sales.set(dept, (sales.get(dept) ?? D(0)).plus(l.netRevenue));
  }

  const ledger = await db.inventoryLedger.groupBy({
    by: ["departmentId", "txnType"],
    where: { organizationId: ctx.organizationId, outletId: f.outletId, createdAt: { gte: f.from, lte: f.to } },
    _sum: { amount: true },
  });
  const costIn = new Map<string, Dec>(), waste = new Map<string, Dec>(), recipe = new Map<string, Dec>();
  const bump = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? D(0)).plus(v));
  for (const g of ledger) {
    const k = g.departmentId ?? UNASSIGNED;
    const amt = D(g._sum.amount ?? 0);
    if (MOVES.has(g.txnType)) bump(costIn, k, amt);
    else if (WASTE.has(g.txnType)) bump(waste, k, amt.neg());
    else if (g.txnType === "SALE_CONSUMPTION") bump(recipe, k, amt.neg());
  }

  const keys = [...departments.filter((d) => d.kind !== "STORE").map((d) => d.id), UNASSIGNED];
  const rows: DepartmentPnlRow[] = keys
    .map((k) => {
      const d = departments.find((x) => x.id === k);
      const s = sales.get(k) ?? D(0);
      const c = costIn.get(k) ?? D(0);
      const w = waste.get(k) ?? D(0);
      const margin = s.minus(c).minus(w);
      return {
        departmentId: k || null, department: d?.name ?? "Unattributed", kind: d?.kind ?? "UNASSIGNED",
        sales: num(money(s)), costIssuedIn: num(money(c)), wastage: num(money(w)), grossMargin: num(money(margin)),
        marginPct: s.gt(0) ? num(money(margin.div(s).times(100))) : 0, recipeCostOfSales: num(money(recipe.get(k) ?? D(0))),
      };
    })
    // Unassigned / empty departments only when they carry something.
    .filter((r) => r.sales || r.costIssuedIn || r.wastage || r.recipeCostOfSales || (r.departmentId && departments.find((d) => d.id === r.departmentId)?.active));
  const total = rows.reduce((a, r) => ({ sales: a.sales.plus(r.sales), cost: a.cost.plus(r.costIssuedIn), waste: a.waste.plus(r.wastage) }), { sales: D(0), cost: D(0), waste: D(0) });
  const totalMargin = total.sales.minus(total.cost).minus(total.waste);
  return {
    outletId: f.outletId, from: f.from.toISOString(), to: f.to.toISOString(), rows,
    total: { sales: num(money(total.sales)), costIssuedIn: num(money(total.cost)), wastage: num(money(total.waste)), grossMargin: num(money(totalMargin)), marginPct: total.sales.gt(0) ? num(money(totalMargin.div(total.sales).times(100))) : 0 },
    basis: "Sales (ex tax) are attributed to the department of the dish's station. Cost issued in = stock bought or moved into the department, net of stock it sent back, at ledger cost. Store departments hold stock and are not listed.",
  };
}

// ---------------- daily costing ----------------

const dailySchema = z.object({ outletId: z.string().min(1), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), departmentId: z.string().optional() });
const MAX_DAYS = 31;

export type DailyCostingRow = { date: string; departmentId: string | null; department: string; opening: number; receipts: number; issuesOut: number; consumption: number; wastage: number; adjustments: number; closing: number };

export async function dailyCosting(db: PrismaClient, ctx: AccessContext, input: z.input<typeof dailySchema>) {
  const f = dailySchema.parse(input);
  assertOutletAccess(ctx, f.outletId);
  assertCan(ctx, "reports.view", f.outletId);
  if (f.from > f.to) throw new ValidationError("`from` must be on or before `to`");
  const tz = await outletTimeZone(db, ctx, f.outletId);
  const days: Array<{ date: string; start: Date; end: Date }> = [];
  for (let d = businessDayRange(f.from, tz); d.date <= f.to; d = businessDayRange(new Date(d.end.getTime() + 3_600_000), tz)) {
    days.push(d);
    if (days.length > MAX_DAYS) throw new ValidationError(`Daily costing covers at most ${MAX_DAYS} days`);
  }
  const departments = await outletDepartments(db, ctx, f.outletId);
  if (f.departmentId && !departments.some((d) => d.id === f.departmentId)) throw new ValidationError("Department not in this outlet");
  const deptWhere = f.departmentId ? { departmentId: f.departmentId } : {};
  const base = { organizationId: ctx.organizationId, outletId: f.outletId, ...deptWhere };

  const openingRows = await db.inventoryLedger.groupBy({ by: ["departmentId"], where: { ...base, createdAt: { lt: days[0].start } }, _sum: { amount: true } });
  const running = new Map<string, Dec>(openingRows.map((r) => [r.departmentId ?? UNASSIGNED, D(r._sum.amount ?? 0)]));
  const keys = f.departmentId ? [f.departmentId] : [...new Set([...departments.map((d) => d.id), ...running.keys()])];
  const name = (k: string) => departments.find((d) => d.id === k)?.name ?? "Unassigned";

  const out: DailyCostingRow[] = [];
  for (const day of days) {
    const [ins, outs] = await Promise.all([
      db.inventoryLedger.groupBy({ by: ["departmentId", "txnType"], where: { ...base, createdAt: { gte: day.start, lt: day.end }, qty: { gt: 0 } }, _sum: { amount: true } }),
      db.inventoryLedger.groupBy({ by: ["departmentId", "txnType"], where: { ...base, createdAt: { gte: day.start, lt: day.end }, qty: { lt: 0 } }, _sum: { amount: true } }),
    ]);
    const acc = new Map<string, Record<"receipts" | "issuesOut" | "consumption" | "wastage" | "adjustments", Dec>>();
    const get = (k: string) => acc.get(k) ?? acc.set(k, { receipts: D(0), issuesOut: D(0), consumption: D(0), wastage: D(0), adjustments: D(0) }).get(k)!;
    for (const g of [...ins, ...outs]) {
      const k = g.departmentId ?? UNASSIGNED;
      const amt = D(g._sum.amount ?? 0);
      const a = get(k);
      if (CONSUMPTION.has(g.txnType)) a.consumption = a.consumption.plus(amt);
      else if (WASTE.has(g.txnType)) a.wastage = a.wastage.plus(amt);
      else if (ADJUST.has(g.txnType)) a.adjustments = a.adjustments.plus(amt);
      else if (amt.gte(0)) a.receipts = a.receipts.plus(amt);
      else a.issuesOut = a.issuesOut.plus(amt);
    }
    for (const k of new Set([...keys, ...acc.keys()])) {
      const opening = running.get(k) ?? D(0);
      const a = get(k);
      const closing = opening.plus(a.receipts).plus(a.issuesOut).plus(a.consumption).plus(a.wastage).plus(a.adjustments);
      running.set(k, closing);
      if (opening.isZero() && closing.isZero() && !acc.has(k)) continue;
      out.push({
        date: day.date, departmentId: k || null, department: name(k), opening: num(money(opening)),
        receipts: num(money(a.receipts)), issuesOut: num(money(a.issuesOut.neg())), consumption: num(money(a.consumption.neg())),
        wastage: num(money(a.wastage.neg())), adjustments: num(money(a.adjustments)), closing: num(money(closing)),
      });
    }
  }
  return { outletId: f.outletId, timezone: tz, from: f.from, to: f.to, rows: out, basis: "Values at ledger cost. Receipts = purchases and stock moved in; issues out = stock moved to another department or outlet; consumption = recipe use by sales and production (net of production output); closing = opening + receipts - issues out - consumption - wastage + adjustments." };
}
