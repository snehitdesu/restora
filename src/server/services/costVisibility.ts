/**
 * Who may see money values next to stock (proposal pp. 8 and 12: a kitchen
 * login works with quantities and cannot see vendor pricing, costs or P&L).
 */
import type { AccessContext } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";

export const canSeeStockValue = (ctx: AccessContext, outletId: string) => can(ctx, "reports.view", outletId) || can(ctx, "purchase.view", outletId) || can(ctx, "finance.view", outletId);

/** Drop line costs from a wastage document for a login that may not see costs. */
export function withoutLineCosts<T extends { lines: Array<{ estCost: unknown }> }>(ctx: AccessContext, outletId: string, doc: T): T {
  if (canSeeStockValue(ctx, outletId)) return doc;
  return { ...doc, lines: doc.lines.map((l) => ({ ...l, estCost: null })) };
}
