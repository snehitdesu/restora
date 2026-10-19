/**
 * Cloud side of desktop sync: the authoritative, scoped read feed of online (QR / ONLINE) orders, and the idempotent
 * apply of desktop-originated actions. PostgreSQL stays the only source of truth for these orders — the desktop
 * mirrors them and asks this module to change them, it never changes them on its own.
 *
 *  - Everything is scoped by the caller's AccessContext (organization, outlet membership, order.view); nothing the
 *    client sends (org, outlet, price, status) is trusted beyond selecting which of its own outlets to read.
 *  - The feed is incremental: a cursor over (updatedAt, id) plus the small set of still-running orders (kitchen and
 *    payment changes do not always move Order.updatedAt, so running orders are always re-offered; the client skips
 *    the ones whose `revision` it already mirrors).
 *  - Actions reuse the real services (submitOrder, updateKOTStatus), so authorization, state machines, audit rows
 *    and KOT creation are exactly the hosted POS's. A SyncOpReceipt makes a retry (same opId) return the original
 *    outcome instead of applying the action twice.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { canTransition, KOT_TRANSITIONS, type KOTStatus } from "@/constants/enums";
import { assertCan, can } from "@/server/auth/rbac";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { prisma } from "@/server/db/client";
import { orderRef } from "@/server/services/bill";
import { submitOrder } from "@/server/services/orders";
import { updateKOTStatus } from "@/server/services/kot";
import { runAfterCommit } from "@/server/services/afterCommit";
import { SYNC_SOURCES, type SyncOpInput, type SyncOpResult, type SyncOutcome, type WireFeed, type WireOrder, type WireOutlet } from "@/lib/sync/wire";

const FINISHED = ["PAID", "CANCELLED", "REFUNDED"] as const;
const FEED_MAX_TAKE = 100;
const ACTIVE_CAP = 200;
const DEFAULT_BACKFILL_HOURS = 48;
const MAX_BACKFILL_HOURS = 24 * 14;
const MAX_REWIND_SECONDS = 300;

const ORDER_INCLUDE = {
  customer: { select: { name: true } },
  table: { select: { code: true } },
  items: { include: { menuItem: { select: { name: true } }, modifiers: true }, orderBy: { createdAt: "asc" as const } },
  kots: { include: { station: { select: { name: true } }, items: true }, orderBy: { number: "asc" as const } },
  payments: { orderBy: { createdAt: "asc" as const } },
};

type OrderRow = NonNullable<Awaited<ReturnType<typeof loadOrderRow>>>;

function loadOrderRow(db: PrismaClient, id: string) {
  return db.order.findUnique({ where: { id }, include: ORDER_INCLUDE });
}

const dec = (v: { toString(): string }) => v.toString();
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toWireOrder(o: OrderRow): WireOrder {
  const base = {
    id: o.id,
    ref: orderRef(o.id),
    outletId: o.outletId,
    status: o.status,
    channel: o.channel,
    source: o.source,
    tableCode: o.table?.code ?? null,
    covers: o.covers,
    guestName: o.customer?.name ?? null,
    notes: o.notes,
    subtotal: dec(o.subtotal),
    discount: dec(o.discount),
    tax: dec(o.tax),
    total: dec(o.total),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    paidAt: iso(o.paidAt),
    items: o.items.map((i) => ({
      id: i.id,
      menuItemName: i.menuItem?.name ?? null,
      name: i.name,
      qty: dec(i.qty),
      unitPrice: dec(i.unitPrice),
      discount: dec(i.discount),
      taxPct: dec(i.taxPct),
      lineTotal: dec(i.lineTotal),
      station: i.station,
      notes: i.notes,
      hsnSac: i.hsnSac,
      modifiers: i.modifiers.map((m) => ({ name: m.name, priceDelta: dec(m.priceDelta) })),
    })),
    kots: o.kots.map((k) => ({
      id: k.id,
      number: k.number,
      station: k.station?.name ?? null,
      status: k.status,
      createdAt: k.createdAt.toISOString(),
      acceptedAt: iso(k.acceptedAt),
      startedAt: iso(k.startedAt),
      readyAt: iso(k.readyAt),
      servedAt: iso(k.servedAt),
      items: k.items.map((ki) => ({ orderItemId: ki.orderItemId, name: ki.name, qty: dec(ki.qty), status: ki.status })),
    })),
    payments: o.payments.map((p) => ({ id: p.id, method: p.method, status: p.status, amount: dec(p.amount), verifiedAt: iso(p.verifiedAt), createdAt: p.createdAt.toISOString() })),
  };
  const revision = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 32);
  return { ...base, revision };
}

// ---------------- outlets ----------------

/** The outlets this caller may read orders for (member of the outlet, with order.view there). */
export async function listSyncOutlets(db: PrismaClient, ctx: AccessContext): Promise<WireOutlet[]> {
  const outlets = await db.outlet.findMany({ where: { organizationId: ctx.organizationId, active: true, id: { in: ctx.outletIds } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  return outlets.filter((o) => can(ctx, "order.view", o.id));
}

// ---------------- feed ----------------

export function encodeCursor(updatedAt: Date, id: string): string {
  return `${updatedAt.toISOString()}|${id}`;
}

export function decodeCursor(raw: string): { at: Date; id: string } {
  const i = raw.indexOf("|");
  const at = new Date(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (i < 0 || Number.isNaN(at.getTime()) || !id || id.length > 64) throw new ValidationError("Invalid cursor");
  return { at, id };
}

export type FeedQuery = { outletId: string; cursor?: string; take?: number; backfillHours?: number; includeActive?: boolean; rewindSeconds?: number };

export async function listOrderFeed(db: PrismaClient, ctx: AccessContext, q: FeedQuery): Promise<WireFeed> {
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "order.view", q.outletId);
  const take = Math.min(Math.max(Math.trunc(q.take ?? 50), 1), FEED_MAX_TAKE);
  const base = { organizationId: ctx.organizationId, outletId: q.outletId, source: { in: [...SYNC_SOURCES] } };
  const serverTime = new Date();

  let after: { at: Date; id: string };
  const from = q.cursor ? decodeCursor(q.cursor) : null;
  if (from) {
    // updatedAt is stamped when a transaction writes, not when it commits: re-reading a short window behind the
    // cursor picks up an order that became visible after a later-stamped one was already delivered.
    const rewindMs = Math.min(Math.max(Math.trunc(q.rewindSeconds ?? 0), 0), MAX_REWIND_SECONDS) * 1000;
    after = rewindMs ? { at: new Date(from.at.getTime() - rewindMs), id: "" } : from;
  } else {
    const hours = Math.min(Math.max(q.backfillHours ?? DEFAULT_BACKFILL_HOURS, 1), MAX_BACKFILL_HOURS);
    after = { at: new Date(serverTime.getTime() - hours * 3_600_000), id: "" };
  }
  const page = await db.order.findMany({
    where: { ...base, OR: [{ updatedAt: { gt: after.at } }, { updatedAt: after.at, id: { gt: after.id } }] },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: take + 1,
    select: { id: true, updatedAt: true },
  });
  const pageRows = page.slice(0, take);
  const hasMore = page.length > take;
  const ids = new Set(pageRows.map((r) => r.id));
  if (q.includeActive) {
    const active = await db.order.findMany({ where: { ...base, status: { notIn: [...FINISHED] } }, orderBy: [{ updatedAt: "desc" }], take: ACTIVE_CAP, select: { id: true } });
    for (const a of active) ids.add(a.id);
  }
  const rows = ids.size
    ? await db.order.findMany({
        where: { id: { in: [...ids] }, organizationId: ctx.organizationId, outletId: q.outletId, source: { in: [...SYNC_SOURCES] } },
        include: ORDER_INCLUDE,
      })
    : [];
  rows.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : 1));
  const last = pageRows.at(-1);
  // A rewound page that ends inside the re-read window must not move the position backwards.
  const behind = !hasMore && from && last && (last.updatedAt.getTime() < from.at.getTime() || (last.updatedAt.getTime() === from.at.getTime() && last.id < from.id));
  const nextCursor = last && !behind ? encodeCursor(last.updatedAt, last.id) : (q.cursor ?? null);
  return { orders: rows.map(toWireOrder), nextCursor, hasMore, serverTime: serverTime.toISOString() };
}

export async function getSyncOrder(db: PrismaClient, ctx: AccessContext, orderId: string): Promise<WireOrder> {
  const o = await loadOrderRow(db, orderId);
  if (!o || o.organizationId !== ctx.organizationId || !(SYNC_SOURCES as readonly string[]).includes(o.source)) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, o.outletId);
  assertCan(ctx, "order.view", o.outletId);
  return toWireOrder(o);
}

