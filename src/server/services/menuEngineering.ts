/**
 * Menu engineering (proposal module 07, p. 10) and the food-cost leakage report
 * (module 08), both derived from real sales and real recipe costs.
 *
 * Menu engineering
 *  - Every active menu item with an approved recipe and a price is placed on
 *    two axes: portions sold in the period, and gross margin % at today's
 *    plate cost ((price - plate cost) / price, plate cost = ingredients x
 *    (1 + recipe overhead %)).
 *  - The dividing lines are the MEDIAN volume and MEDIAN margin % of this
 *    menu (not an industry rule), so the answer moves as the menu evolves.
 *    A value equal to the median counts as high.
 *  - Star = high/high, Plow-horse = high volume / low margin, Puzzle = low
 *    volume / high margin, Dog = low/low. What to do is the proposal's own
 *    advice; food cost above 38% is flagged for re-costing (p. 10).
 *  - Data sufficiency (no invented thresholds): nothing is classified unless
 *    the period has sales and at least two dishes can be scored (a median
 *    split needs two). Dishes without an approved recipe or a price, and
 *    dishes added to the menu after the period started (they were not on
 *    sale for all of it), are listed apart with the reason, never guessed.
 *  - Cost history: `historicalPlateCost` is what the portions sold in the
 *    period actually cost (plate cost frozen on each order line at the sale:
 *    ingredients at the average cost then, plus the recipe's overhead % then);
 *    `costChange` = current - historical
 *    and `marginChange` the margin it moved at today's price.
 *  Price is the outlet's effective menu price (override or menu price), ex tax.
 *
 * Leakage
 *  revenue (net sales) | theoretical food cost (recipes x sales, at average
 *  cost) | wastage cost | count variance (loss positive) | actual food cost =
 *  theoretical + wastage + count loss | leakage gap = actual - theoretical.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AccessContext } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { authorizedOutletIds, itemSales, salesSummary, foodCost, wastageCost, countVarianceCost } from "@/server/services/analytics";
import { getActiveVersionForMenuItem, calculateRecipeCost, plateCostOf } from "@/server/services/recipe";
import { D, money, num } from "@/domain/money";

export const MENU_CLASSES = ["STAR", "PLOWHORSE", "PUZZLE", "DOG"] as const;
export type MenuClass = (typeof MENU_CLASSES)[number];
export const HIGH_FOOD_COST_PCT = 38;

/** The proposal's verdicts and "what to do" (p. 10). */
export const MENU_CLASS_ADVICE: Record<MenuClass, { label: string; action: string }> = {
  STAR: { label: "Star", action: "Protect and feature it: never change the recipe or the supplier quietly." },
  PLOWHORSE: { label: "Plow-horse", action: "Re-engineer the cost: raise the price a little (₹10–20), trim the portion or re-source." },
  PUZZLE: { label: "Puzzle", action: "Market it harder: move it up the menu and brief staff to recommend it." },
  DOG: { label: "Dog", action: "Remove it at the next reprint: it only adds stock, prep time and wastage." },
};
export const RECOST_ADVICE = "Food cost is above 38%: re-cost the recipe (portion, supplier or price).";

type Scored = {
  menuItemId: string;
  name: string;
  category: string | null;
  price: number;
  /** Ingredient cost of one portion today. */
  ingredientCost: number;
  overheadPct: number;
  /** Ingredients + overhead today. */
  plateCost: number;
  /** Contribution per portion at today's price and cost (price - plate cost). */
  margin: number;
  marginPct: number;
  foodCostPct: number;
  /** Portions sold in the period (every variant counts as one dish), net of full refunds. */
  sold: number;
  netRevenue: number;
  /** margin x sold: the contribution this dish makes at today's price and cost. */
  totalMargin: number;
  /** What one standard portion cost when it was sold (recipe only, frozen at the sale; null = no recorded cost). */
  historicalPlateCost: number | null;
  costChange: number | null;
  marginChange: number | null;
  /** Average base-portion price actually charged in the period (null = none sold without a variant). */
  historicalPrice: number | null;
  priceChange: number | null;
  /** Margin % at the period's own price and cost, and how today's differs from it. */
  historicalMarginPct: number | null;
  marginPctChange: number | null;
  /** Share of the portions sold that carry a sale-time cost (0-100): how far the history can be trusted. */
  costCoverage: number | null;
  confidence: "FULL" | "PARTIAL" | "NONE";
  /** Real cost of goods of the lines sold (recipe x variant + add-ons) and the gross margin on their revenue; only with FULL coverage. */
  actualCost: number | null;
  actualGrossMargin: number | null;
  highCost: boolean;
  /** Facts behind the advice, each from the data above. */
  notes: string[];
};
export type MenuEngineeringRow = Scored & { class: MenuClass | null; label: string | null; action: string | null };
export type UnscoredItem = { menuItemId: string; name: string; sold: number; reason: string };

