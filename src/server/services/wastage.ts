/**
 * Wastage documents: record what was lost and why, then post it to the
 * append-only inventory ledger.
 *
 *   create (DRAFT, lines in any unit -> stored in base unit)
 *     -> post (POSTED: one ledger row per line, cost estimated at avg cost)
 *   DRAFT -> CANCELLED (no stock effect)
 *
 * Posting is one-shot (status guard) and each ledger row has a unique sourceRef
 * `wastage:<id>:<material>`, so a retry cannot double-deduct. Documents whose
 * estimated cost exceeds WASTAGE_RULES.approvalThreshold can only be posted by
 * someone holding `inventory.approve_adjustment`. The ledger txnType follows
 * the reason (spoilage/expiry -> SPOILAGE, staff meals -> STAFF_MEAL, else
 * WASTAGE), which feeds wastage analytics and HEAVY_WASTAGE anomaly detection.
 *
 * Dish-level wastage ("3 pizzas", proposal module 03): createDishWastage
 * explodes the dish's approved recipe into raw-material lines (the same
 * explosion a sale uses), so the posted cost is the plate cost x quantity and
 * the stock leaves the dish's department. A sub-recipe the kitchen makes in
 * batches is taken from its prepared stock, not re-exploded (recipe.ts).
 *
 * `occurredAt` records a loss logged after the fact (the dish worksheet for an
 * earlier business day): posting dates the ledger rows to it. Posting into a
 * closed business day is refused (dayLock.ts).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { WastageReason, WASTAGE_TRANSITIONS, type WastageStatus, type InventoryTransactionType } from "@/constants/enums";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { appendLedger, currentQuantity, getAvgCost } from "@/server/services/inventory";
import { convertToBase, explodeRecipe, getActiveVersionForMenuItem } from "@/server/services/recipe";
import { type Client, type Tx, runInTx, assertTransition, nextNumber } from "@/server/services/_workflow";
import { idempotentCreate, requestHashOf } from "@/server/services/idempotency";
import { assertDayOpen } from "@/server/services/dayLock";
import { withoutLineCosts } from "@/server/services/costVisibility";
import { D, dMul, money, num, qty as roundQty } from "@/domain/money";

export const WASTAGE_RULES = { approvalThreshold: 2000 };

function ledgerTypeFor(reason: string): InventoryTransactionType {
  if (reason === "SPOILAGE" || reason === "EXPIRED") return "SPOILAGE";
  if (reason === "STAFF_MEAL") return "STAFF_MEAL";
  return "WASTAGE";
}

function actor(ctx: AccessContext): string | null {
  return ctx.userId === "system" ? null : ctx.userId;
}

const createSchema = z.object({
  outletId: z.string(),
  departmentId: z.string().optional(),
  reason: WastageReason.zod,
  notes: z.string().max(1000).optional(),
  /** When the loss happened, if earlier than now. */
  occurredAt: z.coerce.date().optional(),
  lines: z.array(z.object({ materialId: z.string(), qty: z.number().positive().max(1_000_000_000), unitId: z.string().optional() })).min(1).max(200),
});

export async function createWastage(ctx: AccessContext, input: z.input<typeof createSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = createSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.wastage", data.outletId);
  assertNotFuture(data.occurredAt);
  const ids = data.lines.map((l) => l.materialId);
  if (new Set(ids).size !== ids.length) throw new ValidationError("Each material may appear only once per wastage document");
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "wastage", data),
    findPrior: (key) => prisma.wastage.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } }, include: { lines: true } }),
    create: (key, hash) => createWastageTx(ctx, data, key, hash, db),
  });
}

const dishSchema = z.object({
  outletId: z.string(),
  menuItemId: z.string(),
  qty: z.number().positive().max(100_000),
  /** Defaults to the department that owns the dish's station. */
  departmentId: z.string().optional(),
  reason: WastageReason.zod,
  notes: z.string().max(1000).optional(),
  occurredAt: z.coerce.date().optional(),
});

/** Clock skew allowed on occurredAt; a loss cannot be recorded in the future. */
const FUTURE_SLACK_MS = 10 * 60_000;
function assertNotFuture(at: Date | undefined) {
  if (at && at.getTime() > Date.now() + FUTURE_SLACK_MS) throw new ValidationError("Wastage cannot be dated in the future");
}

