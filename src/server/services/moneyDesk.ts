/**
 * The money desk (proposal module 06, p. 9): closing the day, honestly.
 *
 * Three independent numbers describe one business day, and every figure is
 * derived from transaction rows (Decimal, rupees to 2 dp; differences are
 * shown exactly, never rounded away):
 *
 *   1. What the POS rang     settled orders (PAID + REFUNDED) placed that day,
 *                            billed total per sales channel; plus the
 *                            "expected gross" cross-check: every item sold x
 *                            today's menu price (ex tax) vs what was billed.
 *   2. What was declared     the manager's day-close figures: gross revenue per
 *                            channel (SALES reconciliation) and the money
 *                            counted per payment method (PAYMENTS
 *                            reconciliation, finance.ts).
 *   3. What reached the bank deposit slips and UPI / card credits recorded
 *                            against the day (BankDeposit).
 *
 *   Aggregator commission  = recorded commission of the day's imported
 *                            aggregator orders, else billed x the platform's
 *                            stored commission %.
 *   Expected to bank       = cash + UPI + card collected (counted where the
 *                            manager declared it, else the system figure).
 *
 * Closing (closeDay) completes both reconciliations (their exception lines
 * raise anomalies through the existing engine and tolerance), freezes the
 * figures as a DayClose revision and locks the day (dayLock.ts). Reopening
 * (reopenDay) needs a reason and a fresh password over HTTP; the frozen
 * revision is kept and the next close is a new one. Deposits stay recordable
 * after the close: a deposit made a day late is normal (p. 9).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { raiseAnomaly } from "@/server/services/anomaly";
import { saveReconciliationTx, completeReconciliationTx, reopenReconciliationTx, RECON_RULES } from "@/server/services/reconciliation";
import { expectedByMethod } from "@/server/services/finance";
import { outletBusinessDay, businessDateString, type BusinessDateInput } from "@/server/services/businessDay";
import { assertDayOpen, latestDayClose } from "@/server/services/dayLock";
import { businessDayRange } from "@/domain/time";
import { D, money, moneyAmount, num } from "@/domain/money";

type Db = PrismaClient | Prisma.TransactionClient;
type Dec = Prisma.Decimal;

const dateStr = businessDateString;
const m2 = (v: Dec) => num(money(v));

/** Sales channels as the money desk declares them. */
export const CHANNEL_LABELS: Record<string, string> = {
  DINE_IN: "Dine-in (incl. table QR)",
  TAKEAWAY: "Takeaway",
  DELIVERY: "Own delivery",
  ONLINE: "Own website",
  ZOMATO: "Zomato",
  SWIGGY: "Swiggy",
  AGGREGATOR: "Other aggregators",
};
const AGGREGATOR_CHANNELS = new Set(["ZOMATO", "SWIGGY", "AGGREGATOR"]);
export const BANK_METHODS = ["CASH", "UPI", "CARD"] as const;

export function channelOf(order: { source: string; channel: string }): string {
  if (order.source === "ZOMATO" || order.source === "SWIGGY") return order.source;
  if (order.channel === "AGGREGATOR") return "AGGREGATOR";
  if (order.channel === "QR") return "DINE_IN";
  return CHANNEL_LABELS[order.channel] ? order.channel : "DINE_IN";
}

function authorizeView(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.view", outletId);
}
function authorizeWrite(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.reconcile", outletId);
}
const actor = (ctx: AccessContext) => (ctx.userId === "system" ? null : ctx.userId);

// ---------------------------------------------------------------- figures

type Day = Awaited<ReturnType<typeof outletBusinessDay>>;

