/**
 * Connection settings of the accounting sync providers (non-secret config and
 * write-only credentials), validated when the connection is saved and again
 * when an adapter is built. Kept apart from the service so the connection
 * manager (services/integrations.ts) and the sync service can both use it
 * without importing each other.
 */
import { z } from "zod";
import { ValidationError } from "@/server/db/scope";
import { allowedTallyGateways, ZOHO_DATA_CENTERS, type ZohoDataCenter } from "@/integrations/accounting/sync";

/** File formats (a download) and live sync providers (an API call per voucher). */
export const ACCOUNTING_FILE_PROVIDERS = ["generic", "tally", "zoho"] as const;
export const ACCOUNTING_SYNC_PROVIDERS = ["tally_gateway", "zoho_books"] as const;
export type AccountingSyncProvider = (typeof ACCOUNTING_SYNC_PROVIDERS)[number];
export const isSyncProvider = (p: string): p is AccountingSyncProvider => (ACCOUNTING_SYNC_PROVIDERS as readonly string[]).includes(p);

export const zohoConfig = z.object({
  organizationId: z.string().trim().regex(/^\d{3,30}$/, "Zoho organisation id (digits)"),
  dataCenter: z.enum(Object.keys(ZOHO_DATA_CENTERS) as [ZohoDataCenter, ...ZohoDataCenter[]]).default("in"),
}).passthrough();
export const zohoCreds = z.object({ clientId: z.string().min(5).max(200), clientSecret: z.string().min(5).max(200), refreshToken: z.string().min(10).max(500) });
export const tallyConfig = z.object({ gatewayUrl: z.string().trim().min(1), company: z.string().trim().min(1).max(120) }).passthrough();

const fieldErrors = (e: z.ZodError) => Object.fromEntries(Object.entries(e.flatten().fieldErrors));

/** Validate an accounting sync connection's config / credentials (called when the connection is saved). */
export function validateSyncConnection(provider: string, config: unknown, credentials: unknown) {
  if (provider === "zoho_books") {
    if (config) { const r = zohoConfig.safeParse(config); if (!r.success) throw new ValidationError("Invalid Zoho Books settings", { fieldErrors: fieldErrors(r.error) }); }
    if (credentials) { const r = zohoCreds.safeParse(credentials); if (!r.success) throw new ValidationError("Invalid Zoho Books credentials", { fieldErrors: fieldErrors(r.error) }); }
  }
  if (provider === "tally_gateway" && config) {
    const r = tallyConfig.safeParse(config);
    if (!r.success) throw new ValidationError("Invalid Tally settings", { fieldErrors: fieldErrors(r.error) });
    // A tenant can only point the server at a gateway the deployment allows (no SSRF).
    if (!allowedTallyGateways().includes(r.data.gatewayUrl)) throw new ValidationError("This Tally gateway address is not allowed by the deployment (TALLY_GATEWAY_URLS)", { fieldErrors: { gatewayUrl: ["Not an allowed gateway"] } });
  }
}
