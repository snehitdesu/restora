/**
 * Integration connections (Phase 7 integration management, built on the H4
 * webhook tenant binding).
 *
 * A connection binds one provider account to this organization (and, for POS /
 * aggregator orders, one outlet) and holds its configuration:
 *  - externalRef: the provider's id for the tenant's account (webhook binding);
 *  - webhook signing secret and API credentials: AES-256-GCM encrypted,
 *    WRITE-ONLY — never returned, never audited, never logged;
 *  - mode: SANDBOX / LIVE as declared by the operator. Mock providers are
 *    always shown as MOCK whatever is declared;
 *  - config: non-secret JSON (e.g. which customer messages are enabled);
 *  - health: last check / success / failure (secret-free message).
 *
 * Managing connections needs `integration.manage` (OWNER / ADMIN / AREA_MANAGER).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { decryptSecret, encryptSecret } from "@/server/integrations/secrets";
import { getPaymentProvider } from "@/integrations/payment";
import { getAggregatorProvider } from "@/integrations/aggregator";
import { getPOSProvider } from "@/integrations/pos";
import { twilioCredentialsSchema, TwilioMessagingProvider, resendCredentialsSchema, ResendEmailProvider, MockMessagingProvider, type MessageChannel, type MessagingProvider } from "@/integrations/messaging";
import { safeMessage } from "@/integrations/http";
import { mockProvidersAllowed } from "@/integrations/policy";
import { ACCOUNTING_FILE_PROVIDERS, ACCOUNTING_SYNC_PROVIDERS, isSyncProvider, validateSyncConnection } from "@/server/integrations/accountingConfig";
import { validateSheetsConnection } from "@/server/integrations/sheetsConfig";
import type { IntegrationMode } from "@/integrations/payment/types";

export const INTEGRATION_KINDS = ["POS", "PAYMENT", "AGGREGATOR", "MESSAGING", "ACCOUNTING", "SHEETS"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];
/** Kinds whose inbound webhooks are bound through externalRef. */
const WEBHOOK_KINDS = new Set<IntegrationKind>(["POS", "PAYMENT", "AGGREGATOR"]);

/** Providers that never leave the process — always displayed as MOCK. */
export const MOCK_PROVIDERS = new Set(["mock"]);

/** Per-template opt-in for customer messages (default: nothing is sent). */
export const messagingConfigSchema = z.object({
  /** Channel of order messages (confirmed / ready / paid); other messages name their own channel. */
  channel: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
  templates: z.object({ ORDER_CONFIRMED: z.boolean().default(false), ORDER_READY: z.boolean().default(false), PAYMENT_RECEIVED: z.boolean().default(false) }).default({}),
}).strict();
export type MessagingConfig = z.output<typeof messagingConfigSchema>;

const upsertSchema = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  provider: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{1,40}$/),
  outletId: z.string().min(1).nullish(),
  externalRef: z.string().trim().min(1).max(120).nullish(),
  /** Write-only. Omit to keep the current secret; null clears it (falls back to the deployment secret). */
  webhookSecret: z.string().min(16).max(500).nullish(),
  /** Write-only provider API credentials (validated per provider). Omit to keep; null clears. */
  credentials: z.record(z.string().max(500)).nullish(),
  mode: z.enum(["SANDBOX", "LIVE"]).default("SANDBOX"),
  config: z.record(z.unknown()).nullish(),
  status: z.enum(["CONNECTED", "DISCONNECTED"]).default("CONNECTED"),
}).strict();

type ConnectionRow = Awaited<ReturnType<PrismaClient["integrationConnection"]["findUniqueOrThrow"]>>;

export function effectiveMode(c: { provider: string; mode: string }): IntegrationMode {
  return MOCK_PROVIDERS.has(c.provider) ? "MOCK" : c.mode === "LIVE" ? "LIVE" : "SANDBOX";
}

