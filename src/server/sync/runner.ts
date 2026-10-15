/**
 * Desktop side: one synchronization cycle.
 *
 *   1. OUTBOX — staff actions on mirrored orders (accept, ticket progress) that could not reach the cloud yet, sent in
 *      the order they were taken, each with its stable operation id. The cloud applies an id once, so a retry after a
 *      lost response, a crash or a restart can never accept an order or create a kitchen ticket twice. The cloud's
 *      answer decides the outcome: APPLIED / ALREADY / SUPERSEDED finish the action; CONFLICT (e.g. the order was
 *      cancelled in the cloud meanwhile) is kept visible for a person — nothing is silently overwritten either way.
 *   2. PULL — the incremental order feed from the saved cursor (plus the still-running orders), mirrored into SQLite.
 *
 * One cycle runs at a time per organization (single-flight). Network failure never throws out of a cycle: it is
 * recorded on the link (the status shows OFFLINE and how stale the cache is) and the next cycle retries. A 401 marks
 * the link AUTH_REQUIRED and stops all cloud calls until someone signs in again.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError } from "@/server/db/scope";
import { log } from "@/server/observability/log";
import { CloudAuthError, CloudClient, CloudHttpError, CloudUnavailableError, isTransientCloudError, type Transport } from "@/server/sync/cloudClient";
import { getLink, readToken } from "@/server/sync/link";
import { mirrorOrder, type MirrorTarget } from "@/server/sync/mirror";
import type { SyncOpInput, SyncOpResult, WireFeed } from "@/lib/sync/wire";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_CYCLE = 20;
const OPS_PER_CYCLE = 50;
/** Operation retry spacing: 5 s, 10 s, 20 s … capped at 5 minutes. */
export const opBackoffMs = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);

export type CycleResult = {
  state: "UNLINKED" | "ONLINE" | "OFFLINE" | "AUTH_REQUIRED";
  imported: number;
  updated: number;
  opsDone: number;
  opsConflict: number;
  error?: string;
};

export type SyncDeps = { transport?: Transport; now?: () => Date };

const running = new Map<string, Promise<CycleResult>>();

function safeMessage(e: unknown): string {
  if (e instanceof CloudAuthError || e instanceof CloudHttpError || e instanceof CloudUnavailableError) return e.message;
  if (e instanceof Error && e.name === "CloudOfflineError") return "The cloud could not be reached";
  return "Unexpected synchronization error";
}

/** Run a cycle now; a cycle already running for this organization is joined instead of duplicated. */
export function runSyncCycle(db: PrismaClient, organizationId: string, deps: SyncDeps = {}): Promise<CycleResult> {
  const existing = running.get(organizationId);
  if (existing) return existing;
  const p = cycle(db, organizationId, deps).finally(() => running.delete(organizationId));
  running.set(organizationId, p);
  return p;
}

async function cycle(db: PrismaClient, organizationId: string, deps: SyncDeps): Promise<CycleResult> {
  const link = await getLink(db, organizationId);
  const result: CycleResult = { state: "ONLINE", imported: 0, updated: 0, opsDone: 0, opsConflict: 0 };
  if (!link) return { ...result, state: "UNLINKED" };
  const token = readToken(link);
  if (link.status === "AUTH_REQUIRED" || !token) return { ...result, state: "AUTH_REQUIRED", error: "Sign in to the cloud again" };

  const client = new CloudClient({ baseUrl: link.baseUrl, token, transport: deps.transport });
  const target: MirrorTarget = { organizationId, localOutletId: link.localOutletId, cloudOutletId: link.cloudOutletId };
  const now = deps.now ?? (() => new Date());
  await db.cloudLink.update({ where: { organizationId }, data: { lastAttemptAt: now() } });
  try {
    const sent = await drainOutbox(db, client, target, now);
    result.opsDone = sent.done;
    result.opsConflict = sent.conflict;
    const pulled = await pullFeed(db, client, target, link.cursor);
    result.imported = pulled.imported;
    result.updated = pulled.updated;
    await db.cloudLink.update({ where: { organizationId }, data: { lastSuccessAt: now(), lastError: null, status: "LINKED", ...(pulled.cursor ? { cursor: pulled.cursor } : {}) } });
    return result;
  } catch (e) {
    if (e instanceof CloudAuthError || (e instanceof CloudHttpError && (e.status === 401 || e.status === 403))) {
      await db.cloudLink.update({ where: { organizationId }, data: { status: "AUTH_REQUIRED", lastError: "The cloud ended this sign-in. Sign in again to resume." } });
      log.warn("cloud sync: session ended by the cloud", { event: "cloud_sync_auth" });
      return { ...result, state: "AUTH_REQUIRED", error: "The cloud ended this sign-in" };
    }
    const message = safeMessage(e);
    await db.cloudLink.update({ where: { organizationId }, data: { lastError: message } });
    if (!isTransientCloudError(e)) log.error("cloud sync cycle failed", { event: "cloud_sync_failed", error: message });
    return { ...result, state: "OFFLINE", error: message };
  }
}

