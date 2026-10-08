/**
 * Accounting mapping and direct sync (group 5; proposal p. 12 "CSV exports for
 * Tally, Zoho Books, or your CA's own format" and p. 17 "Tally / Zoho deep
 * integration").
 *
 * Mapping: the organization's books may call RESTORA's "Sales" something else
 * ("Sales - Dine In") and need account ids for the Zoho API. One mapping per
 * organization (integration.manage, audited) renames ledgers and parties in
 * every file export and sync; amounts and source keys never change.
 *
 * Sync: an ACCOUNTING connection with provider `tally_gateway` or `zoho_books`.
 * syncAccounting builds the same vouchers as the file export for a period,
 * applies the mapping and writes one outbox row per voucher (IntegrationDelivery
 * kind ACCOUNTING_SYNC, key `acctsync:<provider>:<sourceKey>`), so a voucher is
 * queued once however often the period is synced. Each row is then sent on its
 * own: SENT with the provider's reference, or FAILED with the safe reason; a
 * retryable failure (timeout, 5xx, 429) is retried by the worker on the bounded
 * schedule, credentials refused (401 / 403) are not. A send whose outcome is
 * unknown (crash between "sending" and "sent") is reconciled first for Zoho
 * (look the reference up) and left for a manual retry for Tally (no lookup).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { authorizedOutletIds } from "@/server/services/analytics";
import { buildVouchers, mappingFor } from "@/server/services/accounting";
import { connectionCredentials, effectiveMode, recordHealth } from "@/server/services/integrations";
import { applyAccountingMap, ordered, type AccountingMap, type Voucher } from "@/integrations/accounting";
import { TallyGatewayClient, ZohoBooksClient } from "@/integrations/accounting/sync";
import { IntegrationError, UnauthorizedIntegrationError, nextAttemptAt, safeMessage, type FetchLike } from "@/integrations/http";
import { isSyncProvider, tallyConfig, validateSyncConnection, zohoConfig, zohoCreds, ACCOUNTING_SYNC_PROVIDERS } from "@/server/integrations/accountingConfig";

export { validateSyncConnection };

export const SYNC_PROVIDERS = ACCOUNTING_SYNC_PROVIDERS;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

// ---------------------------------------------------------------- mapping

const name = z.string().trim().min(1).max(120).refine((s) => !/[\u0000-\u001f]/.test(s), "No control characters");
const mapSchema = z.object({ ledgers: z.record(name, name).default({}), parties: z.record(name, name).default({}) }).strict()
  .refine((m) => Object.keys(m.ledgers).length <= 500 && Object.keys(m.parties).length <= 2000, "Too many mappings");

/** The ledgers RESTORA posts to (fixed ones; expense, vendor and bank ledgers also appear per category / vendor / method). */
export const STANDARD_LEDGERS = ["Sales", "Sales Receivable", "Output CGST", "Output SGST", "Output IGST", "Output GST", "Cash", "Bank - UPI", "Bank - CARD", "Bank - ONLINE", "Bank - WALLET", "Purchases", "Input GST"];

