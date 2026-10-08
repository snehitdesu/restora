/**
 * Aggregator control room (group 5; proposal p. 9 "aggregator paid less than
 * expected" and p. 17 section 11: payout reconciliation, commission / penalty /
 * ad-spend as real costs, net margin per aggregator and per dish).
 *
 * No Zomato / Swiggy partner API is connected (partner credentials are needed),
 * so what the platform actually paid enters as its payout STATEMENT: a list of
 * lines (order id, gross, commission, penalty, ad spend, other deductions, net
 * paid) imported by a person, once per statement reference, never edited:
 *
 *  - importAggregatorStatement: all-or-nothing, idempotent by (aggregator,
 *    statement, order id). Re-sending the same lines imports nothing; a line
 *    that differs from what was imported is refused (a statement is a record).
 *    Each line must add up (gross - deductions = net paid).
 *  - reconcileAggregatorStatement: every line against the order RESTORA
 *    received (expected net = gross - discount - commission at the stored % -
 *    platform fee). Verdicts: MATCHED, SHORT_PAID / OVER_PAID with the reasons
 *    (commission, penalty, ad spend, other deductions, gross differs, order
 *    cancelled here), UNKNOWN_ORDER, DUPLICATE_PAYMENT (the same order paid in
 *    another statement), WRONG_OUTLET. Optionally raises ONE anomaly per
 *    statement when money is missing.
 *  - outstandingAggregatorOrders: orders no statement has paid yet, older than
 *    a grace period: what the platform still owes.
 *  - charges (penalty, ad spend, fee, other): real costs outside any order,
 *    idempotent, voided (reason) never deleted.
 *  - aggregatorMargin: per aggregator and per dish, what the channel really
 *    earns after commission, fees and charges and after the food cost frozen at
 *    the sale. Dishes or orders without a recorded cost are counted apart: a
 *    margin is never computed on a guessed cost.
 *
 * Money is Decimal; every query is organization and outlet scoped.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { raiseAnomaly } from "@/server/services/anomaly";
import { D, money, num } from "@/domain/money";

type Dec = Prisma.Decimal;
const m2 = (v: Dec) => num(money(v));
const actor = (ctx: AccessContext) => (ctx.userId === "system" ? null : ctx.userId);
const TOLERANCE = D("0.01");
const MAX_LINES = 2000;

export const CHARGE_KINDS = ["PENALTY", "AD_SPEND", "FEE", "OTHER"] as const;
export type ChargeKind = (typeof CHARGE_KINDS)[number];

function authorizeView(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.view", outletId);
}
function authorizeWrite(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  assertCan(ctx, "finance.reconcile", outletId);
}
async function aggregatorOf(db: Client, ctx: AccessContext, aggregatorId: string) {
  const a = await db.aggregator.findUnique({ where: { id: aggregatorId } });
  if (!a || a.organizationId !== ctx.organizationId) throw new NotFoundError("Aggregator not found");
  return a;
}
async function outletInOrg(db: Client, ctx: AccessContext, outletId: string) {
  const o = await db.outlet.findFirst({ where: { id: outletId, organizationId: ctx.organizationId }, select: { id: true } });
  if (!o) throw new NotFoundError("Outlet not found");
}

// ---------------------------------------------------------------- aggregators

export async function listAggregators(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "finance.view");
  const rows = await db.aggregator.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" } });
  return rows.map((a) => ({ id: a.id, name: a.name, commissionPct: num(D(a.commissionPct)), active: a.active }));
}

const aggregatorSchema = z.object({
  name: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 _-]{0,39}$/, "Letters, digits, space, dash and underscore only"),
  commissionPct: z.number().min(0).max(60),
  active: z.boolean().default(true),
});

/** Create a platform or change its commission %. A new % applies to orders received after the change; stored orders keep theirs. */
export async function saveAggregator(ctx: AccessContext, input: z.input<typeof aggregatorSchema>, db: Client = prisma) {
  assertCan(ctx, "integration.manage");
  const d = aggregatorSchema.parse(input);
  return runInTx(db, async (tx) => {
    const before = await tx.aggregator.findUnique({ where: { organizationId_name: { organizationId: ctx.organizationId, name: d.name } } });
    const row = await tx.aggregator.upsert({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: d.name } },
      create: { organizationId: ctx.organizationId, name: d.name, commissionPct: D(d.commissionPct), active: d.active },
      update: { commissionPct: D(d.commissionPct), active: d.active },
    });
    await writeAudit(tx, ctx, { action: before ? "UPDATE" : "CREATE", entityType: "Aggregator", entityId: row.id, before: before ? { commissionPct: num(D(before.commissionPct)), active: before.active } : undefined, after: { name: d.name, commissionPct: d.commissionPct, active: d.active } });
    return { id: row.id, name: row.name, commissionPct: num(D(row.commissionPct)), active: row.active };
  });
}