/** What the POS rang that day, per channel, plus the menu-price cross-check. */
async function systemSales(db: Db, ctx: AccessContext, outletId: string, day: Day) {
  const orders = await db.order.findMany({
    where: { organizationId: ctx.organizationId, outletId, status: { in: ["PAID", "REFUNDED"] }, createdAt: { gte: day.start, lt: day.end } },
    select: {
      id: true, source: true, channel: true, subtotal: true, discount: true, tax: true, total: true,
      items: { select: { menuItemId: true, qty: true, unitPrice: true, modifiers: { select: { priceDelta: true } } } },
    },
  });
  const itemIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.menuItemId)).filter((x): x is string => Boolean(x)))];
  const menu = itemIds.length
    ? await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, id: { in: itemIds } }, select: { id: true, price: true, outletOverrides: { where: { outletId }, select: { price: true } } } })
    : [];
  const priceOf = new Map(menu.map((m) => [m.id, D(m.outletOverrides[0]?.price ?? m.price)]));
  const channels = new Map<string, { orders: number; billed: Dec }>();
  let subtotal = D(0), discount = D(0), tax = D(0), total = D(0), atMenu = D(0), billedItems = D(0);
  let unpricedLines = 0, fullyDiscounted = 0;
  for (const o of orders) {
    const key = channelOf(o);
    const c = channels.get(key) ?? { orders: 0, billed: D(0) };
    c.orders++;
    c.billed = c.billed.plus(D(o.total));
    channels.set(key, c);
    subtotal = subtotal.plus(D(o.subtotal));
    discount = discount.plus(D(o.discount));
    tax = tax.plus(D(o.tax));
    total = total.plus(D(o.total));
    if (D(o.total).isZero() && D(o.subtotal).gt(0)) fullyDiscounted++;
    for (const i of o.items) {
      const mods = i.modifiers.reduce((s, m) => s.plus(D(m.priceDelta)), D(0));
      const billedLine = D(i.qty).times(D(i.unitPrice).plus(mods));
      billedItems = billedItems.plus(billedLine);
      const menuPrice = i.menuItemId ? priceOf.get(i.menuItemId) : undefined;
      if (menuPrice === undefined) { unpricedLines++; atMenu = atMenu.plus(billedLine); continue; }
      atMenu = atMenu.plus(D(i.qty).times(menuPrice.plus(mods)));
    }
  }
  return {
    orders: orders.length,
    channels,
    subtotal, discount, tax, total,
    atMenuPrice: atMenu,
    billedItems,
    unpricedLines,
    fullyDiscounted,
  };
}

async function refundsInDay(db: Db, ctx: AccessContext, outletId: string, day: Day) {
  const agg = await db.refund.aggregate({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: day.start, lt: day.end } }, _sum: { amount: true }, _count: true });
  return { amount: D(agg._sum.amount ?? 0), count: agg._count };
}

async function commissions(db: Db, ctx: AccessContext, outletId: string, day: Day) {
  const [aggs, recorded] = await Promise.all([
    db.aggregator.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true, commissionPct: true } }),
    db.aggregatorOrder.findMany({
      where: { organizationId: ctx.organizationId, outletId, placedAt: { gte: day.start, lt: day.end } },
      select: { commission: true, netPayout: true, aggregator: { select: { name: true } } },
    }),
  ]);
  const pct = new Map(aggs.map((a) => [a.name.toUpperCase(), D(a.commissionPct)]));
  const rec = new Map<string, { commission: Dec; payout: Dec; orders: number }>();
  for (const r of recorded) {
    const k = r.aggregator.name.toUpperCase();
    const key = k === "ZOMATO" || k === "SWIGGY" ? k : "AGGREGATOR";
    const cur = rec.get(key) ?? { commission: D(0), payout: D(0), orders: 0 };
    cur.commission = cur.commission.plus(D(r.commission));
    cur.payout = cur.payout.plus(D(r.netPayout));
    cur.orders++;
    rec.set(key, cur);
  }
  return { pct, rec };
}