/** A DRAFT wastage document for whole dishes; post it with postWastage like any other. */
export async function createDishWastage(ctx: AccessContext, input: z.input<typeof dishSchema>, db: Client = prisma, idempotencyKey?: string) {
  const data = dishSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.wastage", data.outletId);
  assertNotFuture(data.occurredAt);
  const item = await db.menuItem.findUnique({ where: { id: data.menuItemId }, select: { organizationId: true, name: true, station: true } });
  if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
  const version = await getActiveVersionForMenuItem(db, ctx, data.menuItemId);
  if (!version) throw new ValidationError(`${item.name} has no approved recipe: record the wasted ingredients instead`);
  const exploded = await explodeRecipe(db, ctx, version.id, data.qty, { stock: true });
  if (!exploded.size) throw new ValidationError(`${item.name}'s recipe has no ingredients`);
  const departmentId = data.departmentId ?? (await db.department.findFirst({ where: { organizationId: ctx.organizationId, outletId: data.outletId, active: true, kind: item.station }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true } }))?.id;
  const doc = {
    outletId: data.outletId, departmentId, reason: data.reason, occurredAt: data.occurredAt,
    notes: [`Dish: ${num(data.qty)} x ${item.name}`, data.notes].filter(Boolean).join(" | "),
    lines: [...exploded].map(([materialId, q]) => ({ materialId, qty: num(roundQty(q)) })).filter((l) => l.qty > 0),
  };
  return idempotentCreate({
    key: idempotencyKey,
    hash: requestHashOf(ctx, "dish-wastage", data),
    findPrior: (key) => prisma.wastage.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } }, include: { lines: true } }),
    create: (key, hash) => createWastageTx(ctx, createSchema.parse(doc), key, hash, db, { menuItemId: data.menuItemId, dishQty: data.qty }),
  });
}

function createWastageTx(ctx: AccessContext, data: z.infer<typeof createSchema>, key: string | null, hash: string | null, db: Client, dish?: { menuItemId: string; dishQty: number }) {
  return runInTx(db, async (tx) => {
    if (data.departmentId) {
      const dept = await tx.department.findUnique({ where: { id: data.departmentId } });
      if (!dept || dept.outletId !== data.outletId) throw new ValidationError("Department not in this outlet");
    }
    const lines = [];
    for (const l of data.lines) {
      const base = await convertToBase(tx, ctx, l.materialId, D(l.qty), l.unitId); // validates material in org
      lines.push({ organizationId: ctx.organizationId, materialId: l.materialId, qty: roundQty(base) });
    }
    const number = await nextNumber(tx, tx.wastage, { outletId: data.outletId }, "WST");
    const doc = await tx.wastage.create({
      data: { organizationId: ctx.organizationId, outletId: data.outletId, departmentId: data.departmentId, number, reason: data.reason, status: "DRAFT", notes: data.notes, occurredAt: data.occurredAt, createdById: actor(ctx), idempotencyKey: key, requestHash: hash, lines: { create: lines }, ...(dish ? { menuItemId: dish.menuItemId, dishQty: D(dish.dishQty) } : {}) },
      include: { lines: true },
    });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Wastage", entityId: doc.id, outletId: data.outletId, after: { reason: data.reason, lines: lines.length, ...(dish ?? {}) } });
    return doc;
  });
}

async function loadDoc(tx: Tx | PrismaClient, ctx: AccessContext, wastageId: string) {
  const doc = await tx.wastage.findUnique({ where: { id: wastageId }, include: { lines: true } });
  if (!doc || doc.organizationId !== ctx.organizationId) throw new NotFoundError("Wastage document not found");
  assertOutletAccess(ctx, doc.outletId);
  assertCan(ctx, "inventory.wastage", doc.outletId);
  return doc;
}