const view = (c: ConnectionRow) => ({
  id: c.id, kind: c.kind, provider: c.provider, outletId: c.outletId, externalRef: c.externalRef, status: c.status,
  mode: effectiveMode(c),
  declaredMode: c.mode,
  configured: c.status === "CONNECTED" && (MOCK_PROVIDERS.has(c.provider) || Boolean(c.credentialsEnc) || WEBHOOK_KINDS.has(c.kind as IntegrationKind) || (c.kind === "ACCOUNTING" && c.provider !== "zoho_books")),
  hasWebhookSecret: Boolean(c.webhookSecretEnc),
  hasCredentials: Boolean(c.credentialsEnc),
  config: c.config ? (JSON.parse(c.config) as Record<string, unknown>) : null,
  lastCheckedAt: c.lastCheckedAt, lastSuccessAt: c.lastSuccessAt, lastFailureAt: c.lastFailureAt, lastError: c.lastError, updatedAt: c.updatedAt,
});
export type IntegrationView = ReturnType<typeof view>;

function validateFor(d: z.output<typeof upsertSchema>) {
  if (WEBHOOK_KINDS.has(d.kind) && !d.externalRef) throw new ValidationError("This integration needs the provider's account / store id", { fieldErrors: { externalRef: ["Required"] } });
  if (d.kind !== "PAYMENT" && WEBHOOK_KINDS.has(d.kind) && !d.outletId) throw new ValidationError("POS and aggregator connections must be bound to an outlet", { fieldErrors: { outletId: ["Choose the outlet these orders belong to"] } });
  if ((d.kind === "MESSAGING" || d.kind === "ACCOUNTING" || d.kind === "SHEETS") && d.outletId) throw new ValidationError("Messaging, accounting and spreadsheet connections are organization-wide");
  if (d.kind === "MESSAGING" && !["mock", "twilio", "resend"].includes(d.provider)) throw new ValidationError(`Unsupported messaging provider "${d.provider}" (mock, twilio for SMS / WhatsApp, resend for e-mail)`);
  if (d.kind === "ACCOUNTING" && ![...ACCOUNTING_FILE_PROVIDERS, ...ACCOUNTING_SYNC_PROVIDERS].includes(d.provider as never)) throw new ValidationError(`Unsupported accounting provider "${d.provider}" (${[...ACCOUNTING_FILE_PROVIDERS, ...ACCOUNTING_SYNC_PROVIDERS].join(", ")})`);
  if (d.kind === "ACCOUNTING" && isSyncProvider(d.provider)) validateSyncConnection(d.provider, d.config, d.credentials);
  if (d.kind === "SHEETS") {
    if (!["google_sheets", "mock"].includes(d.provider)) throw new ValidationError(`Unsupported spreadsheet provider "${d.provider}" (google_sheets, mock)`);
    validateSheetsConnection(d.provider, d.config, d.credentials);
  }
  if (MOCK_PROVIDERS.has(d.provider) && d.mode === "LIVE") throw new ValidationError("A mock provider cannot be LIVE");
  if (d.credentials && d.kind === "MESSAGING" && d.provider === "twilio") {
    const r = twilioCredentialsSchema.safeParse(d.credentials);
    if (!r.success) throw new ValidationError("Invalid Twilio credentials", { fieldErrors: Object.fromEntries(Object.entries(r.error.flatten().fieldErrors)) });
  }
  if (d.credentials && d.kind === "MESSAGING" && d.provider === "resend") {
    const r = resendCredentialsSchema.safeParse(d.credentials);
    if (!r.success) throw new ValidationError("Invalid Resend credentials", { fieldErrors: Object.fromEntries(Object.entries(r.error.flatten().fieldErrors)) });
  }
  if (d.kind === "MESSAGING" && d.config) messagingConfigSchema.parse(d.config);
}

export async function listIntegrations(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "integration.manage");
  const rows = await db.integrationConnection.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ kind: "asc" }, { provider: "asc" }] });
  return rows.map(view);
}

/** Deployment-level providers (environment configuration, not per tenant). */
export function deploymentProviders() {
  const name = (process.env.PAYMENT_PROVIDER ?? "mock").toLowerCase();
  let payment: { provider: string; mode: IntegrationMode | "UNAVAILABLE"; configured: boolean; note?: string };
  try {
    const p = getPaymentProvider(name);
    const configured = p.name === "mock" ? true : Boolean((p as { configured?: boolean }).configured);
    payment = { provider: p.name, mode: p.mode, configured, note: p.name === "mock" ? "Test gateway — no money moves" : configured ? undefined : "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set" };
  } catch (e) {
    payment = { provider: name, mode: "UNAVAILABLE", configured: false, note: safeMessage(e) };
  }
  return { payment, mockProvidersAllowed: mockProvidersAllowed() };
}