async function pettyCashDay(db: Db, ctx: AccessContext, outletId: string, day: Day) {
  const base = { organizationId: ctx.organizationId, outletId };
  // Month to date (proposal p. 9: "month-to-date petty spend, always visible").
  const monthStart = businessDayRange(`${day.date.slice(0, 8)}01`, day.tz).start;
  const [before, rows, month] = await Promise.all([
    db.pettyCashTxn.aggregate({ where: { ...base, createdAt: { lt: day.start } }, _sum: { amount: true } }),
    db.pettyCashTxn.findMany({ where: { ...base, createdAt: { gte: day.start, lt: day.end } }, select: { amount: true, category: true, type: true } }),
    db.pettyCashTxn.groupBy({ by: ["category"], where: { ...base, amount: { lt: 0 }, createdAt: { gte: monthStart, lt: day.end } }, _sum: { amount: true } }),
  ]);
  const monthByCat = month.map((g) => ({ category: g.category ?? "Uncategorised", amount: m2(D(g._sum.amount ?? 0).abs()) })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category));
  const monthOut = month.reduce((s, g) => s.plus(D(g._sum.amount ?? 0).abs()), D(0));
  const opening = D(before._sum.amount ?? 0);
  let inflow = D(0), outflow = D(0);
  const byCat = new Map<string, Dec>();
  for (const r of rows) {
    const a = D(r.amount);
    if (a.gt(0)) inflow = inflow.plus(a);
    else {
      outflow = outflow.plus(a.abs());
      const c = r.category ?? "Uncategorised";
      byCat.set(c, (byCat.get(c) ?? D(0)).plus(a.abs()));
    }
  }
  return {
    opening: m2(opening), inflow: m2(inflow), outflow: m2(outflow), closing: m2(opening.plus(inflow).minus(outflow)),
    byCategory: [...byCat].map(([category, amount]) => ({ category, amount: m2(amount) })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category)),
    monthToDate: { outflow: m2(monthOut), byCategory: monthByCat },
  };
}

export type MoneyDeskDay = Awaited<ReturnType<typeof computeDay>>;

