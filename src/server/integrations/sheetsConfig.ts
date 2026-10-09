/**
 * Connection settings of a spreadsheet (SHEETS) connection, validated when the
 * connection is saved and again when the adapter is built. Apart from the sync
 * service so the connection manager can use it without a circular import.
 */
import { z } from "zod";
import { ValidationError } from "@/server/db/scope";
import { SPREADSHEET_ID } from "@/integrations/sheets";

export const sheetsConfigSchema = z.object({ spreadsheetId: z.string().trim().regex(SPREADSHEET_ID, "The spreadsheet id from its address (docs.google.com/spreadsheets/d/<id>)") }).passthrough();
export const sheetsCredsSchema = z.object({ clientEmail: z.string().trim().email().max(200), privateKey: z.string().min(50).max(5000) });

const fieldErrors = (e: z.ZodError) => Object.fromEntries(Object.entries(e.flatten().fieldErrors));

/** Validate a SHEETS connection when it is saved. */
export function validateSheetsConnection(provider: string, config: unknown, credentials: unknown) {
  if (provider === "google_sheets") {
    if (config) { const r = sheetsConfigSchema.safeParse(config); if (!r.success) throw new ValidationError("Invalid spreadsheet settings", { fieldErrors: fieldErrors(r.error) }); }
    if (credentials) { const r = sheetsCredsSchema.safeParse(credentials); if (!r.success) throw new ValidationError("Invalid Google service account credentials", { fieldErrors: fieldErrors(r.error) }); }
  }
}
