/**
 * Floor operations on a running order (audit MB-03): move it to another table, merge two orders into one bill, split one
 * bill into several. All three are changes to existing orders, so they run SERIALIZABLE and queued per order like every
 * other edit, and all three are audited on every order they touch.
 *
 * What never changes: the money. Nothing here creates, moves or refunds a payment, so an order that already holds a
 * payment (or a payment still waiting for the provider) cannot be merged away or split ("settle or refund first"), and an
 * applied coupon is released explicitly by staff before the bill is reshaped. Totals are always recomputed by the one
 * pricing function (recomputeTotals); an order-level discount is shared between the two bills of a split in proportion to
 * their value, to the paisa.
 *
 * The kitchen is never asked to cook anything twice: lines keep the tickets they were fired on. A ticket that carries
 * lines of both bills of a split is divided into two tickets in the same state (same station, same stamps), so every order
 * still lists exactly its own lines on its own tickets.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { runInTx } from "@/server/services/_workflow";
import { type AccessContext, assertOutletAccess, ValidationError, NotFoundError, ConflictError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, money } from "@/domain/money";
import { calculateOrderTotals, recomputeTotals, releaseTableTx, getOrder } from "@/server/services/orders";
import { nextKotNumber } from "@/server/services/kot";
import { assertNoTableConflict, lockSlots, releaseSlots } from "@/server/services/reservations";
import { requestHashOf } from "@/server/services/idempotency";

type Tx = Prisma.TransactionClient;
type Client = PrismaClient | Tx;

const CLOSED = ["PAID", "CANCELLED", "REFUNDED"];
/** Order statuses in the order the kitchen moves through them (the more advanced one wins when two orders become one). */
const KITCHEN_RANK = ["OPEN", "SENT", "PREPARING", "READY", "SERVED"];
const ref = (id: string) => id.slice(-6).toUpperCase();
const actor = (ctx: AccessContext) => (ctx.userId === "system" ? null : ctx.userId);
const orderTx = <T>(db: Client, orderId: string, fn: (tx: Tx) => Promise<T>) => runInTx(db, fn, { lockKey: `order:${orderId}` });