/** Every figure of the day, from the transaction rows (caller authorizes). */
async function computeDay(db: Db, ctx: AccessContext, outletId: string, businessDate: BusinessDateInput) {
  const day = await outletBusinessDay(db, ctx, outletId, businessDate);
  const reconKey = (kind: string) => ({ outletId_businessDate_kind: { outletId, businessDate: day.key, kind } });
  const [sales, refunds, comm, collected, paymentsRecon, salesRecon, deposits, petty, expenses, unsettled, openDrawers, drawerVariance, closes] = await Promise.all([
    systemSales(db, ctx, outletId, day),
    refundsInDay(db, ctx, outletId, day),
    commissions(db, ctx, outletId, day),
    expectedByMethod(db, ctx, outletId, day.date),
    db.reconciliation.findUnique({ where: reconKey("PAYMENTS"), include: { lines: true } }),
    db.reconciliation.findUnique({ where: reconKey("SALES"), include: { lines: true } }),
    db.bankDeposit.findMany({ where: { organizationId: ctx.organizationId, outletId, businessDate: day.key }, orderBy: [{ depositedAt: "asc" }, { id: "asc" }] }),
    pettyCashDay(db, ctx, outletId, day),
    db.expense.aggregate({ where: { organizationId: ctx.organizationId, outletId, voidedAt: null, spentAt: { gte: day.start, lt: day.end } }, _sum: { amount: true }, _count: true }),
    db.order.count({ where: { organizationId: ctx.organizationId, outletId, createdAt: { gte: day.start, lt: day.end }, status: { notIn: ["PAID", "CANCELLED", "REFUNDED"] } } }),
    db.cashDrawerSession.count({ where: { organizationId: ctx.organizationId, outletId, status: "OPEN", openedAt: { lt: day.end } } }),
    db.cashDrawerSession.aggregate({ where: { organizationId: ctx.organizationId, outletId, closedAt: { gte: day.start, lt: day.end } }, _sum: { variance: true } }),
    db.dayClose.findMany({ where: { organizationId: ctx.organizationId, outletId, businessDate: day.key }, orderBy: { revision: "desc" } }),
  ]);

  // ---- 1 vs 2: billed per channel vs declared
  const declaredSales = new Map((salesRecon?.lines ?? []).map((l) => [l.method, { amount: D(l.actual), note: l.note }]));
  const channelKeys = [...new Set([...sales.channels.keys(), ...declaredSales.keys()])].sort((a, b) => Object.keys(CHANNEL_LABELS).indexOf(a) - Object.keys(CHANNEL_LABELS).indexOf(b) || a.localeCompare(b));
  const channels = channelKeys.map((key) => {
    const sys = sales.channels.get(key) ?? { orders: 0, billed: D(0) };
    const dec = declaredSales.get(key);
    const aggregator = AGGREGATOR_CHANNELS.has(key);
    const rec = comm.rec.get(key);
    const pct = comm.pct.get(key);
    const basis = dec?.amount ?? sys.billed;
    const commission = !aggregator ? null : rec ? rec.commission : pct ? money(basis.times(pct).div(100)) : null;
    return {
      key, label: CHANNEL_LABELS[key] ?? key, orders: sys.orders, billed: m2(sys.billed),
      declared: dec ? m2(dec.amount) : null,
      /** declared - billed: negative = the POS rang more than was declared (p. 9: the most serious). */
      difference: dec ? m2(dec.amount.minus(sys.billed)) : null,
      note: dec?.note ?? null,
      aggregator,
      commissionPct: aggregator && pct ? num(pct) : null,
      commission: commission ? m2(commission) : null,
      commissionBasis: !aggregator ? null : rec ? "recorded" : pct ? "rate" : null,
      expectedPayout: aggregator && commission ? m2(basis.minus(commission)) : null,
    };
  });
  const sum = (xs: Array<number | null>) => xs.reduce<Dec>((s, x) => s.plus(x ?? 0), D(0));

  // ---- collections: system per method vs counted (PAYMENTS reconciliation)
  const counted = new Map((paymentsRecon?.lines ?? []).map((l) => [l.method, D(l.actual)]));
  const methods = [...new Set([...collected.map((c) => c.method), ...[...counted.keys()].filter((m) => m !== "BANK")])].sort();
  const collections = methods.map((method) => {
    const expected = D(collected.find((c) => c.method === method)?.expected ?? 0);
    const declared = counted.get(method);
    return { method, expected: m2(expected), declared: declared ? m2(declared) : null, difference: declared ? m2(declared.minus(expected)) : null };
  });

  // ---- 2 vs 3: expected to bank vs deposited
  const live = deposits.filter((d) => d.status === "RECORDED");
  const bankRows = BANK_METHODS.map((method) => {
    const c = collections.find((x) => x.method === method);
    const expected = D(c?.declared ?? c?.expected ?? 0);
    const deposited = live.filter((d) => d.method === method).reduce((s, d) => s.plus(D(d.amount)), D(0));
    return { method, expected: m2(expected), basis: c?.declared !== null && c?.declared !== undefined ? "counted" : "system", deposited: m2(deposited), gap: m2(deposited.minus(expected)) };
  });
  const expectedToBank = sum(bankRows.map((b) => b.expected));
  const deposited = sum(bankRows.map((b) => b.deposited));

  const latest = closes[0] ?? null;
  const status: "OPEN" | "CLOSED" | "REOPENED" = latest ? (latest.status as "CLOSED" | "REOPENED") : "OPEN";
  const blockers: string[] = [];
  if (unsettled > 0) blockers.push(`${unsettled} order(s) of this day are not settled`);
  if (openDrawers > 0) blockers.push(`${openDrawers} cash drawer session(s) are still open`);
  if (!paymentsRecon) blockers.push("money counted per payment method has not been entered");
  if (!salesRecon) blockers.push("revenue per channel has not been declared");
  if (day.start.getTime() > Date.now()) blockers.push("this day has not started");

  return {
    outletId,
    businessDate: day.date,
    timezone: day.tz,
    status,
    pos: {
      orders: sales.orders,
      grossSales: m2(sales.subtotal),
      discounts: m2(sales.discount),
      tax: m2(sales.tax),
      billed: m2(sales.total),
      refunds: m2(refunds.amount),
      refundCount: refunds.count,
      fullyDiscountedOrders: sales.fullyDiscounted,
      /** Expected gross (p. 9): every item sold x today's menu price, ex tax. */
      atMenuPrice: m2(sales.atMenuPrice),
      billedItems: m2(sales.billedItems),
      /** billed item value - value at menu price: negative = sold below menu price. */
      menuPriceGap: m2(sales.billedItems.minus(sales.atMenuPrice)),
      unpricedLines: sales.unpricedLines,
    },
    channels,
    declaredTotal: salesRecon ? m2(sum(channels.map((c) => c.declared))) : null,
    /** declared - billed over all channels (negative = the POS rang more). */
    declaredDifference: salesRecon ? m2(sum(channels.map((c) => c.declared)).minus(sales.total)) : null,
    commissionTotal: m2(sum(channels.map((c) => c.commission))),
    collections,
    bank: {
      rows: bankRows,
      expected: m2(expectedToBank),
      deposited: m2(deposited),
      gap: m2(deposited.minus(expectedToBank)),
      deposits: deposits.map((d) => ({ id: d.id, method: d.method, amount: m2(D(d.amount)), depositedAt: d.depositedAt.toISOString(), reference: d.reference, bankAccount: d.bankAccount, notes: d.notes, status: d.status, voidReason: d.voidReason, createdAt: d.createdAt.toISOString() })),
    },
    pettyCash: petty,
    expenses: { total: m2(D(expenses._sum.amount ?? 0)), count: expenses._count },
    drawers: { open: openDrawers, closedVariance: m2(D(drawerVariance._sum.variance ?? 0)) },
    reconciliations: {
      payments: paymentsRecon ? { id: paymentsRecon.id, status: paymentsRecon.status } : null,
      sales: salesRecon ? { id: salesRecon.id, status: salesRecon.status } : null,
    },
    unsettledOrders: unsettled,
    blockers,
    readyToClose: status !== "CLOSED" && blockers.length === 0,
    closes: closes.map((c) => ({ id: c.id, revision: c.revision, status: c.status, closedAt: c.closedAt.toISOString(), closedById: c.closedById, notes: c.notes, reopenedAt: c.reopenedAt?.toISOString() ?? null, reopenedById: c.reopenedById, reopenReason: c.reopenReason })),
    lineIds: [...(paymentsRecon?.lines ?? []), ...(salesRecon?.lines ?? [])].map((l) => l.id),
  };
}