export async function upsertIntegration(ctx: AccessContext, input: z.input<typeof upsertSchema>, db: PrismaClient = prisma) {
  assertCan(ctx, "integration.manage");
  const d = upsertSchema.parse(input);
  validateFor(d);
  const outletId = d.outletId ?? null;
  if (outletId) {
    const outlet = await db.outlet.findUnique({ where: { id: outletId } });
    if (!outlet || outlet.organizationId !== ctx.organizationId) throw new NotFoundError("Outlet not found");
  }
  try {
    return await save(ctx, d, outletId, db);
  } catch (e) {
    // Lost a concurrent claim on the same provider account.
    if ((e as { code?: string })?.code === "P2002") throw new ConflictError("This provider account is already connected elsewhere");
    throw e;
  }
}

async function save(ctx: AccessContext, d: z.output<typeof upsertSchema>, outletId: string | null, db: PrismaClient) {
  return db.$transaction(async (tx) => {
    // One provider account belongs to exactly one tenant. The message never reveals which.
    const owner = d.externalRef ? await tx.integrationConnection.findUnique({ where: { kind_provider_externalRef: { kind: d.kind, provider: d.provider, externalRef: d.externalRef } } }) : null;
    if (owner && owner.organizationId !== ctx.organizationId) throw new ConflictError("This provider account is already connected elsewhere");
    const existing = owner ?? (await tx.integrationConnection.findFirst({ where: { organizationId: ctx.organizationId, outletId, kind: d.kind, provider: d.provider } }));
    const secret = d.webhookSecret === undefined ? {} : { webhookSecretEnc: d.webhookSecret === null ? null : encryptSecret(d.webhookSecret) };
    const creds = d.credentials === undefined ? {} : { credentialsEnc: d.credentials === null ? null : encryptSecret(JSON.stringify(d.credentials)) };
    const config = d.config === undefined ? {} : { config: d.config === null ? null : JSON.stringify(d.kind === "MESSAGING" ? messagingConfigSchema.parse(d.config) : d.config) };
    const data = { outletId, externalRef: d.externalRef ?? null, status: d.status, mode: d.mode, ...secret, ...creds, ...config };
    const row = existing
      ? await tx.integrationConnection.update({ where: { id: existing.id }, data })
      : await tx.integrationConnection.create({ data: { organizationId: ctx.organizationId, kind: d.kind, provider: d.provider, ...data } });
    await writeAudit(tx, ctx, {
      action: existing ? "UPDATE" : "CREATE", entityType: "IntegrationConnection", entityId: row.id, outletId: outletId ?? undefined,
      after: {
        kind: d.kind, provider: d.provider, outletId, externalRef: d.externalRef ?? null, status: d.status, mode: d.mode,
        webhookSecret: d.webhookSecret === undefined ? "unchanged" : d.webhookSecret === null ? "cleared" : "set",
        credentials: d.credentials === undefined ? "unchanged" : d.credentials === null ? "cleared" : "set",
        config: d.config === undefined ? "unchanged" : d.config,
      },
    });
    return view(row);
  });
}

