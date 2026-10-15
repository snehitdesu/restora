/**
 * Desktop side: what happens when staff act on an order that is a mirror of a cloud order.
 *
 * The cloud owns these orders, so the desktop must never change its local copy on its own authority. For a mirrored
 * order (and only on the desktop: AHAROS_DESKTOP=1) the router hands every state-changing request here first:
 *
 *   accept (POST /api/orders/:id/submit)       → a durable ACCEPT operation, sent to the cloud with its own id. The local
 *                                                copy changes only when the cloud answers (or the queue drains later);
 *                                                until then the order is honestly still "awaiting acceptance" here.
 *   kitchen ticket progress                    → a KOT_STATUS operation, same way.
 *   payment (create / verify)                  → forwarded to the cloud and mirrored back. Online only: a payment is
 *                                                never recorded without the cloud's own verification.
 *   anything else (edit lines, discount, cancel, merge, refund …)
 *                                              → refused with a plain explanation: done on the hosted POS, where the
 *                                                cloud's rules (step-up re-authentication, refunds) apply.
 *
 * Orders that are not mirrors (counter sales made on this desktop) never reach any of this.
 */
import type { PrismaClient } from "@prisma/client";
import { canTransition, KOT_TRANSITIONS, type KOTStatus } from "@/constants/enums";
import { assertCan, can } from "@/server/auth/rbac";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { mirrorId } from "@/lib/sync/ids";
import type { WireOrder } from "@/lib/sync/wire";
import { CloudAuthError, CloudClient, CloudHttpError, CloudOfflineError, CloudUnavailableError, isTransientCloudError } from "@/server/sync/cloudClient";
import { getLink, readToken } from "@/server/sync/link";
import { mirrorOrder, type MirrorTarget } from "@/server/sync/mirror";
import { enqueueOperation, sendOperation } from "@/server/sync/runner";
import { getOrder } from "@/server/services/orders";

export { CloudUnavailableError };

export type GuardInput = {
  ctx: AccessContext;
  method: string;
  /** Catch-all route segments after `/api/<mount>/`. */
  segs: string[];
  body: unknown;
  idempotencyKey?: string;
  /** API mount from createRouter (e.g. "payments"), when the test helper's pathname is `/api/x/`. */
  resource?: string;
  pathname?: string;
};
export type Guarded = { handled: true; value: unknown } | null;

function apiResource(a: GuardInput): string | undefined {
  if (a.resource) return a.resource;
  const path = a.pathname ?? "";
  const m = /^\/api\/([^/]+)/.exec(path);
  return m?.[1];
}

function isPaymentsApi(a: GuardInput): boolean {
  const resource = apiResource(a);
  if (resource === "payments") return true;
  const path = a.pathname ?? "";
  return path === "/api/payments" || path.startsWith("/api/payments/");
}

const REFUSAL = "This is an online QR order managed in the cloud. On this computer you can accept it and move its kitchen tickets along; take payment here while connected; change, discount, cancel or refund it on the hosted POS.";

export const mirroredBy = (db: PrismaClient, organizationId: string, kind: string, localId: string) =>
  db.cloudRecordMap.findFirst({ where: { organizationId, kind, localId } });

async function connection(db: PrismaClient, organizationId: string) {
  const link = await getLink(db, organizationId);
  if (!link) throw new ValidationError("This computer is not linked to the cloud");
  const token = readToken(link);
  const target: MirrorTarget = { organizationId, localOutletId: link.localOutletId, cloudOutletId: link.cloudOutletId };
  return { link, token, target, client: token ? new CloudClient({ baseUrl: link.baseUrl, token }) : null };
}