/** The figures a close freezes, and that "changed since close" compares. */
function snapshotOf(d: MoneyDeskDay) {
  return {
    pos: { orders: d.pos.orders, billed: d.pos.billed, discounts: d.pos.discounts, refunds: d.pos.refunds, atMenuPrice: d.pos.atMenuPrice },
    channels: d.channels.map((c) => ({ key: c.key, billed: c.billed, declared: c.declared, difference: c.difference, commission: c.commission })),
    collections: d.collections,
    bank: { expected: d.bank.expected, deposited: d.bank.deposited, gap: d.bank.gap },
    pettyCash: d.pettyCash,
    expenses: d.expenses,
    drawers: d.drawers,
  };
}

const COMPARED: Array<[string, (s: ReturnType<typeof snapshotOf>) => number | null]> = [
  ["Orders", (s) => s.pos.orders],
  ["Billed", (s) => s.pos.billed],
  ["Refunds", (s) => s.pos.refunds],
  ["Discounts", (s) => s.pos.discounts],
  ["Expenses", (s) => s.expenses.total],
  ["Petty cash out", (s) => s.pettyCash.outflow],
  ["Deposited", (s) => s.bank.deposited],
];

/** The money desk for one outlet business day. */
export async function getMoneyDesk(db: PrismaClient, ctx: AccessContext, input: { outletId: string; businessDate: string }) {
  const q = z.object({ outletId: z.string().min(1), businessDate: dateStr }).parse(input);
  authorizeView(ctx, q.outletId);
  const d = await computeDay(db, ctx, q.outletId, q.businessDate);
  const { lineIds, ...out } = d;
  const closeIds = d.closes.map((c) => c.id);
  const anomalies = lineIds.length || closeIds.length
    ? await db.anomaly.findMany({
        where: { organizationId: ctx.organizationId, outletId: q.outletId, OR: [{ entityType: "ReconciliationLine", entityId: { in: lineIds } }, { entityType: "DayClose", entityId: { in: closeIds } }] },
        orderBy: [{ detectedAt: "desc" }, { id: "desc" }],
        select: { id: true, type: true, severity: true, status: true, message: true, detectedAt: true, resolutionNote: true },
      })
    : [];
  // What moved after the latest close (orders and payments are never blocked).
  let changedSinceClose: Array<{ figure: string; atClose: number | null; now: number | null }> = [];
  const latest = await db.dayClose.findFirst({ where: { organizationId: ctx.organizationId, outletId: q.outletId, businessDate: (await outletBusinessDay(db, ctx, q.outletId, q.businessDate)).key }, orderBy: { revision: "desc" } });
  if (latest?.status === "CLOSED") {
    const frozen = JSON.parse(latest.snapshot) as ReturnType<typeof snapshotOf>;
    const now = snapshotOf(d);
    changedSinceClose = COMPARED.map(([figure, f]) => ({ figure, atClose: f(frozen), now: f(now) })).filter((r) => r.atClose !== r.now);
  }
  return { ...out, discrepancies: anomalies.map((a) => ({ ...a, detectedAt: a.detectedAt.toISOString() })), changedSinceClose };
}