export async function getAccountingMapping(db: PrismaClient, ctx: AccessContext): Promise<AccountingMap & { updatedAt: string | null }> {
  assertCan(ctx, "integration.manage");
  const row = await db.accountingMapping.findUnique({ where: { organizationId: ctx.organizationId } });
  return { ledgers: row ? JSON.parse(row.ledgers) : {}, parties: row ? JSON.parse(row.parties) : {}, updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function saveAccountingMapping(ctx: AccessContext, input: z.input<typeof mapSchema>, db: PrismaClient = prisma) {
  assertCan(ctx, "integration.manage");
  const m = mapSchema.parse(input);
  return db.$transaction(async (tx) => {
    const before = await tx.accountingMapping.findUnique({ where: { organizationId: ctx.organizationId } });
    const actor = ctx.userId === "system" ? null : ctx.userId;
    const row = await tx.accountingMapping.upsert({
      where: { organizationId: ctx.organizationId },
      create: { organizationId: ctx.organizationId, ledgers: JSON.stringify(m.ledgers), parties: JSON.stringify(m.parties), updatedById: actor },
      update: { ledgers: JSON.stringify(m.ledgers), parties: JSON.stringify(m.parties), updatedById: actor },
    });
    await writeAudit(tx, ctx, { action: before ? "UPDATE" : "CREATE", entityType: "AccountingMapping", entityId: row.id, before: before ? { ledgers: JSON.parse(before.ledgers), parties: JSON.parse(before.parties) } : undefined, after: m });
    return { ledgers: m.ledgers, parties: m.parties, updatedAt: row.updatedAt.toISOString() };
  });
}

// ---------------------------------------------------------------- sync

export type SyncClient = { send(v: Voucher, previouslyAttempted: boolean): Promise<{ providerRef: string }>; healthCheck(): Promise<boolean> };

/** Build the adapter for a connection. `fetchImpl` lets tests drive an emulator. */
export function syncClientFor(c: { provider: string; config: string | null; credentialsEnc: string | null }, map: AccountingMap | null, fetchImpl?: FetchLike): SyncClient {
  const cfg = c.config ? JSON.parse(c.config) : {};
  if (c.provider === "tally_gateway") {
    const t = tallyConfig.parse(cfg);
    const client = new TallyGatewayClient({ url: t.gatewayUrl, company: t.company, fetchImpl });
    return { send: async (v) => ({ providerRef: `tally:${(await client.post(v)).created}` }), healthCheck: () => client.healthCheck() };
  }
  if (c.provider === "zoho_books") {
    const z1 = zohoConfig.parse(cfg);
    const creds = connectionCredentials(c);
    if (!creds) throw new IntegrationError("NOT_CONFIGURED", "Zoho Books credentials are not set", false);
    const client = new ZohoBooksClient({ dataCenter: z1.dataCenter, organizationId: z1.organizationId, credentials: zohoCreds.parse(creds), fetchImpl });
    // The voucher already carries the books' names (the mapping was applied when it was queued): a ledger that IS a
    // Zoho account id (digits) is used as it is; any other name resolves through the mapping ("zoho:<name>" or the name itself -> an
    // account id), so vouchers queued before the mapping was filled in heal when they are retried.
    const isId = (v: string | undefined): v is string => Boolean(v && /^\d{5,30}$/.test(v));
    const accountId = (ledger: string) => (isId(ledger) ? ledger : [map?.ledgers[`zoho:${ledger}`], map?.ledgers[ledger]].find(isId));
    return {
      send: async (v, previouslyAttempted) => {
        if (previouslyAttempted) {
          const existing = await client.findJournal(v.sourceKey);
          if (existing) return { providerRef: `zoho:${existing}` };
        }
        return { providerRef: `zoho:${(await client.createJournal(v, accountId)).journalId}` };
      },
      healthCheck: () => client.healthCheck(),
    };
  }
  throw new IntegrationError("NOT_CONFIGURED", `Unknown accounting sync provider "${c.provider}"`, false);
}

const syncSchema = z.object({ connectionId: z.string().min(1), outletId: z.string().min(1).optional(), from: z.coerce.date(), to: z.coerce.date() })
  .refine((f) => f.from <= f.to, { message: "`from` must be on or before `to`" })
  .refine((f) => f.to.getTime() - f.from.getTime() <= 400 * 86400000, { message: "At most 400 days per sync" });

const MAX_PER_RUN = 200;

/** Queue every voucher of the period not yet synced to this provider, then send them. */
export async function syncAccounting(ctx: AccessContext, input: z.input<typeof syncSchema>, db: PrismaClient = prisma, fetchImpl?: FetchLike) {
  const f = syncSchema.parse(input);
  assertCan(ctx, "integration.manage");
  const ids = authorizedOutletIds(ctx, { outletId: f.outletId }, "finance.view");
  if (!ids.length) throw new ValidationError("No outlet to sync");
  // An org-wide role passes the outlet-membership check for ANY id: a named outlet must exist in this organization.
  if (f.outletId && !(await db.outlet.findFirst({ where: { id: f.outletId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Outlet not found");
  const c = await db.integrationConnection.findUnique({ where: { id: f.connectionId } });
  if (!c || c.organizationId !== ctx.organizationId || c.kind !== "ACCOUNTING") throw new NotFoundError("Accounting connection not found");
  if (!SYNC_PROVIDERS.includes(c.provider as SyncProvider)) throw new ValidationError("This accounting connection is a file format; use the export instead");
  if (c.status !== "CONNECTED") throw new ValidationError("The connection is disconnected");
  const map = await mappingFor(db, ctx.organizationId);
  const { current, reversals } = await buildVouchers(db, ctx, ids, f);
  const keyOf = (sourceKey: string) => `acctsync:${c.provider}:${sourceKey}`;
  const sent = new Set((await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_SYNC", status: "SENT", idempotencyKey: { in: [...current.map((v) => keyOf(v.sourceKey)), ...reversals.map((r) => keyOf(r.originalKey))] } }, select: { idempotencyKey: true } })).map((d) => d.idempotencyKey));
  // A reversal only follows a voucher that reached the books.
  const wanted = applyAccountingMap(ordered([...current, ...reversals.filter((r) => sent.has(keyOf(r.originalKey))).map((r) => r.voucher)]), map);
  let queued = 0;
  for (const v of wanted) {
    const k = keyOf(v.sourceKey);
    try {
      await db.integrationDelivery.create({ data: { organizationId: ctx.organizationId, outletId: f.outletId ?? null, kind: "ACCOUNTING_SYNC", provider: c.provider, mode: effectiveMode(c), idempotencyKey: k, payload: JSON.stringify(v), status: "PENDING", sourceType: v.type, sourceId: v.sourceKey, maxAttempts: 5 } });
      queued++;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e; // already queued (or sent) by an earlier sync
    }
  }
  const due = await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_SYNC", provider: c.provider, status: "PENDING", attempts: 0 }, orderBy: { createdAt: "asc" }, take: MAX_PER_RUN, select: { id: true } });
  let delivered = 0, failed = 0;
  for (const d of due) {
    const r = await deliverAccountingSync(d.id, db, fetchImpl);
    if (r?.status === "SENT") delivered++; else if (r) failed++;
  }
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "INTEGRATION_SYNC", entityType: "AccountingExport", entityId: c.id, outletId: f.outletId, after: { provider: c.provider, from: f.from.toISOString(), to: f.to.toISOString(), vouchers: wanted.length, queued, delivered, failed } }));
  return { provider: c.provider, mode: effectiveMode(c), vouchers: wanted.length, alreadySynced: wanted.length - queued, queued, delivered, failed };
}

/**
 * Send one queued voucher. Claimed by compare-and-set so two callers (a sync
 * and the worker, or two instances) never send it twice. Returns the row's
 * outcome, or null when someone else holds it.
 */
export async function deliverAccountingSync(deliveryId: string, db: PrismaClient = prisma, fetchImpl?: FetchLike) {
  const d = await db.integrationDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || d.kind !== "ACCOUNTING_SYNC") throw new NotFoundError("Delivery not found");
  if (d.status === "SENT") return d;
  const claim = await db.integrationDelivery.updateMany({ where: { id: d.id, status: d.status, attempts: d.attempts }, data: { status: "PENDING", nextAttemptAt: null, attempts: d.attempts + 1 } });
  if (claim.count !== 1) return null;
  const c = await db.integrationConnection.findFirst({ where: { organizationId: d.organizationId, kind: "ACCOUNTING", provider: d.provider, outletId: null } });
  const attempts = d.attempts + 1;
  try {
    if (!c || c.status !== "CONNECTED") throw new IntegrationError("NOT_CONFIGURED", "The accounting connection is missing or disconnected", false);
    const client = syncClientFor(c, await mappingFor(db, d.organizationId), fetchImpl);
    const { providerRef } = await client.send(JSON.parse(d.payload) as Voucher, d.attempts > 0);
    const done = await db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SENT", providerRef, sentAt: new Date(), lastError: null } });
    await recordHealth(db, c.id, true);
    return done;
  } catch (e) {
    const unauthorized = e instanceof UnauthorizedIntegrationError;
    const retryable = e instanceof IntegrationError && e.retryable;
    const code = unauthorized ? "UNAUTHORIZED" : e instanceof IntegrationError ? e.code : "FAILED";
    const failed = await db.integrationDelivery.update({
      where: { id: d.id },
      data: { status: "FAILED", lastError: `${code}: ${safeMessage(e)}`, nextAttemptAt: retryable && attempts < d.maxAttempts ? nextAttemptAt(attempts) : null },
    });
    if (c) await recordHealth(db, c.id, false, e);
    return failed;
  }
}

/** Interrupted sends (PENDING with an attempt and no outcome): Zoho is safe to retry (reference lookup); Tally needs a manual check. */
export async function recoverInterruptedAccountingSync(db: PrismaClient, cutoff: Date, now = new Date()) {
  const zoho = await db.integrationDelivery.updateMany({ where: { kind: "ACCOUNTING_SYNC", provider: "zoho_books", status: "PENDING", attempts: { gt: 0 }, updatedAt: { lt: cutoff } }, data: { status: "FAILED", lastError: "INTERRUPTED: outcome unknown; the next attempt looks the journal up first", nextAttemptAt: now } });
  const other = await db.integrationDelivery.updateMany({ where: { kind: "ACCOUNTING_SYNC", provider: { not: "zoho_books" }, status: "PENDING", attempts: { gt: 0 }, updatedAt: { lt: cutoff } }, data: { status: "FAILED", lastError: "INTERRUPTED: outcome unknown; check the books before retrying", nextAttemptAt: null } });
  return zoho.count + other.count;
}

/** Manual retry of a failed voucher (after fixing credentials / mapping, or checking Tally). */
export async function retryAccountingSync(ctx: AccessContext, deliveryId: string, db: PrismaClient = prisma, fetchImpl?: FetchLike) {
  assertCan(ctx, "integration.manage");
  const d = await db.integrationDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || d.organizationId !== ctx.organizationId || d.kind !== "ACCOUNTING_SYNC") throw new NotFoundError("Delivery not found");
  if (d.status !== "FAILED") throw new ValidationError("Only a failed voucher can be retried");
  const out = await deliverAccountingSync(d.id, db, fetchImpl);
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "INTEGRATION_SYNC", entityType: "IntegrationDelivery", entityId: d.id, after: { retry: true, status: out?.status ?? "BUSY" } }));
  return out;
}

/** Operational state of any outbox row, for the integration screens (no secrets, no payload). */
export function deliveryState(d: { status: string; attempts: number; maxAttempts: number; nextAttemptAt: Date | null; lastError: string | null }) {
  if (d.status === "SENT" || d.status === "DELIVERED") return "SUCCESS";
  if (d.status === "SKIPPED") return "SKIPPED";
  if (d.status === "PENDING") return d.attempts > 0 ? "RUNNING" : "PENDING";
  if (d.lastError?.startsWith("UNAUTHORIZED")) return "UNAUTHORIZED";
  if (d.nextAttemptAt) return d.lastError?.startsWith("TIMEOUT") ? "TIMEOUT_RETRYING" : "RETRYING";
  if (d.attempts >= d.maxAttempts) return "EXHAUSTED";
  return d.lastError?.startsWith("TIMEOUT") ? "TIMEOUT" : "FAILED";
}

export async function listAccountingSync(db: PrismaClient, ctx: AccessContext, input: { status?: string; take?: number } = {}) {
  assertCan(ctx, "integration.manage");
  const rows = await db.integrationDelivery.findMany({
    where: { organizationId: ctx.organizationId, kind: "ACCOUNTING_SYNC", ...(input.status ? { status: input.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: Math.min(input.take ?? 100, 500),
    select: { id: true, provider: true, mode: true, status: true, attempts: true, maxAttempts: true, nextAttemptAt: true, lastError: true, providerRef: true, sourceType: true, sourceId: true, createdAt: true, sentAt: true },
  });
  return rows.map((r) => ({ ...r, state: deliveryState(r) }));
}