const filterSchema = z.object({ outletId: z.string().min(1), from: z.coerce.date().optional(), to: z.coerce.date().optional() });

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function classify(sold: number, marginPct: number, medianSold: number, medianMargin: number): MenuClass {
  const highVol = sold >= medianSold;
  const highMargin = marginPct >= medianMargin;
  return highVol ? (highMargin ? "STAR" : "PLOWHORSE") : highMargin ? "PUZZLE" : "DOG";
}

type Dec = Prisma.Decimal;
type History = { costQty: Dec; cost: Dec; lineCostQty: Dec; lineCost: Dec; priceQty: Dec; price: Dec };

/**
 * What was frozen on the order lines of the period, per dish (settled, not
 * fully refunded orders): the recipe cost of a standard portion at the sale
 * (`unitCost`, plate cost incl. overhead), the line's real cost of goods (`lineCost`) and the base-portion
 * price charged (lines without a variant, whose price is the dish's own).
 */
async function historicalSales(db: PrismaClient, ctx: AccessContext, outletId: string, from?: Date, to?: Date) {
  const createdAt = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;
  const lines = await db.orderItem.findMany({
    where: { organizationId: ctx.organizationId, outletId, menuItemId: { not: null }, order: { status: "PAID", ...(createdAt ? { createdAt } : {}) } },
    select: { menuItemId: true, qty: true, unitCost: true, lineCost: true, unitPrice: true, variantId: true },
  });
  const acc = new Map<string, History>();
  for (const l of lines) {
    const a = acc.get(l.menuItemId!) ?? acc.set(l.menuItemId!, { costQty: D(0), cost: D(0), lineCostQty: D(0), lineCost: D(0), priceQty: D(0), price: D(0) }).get(l.menuItemId!)!;
    const q = D(l.qty);
    if (l.unitCost !== null) { a.costQty = a.costQty.plus(q); a.cost = a.cost.plus(q.times(D(l.unitCost))); }
    if (l.lineCost !== null) { a.lineCostQty = a.lineCostQty.plus(q); a.lineCost = a.lineCost.plus(D(l.lineCost)); }
    if (!l.variantId) { a.priceQty = a.priceQty.plus(q); a.price = a.price.plus(q.times(D(l.unitPrice))); }
  }
  return acc;
}

/** Portions and net revenue per dish, every variant / name of the dish together. */
function salesByDish(rows: Awaited<ReturnType<typeof itemSales>>) {
  const by = new Map<string, { qty: Dec; net: Dec }>();
  for (const r of rows) {
    if (!r.menuItemId) continue;
    const a = by.get(r.menuItemId) ?? by.set(r.menuItemId, { qty: D(0), net: D(0) }).get(r.menuItemId)!;
    a.qty = a.qty.plus(D(r.qty));
    a.net = a.net.plus(D(r.netRevenue));
  }
  return by;
}