export async function guardMirroredRequest(db: PrismaClient, a: GuardInput): Promise<Guarded> {
  if (process.env.AHAROS_DESKTOP !== "1" || a.method === "GET") return null;
  const seg = a.segs;
  const org = a.ctx.organizationId;

  if (seg[0] === "kots" && seg[1]) {
    const map = await mirroredBy(db, org, "KOT", seg[1]);
    if (!map) return null;
    if (seg[2] === "status") return { handled: true, value: await kotStatusMirrored(db, a.ctx, map, (a.body as { status?: unknown })?.status) };
    throw new ConflictError(REFUSAL);
  }
  if (seg[0] === "items" && seg[1]) {
    const item = await mirroredBy(db, org, "ORDER_ITEM", seg[1]);
    if (item) throw new ConflictError(REFUSAL);
    return null;
  }
  if (isPaymentsApi(a)) {
    if (seg.length === 0 && a.method === "POST") {
      const orderId = (a.body as { orderId?: unknown })?.orderId;
      if (typeof orderId !== "string") return null;
      const map = await mirroredBy(db, org, "ORDER", orderId);
      return map ? { handled: true, value: await createPaymentMirrored(db, a.ctx, map, a.body as Record<string, unknown>, a.idempotencyKey) } : null;
    }
    if (seg[1] === "verify") {
      const payment = await mirroredBy(db, org, "PAYMENT", seg[0]);
      if (!payment) return null;
      return { handled: true, value: await verifyPaymentMirrored(db, a.ctx, payment, a.body, a.idempotencyKey) };
    }
    return null;
  }
  if (seg[0] && seg[0] !== "items" && seg[0] !== "kots") {
    const map = await mirroredBy(db, org, "ORDER", seg[0]);
    if (!map) return null;
    if (seg[1] === "submit" && a.method === "POST") return { handled: true, value: await acceptMirrored(db, a.ctx, map) };
    throw new ConflictError(REFUSAL);
  }
  return null;
}

// ---------------- accept ----------------

type MapRow = { organizationId: string; cloudId: string; localId: string; issues: string | null };

async function withSync(db: PrismaClient, ctx: AccessContext, localOrderId: string, sync: Record<string, unknown>) {
  return { ...(await getOrder(db, ctx, localOrderId)), sync };
}

async function acceptMirrored(db: PrismaClient, ctx: AccessContext, map: MapRow) {
  const order = await db.order.findUnique({ where: { id: map.localId }, select: { id: true, status: true, outletId: true } });
  if (!order) throw new NotFoundError("Order not found");
  assertCan(ctx, "order.modify", order.outletId);
  const issues = JSON.parse(map.issues ?? "[]") as string[];
  if (issues.length) throw new ValidationError(`This order cannot be accepted on this computer yet: ${issues.slice(0, 3).join("; ")}. Fix the menu or floor plan here, or accept it on the hosted POS.`);
  if (order.status !== "OPEN") return withSync(db, ctx, order.id, { state: "CONFIRMED", outcome: "ALREADY" });
  return submitOperation(db, ctx, order.id, map, "ACCEPT", {});
}

async function submitOperation(db: PrismaClient, ctx: AccessContext, localOrderId: string, map: MapRow, action: "ACCEPT" | "KOT_STATUS", payload: Record<string, string>) {
  const { token, target, client } = await connection(db, ctx.organizationId);
  const { id } = await enqueueOperation(db, { organizationId: ctx.organizationId, localOrderId, cloudOrderId: map.cloudId, action, payload, createdById: ctx.userId });
  if (!client || !token) return withSync(db, ctx, localOrderId, { state: "QUEUED", opId: id, detail: "Waiting for the cloud sign-in" });
  try {
    const r = await sendOperation(db, client, target, id);
    if (r.status === "PENDING") return withSync(db, ctx, localOrderId, { state: "QUEUED", opId: id });
    if (r.status === "CONFLICT") return withSync(db, ctx, localOrderId, { state: "CONFLICT", opId: id, outcome: r.outcome, detail: r.detail });
    if (r.status === "REJECTED") throw new ConflictError(r.detail ?? "The cloud refused this action");
    return withSync(db, ctx, localOrderId, { state: "CONFIRMED", opId: id, outcome: r.outcome });
  } catch (e) {
    if (e instanceof CloudAuthError || isTransientCloudError(e)) return withSync(db, ctx, localOrderId, { state: "QUEUED", opId: id, detail: e instanceof CloudAuthError ? "Waiting for the cloud sign-in" : "Waiting for the connection" });
    throw e;
  }
}

// ---------------- kitchen tickets ----------------