// ---------------------------------------------------------------- statements

const money8 = z.number().finite().min(-1e8).max(1e8);
const lineSchema = z.object({
  externalId: z.string().trim().min(1).max(100),
  settledAt: z.coerce.date(),
  grossAmount: money8.min(0),
  commission: money8.min(0).default(0),
  penalty: money8.min(0).default(0),
  adSpend: money8.min(0).default(0),
  otherDeductions: money8.min(0).default(0),
  netPayout: money8,
});
const importSchema = z.object({
  outletId: z.string().min(1),
  aggregatorId: z.string().min(1),
  statementRef: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Letters, digits, dot, dash, slash and underscore only"),
  lines: z.array(lineSchema).min(1, "The statement has no lines").max(MAX_LINES, `At most ${MAX_LINES} lines per statement`),
});

type StatementLine = z.output<typeof lineSchema>;
const sameLine = (row: { settledAt: Date; grossAmount: unknown; commission: unknown; penalty: unknown; adSpend: unknown; otherDeductions: unknown; netPayout: unknown }, l: StatementLine) =>
  row.settledAt.getTime() === l.settledAt.getTime() &&
  D(row.grossAmount as never).eq(money(D(l.grossAmount))) && D(row.commission as never).eq(money(D(l.commission))) && D(row.penalty as never).eq(money(D(l.penalty))) &&
  D(row.adSpend as never).eq(money(D(l.adSpend))) && D(row.otherDeductions as never).eq(money(D(l.otherDeductions))) && D(row.netPayout as never).eq(money(D(l.netPayout)));

/** A statement's lines, checked before anything is stored: unique order ids, each line adds up. */
export function validateStatementLines(lines: StatementLine[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const row = i + 1;
    if (seen.has(l.externalId)) problems.push(`Line ${row}: order ${l.externalId} appears twice`);
    seen.add(l.externalId);
    const expected = D(l.grossAmount).minus(D(l.commission)).minus(D(l.penalty)).minus(D(l.adSpend)).minus(D(l.otherDeductions));
    if (expected.minus(D(l.netPayout)).abs().gt(TOLERANCE)) problems.push(`Line ${row} (${l.externalId}): gross ${m2(D(l.grossAmount)).toFixed(2)} less deductions is ${m2(expected).toFixed(2)}, not the net paid ${m2(D(l.netPayout)).toFixed(2)}`);
  });
  return problems;
}