/** A running order the caller may change. */
async function loadRunning(tx: Tx, ctx: AccessContext, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { table: { select: { id: true, code: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  assertCan(ctx, "order.modify", order.outletId);
  if (CLOSED.includes(order.status)) throw new ValidationError(`The order is ${order.status.toLowerCase()}`);
  return order;
}

/** Money already on the bill (paid, part-paid or waiting for the provider) stays where it is: the bill is not reshaped. */
async function assertNoPayments(tx: Tx, orderId: string, what: string) {
  const n = await tx.payment.count({ where: { orderId, status: { in: ["PENDING", "SUCCESS", "PARTIAL"] } } });
  if (n > 0) throw new ValidationError(`${what}: this bill already has a payment on it; settle or refund it first`);
}

async function assertNoCoupon(tx: Tx, orderId: string, what: string) {
  const c = await tx.couponRedemption.findFirst({ where: { orderId, status: "APPLIED" }, include: { coupon: { select: { code: true } } } });
  if (c) throw new ValidationError(`${what}: coupon ${c.coupon.code} is applied to this bill; remove the coupon first`);
}

const full = (db: Client, ctx: AccessContext, orderId: string) => getOrder(db as PrismaClient, ctx, orderId);

// ------------------------------------------------------------------ move to another table

const transferSchema = z.object({ tableId: z.string().min(1) });

/**
 * Move a running order (and the guests with it) to another free table of the same outlet. The kitchen tickets follow
 * because they belong to the order. The old table is released, the new one shows the order's state (occupied, or bill
 * requested), and a party seated from a reservation takes the reservation with it.
 */
export async function transferOrderTable(ctx: AccessContext, orderId: string, input: z.input<typeof transferSchema>, db: Client = prisma) {
  const { tableId } = transferSchema.parse(input);
  const result = await orderTx(db, orderId, async (tx) => {
    const order = await loadRunning(tx, ctx, orderId);
    if (!order.tableId) throw new ValidationError("This order is not at a table");
    if (order.tableId === tableId) return { unchanged: true, fromTable: order.table!.code, toTable: order.table!.code };
    const target = await tx.restaurantTable.findUnique({ where: { id: tableId } });
    if (!target || target.organizationId !== ctx.organizationId || target.outletId !== order.outletId) throw new ValidationError("Table not in this outlet");
    if (target.status === "CLEANING") throw new ValidationError(`Table ${target.code} is being cleaned`);
    const busy = await tx.order.count({ where: { tableId, status: { notIn: CLOSED } } });
    if (busy) throw new ValidationError(`Table ${target.code} already has a running order; merge the orders instead`);

    // A party seated from a reservation moves with the order (only when it is the only party at the old table).
    const othersAtOld = await tx.order.count({ where: { tableId: order.tableId, id: { not: orderId }, status: { notIn: CLOSED } } });
    const seated = othersAtOld === 0 ? await tx.reservation.findMany({ where: { organizationId: ctx.organizationId, tableId: order.tableId, status: "SEATED" } }) : [];
    const moving = seated.length === 1 ? seated[0] : null;
    await assertNoTableConflict(tx, ctx, tableId, new Date(), moving?.id);

    await tx.order.update({ where: { id: orderId }, data: { tableId } });
    await releaseTableTx(tx, order.tableId, orderId);
    await tx.restaurantTable.update({ where: { id: tableId }, data: { status: order.status === "BILLED" ? "BILL_REQUESTED" : "OCCUPIED" } });
    if (moving) {
      await releaseSlots(tx, moving.id);
      await lockSlots(tx, ctx, tableId, moving.id, moving.reservedAt);
      await tx.reservation.update({ where: { id: moving.id }, data: { tableId } });
      await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Reservation", entityId: moving.id, outletId: order.outletId, before: { tableId: order.tableId }, after: { tableId, via: "order moved" } });
    }
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: order.outletId, before: { tableId: order.tableId, table: order.table!.code }, after: { tableId, table: target.code, transfer: true } });
    return { unchanged: false, fromTable: order.table!.code, toTable: target.code };
  });
  return { ...result, order: await full(db, ctx, orderId) };
}

// ------------------------------------------------------------------ merge

const mergeSchema = z.object({ fromOrderId: z.string().min(1) });

/**
 * Fold `fromOrderId` into `targetOrderId`: its lines and kitchen tickets move over, the target's bill is repriced, the
 * emptied order is closed (CANCELLED, with a note saying where it went) and its table is freed. Neither order may be billed
 * yet, and the order being folded away may not hold a payment, a coupon or a manual discount (they would silently
 * disappear). Asking again after it worked returns the merged order.
 */
export async function mergeOrders(ctx: AccessContext, targetOrderId: string, input: z.input<typeof mergeSchema>, db: Client = prisma) {
  const { fromOrderId } = mergeSchema.parse(input);
  if (fromOrderId === targetOrderId) throw new ValidationError("Choose a different order to merge in");
  const outcome = await orderTx(db, targetOrderId, async (tx) => {
    const source = await tx.order.findUnique({ where: { id: fromOrderId }, select: { id: true, organizationId: true, outletId: true, status: true } });
    if (source && source.organizationId === ctx.organizationId && source.status === "CANCELLED") {
      const done = await tx.auditLog.findFirst({ where: { organizationId: ctx.organizationId, entityType: "Order", entityId: fromOrderId, after: { contains: `"mergedInto":"${targetOrderId}"` } }, select: { id: true } });
      if (done) return { replayed: true };
    }
    const target = await loadRunning(tx, ctx, targetOrderId);
    const from = await loadRunning(tx, ctx, fromOrderId);
    if (from.outletId !== target.outletId) throw new ValidationError("The orders belong to different outlets");
    for (const o of [target, from]) if (o.status === "BILLED") throw new ValidationError(`Order #${ref(o.id)} already has its bill requested; merge before the bill is asked for`);
    await assertNoPayments(tx, from.id, `Cannot merge order #${ref(from.id)}`);
    await assertNoCoupon(tx, from.id, `Cannot merge order #${ref(from.id)}`);
    if (D(from.discount).gt(0)) throw new ValidationError(`Cannot merge order #${ref(from.id)}: it carries a discount of ${money(from.discount).toFixed(2)}; remove it first`);

    const lines = await tx.orderItem.updateMany({ where: { orderId: from.id }, data: { orderId: target.id } });
    const tickets = await tx.kot.updateMany({ where: { orderId: from.id }, data: { orderId: target.id } });
    const rank = Math.max(KITCHEN_RANK.indexOf(target.status), KITCHEN_RANK.indexOf(from.status));
    await tx.order.update({
      where: { id: target.id },
      data: {
        status: KITCHEN_RANK[Math.max(rank, 0)],
        covers: target.covers + from.covers,
        customerId: target.customerId ?? from.customerId,
        notes: [target.notes, from.notes].filter(Boolean).join(" · ") || null,
      },
    });
    await recomputeTotals(tx, target.id);
    await recomputeTotals(tx, from.id);
    await tx.order.update({ where: { id: from.id }, data: { status: "CANCELLED", notes: `Merged into order #${ref(target.id)}` } });
    if (from.tableId && from.tableId !== target.tableId) await releaseTableTx(tx, from.tableId, from.id);
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: from.id, outletId: from.outletId, before: { status: from.status, tableId: from.tableId }, after: { status: "CANCELLED", mergedInto: target.id, lines: lines.count, tickets: tickets.count } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: target.id, outletId: target.outletId, before: { status: target.status, covers: target.covers }, after: { merged: from.id, lines: lines.count, tickets: tickets.count } });
    return { replayed: false, lines: lines.count };
  });
  return { ...outcome, order: await full(db, ctx, targetOrderId) };
}

