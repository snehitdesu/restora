/**
 * Stock that is about to expire (audit IN-14, proposal p. 18: batch numbers, expiry dates, FSSAI lot codes — and use the
 * earliest expiry first).
 *
 * Goods receipts and production batches record a batch number, an expiry date and, for packaged food, the FSSAI lot code on
 * the ledger rows that bring stock in. Stock is counted per material, not per batch, so what is left of each batch is
 * derived, openly: the shelf is assumed to be used earliest-expiry-first (FEFO), which means what is on hand is the latest-
 * expiring receipts. The list is therefore exactly right when the kitchen follows FEFO and a close estimate otherwise; it
 * says so. Quantities only: no cost leaves this service.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { D, num, qty as roundQty } from "@/domain/money";
import { localDate } from "@/domain/time";
import { outletTimeZone } from "@/server/services/businessDay";

const inputSchema = z.object({
  outletId: z.string().min(1),
  /** How far ahead to look (calendar days from today in the outlet's time zone). */
  days: z.coerce.number().int().min(0).max(120).default(7),
});

export type ExpiryStatus = "EXPIRED" | "TODAY" | "SOON";
export type ExpiryRow = {
  materialId: string;
  name: string;
  sku: string;
  unit: string | null;
  batchNo: string | null;
  fssaiLot: string | null;
  /** YYYY-MM-DD */
  expiryDate: string;
  daysLeft: number;
  status: ExpiryStatus;
  /** What is left of this batch, in the material's base unit (derived assuming earliest-expiry-first use). */
  remaining: number;
  /** The batch to use first for this material. */
  useFirst: boolean;
};
export type ExpiryReport = { outletId: string; asOf: string; days: number; rows: ExpiryRow[]; counts: { expired: number; today: number; soon: number }; basis: string };

export const EXPIRY_BASIS = "What is left of each batch is worked out from the stock on hand, assuming the earliest expiry is used first. It is exact when the kitchen follows that rule.";

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

export async function expiringStock(db: PrismaClient, ctx: AccessContext, input: z.input<typeof inputSchema>, now: Date = new Date()): Promise<ExpiryReport> {
  const q = inputSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "inventory.view", q.outletId);
  const tz = await outletTimeZone(db, ctx, q.outletId);
  const today = localDate(now, tz);
  const where = { organizationId: ctx.organizationId, outletId: q.outletId };

  // Stock coming in with an expiry date, per batch; then what is on hand per material.
  const dated = await db.inventoryLedger.findMany({ where: { ...where, expiryDate: { not: null }, qty: { gt: 0 } }, select: { materialId: true, batchNo: true, fssaiLot: true, expiryDate: true, qty: true } });
  if (!dated.length) return { outletId: q.outletId, asOf: today, days: q.days, rows: [], counts: { expired: 0, today: 0, soon: 0 }, basis: EXPIRY_BASIS };
  const materialIds = [...new Set(dated.map((r) => r.materialId))];
  const [sums, materials] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["materialId"], where: { ...where, materialId: { in: materialIds } }, _sum: { qty: true } }),
    db.material.findMany({ where: { organizationId: ctx.organizationId, id: { in: materialIds } }, select: { id: true, name: true, sku: true, baseUnit: { select: { code: true } } } }),
  ]);
  const onHand = new Map(sums.map((s) => [s.materialId, D(s._sum.qty ?? 0)]));
  const meta = new Map(materials.map((m) => [m.id, m]));

  const rows: ExpiryRow[] = [];
  for (const materialId of materialIds) {
    // Batches of this material, latest expiry first: that is where the stock on hand sits if the earliest is used first.
    const batches = new Map<string, { batchNo: string | null; fssaiLot: string | null; expiry: string; qty: ReturnType<typeof D> }>();
    for (const r of dated.filter((x) => x.materialId === materialId)) {
      const expiry = r.expiryDate!.toISOString().slice(0, 10);
      const key = `${r.batchNo ?? ""}|${r.fssaiLot ?? ""}|${expiry}`;
      const cur = batches.get(key);
      batches.set(key, { batchNo: r.batchNo, fssaiLot: r.fssaiLot, expiry, qty: (cur?.qty ?? D(0)).plus(D(r.qty)) });
    }
    let left = onHand.get(materialId) ?? D(0);
    const live: Array<{ batchNo: string | null; fssaiLot: string | null; expiry: string; remaining: ReturnType<typeof D> }> = [];
    for (const b of [...batches.values()].sort((a, c) => c.expiry.localeCompare(a.expiry))) {
      if (left.lte(0)) break;
      const take = left.lt(b.qty) ? left : b.qty;
      live.push({ batchNo: b.batchNo, fssaiLot: b.fssaiLot, expiry: b.expiry, remaining: take });
      left = left.minus(take);
    }
    live.sort((a, b) => a.expiry.localeCompare(b.expiry));
    live.forEach((b, i) => {
      const daysLeft = dayDiff(b.expiry, today);
      if (daysLeft > q.days) return;
      const m = meta.get(materialId);
      rows.push({
        materialId, name: m?.name ?? materialId, sku: m?.sku ?? "", unit: m?.baseUnit?.code ?? null, batchNo: b.batchNo, fssaiLot: b.fssaiLot, expiryDate: b.expiry, daysLeft,
        status: daysLeft < 0 ? "EXPIRED" : daysLeft === 0 ? "TODAY" : "SOON", remaining: num(roundQty(b.remaining)), useFirst: i === 0,
      });
    });
  }
  rows.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.name.localeCompare(b.name));
  return {
    outletId: q.outletId, asOf: today, days: q.days, rows, basis: EXPIRY_BASIS,
    counts: { expired: rows.filter((r) => r.status === "EXPIRED").length, today: rows.filter((r) => r.status === "TODAY").length, soon: rows.filter((r) => r.status === "SOON").length },
  };
}