// ---------------------------------------------------------------- declared sales

const declareSchema = z.object({
  outletId: z.string().min(1),
  businessDate: dateStr,
  declared: z.array(z.object({ channel: z.string().refine((c) => Boolean(CHANNEL_LABELS[c]), "Unknown channel"), amount: moneyAmount(z.number().nonnegative()), note: z.string().max(300).optional() })).min(1).max(20),
  notes: z.string().max(500).optional(),
}).strict();

/**
 * Save the manager's declared revenue per channel (proposal p. 9 "Revenue
 * declared"). A DRAFT SALES reconciliation: expected = what the POS billed,
 * actual = declared. Re-saving replaces the draft; a closed day refuses it.
 */
export async function declareSales(ctx: AccessContext, input: z.input<typeof declareSchema>, db: Client = prisma) {
  const data = declareSchema.parse(input);
  authorizeWrite(ctx, data.outletId);
  const channels = data.declared.map((d) => d.channel);
  if (new Set(channels).size !== channels.length) throw new ValidationError("Declare each channel once");
  return runInTx(db, async (tx) => {
    const day = await assertDayOpen(tx, ctx, data.outletId, data.businessDate, "declared revenue");
    if (day.start.getTime() > Date.now()) throw new ValidationError("Revenue cannot be declared for a future day");
    const sales = await systemSales(tx, ctx, data.outletId, day);
    const declared = new Map(data.declared.map((d) => [d.channel, d]));
    const keys = [...new Set([...sales.channels.keys(), ...declared.keys()])];
    const lines = keys.map((k) => ({
      method: k,
      expected: num(money(sales.channels.get(k)?.billed ?? D(0))),
      // A channel the POS billed but the manager left out is declared as zero, not skipped.
      actual: declared.get(k)?.amount ?? 0,
      note: declared.get(k)?.note,
    }));
    const recon = await saveReconciliationTx(tx, ctx, { outletId: data.outletId, businessDate: day.date, kind: "SALES", lines, notes: data.notes });
    return tx.reconciliation.findUniqueOrThrow({ where: { id: recon.id }, include: { lines: true } });
  });
}

// ---------------------------------------------------------------- bank deposits

const depositSchema = z.object({
  outletId: z.string().min(1),
  businessDate: dateStr,
  method: z.enum(BANK_METHODS).default("CASH"),
  amount: moneyAmount(z.number().positive()),
  depositedAt: z.coerce.date(),
  reference: z.string().trim().min(2, "Enter the slip or transaction reference").max(80),
  bankAccount: z.string().trim().max(60).optional(),
  notes: z.string().max(300).optional(),
}).strict();