// ------------------------------------------------------------------ split

const splitSchema = z.object({
  /** Lines (or part of a line: `qty` smaller than the line's) that go to the new bill. */
  lines: z.array(z.object({ orderItemId: z.string().min(1), qty: z.number().positive().max(100000).optional() }).strict()).min(1).max(100),
  /** Guests at the new bill (the original bill keeps the rest; never below 1). */
  covers: z.number().int().positive().max(100).optional(),
});
export type SplitInput = z.input<typeof splitSchema>;

/**
 * Take some lines off a bill onto a new bill at the same table (a separate tax invoice when it is paid). `qty` smaller than
 * the line's moves part of the line (2 of 3 dosas). Lines keep their kitchen tickets (see the file header). The order-level
 * discount is shared by value. Needs an Idempotency-Key to be safe to retry: the same key and request returns the new bill.
 */
export async function splitOrder(ctx: AccessContext, orderId: string, input: SplitInput, idempotencyKey?: string, db: Client = prisma) {
  const data = splitSchema.parse(input);
  const hash = requestHashOf(ctx, "order-split", { orderId, lines: [...data.lines].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)), covers: data.covers ?? null });
  const key = idempotencyKey ? `split:${idempotencyKey}` : undefined;
  const replay = async () => {
    if (!key) return null;
    const prior = await db.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
    if (!prior) return null;
    if (prior.requestHash !== hash || prior.createdById !== actor(ctx)) throw new ConflictError("Idempotency key was already used for a different request");
    return prior;
  };
  const prior = await replay();
  if (prior) return { replayed: true, original: await full(db, ctx, orderId), order: await full(db, ctx, prior.id) };

  let newId: string;
  try {
    newId = await orderTx(db, orderId, (tx) => splitInTx(tx, ctx, orderId, data, key, hash));
  } catch (e) {
    if (key && (e as { code?: string })?.code === "P2002") {
      const again = await replay();
      if (again) return { replayed: true, original: await full(db, ctx, orderId), order: await full(db, ctx, again.id) };
    }
    throw e;
  }
  return { replayed: false, original: await full(db, ctx, orderId), order: await full(db, ctx, newId) };
}

