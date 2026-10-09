/**
 * One queue for everything purchasing has in flight (audit PP-04, proposal p. 5: "vendor POs and internal indents share one
 * queue, filtered by status tabs"): purchase orders and indents together, newest first, with the tabs that matter to the
 * people who use it.
 *
 *   needs-approval  submitted and waiting for someone with purchase.approve
 *   in-progress     raised, approved or ordered, goods not all in yet
 *   done            received, billed, closed or cancelled
 *   all
 *
 * Reads follow what the two lists already allow: purchase orders need purchase.view (and carry amounts); a login that
 * may only raise indents (the kitchen) sees indents, without a price in sight. Paging is by (createdAt, id), merged
 * across both tables, so a page never skips or repeats a document.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, ForbiddenError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { authorizedOutletIds } from "@/server/services/analytics";
import { money, num } from "@/domain/money";

export const QUEUE_TABS = ["needs-approval", "in-progress", "done", "all"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

const PO_STATES: Record<Exclude<QueueTab, "all">, string[]> = { "needs-approval": ["SUBMITTED"], "in-progress": ["DRAFT", "APPROVED", "ORDERED", "PARTIAL"], done: ["RECEIVED", "BILLED", "CLOSED", "CANCELLED"] };
const INDENT_STATES: Record<Exclude<QueueTab, "all">, string[]> = { "needs-approval": ["SUBMITTED"], "in-progress": ["DRAFT", "APPROVED"], done: ["CLOSED", "CANCELLED"] };

const inputSchema = z.object({
  outletId: z.string().optional(),
  tab: z.enum(QUEUE_TABS).default("needs-approval"),
  kind: z.enum(["all", "purchase-order", "indent"]).default("all"),
  take: z.coerce.number().int().positive().max(100).default(30),
  /** `<ISO createdAt>|<id>` of the last row of the previous page. */
  cursor: z.string().max(80).optional(),
});

export type QueueItem = {
  kind: "PURCHASE_ORDER" | "INDENT";
  id: string;
  number: string;
  status: string;
  outletId: string;
  createdAt: string;
  lines: number;
  /** Purchase orders only, and only for logins that may see prices. */
  total: number | null;
  vendorId: string | null;
  /** Raised from the reorder screen ("REORDER") or made by hand. */
  source: string | null;
  href: string;
};
export type QueueResult = { items: QueueItem[]; nextCursor: string | null; counts: Record<Exclude<QueueTab, "all">, number>; includesPurchaseOrders: boolean };

function parseCursor(raw?: string): { at: Date; id: string } | null {
  if (!raw) return null;
  const [iso, id] = raw.split("|");
  const at = new Date(iso);
  return id && !Number.isNaN(at.getTime()) ? { at, id } : null;
}
/** Rows strictly older than the cursor in (createdAt desc, id desc) order. */
const before = (c: { at: Date; id: string } | null) => (c ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : {});

export async function procurementQueue(db: PrismaClient, ctx: AccessContext, input: z.input<typeof inputSchema> = {}): Promise<QueueResult> {
  const f = inputSchema.parse(input);
  const seesOrders = can(ctx, "purchase.view", f.outletId);
  const seesIndents = seesOrders || can(ctx, "indent.create", f.outletId);
  if (!seesIndents) throw new ForbiddenError("Missing permission to see purchasing documents");
  const wantOrders = seesOrders && f.kind !== "indent";
  const wantIndents = seesIndents && f.kind !== "purchase-order";
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, seesOrders ? "purchase.view" : "indent.create");
  const org = { organizationId: ctx.organizationId, outletId: { in: ids } };
  const cursor = parseCursor(f.cursor);
  const statusIn = (map: typeof PO_STATES, tab: QueueTab) => (tab === "all" ? {} : { status: { in: map[tab] } });

  const [orders, indents] = await Promise.all([
    wantOrders
      ? db.purchaseOrder.findMany({ where: { ...org, ...statusIn(PO_STATES, f.tab), ...before(cursor) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.take + 1, select: { id: true, number: true, status: true, outletId: true, createdAt: true, total: true, vendorId: true, source: true, _count: { select: { lines: true } } } })
      : Promise.resolve([]),
    wantIndents
      ? db.purchaseIndent.findMany({ where: { ...org, ...statusIn(INDENT_STATES, f.tab), ...before(cursor) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.take + 1, select: { id: true, number: true, status: true, outletId: true, createdAt: true, source: true, _count: { select: { lines: true } } } })
      : Promise.resolve([]),
  ]);

  const merged: Array<QueueItem & { at: Date }> = [
    ...orders.map((o) => ({ kind: "PURCHASE_ORDER" as const, id: o.id, number: o.number, status: o.status, outletId: o.outletId, at: o.createdAt, createdAt: o.createdAt.toISOString(), lines: o._count.lines, total: num(money(o.total)), vendorId: o.vendorId, source: o.source, href: `/procurement/purchase-orders/${o.id}` })),
    ...indents.map((i) => ({ kind: "INDENT" as const, id: i.id, number: i.number, status: i.status, outletId: i.outletId, at: i.createdAt, createdAt: i.createdAt.toISOString(), lines: i._count.lines, total: null, vendorId: null, source: i.source, href: `/procurement/indents/${i.id}` })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
  const page = merged.slice(0, f.take);
  const last = page.at(-1);
  const nextCursor = merged.length > f.take && last ? `${last.at.toISOString()}|${last.id}` : null;

  // Tab counts for the chips (same scope and kind filter, ignoring the tab and the page).
  const count = async (tab: Exclude<QueueTab, "all">) =>
    (wantOrders ? await db.purchaseOrder.count({ where: { ...org, status: { in: PO_STATES[tab] } } }) : 0) + (wantIndents ? await db.purchaseIndent.count({ where: { ...org, status: { in: INDENT_STATES[tab] } } }) : 0);
  const counts = { "needs-approval": await count("needs-approval"), "in-progress": await count("in-progress"), done: await count("done") };

  return { items: page.map(({ at: _at, ...item }) => { void _at; return item; }), nextCursor, counts, includesPurchaseOrders: wantOrders };
}
