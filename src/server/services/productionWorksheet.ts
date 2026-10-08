/**
 * Dish production worksheet (proposal module 05): one row per dish per outlet
 * business day.
 *
 *   prepared  - entered by the chef (DishProduction.preparedQty)
 *   sold      - automatic: portions on PAID orders placed that business day
 *               (POS, QR, manual sales log); fully refunded orders excluded
 *   wasted    - posted dish-level wastage documents dated that day. The
 *               wastage register is the ONLY path that moves stock for wasted
 *               dishes: "Add wasted" here creates and posts such a document,
 *               so a dish logged here and in the register is one loss, never two
 *   variance  - prepared - sold - wasted: the unexplained gap ("40 prepared,
 *               31 sold, 3 wasted: six portions are unaccounted for")
 *   wastage cost (posted cost of those documents) and variance cost (at
 *               today's plate cost), hidden from logins that may not see costs
 *
 * Preparing dishes does not move stock: a sale depletes the recipe, wastage
 * depletes the recipe, and the unexplained gap surfaces at the next stock
 * count. Consuming at "prepared" as well would deplete twice.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan, can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { runInTx } from "@/server/services/_workflow";
import { getActiveVersionForMenuItem, calculateRecipeCost } from "@/server/services/recipe";
import { outletBusinessDay, businessDateString } from "@/server/services/businessDay";
import { assertDayOpen } from "@/server/services/dayLock";
import { canSeeStockValue, withoutLineCosts } from "@/server/services/costVisibility";
import { createDishWastage, postWastage } from "@/server/services/wastage";
import { WastageReason } from "@/constants/enums";
import { D, money, num, qty as roundQty } from "@/domain/money";

const dateStr = businessDateString;

export type WorksheetRow = {
  menuItemId: string;
  name: string;
  departmentId: string | null;
  department: string | null;
  prepared: number | null;
  sold: number;
  wasted: number;
  /** Dish wastage logged that day but not posted yet (awaiting approval). */
  wastedPending: number;
  variance: number | null;
  plateCost?: number | null;
  wastageCost?: number | null;
  varianceCost?: number | null;
  notes: string | null;
  updatedAt: string | null;
};