export async function menuEngineering(db: PrismaClient, ctx: AccessContext, input: z.input<typeof filterSchema>) {
  const f = filterSchema.parse(input);
  authorizedOutletIds(ctx, { outletId: f.outletId }, "reports.view");
  // Plate costs come from recipe costing: a login without recipe access (kitchen,
  // cashier) cannot read them through this report either.
  assertCan(ctx, "recipe.view", f.outletId);
  const [sales, history] = await Promise.all([itemSales(db, ctx, { outletId: f.outletId, from: f.from, to: f.to }), historicalSales(db, ctx, f.outletId, f.from, f.to)]);
  const soldBy = salesByDish(sales);
  const items = await db.menuItem.findMany({
    where: { organizationId: ctx.organizationId, active: true, outletOverrides: { none: { outletId: f.outletId, active: false } } },
    select: { id: true, name: true, price: true, createdAt: true, category: { select: { name: true } }, outletOverrides: { where: { outletId: f.outletId }, select: { price: true } } },
    orderBy: { name: "asc" },
  });

  const scored: Scored[] = [];
  const unscored: UnscoredItem[] = [];
  for (const it of items) {
    const sold = soldBy.get(it.id);
    const qty = num(sold?.qty ?? D(0));
    const price = D(it.outletOverrides[0]?.price ?? it.price);
    if (price.lte(0)) { unscored.push({ menuItemId: it.id, name: it.name, sold: qty, reason: "No price" }); continue; }
    const version = await getActiveVersionForMenuItem(db, ctx, it.id);
    if (!version) { unscored.push({ menuItemId: it.id, name: it.name, sold: qty, reason: "No approved recipe" }); continue; }
    if (f.from && it.createdAt > f.from) { unscored.push({ menuItemId: it.id, name: it.name, sold: qty, reason: "New in this period: not on the menu for all of it" }); continue; }
    const costing = await calculateRecipeCost(db, ctx, version.id, { outletId: f.outletId, quantity: 1 });
    // An ingredient never bought at this outlet costs "0": scoring the dish would invent its margin.
    const unpriced = costing.lines.filter((l) => l.quantity.gt(0) && l.unitCost.isZero()).map((l) => l.materialId);
    if (unpriced.length) {
      const names = await db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: unpriced } }, select: { name: true }, orderBy: { name: "asc" } });
      unscored.push({ menuItemId: it.id, name: it.name, sold: qty, reason: `No purchase cost at this outlet for ${names.map((m) => m.name).join(", ")}` });
      continue;
    }
    const ingredients = costing.total;
    const plate = plateCostOf(ingredients, version.overheadPct);
    const margin = price.minus(plate);
    const net = sold?.net ?? D(0);
    const h = history.get(it.id);
    // Frozen with the sale, overhead included: today's overhead % never rewrites the history.
    const histPlate = h && h.costQty.gt(0) ? money(h.cost.div(h.costQty)) : null;
    const histPrice = h && h.priceQty.gt(0) ? money(h.price.div(h.priceQty)) : null;
    const marginPct = margin.div(price).times(100);
    const histMarginPct = histPlate && histPrice && histPrice.gt(0) ? histPrice.minus(histPlate).div(histPrice).times(100) : null;
    const coverage = qty > 0 && h ? D(h.costQty).div(D(qty)).times(100) : null;
    const confidence: Scored["confidence"] = !coverage || coverage.isZero() ? "NONE" : coverage.gte(100) ? "FULL" : "PARTIAL";
    const actualCost = confidence === "FULL" && h ? money(h.lineCost) : null;
    const notes: string[] = [];
    if (histPlate && !plate.eq(histPlate)) notes.push(`Plate cost ${plate.gt(histPlate) ? "rose" : "fell"} from ₹${num(histPlate)} (when these portions were sold) to ₹${num(plate)} today.`);
    if (histPrice && !price.eq(histPrice)) notes.push(`Price is ₹${num(money(price))} today against ₹${num(histPrice)} charged on average in the period.`);
    if (confidence === "PARTIAL") notes.push(`Only ${num(money(coverage!))}% of the portions sold carry a sale-time cost: the historical figures cover part of the period.`);
    scored.push({
      menuItemId: it.id, name: it.name, category: it.category?.name ?? null,
      price: num(money(price)), ingredientCost: num(money(ingredients)), overheadPct: num(D(version.overheadPct)), plateCost: num(plate), margin: num(money(margin)),
      marginPct: num(money(marginPct)), foodCostPct: num(money(D(ingredients).div(price).times(100))),
      sold: qty, netRevenue: num(money(net)), totalMargin: num(money(margin.times(qty))),
      historicalPlateCost: histPlate ? num(histPlate) : null,
      costChange: histPlate ? num(money(plate.minus(histPlate))) : null,
      // At today's price the margin moves opposite to the cost.
      marginChange: histPlate ? num(money(histPlate.minus(plate))) : null,
      historicalPrice: histPrice ? num(histPrice) : null,
      priceChange: histPrice ? num(money(price.minus(histPrice))) : null,
      historicalMarginPct: histMarginPct ? num(money(histMarginPct)) : null,
      marginPctChange: histMarginPct ? num(money(marginPct.minus(histMarginPct))) : null,
      costCoverage: coverage ? num(money(coverage)) : null,
      confidence,
      actualCost: actualCost ? num(actualCost) : null,
      actualGrossMargin: actualCost ? num(money(net.minus(actualCost))) : null,
      highCost: D(ingredients).div(price).times(100).gt(HIGH_FOOD_COST_PCT),
      notes,
    });
  }

  const totalSold = scored.reduce((a, r) => a + r.sold, 0);
  const sufficiency = scored.length < 2
    ? { sufficient: false, reason: "At least two dishes with an approved recipe and a price are needed to split the menu at its medians." }
    : totalSold <= 0
      ? { sufficient: false, reason: "No dishes were sold in this period, so there is no volume to compare." }
      : { sufficient: true, reason: null };
  const medianSold = sufficiency.sufficient ? median(scored.map((r) => r.sold)) : null;
  const medianMarginPct = sufficiency.sufficient ? num(money(D(median(scored.map((r) => r.marginPct))))) : null;
  const rows: MenuEngineeringRow[] = scored
    .map((r) => {
      if (!sufficiency.sufficient) return { ...r, class: null, label: null, action: r.highCost ? RECOST_ADVICE : null };
      const c = classify(r.sold, r.marginPct, medianSold!, medianMarginPct!);
      return { ...r, class: c, label: MENU_CLASS_ADVICE[c].label, action: MENU_CLASS_ADVICE[c].action };
    })
    .sort((a, b) => (a.class ? MENU_CLASSES.indexOf(a.class) : 9) - (b.class ? MENU_CLASSES.indexOf(b.class) : 9) || b.sold - a.sold || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(MENU_CLASSES.map((c) => [c, rows.filter((r) => r.class === c).length])) as Record<MenuClass, number>;
  return {
    outletId: f.outletId,
    from: f.from?.toISOString() ?? null,
    to: f.to?.toISOString() ?? null,
    sufficient: sufficiency.sufficient,
    insufficientReason: sufficiency.reason,
    medianSold,
    medianMarginPct,
    highFoodCostPct: HIGH_FOOD_COST_PCT,
    recostAdvice: RECOST_ADVICE,
    counts,
    highCostItems: rows.filter((r) => r.highCost).length,
    rows,
    unscored,
    basis: "Margin % = (outlet menu price - plate cost) / price, ex tax; plate cost = today's ingredient cost at average cost x (1 + recipe overhead %). Volume = portions sold on settled orders in the period (every variant counts), net of full refunds. Split lines = the median of this menu. Historical plate cost = the plate cost of one standard portion recorded when each portion was sold (ingredients at the average cost then plus the recipe's overhead % then; add-ons and variant sizes excluded, so it compares with today's plate cost, and later price or overhead edits never change it); historical price = the average price charged for the standard portion. Actual cost = what the lines sold really consumed, add-ons and sizes included.",
  };
}