async function loadConnection(db: PrismaClient, ctx: AccessContext, id: string) {
  const c = await db.integrationConnection.findUnique({ where: { id } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Integration not found");
  return c;
}

/** Record a provider call's outcome on the connection (secret-free message). */
export async function recordHealth(db: PrismaClient, connectionId: string, ok: boolean, error?: unknown) {
  const now = new Date();
  await db.integrationConnection.update({ where: { id: connectionId }, data: ok ? { lastCheckedAt: now, lastSuccessAt: now, lastError: null } : { lastCheckedAt: now, lastFailureAt: now, lastError: safeMessage(error ?? "Failed") } });
}

/** Decrypted credentials (server-internal; never returned by an API). */
export function connectionCredentials(c: { credentialsEnc: string | null }): Record<string, string> | null {
  if (!c.credentialsEnc) return null;
  return JSON.parse(decryptSecret(c.credentialsEnc)) as Record<string, string>;
}

export type MessagingHandle = { connection: ConnectionRow; provider: MessagingProvider; config: MessagingConfig };

/** The adapter for one MESSAGING connection, or null when it cannot be built (no credentials, mocks refused in production, unknown provider). */
export function messagingProviderFor(c: ConnectionRow): MessagingHandle | null {
  const config = messagingConfigSchema.parse(c.config ? JSON.parse(c.config) : {});
  if (c.provider === "mock") {
    if (!mockProvidersAllowed()) return null;
    return { connection: c, provider: new MockMessagingProvider(), config };
  }
  if (c.provider === "twilio") {
    const creds = connectionCredentials(c);
    if (!creds) return null;
    return { connection: c, provider: new TwilioMessagingProvider(twilioCredentialsSchema.parse(creds), effectiveMode(c)), config };
  }
  if (c.provider === "resend") {
    const creds = connectionCredentials(c);
    if (!creds) return null;
    return { connection: c, provider: new ResendEmailProvider(resendCredentialsSchema.parse(creds), effectiveMode(c)), config };
  }
  return null;
}

/**
 * The organization's messaging connection + adapter that can carry `channel`, or null when none is connected.
 * Order messages use the default (SMS / WhatsApp, whichever the connection's `channel` says); e-mail needs its own
 * provider connection. The most recently updated connection wins when several qualify.
 */
export async function messagingFor(db: PrismaClient, organizationId: string, channel?: MessageChannel): Promise<MessagingHandle | null> {
  const rows = await db.integrationConnection.findMany({ where: { organizationId, kind: "MESSAGING", outletId: null, status: "CONNECTED" }, orderBy: { updatedAt: "desc" } });
  for (const c of rows) {
    const h = messagingProviderFor(c);
    if (!h) continue;
    if (channel ? h.provider.supports(channel) : h.provider.supports(h.config.channel)) return h;
  }
  return null;
}

/** Ask the provider whether the connection works. Records the outcome; never throws a provider error to the caller. */
export async function testConnection(ctx: AccessContext, id: string, db: PrismaClient = prisma) {
  assertCan(ctx, "integration.manage");
  const c = await loadConnection(db, ctx, id);
  let ok = false;
  let error: unknown;
  try {
    if (c.kind === "PAYMENT") ok = await getPaymentProvider(c.provider).healthCheck();
    else if (c.kind === "AGGREGATOR") ok = await getAggregatorProvider(c.provider).healthCheck();
    else if (c.kind === "POS") ok = await getPOSProvider(c.provider).healthCheck();
    else if (c.kind === "MESSAGING") {
      const m = messagingProviderFor(c);
      ok = m ? await m.provider.healthCheck() : false;
      if (!m) error = "Messaging is not connected or has no credentials";
    } else if (c.kind === "ACCOUNTING" && isSyncProvider(c.provider)) {
      // Sync providers are really reached (Tally gateway / Zoho organisation); file formats have nothing to reach.
      const { syncClientFor } = await import("@/server/services/accountingSync");
      const { mappingFor } = await import("@/server/services/accounting");
      ok = await syncClientFor(c, await mappingFor(db, ctx.organizationId)).healthCheck();
    } else if (c.kind === "SHEETS") {
      const { sheetsProviderFor } = await import("@/server/services/sheetsSync");
      ok = await sheetsProviderFor(c).healthCheck();
    } else ok = true; // ACCOUNTING file formats: nothing to reach
    if (!ok && !error) error = "Provider did not confirm the connection";
  } catch (e) {
    error = e;
  }
  await recordHealth(db, c.id, ok, error);
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "INTEGRATION_SYNC", entityType: "IntegrationConnection", entityId: c.id, after: { test: ok ? "ok" : "failed", error: ok ? null : safeMessage(error) } }));
  return view(await db.integrationConnection.findUniqueOrThrow({ where: { id: c.id } }));
}

/** Integration audit history (connections, printers, jobs, deliveries) — secrets never appear in audit rows. */
export async function integrationAudit(db: PrismaClient, ctx: AccessContext, take = 100) {
  assertCan(ctx, "integration.manage");
  const rows = await db.auditLog.findMany({
    where: { organizationId: ctx.organizationId, entityType: { in: ["IntegrationConnection", "Printer", "PrintJob", "IntegrationDelivery", "AccountingExport", "AccountingMapping", "SheetsSync", "SheetSyncConflict", "AggregatorStatement", "AggregatorCharge"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: Math.min(take, 200),
    select: { id: true, action: true, entityType: true, entityId: true, actorId: true, outletId: true, createdAt: true, after: true },
  });
  return rows;
}
