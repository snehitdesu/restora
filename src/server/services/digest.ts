/**
 * The morning summary (proposal pp. 11, 17: "daily business summary pushed at 9 AM"). One figure set per outlet for
 * the previous business day: paid orders, revenue, average order, new unhappy feedback, items at or below their
 * reorder level, open anomalies. Built from the same tables the reports read; shown in the app (notification and a
 * preview screen) and, if the owner set a number, sent as one message. Revenue is paid orders net of refunds.
 */
import type { PrismaClient } from "@prisma/client";
import { assertCan } from "@/server/auth/rbac";
import { type AccessContext } from "@/server/db/scope";
import { systemContext } from "@/server/auth/context";
import { businessDayRange } from "@/domain/time";
import { orgTimeZone } from "@/server/services/businessDay";
import { lowStock } from "@/server/services/inventory";
import { getGrowthSettings } from "@/server/services/growthSettings";
import { D, money } from "@/domain/money";

export type DigestOutlet = { outletId: string; name: string; orders: number; revenue: number; averageOrder: number; unhappyFeedback: number; itemsToReorder: number; openAnomalies: number };
export type Digest = { date: string; restaurant: string; outlets: DigestOutlet[]; text: string };

/** Build the digest for the business day `date` (YYYY-MM-DD in the organization's time zone). Internal: callers authorize. */
export async function buildDigest(db: PrismaClient, organizationId: string, date: string): Promise<Digest> {
  const ctx = systemContext(organizationId);
  const tz = await orgTimeZone(db, ctx);
  const { start, end } = businessDayRange(date, tz);
  const settings = await getGrowthSettings(db, organizationId);
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  const outlets = await db.outlet.findMany({ where: { organizationId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const rows: DigestOutlet[] = [];
  for (const o of outlets) {
    const paid = await db.order.aggregate({ where: { organizationId, outletId: o.id, status: "PAID", paidAt: { gte: start, lt: end } }, _sum: { total: true }, _count: true });
    const refunded = await db.refund.aggregate({ where: { payment: { order: { organizationId, outletId: o.id, status: "PAID", paidAt: { gte: start, lt: end } } } }, _sum: { amount: true } });
    const revenue = money(D(paid._sum.total ?? 0).minus(D(refunded._sum.amount ?? 0)));
    const orders = paid._count;
    const unhappy = await db.feedback.count({ where: { organizationId, outletId: o.id, createdAt: { gte: start, lt: end }, rating: { lte: settings.lowRatingMax } } });
    const itemsToReorder = (await lowStock(db, ctx, o.id)).length;
    const anomalies = await db.anomaly.count({ where: { organizationId, outletId: o.id, status: "OPEN" } });
    rows.push({ outletId: o.id, name: o.name, orders, revenue: revenue.toNumber(), averageOrder: orders ? money(revenue.div(orders)).toNumber() : 0, unhappyFeedback: unhappy, itemsToReorder, openAnomalies: anomalies });
  }
  const inr = (n: number) => `Rs.${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = rows.map((r) => `${r.name}: ${r.orders} orders, ${inr(r.revenue)}${r.orders ? ` (avg ${inr(r.averageOrder)})` : ""}${r.unhappyFeedback ? `, ${r.unhappyFeedback} unhappy feedback` : ""}${r.itemsToReorder ? `, ${r.itemsToReorder} items to reorder` : ""}${r.openAnomalies ? `, ${r.openAnomalies} open alerts` : ""}`);
  return { date, restaurant: org?.name ?? "", outlets: rows, text: [`${org?.name ?? "RESTORA"} summary for ${date}`, ...lines].join("\n") };
}

/** The same figures for a screen: reports.view at the org level. */
export async function digestPreview(db: PrismaClient, ctx: AccessContext, date?: string): Promise<Digest> {
  assertCan(ctx, "reports.view");
  const tz = await orgTimeZone(db, ctx);
  const d = date ?? businessDayRange(new Date(Date.now() - 86400_000), tz).date;
  return buildDigest(db, ctx.organizationId, d);
}