export async function importAggregatorStatement(ctx: AccessContext, input: z.input<typeof importSchema>, db: Client = prisma): Promise<{ statementRef: string; imported: number; alreadyImported: number; gross: number; netPayout: number }> {
  const d = importSchema.parse(input);
  authorizeWrite(ctx, d.outletId);
  const problems = validateStatementLines(d.lines);
  if (problems.length) throw new ValidationError(`${problems.length} line(s) cannot be imported: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "; …" : ""}`);
  const attempt = () => runInTx(db, async (tx) => {
    await outletInOrg(tx, ctx, d.outletId);
    const agg = await aggregatorOf(tx, ctx, d.aggregatorId);
    const existing = await tx.aggregatorStatementLine.findMany({ where: { organizationId: ctx.organizationId, aggregatorId: agg.id, statementRef: d.statementRef } });
    const byId = new Map(existing.map((e) => [e.externalId, e]));
    if (existing.some((e) => e.outletId !== d.outletId)) throw new ConflictError("This statement reference was imported for another outlet");
    const differs = d.lines.filter((l) => { const e = byId.get(l.externalId); return e && !sameLine(e, l); }).map((l) => l.externalId);
    if (differs.length) throw new ConflictError(`${differs.length} line(s) differ from what statement ${d.statementRef} already holds (${differs.slice(0, 5).join(", ")}); a statement is never edited`);
    const fresh = d.lines.filter((l) => !byId.has(l.externalId));
    if (fresh.length) {
      await tx.aggregatorStatementLine.createMany({
        data: fresh.map((l) => ({
          organizationId: ctx.organizationId, outletId: d.outletId, aggregatorId: agg.id, statementRef: d.statementRef, externalId: l.externalId, settledAt: l.settledAt,
          grossAmount: money(D(l.grossAmount)), commission: money(D(l.commission)), penalty: money(D(l.penalty)), adSpend: money(D(l.adSpend)), otherDeductions: money(D(l.otherDeductions)), netPayout: money(D(l.netPayout)), importedById: actor(ctx),
        })),
      });
    }
    const gross = d.lines.reduce((a, l) => a.plus(D(l.grossAmount)), D(0));
    const net = d.lines.reduce((a, l) => a.plus(D(l.netPayout)), D(0));
    if (fresh.length) await writeAudit(tx, ctx, { action: "IMPORT", entityType: "AggregatorStatement", entityId: `${agg.id}:${d.statementRef}`, outletId: d.outletId, after: { aggregator: agg.name, statementRef: d.statementRef, lines: fresh.length, gross: m2(gross), netPayout: m2(net) } });
    return { statementRef: d.statementRef, imported: fresh.length, alreadyImported: d.lines.length - fresh.length, gross: m2(gross), netPayout: m2(net) };
  });
  try {
    return await attempt();
  } catch (e) {
    // Two imports of the same statement at once: the loser re-reads and finds the lines already there.
    if ((e as { code?: string })?.code === "P2002") return attempt();
    throw e;
  }
}

export async function listAggregatorStatements(db: PrismaClient, ctx: AccessContext, input: { outletId: string; aggregatorId?: string }) {
  authorizeView(ctx, input.outletId);
  await outletInOrg(db, ctx, input.outletId);
  const rows = await db.aggregatorStatementLine.groupBy({
    by: ["aggregatorId", "statementRef"],
    where: { organizationId: ctx.organizationId, outletId: input.outletId, ...(input.aggregatorId ? { aggregatorId: input.aggregatorId } : {}) },
    _count: { _all: true }, _sum: { grossAmount: true, commission: true, penalty: true, adSpend: true, otherDeductions: true, netPayout: true }, _max: { settledAt: true, importedAt: true },
  });
  const aggs = new Map((await db.aggregator.findMany({ where: { organizationId: ctx.organizationId } })).map((a) => [a.id, a.name]));
  return rows
    .map((r) => ({ aggregatorId: r.aggregatorId, aggregator: aggs.get(r.aggregatorId) ?? "Platform", statementRef: r.statementRef, lines: r._count._all, gross: m2(D(r._sum.grossAmount ?? 0)), commission: m2(D(r._sum.commission ?? 0)), penalty: m2(D(r._sum.penalty ?? 0)), adSpend: m2(D(r._sum.adSpend ?? 0)), otherDeductions: m2(D(r._sum.otherDeductions ?? 0)), netPayout: m2(D(r._sum.netPayout ?? 0)), lastSettledAt: r._max.settledAt?.toISOString() ?? null, importedAt: r._max.importedAt?.toISOString() ?? null }))
    .sort((a, b) => (b.lastSettledAt ?? "").localeCompare(a.lastSettledAt ?? "") || a.statementRef.localeCompare(b.statementRef));
}

// ---------------------------------------------------------------- reconciliation

export type StatementVerdict = "MATCHED" | "SHORT_PAID" | "OVER_PAID" | "UNKNOWN_ORDER" | "DUPLICATE_PAYMENT" | "WRONG_OUTLET";
export type StatementReason = "COMMISSION_DIFFERS" | "PENALTY" | "AD_SPEND" | "OTHER_DEDUCTION" | "GROSS_DIFFERS" | "ORDER_CANCELLED_HERE";
export type StatementCheckRow = {
  externalId: string; verdict: StatementVerdict; reasons: StatementReason[];
  expectedNet: number | null; paidNet: number; difference: number | null; commissionDifference: number | null; penalty: number; adSpend: number; otherDeductions: number; paidInStatements: string[];
};

const refSchema = z.object({ outletId: z.string().min(1), aggregatorId: z.string().min(1), statementRef: z.string().trim().min(1).max(60) });