// ---------------- pull ----------------

async function pullFeed(db: PrismaClient, client: CloudClient, target: MirrorTarget, startCursor: string | null) {
  let cursor = startCursor;
  let imported = 0;
  let updated = 0;
  for (let page = 0; page < MAX_PAGES_PER_CYCLE; page++) {
    const q = new URLSearchParams({ outletId: target.cloudOutletId, take: String(PAGE_SIZE) });
    if (cursor) q.set("cursor", cursor);
    if (page === 0) q.set("includeActive", "1");
    const feed = await client.get<WireFeed>(`/api/sync/orders?${q}`, { background: true });
    let failed: unknown = null;
    for (const wire of feed.orders) {
      try {
        const r = await mirrorOrder(db, target, wire);
        if (r.action === "created") imported++;
        else if (r.action === "updated") updated++;
      } catch (e) {
        failed ??= e;
        log.error("cloud sync: could not mirror an order", { event: "cloud_sync_mirror_failed", order: wire.ref, error: e });
      }
    }
    // The feed position only advances over a page that was mirrored completely: a failed order is retried next cycle.
    if (failed) throw failed;
    if (feed.nextCursor) cursor = feed.nextCursor;
    if (!feed.hasMore) break;
  }
  return { imported, updated, cursor };
}

// ---------------- outbox ----------------

/** Queue a staff action on a mirrored order. Durable before anything is sent; an identical action already waiting is reused. */
export async function enqueueOperation(db: PrismaClient, input: { organizationId: string; localOrderId: string; cloudOrderId: string; action: SyncOpInput["action"]; payload: Record<string, string>; createdById?: string }): Promise<{ id: string; created: boolean }> {
  const payload = JSON.stringify(input.payload);
  const dup = await db.syncOperation.findFirst({ where: { organizationId: input.organizationId, localOrderId: input.localOrderId, action: input.action, payload, status: "PENDING" }, select: { id: true } });
  if (dup) return { id: dup.id, created: false };
  const op = await db.syncOperation.create({ data: { id: randomUUID(), organizationId: input.organizationId, localOrderId: input.localOrderId, cloudOrderId: input.cloudOrderId, action: input.action, payload, createdById: input.createdById } });
  return { id: op.id, created: true };
}

function toWireInput(op: { id: string; action: string; cloudOrderId: string; payload: string }): SyncOpInput {
  const p = JSON.parse(op.payload) as { kotId?: string; to?: string; actor?: string };
  const base = { opId: op.id, orderId: op.cloudOrderId, actorLabel: p.actor };
  return (op.action === "ACCEPT" ? { action: "ACCEPT", ...base } : { action: "KOT_STATUS", ...base, kotId: p.kotId, to: p.to }) as SyncOpInput;
}

export type SendOutcome = { sent: boolean; status: "DONE" | "CONFLICT" | "REJECTED" | "PENDING"; outcome?: string; detail?: string | null };