export async function getWorksheet(db: PrismaClient, ctx: AccessContext, input: { outletId: string; businessDate: string; departmentId?: string }) {
  const q = z.object({ outletId: z.string().min(1), businessDate: dateStr, departmentId: z.string().optional() }).parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "inventory.view", q.outletId);
  const day = await outletBusinessDay(db, ctx, q.outletId, q.businessDate);
  const inDay = { gte: day.start, lt: day.end };
  const [entries, departments, sold, wastage] = await Promise.all([
    db.dishProduction.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId, businessDate: day.date } }),
    db.department.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId }, select: { id: true, name: true, kind: true, active: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    db.orderItem.groupBy({
      by: ["menuItemId"],
      where: { organizationId: ctx.organizationId, outletId: q.outletId, menuItemId: { not: null }, order: { status: "PAID", createdAt: inDay } },
      _sum: { qty: true },
    }),
    // A dish loss belongs to the day it happened (occurredAt) or, when not back-dated, the day it was entered.
    db.wastage.findMany({
      where: { organizationId: ctx.organizationId, outletId: q.outletId, menuItemId: { not: null }, status: { in: ["DRAFT", "POSTED"] }, OR: [{ occurredAt: inDay }, { occurredAt: null, createdAt: inDay }] },
      select: { menuItemId: true, dishQty: true, status: true, departmentId: true, lines: { select: { estCost: true } } },
    }),
  ]);
  const soldBy = new Map(sold.map((s) => [s.menuItemId!, D(s._sum.qty ?? 0)]));
  const wasteBy = new Map<string, { posted: ReturnType<typeof D>; pending: ReturnType<typeof D>; cost: ReturnType<typeof D> }>();
  for (const w of wastage) {
    const cur = wasteBy.get(w.menuItemId!) ?? { posted: D(0), pending: D(0), cost: D(0) };
    if (w.status === "POSTED") {
      cur.posted = cur.posted.plus(D(w.dishQty ?? 0));
      cur.cost = cur.cost.plus(w.lines.reduce((s, l) => s.plus(D(l.estCost)), D(0)));
    } else cur.pending = cur.pending.plus(D(w.dishQty ?? 0));
    wasteBy.set(w.menuItemId!, cur);
  }
  const itemIds = [...new Set([...entries.map((e) => e.menuItemId), ...soldBy.keys(), ...wasteBy.keys()])];
  const items = itemIds.length ? await db.menuItem.findMany({ where: { organizationId: ctx.organizationId, id: { in: itemIds } }, select: { id: true, name: true, station: true } }) : [];
  const deptOfStation = (station: string) => departments.find((d) => d.active && d.kind === station) ?? null;
  const showCost = canSeeStockValue(ctx, q.outletId) && can(ctx, "recipe.view", q.outletId);

  const rows: WorksheetRow[] = [];
  for (const it of items) {
    const e = entries.find((x) => x.menuItemId === it.id);
    const dept = e?.departmentId ? departments.find((d) => d.id === e.departmentId) ?? null : deptOfStation(it.station);
    if (q.departmentId && dept?.id !== q.departmentId) continue;
    const s = soldBy.get(it.id) ?? D(0);
    const w = wasteBy.get(it.id);
    const wasted = w?.posted ?? D(0);
    const prepared = e ? D(e.preparedQty) : null;
    const variance = prepared === null ? null : roundQty(prepared.minus(s).minus(wasted));
    const row: WorksheetRow = {
      menuItemId: it.id, name: it.name, departmentId: dept?.id ?? null, department: dept?.name ?? null,
      prepared: prepared === null ? null : num(prepared), sold: num(roundQty(s)), wasted: num(roundQty(wasted)), wastedPending: num(roundQty(w?.pending ?? D(0))),
      variance: variance === null ? null : num(variance), notes: e?.notes ?? null, updatedAt: e?.updatedAt.toISOString() ?? null,
    };
    if (showCost) {
      const version = await getActiveVersionForMenuItem(db, ctx, it.id);
      const plate = version ? D((await calculateRecipeCost(db, ctx, version.id, { outletId: q.outletId, quantity: 1 })).total) : null;
      row.plateCost = plate ? num(money(plate)) : null;
      row.wastageCost = num(money(w?.cost ?? D(0)));
      row.varianceCost = plate && variance !== null ? num(money(plate.times(variance))) : null;
    }
    rows.push(row);
  }
  rows.sort((a, b) => (a.department ?? "~").localeCompare(b.department ?? "~") || a.name.localeCompare(b.name));
  const total = (f: (r: WorksheetRow) => number | null | undefined) => num(roundQty(rows.reduce((acc, r) => acc.plus(f(r) ?? 0), D(0))));
  const totalMoney = (f: (r: WorksheetRow) => number | null | undefined) => (showCost ? num(money(rows.reduce((acc, r) => acc.plus(f(r) ?? 0), D(0)))) : undefined);
  return {
    outletId: q.outletId, businessDate: day.date, rows, showCost,
    totals: {
      prepared: total((r) => r.prepared), sold: total((r) => r.sold), wasted: total((r) => r.wasted),
      // Only shortfalls are unexplained; more sold than prepared is listed per row, not netted away.
      unexplained: total((r) => (r.variance !== null && r.variance > 0 ? r.variance : 0)),
      wastageCost: totalMoney((r) => r.wastageCost), varianceCost: totalMoney((r) => (r.varianceCost !== null && r.varianceCost !== undefined && r.varianceCost > 0 ? r.varianceCost : 0)),
    },
  };
}

const saveSchema = z.object({
  outletId: z.string().min(1),
  businessDate: dateStr,
  menuItemId: z.string().min(1),
  preparedQty: z.number().min(0).max(100_000),
  notes: z.string().max(300).optional(),
}).strict();