export type LeakageReport = {
  revenue: number;
  theoreticalFoodCost: number;
  wastage: number;
  countVarianceLoss: number;
  actualFoodCost: number;
  leakage: number;
  pct: { theoretical: number; wastage: number; countVariance: number; actual: number; leakage: number };
};

/** Theoretical vs actual food cost for a period (module 08: "the report I would show you first"). */
export async function foodCostLeakage(db: PrismaClient, ctx: AccessContext, input: { outletId?: string; from?: Date; to?: Date }): Promise<LeakageReport> {
  const f = { outletId: input.outletId, from: input.from, to: input.to };
  authorizedOutletIds(ctx, f, "reports.view");
  const [summary, theoretical, waste, count] = await Promise.all([salesSummary(db, ctx, f), foodCost(db, ctx, f), wastageCost(db, ctx, f), countVarianceCost(db, ctx, f)]);
  const revenue = D(summary.netSales);
  // A count surplus (books under reality) reduces the loss; it never becomes negative leakage on its own line.
  const countLoss = D(count).neg();
  const actual = D(theoretical).plus(waste).plus(countLoss);
  const leakage = actual.minus(theoretical);
  const pct = (v: ReturnType<typeof D>) => (revenue.gt(0) ? num(money(v.div(revenue).times(100))) : 0);
  return {
    revenue: num(money(revenue)),
    theoreticalFoodCost: num(money(D(theoretical))),
    wastage: num(money(D(waste))),
    countVarianceLoss: num(money(countLoss)),
    actualFoodCost: num(money(actual)),
    leakage: num(money(leakage)),
    pct: { theoretical: pct(D(theoretical)), wastage: pct(D(waste)), countVariance: pct(countLoss), actual: pct(actual), leakage: pct(leakage) },
  };
}