/** Send one queued action. Compare-and-set claim so an overlapping sender never posts the same attempt twice. */
export async function sendOperation(db: PrismaClient, client: CloudClient, target: MirrorTarget, opId: string, now: () => Date = () => new Date()): Promise<SendOutcome> {
  const op = await db.syncOperation.findUnique({ where: { id: opId } });
  if (!op || op.status !== "PENDING") return { sent: false, status: (op?.status as SendOutcome["status"]) ?? "PENDING" };
  const claimed = await db.syncOperation.updateMany({ where: { id: opId, status: "PENDING", attempts: op.attempts }, data: { attempts: op.attempts + 1, nextAttemptAt: new Date(now().getTime() + opBackoffMs(op.attempts + 1)) } });
  if (claimed.count !== 1) return { sent: false, status: "PENDING" };
  try {
    const res = await client.post<SyncOpResult>("/api/sync/ops", toWireInput(op));
    const status = res.outcome === "CONFLICT" ? "CONFLICT" : "DONE";
    await db.syncOperation.update({ where: { id: opId }, data: { status, outcome: res.outcome, lastError: res.detail, completedAt: now() } });
    await mirrorOrder(db, target, res.order).catch((e) => log.error("cloud sync: could not mirror an order after an action", { event: "cloud_sync_mirror_failed", error: e }));
    return { sent: true, status, outcome: res.outcome, detail: res.detail };
  } catch (e) {
    if (e instanceof CloudAuthError) {
      // Not the operation's fault: leave it queued and make it due as soon as the operator signs in again.
      await db.syncOperation.update({ where: { id: opId }, data: { attempts: op.attempts, nextAttemptAt: now(), lastError: "Waiting for the cloud sign-in" } });
      throw e;
    }
    if (isTransientCloudError(e)) {
      await db.syncOperation.update({ where: { id: opId }, data: { lastError: safeMessage(e) } });
      throw e;
    }
    // The cloud understood the request and refused it for good (not allowed, order unknown, invalid): never retried.
    await db.syncOperation.update({ where: { id: opId }, data: { status: "REJECTED", lastError: safeMessage(e), completedAt: now() } });
    return { sent: true, status: "REJECTED", detail: safeMessage(e) };
  }
}

async function drainOutbox(db: PrismaClient, client: CloudClient, target: MirrorTarget, now: () => Date) {
  const due = await db.syncOperation.findMany({ where: { organizationId: target.organizationId, status: "PENDING", nextAttemptAt: { lte: now() } }, orderBy: { createdAt: "asc" }, take: OPS_PER_CYCLE, select: { id: true } });
  let done = 0;
  let conflict = 0;
  for (const { id } of due) {
    // A transient failure rethrows and ends the drain: later actions on the same order must not overtake this one.
    const r = await sendOperation(db, client, target, id, now);
    if (r.status === "DONE") done++;
    else if (r.status === "CONFLICT" || r.status === "REJECTED") conflict++;
  }
  return { done, conflict };
}

// ---------------- operator controls ----------------

/** "Retry now": make every waiting action due immediately and run a cycle. */
export async function retryNow(db: PrismaClient, organizationId: string, deps: SyncDeps = {}): Promise<CycleResult> {
  await db.syncOperation.updateMany({ where: { organizationId, status: "PENDING" }, data: { nextAttemptAt: new Date() } });
  return runSyncCycle(db, organizationId, deps);
}

/** A person dismisses a conflicted / rejected action after looking at it (the cloud's state is already mirrored). */
export async function dismissOperation(db: PrismaClient, organizationId: string, opId: string): Promise<void> {
  const op = await db.syncOperation.findUnique({ where: { id: opId } });
  if (!op || op.organizationId !== organizationId) throw new NotFoundError("Action not found");
  if (op.status !== "CONFLICT" && op.status !== "REJECTED") throw new ConflictError("Only an action that needs attention can be dismissed");
  await db.syncOperation.update({ where: { id: opId }, data: { status: "RESOLVED" } });
}

export type OperationView = { id: string; localOrderId: string; action: string; status: string; outcome: string | null; detail: string | null; attempts: number; createdAt: string; completedAt: string | null; ref: string };

export async function listOperations(db: PrismaClient, organizationId: string, opts: { attention?: boolean; take?: number } = {}): Promise<OperationView[]> {
  const rows = await db.syncOperation.findMany({
    where: { organizationId, status: opts.attention ? { in: ["PENDING", "CONFLICT", "REJECTED"] } : undefined },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 50, 200),
  });
  return rows.map((o) => ({ id: o.id, localOrderId: o.localOrderId, action: o.action, status: o.status, outcome: o.outcome, detail: o.lastError, attempts: o.attempts, createdAt: o.createdAt.toISOString(), completedAt: o.completedAt?.toISOString() ?? null, ref: o.localOrderId.slice(-6).toUpperCase() }));
}