async function kotStatusMirrored(db: PrismaClient, ctx: AccessContext, map: MapRow, rawTo: unknown) {
  const to = rawTo as KOTStatus;
  if (!["ACCEPTED", "PREPARING", "READY", "SERVED"].includes(String(to))) throw new ConflictError("Cancelling or re-routing a cloud order's kitchen ticket is done on the hosted POS");
  const kot = await db.kot.findUnique({ where: { id: map.localId }, select: { id: true, orderId: true, outletId: true, status: true } });
  if (!kot) throw new NotFoundError("KOT not found");
  if (!(to === "SERVED" && can(ctx, "kot.serve", kot.outletId))) assertCan(ctx, "kot.update", kot.outletId);
  // Actions already waiting for this ticket count: the next step is judged from where the queue will leave it.
  const waiting = await db.syncOperation.findMany({ where: { organizationId: ctx.organizationId, localOrderId: kot.orderId, action: "KOT_STATUS", status: "PENDING" }, orderBy: { createdAt: "asc" }, select: { payload: true } });
  let effective = kot.status;
  for (const w of waiting) {
    const p = JSON.parse(w.payload) as { kotId?: string; to?: string };
    if (p.kotId === map.cloudId && p.to) effective = p.to;
  }
  if (effective === to) return withSync(db, ctx, kot.orderId, { state: effective === kot.status ? "CONFIRMED" : "QUEUED", outcome: "ALREADY" });
  if (!canTransition(KOT_TRANSITIONS, effective as KOTStatus, to)) throw new ValidationError(`Cannot move KOT from ${effective} to ${to}`);
  const orderMap = await mirroredBy(db, ctx.organizationId, "ORDER", kot.orderId);
  if (!orderMap) throw new NotFoundError("Order not found");
  return submitOperation(db, ctx, kot.orderId, orderMap, "KOT_STATUS", { kotId: map.cloudId, to });
}

// ---------------- payments (online only) ----------------

async function cloudCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CloudUnavailableError) throw e;
    if (e instanceof CloudOfflineError || (e instanceof CloudHttpError && e.transient)) throw new CloudUnavailableError();
    if (e instanceof CloudAuthError) throw e;
    if (e instanceof CloudHttpError) throw e.status === 404 ? new NotFoundError(e.message) : e.status === 403 ? new ConflictError(e.message) : new ValidationError(e.message);
    throw e;
  }
}

async function refreshMirror(db: PrismaClient, client: CloudClient, target: MirrorTarget, cloudOrderId: string) {
  const wire = await client.get<WireOrder>(`/api/sync/orders/${encodeURIComponent(cloudOrderId)}`);
  await mirrorOrder(db, target, wire);
}

async function createPaymentMirrored(db: PrismaClient, ctx: AccessContext, map: MapRow, body: Record<string, unknown>, idempotencyKey?: string) {
  const order = await db.order.findUnique({ where: { id: map.localId }, select: { outletId: true } });
  if (!order) throw new NotFoundError("Order not found");
  assertCan(ctx, "payment.take", order.outletId);
  const { client, target } = await connection(db, ctx.organizationId);
  if (!client) throw new CloudAuthError("The cloud sign-in has ended. Sign in to the cloud again (Cloud sync page), then retry.");
  const dto = await cloudCall(async () => {
    const created = await client.post<{ id: string } & Record<string, unknown>>("/api/payments", { ...body, orderId: map.cloudId }, { idempotencyKey });
    await refreshMirror(db, client, target, map.cloudId);
    return created;
  });
  return { ...dto, id: mirrorId("PAYMENT", dto.id, ctx.organizationId), orderId: map.localId };
}

async function verifyPaymentMirrored(db: PrismaClient, ctx: AccessContext, pay: MapRow, body: unknown, idempotencyKey?: string) {
  const local = await db.payment.findUnique({ where: { id: pay.localId }, select: { orderId: true, outletId: true } });
  if (!local) throw new NotFoundError("Payment not found");
  assertCan(ctx, "payment.take", local.outletId);
  const orderMap = await mirroredBy(db, ctx.organizationId, "ORDER", local.orderId);
  const { client, target } = await connection(db, ctx.organizationId);
  if (!client || !orderMap) throw new CloudAuthError("The cloud sign-in has ended. Sign in to the cloud again (Cloud sync page), then retry.");
  const res = await cloudCall(async () => {
    const r = await client.post<{ payment: { id: string } & Record<string, unknown> } & Record<string, unknown>>(`/api/payments/${encodeURIComponent(pay.cloudId)}/verify`, body ?? {}, { idempotencyKey });
    await refreshMirror(db, client, target, orderMap.cloudId);
    return r;
  });
  return { ...res, payment: { ...res.payment, id: pay.localId, orderId: local.orderId } };
}