// ---------------- operations ----------------

const KOT_RANK: Record<string, number> = { NEW: 0, ACCEPTED: 1, PREPARING: 2, READY: 3, SERVED: 4 };
const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

type Applied = { outcome: SyncOutcome; detail: string | null };

async function applyAccept(ctx: AccessContext, orderId: string, db: PrismaClient): Promise<Applied> {
  const decide = (status: string): Applied | null => {
    if (status === "CANCELLED" || status === "REFUNDED") return { outcome: "CONFLICT", detail: `The order was ${status.toLowerCase()} in the cloud before this acceptance arrived` };
    if (status !== "OPEN") return { outcome: "ALREADY", detail: "The order had already been accepted" };
    return null;
  };
  const cur = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  const early = decide(cur.status);
  if (early) return early;
  try {
    await submitOrder(ctx, orderId, db);
  } catch (e) {
    // Someone (the hosted POS) moved the order between our read and the write: classify by what it is now.
    const now = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    const verdict = decide(now.status);
    if (verdict && e instanceof ValidationError) return verdict;
    throw e;
  }
  runAfterCommit("kots-created", async () => (await import("@/server/services/integrationHooks")).afterKotsCreated(ctx, orderId));
  return { outcome: "APPLIED", detail: null };
}

async function applyKotStatus(ctx: AccessContext, orderId: string, kotId: string, to: KOTStatus, db: PrismaClient): Promise<Applied> {
  const kot = await db.kot.findUnique({ where: { id: kotId }, select: { id: true, orderId: true, status: true, organizationId: true } });
  if (!kot || kot.organizationId !== ctx.organizationId || kot.orderId !== orderId) throw new NotFoundError("Ticket not found");
  const classify = (cur: string): Applied | null => {
    if (cur === to) return { outcome: "ALREADY", detail: null };
    if (cur === "CANCELLED") return { outcome: "CONFLICT", detail: "The ticket was cancelled in the cloud" };
    if ((KOT_RANK[cur] ?? 0) > KOT_RANK[to]) return { outcome: "SUPERSEDED", detail: `The ticket is already ${cur}` };
    if (!canTransition(KOT_TRANSITIONS, cur as KOTStatus, to)) return { outcome: "CONFLICT", detail: `The ticket is ${cur}; it cannot go to ${to} directly` };
    return null;
  };
  const early = classify(kot.status);
  if (early) return early;
  try {
    await updateKOTStatus(ctx, kotId, to, db);
  } catch (e) {
    const now = await db.kot.findUniqueOrThrow({ where: { id: kotId }, select: { status: true } });
    const verdict = classify(now.status);
    if (verdict) return verdict;
    throw e;
  }
  return { outcome: "APPLIED", detail: null };
}

