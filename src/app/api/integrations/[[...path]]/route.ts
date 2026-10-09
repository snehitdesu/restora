import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { deploymentProviders, integrationAudit, listIntegrations, testConnection, upsertIntegration } from "@/server/services/integrations";
import { deliverMessage, listDeliveries, MESSAGE_TEMPLATES, sendOrderMessage } from "@/server/services/messaging";
import { pushAggregatorStatus } from "@/server/services/aggregatorSync";
import { deliverItemAvailability } from "@/server/services/aggregatorMenu";
import { accountingBatch, exportAccounting } from "@/server/services/accounting";
import { getAccountingMapping, listAccountingSync, retryAccountingSync, saveAccountingMapping, STANDARD_LEDGERS, syncAccounting } from "@/server/services/accountingSync";
import { listSheetConflicts, resolveSheetConflict, runSheetsSync, SHEET_DATASETS } from "@/server/services/sheetsSync";

export const runtime = "nodejs";

// Integration management. Secrets are write-only: no response, audit row or error ever contains one.
export const { GET, POST } = createRouter([
  { method: "GET", path: "", handler: async ({ ctx }) => ({ connections: await listIntegrations(prisma, ctx), deployment: deploymentProviders() }) },
  { method: "POST", path: "", reauth: "settings.manage", handler: ({ ctx, body }) => upsertIntegration(ctx, body as never) },
  { method: "POST", path: ":id/test", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => testConnection(ctx, params.id) },
  { method: "GET", path: "audit", handler: ({ ctx }) => integrationAudit(prisma, ctx) },
  { method: "GET", path: "deliveries", handler: ({ ctx, query }) => listDeliveries(prisma, ctx, query as never) },
  {
    method: "POST", path: "deliveries/:id/retry", rateLimit: RATE_POLICIES.integrationAction,
    handler: async ({ ctx, params }) => {
      if (!can(ctx, "integration.manage")) throw new ForbiddenError('Missing permission "integration.manage"');
      const d = await prisma.integrationDelivery.findUnique({ where: { id: params.id } });
      if (!d || d.organizationId !== ctx.organizationId) throw new NotFoundError("Delivery not found");
      if (d.status !== "FAILED") throw new ValidationError(`Only failed deliveries can be retried (this one is ${d.status})`);
      if (d.kind === "MESSAGE") return deliverMessage(ctx, d.id);
      if (d.kind === "AGGREGATOR_STATUS" && d.sourceId) return pushAggregatorStatus(ctx, d.sourceId, (JSON.parse(d.payload) as { status: "READY" }).status);
      if (d.kind === "AGGREGATOR_ITEM") return deliverItemAvailability(ctx, d.id);
      if (d.kind === "ACCOUNTING_SYNC") return retryAccountingSync(ctx, d.id);
      throw new ValidationError("This delivery cannot be retried");
    },
  },
  // Customer message for one order (staff action; the provider must be connected).
  { method: "POST", path: "orders/:id/message", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params, body }) => sendOrderMessage(ctx, params.id, z.object({ template: z.enum(MESSAGE_TEMPLATES) }).parse(body).template) },
  // Accounting: export what is new for the period (deterministic file), re-download a batch.
  { method: "POST", path: "accounting/export", rateLimit: RATE_POLICIES.export, handler: ({ ctx, body }) => exportAccounting(ctx, body as never) },
  { method: "GET", path: "accounting/batches/:id", handler: ({ ctx, params }) => accountingBatch(ctx, params.id) },
  // Accounting mapping: the books' own ledger / party names (and Zoho account ids). Saving changes every later export and sync.
  { method: "GET", path: "accounting/mapping", handler: async ({ ctx }) => ({ ...(await getAccountingMapping(prisma, ctx)), standardLedgers: STANDARD_LEDGERS }) },
  { method: "POST", path: "accounting/mapping", reauth: "settings.manage", handler: ({ ctx, body }) => saveAccountingMapping(ctx, body as never) },
  // Direct sync to Tally (gateway) / Zoho Books: one outbox row per voucher, sent once under its idempotency key.
  { method: "POST", path: "accounting/sync", rateLimit: RATE_POLICIES.export, handler: ({ ctx, body }) => syncAccounting(ctx, body as never) },
  { method: "GET", path: "accounting/sync", handler: ({ ctx, query }) => listAccountingSync(prisma, ctx, { status: query.status || undefined, take: query.take ? Number(query.take) : undefined }) },
  { method: "POST", path: "accounting/sync/:id/retry", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => retryAccountingSync(ctx, params.id) },
  // Google Sheets: push snapshots / two-way materials, conflicts settled by a person.
  { method: "POST", path: "sheets/sync", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, body }) => runSheetsSync(ctx, body as never) },
  { method: "GET", path: "sheets/conflicts", handler: async ({ ctx, query }) => ({ datasets: SHEET_DATASETS, conflicts: await listSheetConflicts(prisma, ctx, { status: query.status === "RESOLVED" ? "RESOLVED" : query.status === "OPEN" ? "OPEN" : undefined }) }) },
  { method: "POST", path: "sheets/conflicts/:id/resolve", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params, body }) => resolveSheetConflict(ctx, params.id, z.object({ choice: z.enum(["RESTORA", "SHEET"]) }).parse(body).choice) },
]);
