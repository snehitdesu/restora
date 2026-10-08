/**
 * QR stock labels (proposal p. 17, "Barcode / QR stock labels").
 *
 * A label carries the material's SKU, never its internal id:
 *   RESTORA-STOCK:<SKU>
 * Scanning a label (phone camera or a USB scanner typing into the look-up
 * box) resolves the SKU within the caller's organization to the material, its
 * stock at the outlet (per department) and its reorder level, so the store can
 * count, issue or record wastage from the shelf. Quantities only for logins
 * that may not see costs.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { canSeeStockValue } from "@/server/services/costVisibility";
import { D, money, num, qty as roundQty } from "@/domain/money";

export const LABEL_PREFIX = "RESTORA-STOCK:";

/** The SKU in a scanned label or a typed code ("RESTORA-STOCK:RM-0001" or "RM-0001"). */
export function skuFromCode(code: string): string {
  const c = code.trim();
  const sku = c.toUpperCase().startsWith(LABEL_PREFIX) ? c.slice(LABEL_PREFIX.length) : c;
  if (!sku || sku.length > 60 || /[\r\n]/.test(sku)) throw new ValidationError("Not a stock label");
  return sku.trim();
}

export function labelPayload(sku: string) {
  return `${LABEL_PREFIX}${sku}`;
}

const lookupSchema = z.object({ outletId: z.string().min(1), code: z.string().min(1).max(100) });

export async function lookupStockLabel(db: PrismaClient, ctx: AccessContext, input: z.input<typeof lookupSchema>) {
  const q = lookupSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "inventory.view", q.outletId);
  const sku = skuFromCode(q.code);
  // SKUs are unique per organization; match exactly first, then the code as typed in upper / lower case
  // (a hand-typed "rm-0001"), always through the (organizationId, sku) index, never a scan of the catalogue.
  const select = { id: true, sku: true, name: true, active: true, reorderLevel: true, baseUnit: { select: { code: true } }, category: { select: { name: true } } } as const;
  const material =
    (await db.material.findFirst({ where: { organizationId: ctx.organizationId, sku }, select })) ??
    (await db.material.findFirst({ where: { organizationId: ctx.organizationId, sku: { in: [sku.toUpperCase(), sku.toLowerCase()] } }, select }));
  if (!material) throw new NotFoundError(`No material with code ${sku}`);
  const [byDept, departments, cost] = await Promise.all([
    db.inventoryLedger.groupBy({ by: ["departmentId"], where: { organizationId: ctx.organizationId, outletId: q.outletId, materialId: material.id }, _sum: { qty: true } }),
    db.department.findMany({ where: { organizationId: ctx.organizationId, outletId: q.outletId }, select: { id: true, name: true } }),
    db.outletMaterialCost.findUnique({ where: { outletId_materialId: { outletId: q.outletId, materialId: material.id } }, select: { avgCost: true } }),
  ]);
  const total = byDept.reduce((s, g) => s.plus(D(g._sum.qty ?? 0)), D(0));
  const showValue = canSeeStockValue(ctx, q.outletId);
  return {
    materialId: material.id, sku: material.sku, name: material.name, active: material.active, unit: material.baseUnit.code, category: material.category?.name ?? null,
    onHand: num(roundQty(total)), reorderLevel: num(D(material.reorderLevel)),
    departments: byDept.filter((g) => !D(g._sum.qty ?? 0).isZero()).map((g) => ({ departmentId: g.departmentId, department: g.departmentId ? departments.find((d) => d.id === g.departmentId)?.name ?? "Department" : "Unassigned", qty: num(roundQty(D(g._sum.qty ?? 0))) })),
    ...(showValue ? { avgCost: cost ? num(D(cost.avgCost).toDecimalPlaces(6)) : null, value: cost ? num(money(total.times(D(cost.avgCost)))) : null } : {}),
  };
}
