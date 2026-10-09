/**
 * Switch a dish on or off on the ordering platforms (audit AG-04, proposal p. 17: "switch items on/off across platforms").
 *
 * When a menu item is marked sold out, taken off the menu, or put back, every connected aggregator store (an
 * IntegrationConnection of kind AGGREGATOR bound to an outlet) is told the item's new state, through the same outbox the
 * order-status pushes use: one delivery per (store, item, change), visible and retryable in the integrations control room.
 *
 *   - The state sent is the item's effective state at that outlet (on the menu there, not sold out there or anywhere), worked
 *     out when the change is made and again just before a retry. A retry of "off" after the dish was switched back on is
 *     therefore dropped as superseded instead of switching it off on the platform again.
 *   - The platform knows a dish by its POS code. A dish without one cannot be matched, and the delivery says so (SKIPPED).
 *   - Only a mock adapter exists. It records what would be sent and every delivery is labelled MOCK; a real Zomato / Swiggy
 *     adapter needs partner credentials and has never been run against a platform. With no adapter available (production
 *     without a partner integration) the delivery is SKIPPED with that reason: nothing is recorded as sent that was not.
 */
import type { IntegrationConnection, PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { type AccessContext } from "@/server/db/scope";
import { getAggregatorProvider, type AggregatorProvider } from "@/integrations/aggregator";
import { nextAttemptAt, safeMessage } from "@/integrations/http";
import { ProviderUnavailableError } from "@/integrations/policy";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

type Db = PrismaClient;
type ItemState = { name: string; posCode: string | null; available: boolean };

/** The dish's state at one outlet (null outlet: the organization-wide state). Null when the item does not exist in this organization. */
async function itemState(db: Db, organizationId: string, menuItemId: string, outletId: string | null): Promise<ItemState | null> {
  const item = await db.menuItem.findFirst({
    where: { id: menuItemId, organizationId },
    select: { name: true, posCode: true, active: true, soldOut: true, ...(outletId ? { outletOverrides: { where: { outletId }, select: { active: true, soldOut: true }, take: 1 } } : {}) },
  });
  if (!item) return null;
  const o = (item as typeof item & { outletOverrides?: Array<{ active: boolean; soldOut: boolean }> }).outletOverrides?.[0];
  return { name: item.name, posCode: item.posCode, available: item.active && !item.soldOut && (o?.active ?? true) && !(o?.soldOut ?? false) };
}

/** Connected aggregator stores that sell this outlet's menu (an organization-wide store when no outlet is named). */
async function stores(db: Db, organizationId: string, outletId?: string) {
  return db.integrationConnection.findMany({
    where: { organizationId, kind: "AGGREGATOR", status: "CONNECTED", externalRef: { not: null }, ...(outletId ? { OR: [{ outletId }, { outletId: null }] } : {}) },
    orderBy: { id: "asc" },
  });
}

function adapterFor(conn: Pick<IntegrationConnection, "provider">): { adapter: AggregatorProvider } | { error: string } {
  try {
    return { adapter: getAggregatorProvider(conn.provider.toLowerCase()) };
  } catch (e) {
    if (!(e instanceof ProviderUnavailableError)) throw e;
    return { error: `No adapter is available for ${conn.provider}: the platform was not told` };
  }
}

export type ItemPush = { deliveryId: string; connectionId: string; provider: string; status: string; available: boolean };

/**
 * Tell the connected stores about an item's new state. `outletId` limits it to one outlet's stores (an outlet-level change);
 * without it, every store is told (an organization-level change). Safe to call more than once for the same change.
 */
export async function pushItemAvailability(ctx: AccessContext, input: { menuItemId: string; outletId?: string; changeKey?: string }, db: Db = prisma): Promise<ItemPush[]> {
  const conns = await stores(db, ctx.organizationId, input.outletId);
  if (!conns.length) return [];
  const stamp = input.changeKey ?? String(Date.now());
  const out: ItemPush[] = [];
  for (const conn of conns) {
    const state = await itemState(db, ctx.organizationId, input.menuItemId, conn.outletId);
    if (!state) return out;
    const resolved = adapterFor(conn);
    const key = `aggitem:${conn.id}:${input.menuItemId}:${state.available ? "on" : "off"}:${stamp}`.slice(0, 190);
    const existing = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
    let d = existing;
    if (!d) {
      const payload = JSON.stringify({ connectionId: conn.id, storeRef: conn.externalRef, itemCode: state.posCode, itemName: state.name, available: state.available });
      const base = { organizationId: ctx.organizationId, outletId: conn.outletId, kind: "AGGREGATOR_ITEM", idempotencyKey: key, payload, target: `${state.name} → ${state.available ? "on" : "off"}`.slice(0, 120), sourceType: "MenuItem", sourceId: input.menuItemId, maxAttempts: 5 };
      try {
        if (!state.posCode) d = await db.integrationDelivery.create({ data: { ...base, provider: conn.provider, mode: "adapter" in resolved ? resolved.adapter.mode : conn.mode, status: "SKIPPED", lastError: `${state.name} has no POS code, so ${conn.provider} cannot match it` } });
        else if ("error" in resolved) d = await db.integrationDelivery.create({ data: { ...base, provider: conn.provider, mode: conn.mode, status: "SKIPPED", lastError: resolved.error } });
        else d = await db.integrationDelivery.create({ data: { ...base, provider: resolved.adapter.name, mode: resolved.adapter.mode } });
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002") throw e;
        d = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
      }
    }
    if (d && d.status === "PENDING") d = (await deliverItemAvailability(ctx, d.id, db)) ?? d;
    if (d) out.push({ deliveryId: d.id, connectionId: conn.id, provider: d.provider, status: d.status, available: state.available });
  }
  return out;
}

/** Send (or re-send) one item delivery: PENDING or FAILED rows only. A delivery whose state is out of date is dropped. */
export async function deliverItemAvailability(ctx: AccessContext, deliveryId: string, db: Db = prisma) {
  const d = await db.integrationDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || d.organizationId !== ctx.organizationId || d.kind !== "AGGREGATOR_ITEM") return null;
  if (d.status === "SENT" || d.status === "DELIVERED" || d.status === "SKIPPED") return d;
  if (d.attempts >= d.maxAttempts) return d;
  const p = JSON.parse(d.payload) as { connectionId: string; storeRef: string; itemCode: string | null; available: boolean };
  const conn = await db.integrationConnection.findFirst({ where: { id: p.connectionId, organizationId: ctx.organizationId } });
  if (!conn || conn.status !== "CONNECTED") return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED", lastError: "The store is no longer connected", nextAttemptAt: null } });
  const now = d.sourceId ? await itemState(db, ctx.organizationId, d.sourceId, conn.outletId) : null;
  if (!now || now.available !== p.available) return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED", lastError: "Superseded: the item has been switched since", nextAttemptAt: null } });
  const resolved = adapterFor(conn);
  if ("error" in resolved) return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED", lastError: resolved.error, nextAttemptAt: null } });
  const { adapter } = resolved;
  if (!adapter.setItemAvailability || !p.itemCode) return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SKIPPED", attempts: d.attempts + 1, lastError: !p.itemCode ? "The item has no POS code" : `${adapter.name} does not accept item updates`, nextAttemptAt: null } });
  const attempts = d.attempts + 1;
  try {
    const r = await adapter.setItemAvailability({ storeRef: p.storeRef, itemCode: p.itemCode, available: p.available });
    return await db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SENT", attempts, providerRef: r.providerRef, sentAt: new Date(), lastError: null, nextAttemptAt: null } });
  } catch (e) {
    inc("restora_integration_failures_total", { kind: "aggregator_item" });
    log.warn("aggregator item update failed", { event: "integration_failed", kind: "AGGREGATOR_ITEM", deliveryId: d.id, provider: d.provider, attempt: attempts, error: e });
    return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "FAILED", attempts, lastError: safeMessage(e), nextAttemptAt: attempts < d.maxAttempts ? nextAttemptAt(attempts) : null } });
  }
}