/** Every line of a statement against the order RESTORA received. Read-only; deterministic. */
export async function reconcileAggregatorStatement(db: PrismaClient, ctx: AccessContext, input: z.input<typeof refSchema>) {
  const f = refSchema.parse(input);
  authorizeView(ctx, f.outletId);
  const agg = await aggregatorOf(db, ctx, f.aggregatorId);
  const lines = await db.aggregatorStatementLine.findMany({ where: { organizationId: ctx.organizationId, aggregatorId: agg.id, statementRef: f.statementRef }, orderBy: [{ externalId: "asc" }] });
  if (!lines.length) throw new NotFoundError("Statement not found");
  if (lines.some((l) => l.outletId !== f.outletId)) throw new NotFoundError("Statement not found");
  const ids = lines.map((l) => l.externalId);
  const [orders, others] = await Promise.all([
    db.aggregatorOrder.findMany({ where: { organizationId: ctx.organizationId, aggregatorId: agg.id, externalId: { in: ids } } }),
    db.aggregatorStatementLine.findMany({ where: { organizationId: ctx.organizationId, aggregatorId: agg.id, externalId: { in: ids }, statementRef: { not: f.statementRef } }, select: { externalId: true, statementRef: true } }),
  ]);
  const localOrders = orders.some((o) => o.orderId) ? await db.order.findMany({ where: { id: { in: orders.map((o) => o.orderId).filter((x): x is string => Boolean(x)) } }, select: { id: true, status: true } }) : [];
  const status = new Map(localOrders.map((o) => [o.id, o.status]));
  const byOrder = new Map(orders.map((o) => [o.externalId, o]));
  const paidElsewhere = new Map<string, string[]>();
  for (const o of others) paidElsewhere.set(o.externalId, [...(paidElsewhere.get(o.externalId) ?? []), o.statementRef].sort());

  const rows: StatementCheckRow[] = lines.map((l) => {
    const o = byOrder.get(l.externalId);
    const paid = D(l.netPayout);
    const base = { externalId: l.externalId, paidNet: m2(paid), penalty: m2(D(l.penalty)), adSpend: m2(D(l.adSpend)), otherDeductions: m2(D(l.otherDeductions)), paidInStatements: paidElsewhere.get(l.externalId) ?? [] };
    if (!o) return { ...base, verdict: "UNKNOWN_ORDER" as const, reasons: [], expectedNet: null, difference: null, commissionDifference: null };
    if (o.outletId !== f.outletId) return { ...base, verdict: "WRONG_OUTLET" as const, reasons: [], expectedNet: m2(D(o.netPayout)), difference: null, commissionDifference: null };
    const expected = D(o.netPayout);
    const diff = paid.minus(expected);
    const commissionDiff = D(l.commission).minus(D(o.commission));
    const reasons: StatementReason[] = [];
    const cancelled = o.orderId ? ["CANCELLED", "REFUNDED"].includes(status.get(o.orderId) ?? "") : false;
    if (cancelled) reasons.push("ORDER_CANCELLED_HERE");
    if (!commissionDiff.abs().lte(TOLERANCE)) reasons.push("COMMISSION_DIFFERS");
    if (D(l.penalty).gt(0)) reasons.push("PENALTY");
    if (D(l.adSpend).gt(0)) reasons.push("AD_SPEND");
    if (D(l.otherDeductions).minus(D(o.platformFee)).gt(TOLERANCE)) reasons.push("OTHER_DEDUCTION");
    if (!D(l.grossAmount).minus(D(o.grossAmount).minus(D(o.discount))).abs().lte(TOLERANCE)) reasons.push("GROSS_DIFFERS");
    const dup = (paidElsewhere.get(l.externalId) ?? []).length > 0;
    const verdict: StatementVerdict = dup ? "DUPLICATE_PAYMENT" : diff.abs().lte(TOLERANCE) ? "MATCHED" : diff.lt(0) ? "SHORT_PAID" : "OVER_PAID";
    return { ...base, verdict, reasons: verdict === "MATCHED" ? [] : reasons, expectedNet: m2(expected), difference: m2(diff), commissionDifference: m2(commissionDiff) };
  });

  const sum = (pick: (r: StatementCheckRow) => number) => rows.reduce((a, r) => a.plus(D(pick(r))), D(0));
  const known = rows.filter((r) => r.expectedNet !== null);
  const shortPaid = rows.filter((r) => r.verdict === "SHORT_PAID");
  const summary = {
    lines: rows.length,
    counts: Object.fromEntries((["MATCHED", "SHORT_PAID", "OVER_PAID", "UNKNOWN_ORDER", "DUPLICATE_PAYMENT", "WRONG_OUTLET"] as const).map((v) => [v, rows.filter((r) => r.verdict === v).length])) as Record<StatementVerdict, number>,
    expectedNet: m2(known.reduce((a, r) => a.plus(D(r.expectedNet!)), D(0))),
    paidNet: m2(sum((r) => r.paidNet)),
    // What the platform paid LESS than RESTORA expected, line by line (never netted against an overpayment elsewhere),
    // how much of it is commission charged above the stored %, and what it paid MORE (for example for an order cancelled here).
    shortfall: m2(shortPaid.reduce((a, r) => a.plus(D(r.expectedNet!)).minus(D(r.paidNet)), D(0))),
    shortfallFromCommission: m2(shortPaid.reduce((a, r) => a.plus(D(r.commissionDifference ?? 0).gt(0) ? D(r.commissionDifference ?? 0) : D(0)), D(0))),
    overpaid: m2(rows.filter((r) => r.verdict === "OVER_PAID").reduce((a, r) => a.plus(D(r.difference ?? 0)), D(0))),
    penalties: m2(sum((r) => r.penalty)),
    adSpend: m2(sum((r) => r.adSpend)),
    paidForUnknownOrders: m2(rows.filter((r) => r.verdict === "UNKNOWN_ORDER").reduce((a, r) => a.plus(D(r.paidNet)), D(0))),
  };
  return { aggregatorId: agg.id, aggregator: agg.name, statementRef: f.statementRef, outletId: f.outletId, summary, rows };
}