/** Apply one desktop-originated action exactly once (receipt-keyed) and return the order as it now stands in the cloud. */
export async function applySyncOp(ctx: AccessContext, input: SyncOpInput, db: PrismaClient = prisma): Promise<SyncOpResult> {
  const order = await db.order.findUnique({ where: { id: input.orderId }, select: { id: true, organizationId: true, outletId: true, source: true } });
  if (!order || order.organizationId !== ctx.organizationId || !(SYNC_SOURCES as readonly string[]).includes(order.source)) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  assertCan(ctx, "order.view", order.outletId);

  const answer = async (outcome: string, detail: string | null, replayed: boolean): Promise<SyncOpResult> => ({
    opId: input.opId,
    outcome: outcome as SyncOutcome,
    detail,
    replayed,
    order: toWireOrder((await loadOrderRow(db, input.orderId))!),
  });
  const prior = await db.syncOpReceipt.findUnique({ where: { organizationId_opId: { organizationId: ctx.organizationId, opId: input.opId } } });
  if (prior) {
    // The same opId is only ever the same request: anything else is a client bug, not a replay.
    if (prior.orderId !== input.orderId || prior.action !== input.action) throw new ValidationError("This operation id was already used for a different request");
    return answer(prior.outcome, prior.detail, true);
  }

  const applied = input.action === "ACCEPT" ? await applyAccept(ctx, input.orderId, db) : await applyKotStatus(ctx, input.orderId, input.kotId, input.to, db);
  try {
    await db.syncOpReceipt.create({ data: { organizationId: ctx.organizationId, outletId: order.outletId, opId: input.opId, action: input.action, orderId: input.orderId, outcome: applied.outcome, detail: applied.detail, actorId: ctx.userId, actorLabel: input.actorLabel ?? null } });
  } catch (e) {
    if (!isUnique(e)) throw e;
    const winner = await db.syncOpReceipt.findUnique({ where: { organizationId_opId: { organizationId: ctx.organizationId, opId: input.opId } } });
    if (winner) return answer(winner.outcome, winner.detail, true);
    throw e;
  }
  return answer(applied.outcome, applied.detail, false);
}