async function splitInTx(tx: Tx, ctx: AccessContext, orderId: string, data: z.output<typeof splitSchema>, key: string | undefined, hash: string): Promise<string> {
  const source = await loadRunning(tx, ctx, orderId);
  await assertNoPayments(tx, orderId, "Cannot split");
  await assertNoCoupon(tx, orderId, "Cannot split");
  const items = await tx.orderItem.findMany({ where: { orderId }, include: { modifiers: true, kotItems: true } });
  const byId = new Map(items.map((i) => [i.id, i]));

  // The plan: which lines move whole, which are divided, and how much.
  const seen = new Set<string>();
  const plan = data.lines.map((l) => {
    const item = byId.get(l.orderItemId);
    if (!item) throw new ValidationError("A line to split is not on this order");
    if (seen.has(item.id)) throw new ValidationError(`${item.name} is listed twice`);
    seen.add(item.id);
    const qty = l.qty === undefined ? D(item.qty) : D(l.qty);
    if (qty.gt(D(item.qty))) throw new ValidationError(`Only ${D(item.qty).toString()} × ${item.name} on the bill`);
    return { item, qty, whole: qty.eq(D(item.qty)) };
  });
  if (plan.every((p) => p.whole) && plan.length === items.length) throw new ValidationError("Leave at least one item on the original bill (to move the whole order, move it to another table)");

  const newOrder = await tx.order.create({
    data: {
      organizationId: ctx.organizationId, outletId: source.outletId, channel: source.channel, source: source.source, tableId: source.tableId, customerId: source.customerId,
      status: source.status, billedAt: source.billedAt, covers: data.covers ?? 1, createdById: actor(ctx), createdAt: source.createdAt, idempotencyKey: key ?? null, requestHash: key ? hash : null,
    },
  });
  await tx.order.update({ where: { id: orderId }, data: { covers: Math.max(1, source.covers - (data.covers ?? 1)) } });

  // Lines: whole lines change order; a divided line leaves a smaller copy behind and a new line on the new bill.
  const moved = new Map<string, { newItemId: string; qty: Prisma.Decimal; whole: boolean }>();
  for (const { item, qty, whole } of plan) {
    if (whole) {
      await tx.orderItem.update({ where: { id: item.id }, data: { orderId: newOrder.id } });
      moved.set(item.id, { newItemId: item.id, qty, whole: true });
      continue;
    }
    const movedDiscount = money(D(item.discount).times(qty).div(D(item.qty)));
    const clone = await tx.orderItem.create({
      data: {
        organizationId: ctx.organizationId, outletId: item.outletId, orderId: newOrder.id, menuItemId: item.menuItemId, posItemCode: item.posItemCode, variantId: item.variantId,
        name: item.name, qty, unitPrice: item.unitPrice, discount: movedDiscount, taxPct: item.taxPct, hsnSac: item.hsnSac, station: item.station, notes: item.notes,
        modifiers: item.modifiers.length ? { create: item.modifiers.map((m) => ({ name: m.name, optionId: m.optionId, priceDelta: m.priceDelta })) } : undefined,
      },
    });
    await tx.orderItem.update({ where: { id: item.id }, data: { qty: D(item.qty).minus(qty), discount: money(D(item.discount).minus(movedDiscount)) } });
    moved.set(item.id, { newItemId: clone.id, qty, whole: false });
  }

  // Kitchen tickets: a ticket whose lines all moved goes with them; one that is shared is divided into two tickets in the same state.
  const tickets = await tx.kot.findMany({ where: { orderId }, include: { items: true } });
  for (const kot of tickets) {
    const touched = kot.items.filter((ki) => ki.orderItemId && moved.has(ki.orderItemId));
    if (!touched.length) continue;
    if (kot.items.every((ki) => ki.orderItemId && moved.get(ki.orderItemId)?.whole)) {
      await tx.kot.update({ where: { id: kot.id }, data: { orderId: newOrder.id } });
      continue;
    }
    const twin = await tx.kot.create({
      data: {
        organizationId: ctx.organizationId, outletId: kot.outletId, orderId: newOrder.id, stationId: kot.stationId, number: await nextKotNumber(tx, kot.outletId), status: kot.status,
        printedAt: kot.printedAt, acceptedAt: kot.acceptedAt, startedAt: kot.startedAt, readyAt: kot.readyAt, servedAt: kot.servedAt, createdAt: kot.createdAt,
      },
    });
    for (const ki of touched) {
      const mv = moved.get(ki.orderItemId!)!;
      if (mv.whole) {
        await tx.kotItem.update({ where: { id: ki.id }, data: { kotId: twin.id } });
      } else {
        await tx.kotItem.update({ where: { id: ki.id }, data: { qty: D(ki.qty).minus(mv.qty) } });
        await tx.kotItem.create({ data: { kotId: twin.id, orderItemId: mv.newItemId, name: ki.name, qty: mv.qty, status: ki.status, notes: ki.notes } });
      }
    }
  }

  // The order-level discount is shared by the value each bill now carries.
  const worth = async (id: string) => {
    const rows = await tx.orderItem.findMany({ where: { orderId: id }, include: { modifiers: true } });
    return calculateOrderTotals(rows.map((r) => ({ qty: r.qty, unitPrice: r.unitPrice, discount: r.discount, taxPct: r.taxPct, modifiersPerUnit: r.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0)) })), 0).subtotal;
  };
  const [keptValue, movedValue] = [await worth(orderId), await worth(newOrder.id)];
  const discount = D(source.discount);
  const newShare = discount.gt(0) && keptValue.plus(movedValue).gt(0) ? money(discount.times(movedValue).div(keptValue.plus(movedValue))) : D(0);
  await tx.order.update({ where: { id: newOrder.id }, data: { discount: newShare } });
  await tx.order.update({ where: { id: orderId }, data: { discount: discount.minus(newShare) } });
  const before = { subtotal: money(source.subtotal).toFixed(2), tax: money(source.tax).toFixed(2), total: money(source.total).toFixed(2) };
  const kept = await recomputeTotals(tx, orderId);
  const created = await recomputeTotals(tx, newOrder.id);

  await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Order", entityId: orderId, outletId: source.outletId, before, after: { splitTo: newOrder.id, lines: plan.map((p) => ({ name: p.item.name, qty: p.qty.toString() })), total: money(kept.total).toFixed(2) } });
  await writeAudit(tx, ctx, { action: "CREATE", entityType: "Order", entityId: newOrder.id, outletId: source.outletId, after: { splitFrom: orderId, total: money(created.total).toFixed(2) } });
  return newOrder.id;
}