/** Review a statement and, when money is missing or paid twice, raise ONE anomaly for it (repeat reviews raise nothing more). */
export async function reviewAggregatorStatement(ctx: AccessContext, input: z.input<typeof refSchema>, db: PrismaClient = prisma) {
  const f = refSchema.parse(input);
  authorizeWrite(ctx, f.outletId);
  const result = await reconcileAggregatorStatement(db, ctx, f);
  const s = result.summary;
  const problems = s.counts.SHORT_PAID + s.counts.OVER_PAID + s.counts.UNKNOWN_ORDER + s.counts.DUPLICATE_PAYMENT + s.counts.WRONG_OUTLET;
  let anomalyRaised = false;
  if (problems > 0) {
    anomalyRaised = await runInTx(db, async (tx) => {
      const r = await raiseAnomaly(tx, ctx, {
        type: "RECONCILIATION_MISMATCH", severity: s.shortfall > 0 || s.counts.DUPLICATE_PAYMENT > 0 ? "HIGH" : "MEDIUM", outletId: f.outletId,
        entityType: "AggregatorStatement", entityId: `${result.aggregatorId}:${f.statementRef}`,
        message: `${result.aggregator} statement ${f.statementRef}: ${problems} of ${s.lines} lines differ from the orders (paid ${s.paidNet.toFixed(2)}, expected ${s.expectedNet.toFixed(2)}, shortfall ${s.shortfall.toFixed(2)})`,
        recurrence: "ONCE",
      });
      return r.created;
    });
  }
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "UPDATE", entityType: "AggregatorStatement", entityId: `${result.aggregatorId}:${f.statementRef}`, outletId: f.outletId, after: { reviewed: true, counts: s.counts, shortfall: s.shortfall, anomalyRaised } }));
  return { ...result, anomalyRaised };
}

const outstandingSchema = z.object({ outletId: z.string().min(1), aggregatorId: z.string().min(1), graceDays: z.coerce.number().int().min(0).max(60).default(7) });