/** Record (or correct) the portions prepared. Audited; refused for a future or closed day. */
export async function saveWorksheetEntry(ctx: AccessContext, input: z.input<typeof saveSchema>, db: PrismaClient = prisma) {
  const data = saveSchema.parse(input);
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.produce", data.outletId);
  return runInTx(db, async (tx) => {
    const day = await assertDayOpen(tx, ctx, data.outletId, data.businessDate, "the production worksheet");
    if (day.start.getTime() > Date.now()) throw new ValidationError("The worksheet cannot be filled for a future day");
    const item = await tx.menuItem.findUnique({ where: { id: data.menuItemId }, select: { organizationId: true, station: true } });
    if (!item || item.organizationId !== ctx.organizationId) throw new NotFoundError("Menu item not found");
    const existing = await tx.dishProduction.findUnique({ where: { outletId_businessDate_menuItemId: { outletId: data.outletId, businessDate: day.date, menuItemId: data.menuItemId } } });
    const actor = ctx.userId === "system" ? null : ctx.userId;
    const departmentId = existing?.departmentId ?? (await tx.department.findFirst({ where: { organizationId: ctx.organizationId, outletId: data.outletId, active: true, kind: item.station }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true } }))?.id ?? null;
    const row = await tx.dishProduction.upsert({
      where: { outletId_businessDate_menuItemId: { outletId: data.outletId, businessDate: day.date, menuItemId: data.menuItemId } },
      update: { preparedQty: D(data.preparedQty), notes: data.notes ?? existing?.notes, updatedById: actor },
      create: { organizationId: ctx.organizationId, outletId: data.outletId, departmentId, businessDate: day.date, menuItemId: data.menuItemId, preparedQty: D(data.preparedQty), notes: data.notes, createdById: actor, updatedById: actor },
    });
    await writeAudit(tx, ctx, {
      action: existing ? "UPDATE" : "CREATE", entityType: "DishProduction", entityId: row.id, outletId: data.outletId,
      before: existing ? { preparedQty: num(D(existing.preparedQty)), notes: existing.notes } : undefined,
      after: { businessDate: day.date, menuItemId: data.menuItemId, preparedQty: data.preparedQty, notes: row.notes },
    });
    return row;
  });
}

const wasteSchema = z.object({
  outletId: z.string().min(1),
  businessDate: dateStr,
  menuItemId: z.string().min(1),
  qty: z.number().positive().max(100_000),
  reason: WastageReason.zod.default("OVERPRODUCTION"),
  notes: z.string().max(300).optional(),
}).strict();

/**
 * Log wasted portions from the worksheet: a dish-level wastage document dated
 * to that business day, posted straight away. Above the wastage approval
 * threshold a login without inventory.approve_adjustment leaves it DRAFT for a
 * manager (shown as "awaiting approval"). Idempotency-Key required: a retry
 * returns the same document and never posts twice.
 */
export async function recordWorksheetWastage(ctx: AccessContext, input: z.input<typeof wasteSchema>, idempotencyKey: string | undefined, db: PrismaClient = prisma) {
  const data = wasteSchema.parse(input);
  if (!idempotencyKey) throw new ValidationError("Idempotency-Key header is required");
  assertOutletAccess(ctx, data.outletId);
  assertCan(ctx, "inventory.wastage", data.outletId);
  const day = await assertDayOpen(db, ctx, data.outletId, data.businessDate, "wastage");
  if (day.start.getTime() > Date.now()) throw new ValidationError("Wastage cannot be logged for a future day");
  // Today's loss is dated now; an earlier day's loss to the last moment of that day.
  const occurredAt = Date.now() < day.end.getTime() ? undefined : new Date(day.end.getTime() - 1);
  // A kitchen login sees quantities only (proposal p. 8: no costs).
  const strip = <T extends { lines: Array<{ estCost: unknown }> }>(w: T) => withoutLineCosts(ctx, data.outletId, w);
  const doc = await createDishWastage(ctx, { outletId: data.outletId, menuItemId: data.menuItemId, qty: data.qty, reason: data.reason, notes: [`Worksheet ${day.date}`, data.notes].filter(Boolean).join(" | "), occurredAt }, db, idempotencyKey);
  if (doc.status !== "DRAFT") return { wastage: strip(doc), posted: doc.status === "POSTED", awaitingApproval: false };
  try {
    const r = await postWastage(ctx, doc.id, db);
    return { wastage: strip(r.wastage), posted: true, awaitingApproval: false, ...(canSeeStockValue(ctx, data.outletId) ? { totalCost: r.totalCost } : {}) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { wastage: strip(doc), posted: false, awaitingApproval: true };
    // A retry with the same key that raced this one posted the document first: report it, posted once.
    const now = await db.wastage.findUnique({ where: { id: doc.id }, include: { lines: true } });
    if (now && now.status !== "DRAFT") return { wastage: strip(now), posted: now.status === "POSTED", awaitingApproval: false };
    throw e;
  }
}
