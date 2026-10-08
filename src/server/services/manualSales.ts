/**
 * Manual sales log (proposal module 04: "No POS yet? Still fine."). A manager
 * (or the kitchen) enters the dishes sold on a business day outside the POS.
 * It becomes one settled order (source MANUAL) dated to that day, so it:
 *  - counts in revenue, item, category and menu-engineering analytics like any
 *    other settled order (no payment rows: the money is declared at day close);
 *  - depletes stock exactly like a POS bill (recipe explosion, department of
 *    the dish's station, unmapped dishes to the queue), with the ledger rows
 *    back-dated to the sale day;
 *  - is idempotent: the Idempotency-Key is the order's external reference, so a
 *    retried submission returns the original order instead of selling twice.
 * Prices are the outlet's menu prices at entry time (never a client total).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { runInTx } from "@/server/services/_workflow";
import { calculateOrderTotals } from "@/server/services/orders";
import { outletBusinessDay as outletBusinessDayOf, businessDateString } from "@/server/services/businessDay";
import { consumeInventoryForOrder } from "@/server/services/orderConsumption";
import { assertDayOpen } from "@/server/services/dayLock";
import { D, money, num } from "@/domain/money";

const schema = z.object({
  outletId: z.string().min(1),
  businessDate: businessDateString,
  notes: z.string().max(500).optional(),
  lines: z.array(z.object({ menuItemId: z.string().min(1), qty: z.number().positive().max(10_000) })).min(1).max(200),
});

/** Who may log manual sales: order takers, or the kitchen recording dish sales. */
function assertMayLog(ctx: AccessContext, outletId: string) {
  assertOutletAccess(ctx, outletId);
  if (!can(ctx, "order.create", outletId) && !can(ctx, "inventory.produce", outletId)) throw new ForbiddenError("Missing permission to record sales");
}

export async function recordManualSales(ctx: AccessContext, input: z.input<typeof schema>, idempotencyKey?: string, db: PrismaClient = prisma) {
  const data = schema.parse(input);
  assertMayLog(ctx, data.outletId);
  const ids = data.lines.map((l) => l.menuItemId);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Each dish may appear only once; add the quantities together");
  const externalRef = `manual:${idempotencyKey ?? randomUUID()}`;
  try {
    return await recordTx(ctx, data, ids, externalRef, db);
  } catch (e) {
    // The same log sent twice at once: both found no prior order and the loser's insert hit the unique
    // (outlet, MANUAL, externalRef). Running again finds the winner's order and returns it as the replay.
    if (idempotencyKey && (e as { code?: string })?.code === "P2002") return recordTx(ctx, data, ids, externalRef, db);
    throw e;
  }
}

function recordTx(ctx: AccessContext, data: z.infer<typeof schema>, ids: string[], externalRef: string, db: PrismaClient) {
  return runInTx(db, async (tx) => {
    const prior = await tx.order.findUnique({ where: { outletId_source_externalRef: { outletId: data.outletId, source: "MANUAL", externalRef } }, include: { items: true } });
    // A replay of an accepted log returns it even after the day closed; anything new needs an open day.
    const day = prior ? await outletBusinessDayOf(tx, ctx, data.outletId, data.businessDate) : await assertDayOpen(tx, ctx, data.outletId, data.businessDate, "a manual sales log");
    if (day.start.getTime() > Date.now()) throw new ValidationError("Sales cannot be logged for a future day");
    if (prior) {
      if (prior.createdAt < day.start || prior.createdAt >= day.end) throw new ValidationError("Idempotency key was already used for a different day");
      return { order: prior, duplicate: true };
    }
    const items = await tx.menuItem.findMany({
      where: { organizationId: ctx.organizationId, id: { in: ids } },
      select: { id: true, name: true, price: true, taxPct: true, station: true, hsnSac: true, active: true, outletOverrides: { where: { outletId: data.outletId }, select: { price: true, active: true } } },
    });
    if (items.length !== ids.length) throw new NotFoundError("Menu item not found");
    const byId = new Map(items.map((i) => [i.id, i]));
    const priced = data.lines.map((l) => {
      const it = byId.get(l.menuItemId)!;
      if (it.outletOverrides[0]?.active === false) throw new ValidationError(`${it.name} is not offered at this outlet`);
      return { line: l, item: it, unitPrice: D(it.outletOverrides[0]?.price ?? it.price) };
    });
    const totals = calculateOrderTotals(priced.map((p) => ({ qty: p.line.qty, unitPrice: num(p.unitPrice), taxPct: num(D(p.item.taxPct)), modifiersPerUnit: 0 })), 0);
    // Midday of the business day (or now, for today's log entered before noon).
    const at = new Date(Math.min(day.start.getTime() + 12 * 3_600_000, Date.now(), day.end.getTime() - 1));
    const order = await tx.order.create({
      data: {
        organizationId: ctx.organizationId, outletId: data.outletId, channel: "DINE_IN", source: "MANUAL", externalRef,
        status: "PAID", subtotal: totals.subtotal, tax: totals.tax, total: totals.total, discount: money(0),
        notes: data.notes ? `Manual sales log: ${data.notes}` : "Manual sales log", createdById: ctx.userId === "system" ? null : ctx.userId,
        billedAt: at, paidAt: at, createdAt: at,
        items: {
          create: priced.map((p) => ({
            organizationId: ctx.organizationId, outletId: data.outletId, menuItemId: p.item.id, name: p.item.name,
            qty: D(p.line.qty), unitPrice: money(p.unitPrice), taxPct: D(p.item.taxPct), hsnSac: p.item.hsnSac,
            lineTotal: money(D(p.line.qty).times(p.unitPrice)), station: p.item.station, createdAt: at,
          })),
        },
      },
      include: { items: true },
    });
    const consumption = await consumeInventoryForOrder(tx, ctx, order.id, { at });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Order", entityId: order.id, outletId: data.outletId, after: { source: "MANUAL", businessDate: day.date, lines: data.lines.length, total: num(order.total), unmapped: consumption.unmapped.length } });
    return { order, duplicate: false, consumption: { totalCost: consumption.totalCost, unmapped: consumption.unmapped } };
  });
}

/** Manual sales logged for an outlet (most recent first). */
export async function listManualSales(db: PrismaClient, ctx: AccessContext, input: { outletId: string; take?: number }) {
  const q = z.object({ outletId: z.string().min(1), take: z.coerce.number().int().min(1).max(100).default(30) }).parse(input);
  assertMayLog(ctx, q.outletId);
  return db.order.findMany({
    where: { organizationId: ctx.organizationId, outletId: q.outletId, source: "MANUAL" },
    orderBy: { createdAt: "desc" },
    take: q.take,
    select: { id: true, createdAt: true, total: true, notes: true, createdById: true, items: { select: { name: true, qty: true, lineTotal: true } } },
  });
}