const FUTURE_SLACK_MS = 10 * 60_000;

/** Record money that reached the bank for a sales day. Idempotency-Key required. */
export async function recordBankDeposit(ctx: AccessContext, input: z.input<typeof depositSchema>, idempotencyKey: string | undefined, db: Client = prisma) {
  const data = depositSchema.parse(input);
  if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
  authorizeWrite(ctx, data.outletId);
  if (data.depositedAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw new ValidationError("A deposit cannot be dated in the future");
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "bank-deposit", data),
    findPrior: (key) => prisma.bankDeposit.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      const day = await outletBusinessDay(tx, ctx, data.outletId, data.businessDate);
      if (day.start.getTime() > Date.now()) throw new ValidationError("Deposits cannot be recorded for a future sales day");
      if (data.depositedAt < day.start) throw new ValidationError(`The deposit date is before sales day ${day.date}`);
      const row = await tx.bankDeposit.create({
        data: {
          organizationId: ctx.organizationId, outletId: data.outletId, businessDate: day.key, method: data.method, amount: money(data.amount),
          depositedAt: data.depositedAt, reference: data.reference, bankAccount: data.bankAccount, notes: data.notes, createdById: actor(ctx), idempotencyKey: key, requestHash: hash,
        },
      });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "BankDeposit", entityId: row.id, outletId: data.outletId, after: { businessDate: day.date, method: data.method, amount: data.amount, reference: data.reference, depositedAt: data.depositedAt.toISOString() } });
      return row;
    }),
  });
}