/** Orders no statement has paid, older than the grace period: what the platform still owes. */
export async function outstandingAggregatorOrders(db: PrismaClient, ctx: AccessContext, input: z.input<typeof outstandingSchema>, now = new Date()) {
  const f = outstandingSchema.parse(input);
  authorizeView(ctx, f.outletId);
  await outletInOrg(db, ctx, f.outletId);
  const agg = await aggregatorOf(db, ctx, f.aggregatorId);
  const before = new Date(now.getTime() - f.graceDays * 86400_000);
  const orders = await db.aggregatorOrder.findMany({ where: { organizationId: ctx.organizationId, outletId: f.outletId, aggregatorId: agg.id, placedAt: { lte: before }, netPayout: { gt: 0 } }, orderBy: [{ placedAt: "asc" }, { externalId: "asc" }], take: 2000 });
  const paid = new Set((await db.aggregatorStatementLine.findMany({ where: { organizationId: ctx.organizationId, aggregatorId: agg.id, externalId: { in: orders.map((o) => o.externalId) } }, select: { externalId: true } })).map((l) => l.externalId));
  const owed = orders.filter((o) => !paid.has(o.externalId));
  return { aggregator: agg.name, graceDays: f.graceDays, count: owed.length, owed: m2(owed.reduce((a, o) => a.plus(D(o.netPayout)), D(0))), orders: owed.map((o) => ({ externalId: o.externalId, placedAt: o.placedAt.toISOString(), expectedNet: m2(D(o.netPayout)) })) };
}

// ---------------------------------------------------------------- charges

const chargeSchema = z.object({
  outletId: z.string().min(1),
  aggregatorId: z.string().min(1),
  kind: z.enum(CHARGE_KINDS),
  amount: z.number().positive().max(1e8),
  chargedOn: z.coerce.date(),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
});

export async function createAggregatorCharge(ctx: AccessContext, input: z.input<typeof chargeSchema>, idempotencyKey: string | undefined, db: Client = prisma) {
  const d = chargeSchema.parse(input);
  if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
  authorizeWrite(ctx, d.outletId);
  if (d.chargedOn.getTime() > Date.now() + 36 * 3600_000) throw new ValidationError("A charge cannot be dated in the future");
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "aggregator-charge", d),
    findPrior: (key) => prisma.aggregatorCharge.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } }),
    create: (key, hash) => runInTx(db, async (tx) => {
      await outletInOrg(tx, ctx, d.outletId);
      const agg = await aggregatorOf(tx, ctx, d.aggregatorId);
      const row = await tx.aggregatorCharge.create({ data: { organizationId: ctx.organizationId, outletId: d.outletId, aggregatorId: agg.id, kind: d.kind, amount: money(D(d.amount)), chargedOn: d.chargedOn, reference: d.reference, notes: d.notes, createdById: actor(ctx), idempotencyKey: key, requestHash: hash } });
      await writeAudit(tx, ctx, { action: "CREATE", entityType: "AggregatorCharge", entityId: row.id, outletId: d.outletId, after: { aggregator: agg.name, kind: d.kind, amount: d.amount, chargedOn: d.chargedOn.toISOString(), reference: d.reference } });
      return row;
    }),
  });
}