/** Post a DRAFT document to the ledger. Rejects without effect if any line exceeds on-hand stock. */
export async function postWastage(ctx: AccessContext, wastageId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const doc = await loadDoc(tx, ctx, wastageId);
    assertTransition(WASTAGE_TRANSITIONS, doc.status as WastageStatus, "POSTED", "wastage");
    await assertDayOpen(tx, ctx, doc.outletId, doc.occurredAt ?? new Date(), "wastage");

    const priced = [];
    let total = D(0);
    for (const line of doc.lines) {
      const onHand = await currentQuantity(tx, ctx, doc.outletId, line.materialId);
      if (onHand.lt(D(line.qty))) throw new ValidationError(`Cannot waste ${num(line.qty)} of ${line.materialId}: only ${num(onHand)} on hand`);
      const rate = await getAvgCost(tx, ctx, doc.outletId, line.materialId);
      const cost = money(dMul(line.qty, rate));
      total = total.plus(cost);
      priced.push({ line, rate, cost });
    }
    if (total.gt(WASTAGE_RULES.approvalThreshold)) assertCan(ctx, "inventory.approve_adjustment", doc.outletId);

    const txnType = ledgerTypeFor(doc.reason);
    for (const { line, rate, cost } of priced) {
      await appendLedger(tx, ctx, {
        outletId: doc.outletId, departmentId: doc.departmentId, materialId: line.materialId, magnitude: line.qty, rate, txnType,
        sourceType: "WASTAGE", sourceId: doc.id, sourceRef: `wastage:${doc.id}:${line.materialId}`, note: `${doc.reason} ${doc.number}`,
        createdAt: doc.occurredAt ?? undefined,
      });
      await tx.wastageLine.update({ where: { id: line.id }, data: { estCost: cost } });
    }
    const updated = await tx.wastage.update({ where: { id: wastageId }, data: { status: "POSTED" }, include: { lines: true } });
    await writeAudit(tx, ctx, { action: "INVENTORY_MOVEMENT", entityType: "Wastage", entityId: wastageId, outletId: doc.outletId, before: { status: doc.status }, after: { status: "POSTED", txnType, totalCost: num(money(total)) } });
    return { wastage: updated, totalCost: num(money(total)) };
  });
}

export async function cancelWastage(ctx: AccessContext, wastageId: string, db: Client = prisma) {
  return runInTx(db, async (tx) => {
    const doc = await loadDoc(tx, ctx, wastageId);
    assertTransition(WASTAGE_TRANSITIONS, doc.status as WastageStatus, "CANCELLED", "wastage");
    const updated = await tx.wastage.update({ where: { id: wastageId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "Wastage", entityId: wastageId, outletId: doc.outletId, before: { status: doc.status }, after: { status: "CANCELLED" } });
    return updated;
  });
}

export async function listWastage(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date; status?: WastageStatus; take?: number; cursor?: string }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "inventory.view", filter.outletId);
  const take = Math.min(filter.take ?? 50, 200);
  const createdAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const rows = await db.wastage.findMany({
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, ...(filter.status ? { status: filter.status } : {}), ...(createdAt ? { createdAt } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    include: { lines: true },
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take).map((d) => withoutLineCosts(ctx, filter.outletId, d));
  return { items, nextCursor: rows.length > take ? items[items.length - 1].id : null };
}

/** Posted wastage cost by reason for an outlet/period (from the document lines). */
export async function wastageByReason(db: PrismaClient, ctx: AccessContext, filter: { outletId: string; from?: Date; to?: Date }) {
  assertOutletAccess(ctx, filter.outletId);
  assertCan(ctx, "reports.view", filter.outletId);
  const createdAt = filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined;
  const docs = await db.wastage.groupBy({
    by: ["reason"],
    where: { organizationId: ctx.organizationId, outletId: filter.outletId, status: "POSTED", ...(createdAt ? { createdAt } : {}) },
    _count: true,
  });
  const costs = await Promise.all(
    docs.map((d) =>
      db.wastageLine.aggregate({ where: { wastage: { organizationId: ctx.organizationId, outletId: filter.outletId, status: "POSTED", reason: d.reason, ...(createdAt ? { createdAt } : {}) } }, _sum: { estCost: true } })
    )
  );
  return docs.map((d, i) => ({ reason: d.reason, documents: d._count, cost: num(money(D(costs[i]._sum.estCost ?? 0))) })).sort((a, b) => b.cost - a.cost);
}
