/**
 * Staff QR scanner: what does this table QR open, and does it work here?
 *
 * Read-only. The scanned text is parsed by the same rules the client uses
 * (lib/qr/tableQrUrl.ts), its origin must be one of THIS deployment's own
 * addresses, and the token is resolved by the guest site's own lookup
 * (guestOrdering.lookupTableToken) — there is no second token check.
 *
 * Nothing is fetched from or redirected to the scanned URL. The response
 * names the table only when it belongs to the caller's organization and an
 * outlet they may see tables at; anything else is the same "not recognised"
 * answer (no oracle for other restaurants' tokens). Tokens are never logged
 * and only appear in the response inside the validated guest link.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { can, type Permission } from "@/server/auth/rbac";
import { type AccessContext, ForbiddenError, assertOutletAccess } from "@/server/db/scope";
import { lookupTableToken } from "@/server/services/guestOrdering";
import { guestBaseUrl } from "@/server/services/masterData";
import { MAX_QR_TEXT, guestTableUrl, maskToken, originOf, parseTableQr, type TableQrRejection } from "@/lib/qr/tableQrUrl";

/** Same audience as the Tables screen (nav entry /tables and masterData.listTables). */
export const QR_SCAN_PERMISSIONS: readonly Permission[] = ["outlet.manage", "order.view", "reservation.manage"];

export type QrScanEnvironment = {
  /** The origin printed in the QR; null for a pasted bare token. */
  qrOrigin: string | null;
  /** This deployment's guest address (PUBLIC_BASE_URL, else the address this request came to). */
  appOrigin: string;
  /** The QR's origin is this deployment's guest address (null when there is no origin to compare). */
  matchesApp: boolean | null;
};

type TableFacts = { table: { code: string }; outletName: string; restaurantName: string; tokenHint: string; environment: QrScanEnvironment };

export type QrScanResult =
  | ({ status: "valid"; guestUrl: string } & TableFacts)
  | ({ status: "inactive"; message: string } & TableFacts)
  | { status: "not_found"; tokenHint: string; environment: QrScanEnvironment; message: string }
  | { status: "rejected"; reason: TableQrRejection; message: string };

const input = z.object({ text: z.string().max(MAX_QR_TEXT * 2) }).strict();

export const QR_SCAN_MESSAGES = {
  not_found: "This RESTORA link is well-formed, but no table here uses it. The code may have been replaced (rotated) or switched off, or it belongs to a different RESTORA database.",
  inactive: "This QR belongs to a table here, but its outlet or restaurant is switched off, so guests would see “QR code not recognised”.",
} as const;

function mayViewTables(ctx: AccessContext, outletId?: string) {
  return QR_SCAN_PERMISSIONS.some((p) => can(ctx, p, outletId));
}

/** The table's outlet is one this user may see tables at (same rule as listTables). */
function mayViewTableAt(ctx: AccessContext, t: { organizationId: string; outletId: string }) {
  if (t.organizationId !== ctx.organizationId) return false;
  try {
    assertOutletAccess(ctx, t.outletId);
  } catch {
    return false;
  }
  return mayViewTables(ctx, t.outletId);
}

/** This deployment's own addresses: the configured public guest address and the address the request reached. */
export function trustedQrOrigins(requestOrigin: string): { appOrigin: string; trusted: string[] } {
  const request = originOf(requestOrigin);
  const configured = originOf(guestBaseUrl());
  const appOrigin = configured ?? request;
  if (!appOrigin) throw new Error("No origin for this deployment");
  return { appOrigin, trusted: [...new Set([configured, request].filter((o): o is string => Boolean(o)))] };
}

export async function scanTableQr(ctx: AccessContext, body: unknown, opts: { requestOrigin: string }, db: PrismaClient = prisma): Promise<QrScanResult> {
  if (!mayViewTables(ctx)) throw new ForbiddenError("Missing permission to check table QR codes");
  const { text } = input.parse(body);
  const { appOrigin, trusted } = trustedQrOrigins(opts.requestOrigin);

  const parsed = parseTableQr(text, { trustedOrigins: trusted });
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason, message: parsed.message };

  const environment: QrScanEnvironment = { qrOrigin: parsed.origin, appOrigin, matchesApp: parsed.origin === null ? null : parsed.origin === appOrigin };
  const tokenHint = maskToken(parsed.token);
  const notFound: QrScanResult = { status: "not_found", tokenHint, environment, message: QR_SCAN_MESSAGES.not_found };

  const found = await lookupTableToken(parsed.token, db);
  if (found.status === "not_found") return notFound;

  const t = found.status === "ok" ? { organizationId: found.guest.ctx.organizationId, outletId: found.guest.outlet.id } : found.table;
  if (!mayViewTableAt(ctx, t)) return notFound;

  if (found.status === "inactive") {
    return { status: "inactive", table: { code: found.table.code }, outletName: found.outletName, restaurantName: found.restaurantName, tokenHint, environment, message: QR_SCAN_MESSAGES.inactive };
  }
  const g = found.guest;
  return { status: "valid", table: { code: g.table.code }, outletName: g.outlet.name, restaurantName: g.restaurantName, tokenHint, environment, guestUrl: guestTableUrl(appOrigin, parsed.token) };
}