export async function voidAggregatorCharge(ctx: AccessContext, chargeId: string, reason: string, db: Client = prisma) {
  const why = z.string().trim().min(3, "Give a reason").max(300).parse(reason);
  return runInTx(db, async (tx) => {
    const c = await tx.aggregatorCharge.findUnique({ where: { id: chargeId } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Charge not found");
    authorizeWrite(ctx, c.outletId);
    if (c.voidedAt) throw new ValidationError("This charge is already void");
    const updated = await tx.aggregatorCharge.update({ where: { id: chargeId }, data: { voidedAt: new Date(), voidedById: actor(ctx), voidReason: why } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "AggregatorCharge", entityId: chargeId, outletId: c.outletId, before: { kind: c.kind, amount: num(D(c.amount)) }, after: { reason: why } });
    return updated;
  });
}

export async function listAggregatorCharges(db: PrismaClient, ctx: AccessContext, input: { outletId: string; aggregatorId?: string; from?: Date; to?: Date; includeVoided?: boolean }) {
  authorizeView(ctx, input.outletId);
  await outletInOrg(db, ctx, input.outletId);
  const rows = await db.aggregatorCharge.findMany({
    where: { organizationId: ctx.organizationId, outletId: input.outletId, ...(input.aggregatorId ? { aggregatorId: input.aggregatorId } : {}), ...(input.includeVoided ? {} : { voidedAt: null }), ...(input.from || input.to ? { chargedOn: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) },
    orderBy: [{ chargedOn: "desc" }, { id: "desc" }], take: 500,
  });
  return rows.map((c) => ({ id: c.id, aggregatorId: c.aggregatorId, kind: c.kind, amount: num(D(c.amount)), chargedOn: c.chargedOn.toISOString(), reference: c.reference, notes: c.notes, voided: Boolean(c.voidedAt), voidReason: c.voidReason, createdAt: c.createdAt.toISOString() }));
}

// ---------------------------------------------------------------- margin

const marginSchema = z.object({ outletId: z.string().min(1), from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.from <= r.to, { message: "`from` must be on or before `to`", path: ["from"] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= 366 * 86400_000, { message: "At most one year", path: ["to"] });

/**
 * What each platform really earns, and each dish on it. Per aggregator: orders
 * received in the period (cancelled / refunded orders counted apart, never as
 * revenue), gross, discounts, commission, platform fees, expected net, charges
 * (penalty, ad spend, fee, other), food cost from the cost frozen on the order
 * lines, and the contribution. Per dish: ex-tax revenue, the commission and fees
 * its share of the order's gross carries, its food cost, and what is left.
 */
export async function aggregatorMargin(db: PrismaClient, ctx: AccessContext, input: z.input<typeof marginSchema>) {
  const f = marginSchema.parse(input);
  authorizeView(ctx, f.outletId);
  assertCan(ctx, "reports.view", f.outletId); // food cost is shown
  await outletInOrg(db, ctx, f.outletId);
  const [links, charges, aggs] = await Promise.all([
    db.aggregatorOrder.findMany({ where: { organizationId: ctx.organizationId, outletId: f.outletId, placedAt: { gte: f.from, lte: f.to } } }),
    db.aggregatorCharge.findMany({ where: { organizationId: ctx.organizationId, outletId: f.outletId, chargedOn: { gte: f.from, lte: f.to }, voidedAt: null } }),
    db.aggregator.findMany({ where: { organizationId: ctx.organizationId } }),
  ]);
  const orderIds = links.map((l) => l.orderId).filter((x): x is string => Boolean(x));
  const orders = orderIds.length ? await db.order.findMany({ where: { id: { in: orderIds }, organizationId: ctx.organizationId }, select: { id: true, status: true, items: { select: { menuItemId: true, name: true, qty: true, lineTotal: true, lineCost: true } } } }) : [];
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const byAgg = new Map(aggs.map((a) => [a.id, a]));

  type Acc = { orders: number; cancelled: number; gross: Dec; discount: Dec; commission: Dec; fees: Dec; net: Dec; revenue: Dec; cost: Dec; costedLines: number; lines: number };
  const blank = (): Acc => ({ orders: 0, cancelled: 0, gross: D(0), discount: D(0), commission: D(0), fees: D(0), net: D(0), revenue: D(0), cost: D(0), costedLines: 0, lines: 0 });
  const perAgg = new Map<string, Acc>();
  const perDish = new Map<string, { aggregatorId: string; menuItemId: string | null; name: string; qty: Dec; revenue: Dec; deductions: Dec; cost: Dec; costedQty: Dec }>();

  for (const l of links) {
    const a = perAgg.get(l.aggregatorId) ?? perAgg.set(l.aggregatorId, blank()).get(l.aggregatorId)!;
    const o = l.orderId ? orderById.get(l.orderId) : undefined;
    if (o && ["CANCELLED", "REFUNDED"].includes(o.status)) { a.cancelled++; continue; }
    a.orders++;
    a.gross = a.gross.plus(D(l.grossAmount)); a.discount = a.discount.plus(D(l.discount)); a.commission = a.commission.plus(D(l.commission)); a.fees = a.fees.plus(D(l.platformFee)); a.net = a.net.plus(D(l.netPayout));
    if (!o) continue;
    const orderGross = o.items.reduce((s, i) => s.plus(D(i.lineTotal)), D(0));
    for (const i of o.items) {
      a.lines++; a.revenue = a.revenue.plus(D(i.lineTotal));
      if (i.lineCost !== null) { a.costedLines++; a.cost = a.cost.plus(D(i.lineCost)); }
      const key = `${l.aggregatorId}|${i.menuItemId ?? `name:${i.name}`}`;
      const d = perDish.get(key) ?? perDish.set(key, { aggregatorId: l.aggregatorId, menuItemId: i.menuItemId, name: i.name, qty: D(0), revenue: D(0), deductions: D(0), cost: D(0), costedQty: D(0) }).get(key)!;
      d.qty = d.qty.plus(D(i.qty)); d.revenue = d.revenue.plus(D(i.lineTotal));
      // Commission, fees and discounts follow the dish's share of the order's item total.
      const share = orderGross.gt(0) ? D(i.lineTotal).div(orderGross) : D(0);
      d.deductions = d.deductions.plus(share.times(D(l.commission).plus(D(l.platformFee))));
      if (i.lineCost !== null) { d.cost = d.cost.plus(D(i.lineCost)); d.costedQty = d.costedQty.plus(D(i.qty)); }
    }
  }

  const chargesBy = new Map<string, Record<ChargeKind, Dec>>();
  for (const c of charges) {
    const r = chargesBy.get(c.aggregatorId) ?? chargesBy.set(c.aggregatorId, { PENALTY: D(0), AD_SPEND: D(0), FEE: D(0), OTHER: D(0) }).get(c.aggregatorId)!;
    const k = (CHARGE_KINDS as readonly string[]).includes(c.kind) ? (c.kind as ChargeKind) : "OTHER";
    r[k] = r[k].plus(D(c.amount));
  }
  const aggIds = [...new Set([...perAgg.keys(), ...chargesBy.keys()])];
  const aggregators = aggIds.map((id) => {
    const a = perAgg.get(id) ?? blank();
    const ch = chargesBy.get(id) ?? { PENALTY: D(0), AD_SPEND: D(0), FEE: D(0), OTHER: D(0) };
    const chargeTotal = Object.values(ch).reduce((s, v) => s.plus(v), D(0));
    const fullyCosted = a.lines > 0 && a.costedLines === a.lines;
    const afterDiscount = a.gross.minus(a.discount);
    const contribution = fullyCosted ? a.net.minus(a.cost).minus(chargeTotal) : null;
    return {
      aggregatorId: id, aggregator: byAgg.get(id)?.name ?? "Platform", commissionPct: num(D(byAgg.get(id)?.commissionPct ?? 0)),
      orders: a.orders, cancelled: a.cancelled, grossSales: m2(a.gross), discounts: m2(a.discount), commission: m2(a.commission), platformFees: m2(a.fees),
      effectiveCutPct: afterDiscount.gt(0) ? m2(a.commission.plus(a.fees).div(afterDiscount).times(100)) : null,
      expectedNet: m2(a.net),
      charges: { penalty: m2(ch.PENALTY), adSpend: m2(ch.AD_SPEND), fee: m2(ch.FEE), other: m2(ch.OTHER), total: m2(chargeTotal) },
      netAfterCharges: m2(a.net.minus(chargeTotal)),
      foodCost: fullyCosted ? m2(a.cost) : null,
      costCoveragePct: a.lines ? m2(D(a.costedLines).div(a.lines).times(100)) : null,
      contribution: contribution ? m2(contribution) : null,
      contributionPct: contribution && a.gross.gt(0) ? m2(contribution.div(a.gross).times(100)) : null,
    };
  }).sort((x, y) => y.grossSales - x.grossSales || x.aggregator.localeCompare(y.aggregator));

  const dishes = [...perDish.values()].map((d) => {
    const costed = d.costedQty.eq(d.qty) && d.qty.gt(0);
    const margin = costed ? d.revenue.minus(d.deductions).minus(d.cost) : null;
    return {
      aggregatorId: d.aggregatorId, aggregator: byAgg.get(d.aggregatorId)?.name ?? "Platform", menuItemId: d.menuItemId, name: d.name, qty: num(d.qty),
      revenue: m2(d.revenue), platformCut: m2(d.deductions), foodCost: costed ? m2(d.cost) : null, margin: margin ? m2(margin) : null,
      marginPct: margin && d.revenue.gt(0) ? m2(margin.div(d.revenue).times(100)) : null,
    };
  }).sort((x, y) => (y.margin ?? -Infinity) - (x.margin ?? -Infinity) || x.name.localeCompare(y.name));

  return {
    outletId: f.outletId, from: f.from.toISOString(), to: f.to.toISOString(), aggregators, dishes,
    basis: "Gross = the platform's billed item total. Cut = commission at the stored % plus platform fees (shared over the order's dishes by their item total). Charges (penalty, ad spend, fee, other) are real costs outside any order. Food cost is the cost frozen on each order line at the sale; a platform or dish with any line lacking a recorded cost shows no contribution rather than a guess. Cancelled and refunded orders are counted apart and earn nothing.",
  };
}