/** Void a wrong deposit entry (kept, marked VOIDED, audited). Over HTTP it needs a fresh password. */
export async function voidBankDeposit(ctx: AccessContext, depositId: string, reason: string, db: Client = prisma) {
  const why = z.string().trim().min(3, "Give a reason").max(300).parse(reason);
  return runInTx(db, async (tx) => {
    const d = await tx.bankDeposit.findUnique({ where: { id: depositId } });
    if (!d || d.organizationId !== ctx.organizationId) throw new NotFoundError("Deposit not found");
    authorizeWrite(ctx, d.outletId);
    if (d.status === "VOIDED") throw new ValidationError("This deposit is already void");
    const updated = await tx.bankDeposit.update({ where: { id: depositId }, data: { status: "VOIDED", voidReason: why, voidedById: actor(ctx), voidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "BankDeposit", entityId: depositId, outletId: d.outletId, before: { status: d.status, amount: num(D(d.amount)) }, after: { status: "VOIDED", reason: why } });
    return updated;
  });
}

// ---------------------------------------------------------------- close / reopen

const closeSchema = z.object({ outletId: z.string().min(1), businessDate: dateStr, notes: z.string().max(500).optional() }).strict();

/**
 * Close the day: complete the payments and sales reconciliations (exception
 * lines raise anomalies), freeze the figures as a new DayClose revision,
 * raise a bank-gap anomaly when deposits differ from what was expected, and
 * lock the day. Refused with the reasons while anything blocks it.
 */
export async function closeDay(ctx: AccessContext, input: z.input<typeof closeSchema>, db: Client = prisma) {
  const data = closeSchema.parse(input);
  authorizeWrite(ctx, data.outletId);
  try {
    return await closeDayTx(ctx, data, db);
  } catch (e) {
    // Two closes at once: the unique (outlet, day, revision) lets one through; the other is told so.
    if ((e as { code?: string })?.code === "P2002") throw new ConflictError(`Business day ${data.businessDate} was just closed by someone else`);
    throw e;
  }
}

function closeDayTx(ctx: AccessContext, data: z.infer<typeof closeSchema>, db: Client) {
  return runInTx(db, async (tx) => {
    const { day, close: latest } = await latestDayClose(tx, ctx, data.outletId, data.businessDate);
    if (latest?.status === "CLOSED") throw new ConflictError(`Business day ${day.date} is already closed`);
    let figures = await computeDay(tx, ctx, data.outletId, day.date);
    if (figures.blockers.length) throw new ValidationError(`The day cannot be closed yet: ${figures.blockers.join("; ")}`);
    for (const r of [figures.reconciliations.payments, figures.reconciliations.sales]) {
      if (r && r.status !== "COMPLETED") await completeReconciliationTx(tx, ctx, r.id);
    }
    figures = await computeDay(tx, ctx, data.outletId, day.date);
    const snapshot = snapshotOf(figures);
    const row = await tx.dayClose.create({
      data: { organizationId: ctx.organizationId, outletId: data.outletId, businessDate: day.key, revision: (latest?.revision ?? 0) + 1, status: "CLOSED", snapshot: JSON.stringify(snapshot), notes: data.notes, closedById: actor(ctx) },
    });
    const gap = D(figures.bank.gap);
    if (gap.abs().gt(RECON_RULES.mismatchTolerance)) {
      await raiseAnomaly(tx, ctx, {
        type: "RECONCILIATION_MISMATCH", severity: gap.abs().gt(1000) ? "HIGH" : "MEDIUM", outletId: data.outletId, entityType: "DayClose", entityId: row.id,
        message: `Bank ${day.date}: deposited ₹${figures.bank.deposited} vs expected ₹${figures.bank.expected} (gap ₹${figures.bank.gap})`,
      });
    }
    await writeAudit(tx, ctx, { action: "APPROVE", entityType: "DayClose", entityId: row.id, outletId: data.outletId, after: { businessDate: day.date, revision: row.revision, status: "CLOSED", ...snapshot.bank, billed: snapshot.pos.billed } });
    return { close: row, figures: snapshot };
  });
}

const reopenSchema = z.object({ outletId: z.string().min(1), businessDate: dateStr, reason: z.string().trim().min(5, "Explain why the day is being reopened").max(500) }).strict();

/** Reopen a closed day for a correction: the frozen revision is kept; the reconciliations return to draft. */
export async function reopenDay(ctx: AccessContext, input: z.input<typeof reopenSchema>, db: Client = prisma) {
  const data = reopenSchema.parse(input);
  authorizeWrite(ctx, data.outletId);
  return runInTx(db, async (tx) => {
    const { day, close: latest } = await latestDayClose(tx, ctx, data.outletId, data.businessDate);
    if (latest?.status !== "CLOSED") throw new ConflictError(`Business day ${day.date} is not closed`);
    const updated = await tx.dayClose.update({ where: { id: latest.id }, data: { status: "REOPENED", reopenedById: actor(ctx), reopenedAt: new Date(), reopenReason: data.reason } });
    for (const kind of ["PAYMENTS", "SALES"]) {
      const r = await tx.reconciliation.findUnique({ where: { outletId_businessDate_kind: { outletId: data.outletId, businessDate: day.key, kind } } });
      if (r) await reopenReconciliationTx(tx, ctx, r.id, data.reason);
    }
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "DayClose", entityId: latest.id, outletId: data.outletId, before: { status: "CLOSED", revision: latest.revision }, after: { status: "REOPENED", reason: data.reason } });
    return updated;
  });
}

/** Recent closes for an outlet (the "recent reconciliations" list of the manager workspace, p. 9). */
export async function listDayCloses(db: PrismaClient, ctx: AccessContext, input: { outletId: string; take?: number }) {
  const q = z.object({ outletId: z.string().min(1), take: z.coerce.number().int().min(1).max(60).default(14) }).parse(input);
  authorizeView(ctx, q.outletId);
  const rows = await db.dayClose.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId }, orderBy: [{ businessDate: "desc" }, { revision: "desc" }], take: q.take });
  return rows.map((r) => {
    const s = JSON.parse(r.snapshot) as ReturnType<typeof snapshotOf>;
    return { id: r.id, businessDate: r.businessDate.toISOString().slice(0, 10), revision: r.revision, status: r.status, closedAt: r.closedAt.toISOString(), billed: s.pos.billed, deposited: s.bank.deposited, bankGap: s.bank.gap, reopenReason: r.reopenReason };
  });
}
