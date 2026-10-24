/**
 * Desktop side of table QR codes. A desktop linked to the cloud must not print its own address
 * (http://localhost:<port>, unreachable from a phone) or its own table tokens (the cloud's guest menu does not
 * know them): guests order on the hosted restaurant, so its codes carry the cloud's public address and the
 * cloud table's token, matched by table code exactly as mirrored orders are (mirror.ts).
 *
 * Unlinked (or linked to another local outlet) → LOCAL: the Tables screen keeps its local behaviour. Linked but the
 * cloud cannot answer → CLOUD_UNAVAILABLE: no code is shown rather than a local one that would not work.
 */
import type { PrismaClient } from "@prisma/client";
import { can } from "@/server/auth/rbac";
import { type AccessContext, assertOutletAccess, ForbiddenError } from "@/server/db/scope";
import { CloudAuthError, CloudClient, CloudOfflineError, normalizeBaseUrl } from "@/server/sync/cloudClient";
import { getLink, readToken } from "@/server/sync/link";
import { guestTableUrl, isGuestTableToken } from "@/lib/qr/tableQrUrl";
import type { WireGuestQr } from "@/lib/sync/wire";

export type DesktopGuestQr =
  | { mode: "LOCAL" }
  | { mode: "CLOUD"; origin: string; tables: Record<string, string>; commonUrl: string | null }
  | { mode: "CLOUD_UNAVAILABLE"; origin: string; message: string };

/**
 * The address printed codes open: the cloud's PUBLIC_BASE_URL when it is a valid https origin, else the address
 * this desktop was linked with (already https, or loopback http for local development; normalizeBaseUrl).
 */
export function hostedGuestOrigin(cloudBaseUrl: string | null, linkBaseUrl: string): string {
  if (cloudBaseUrl) {
    try {
      const o = normalizeBaseUrl(cloudBaseUrl);
      if (o.startsWith("https://")) return o;
    } catch {
      // not a usable public address: fall back to the linked one
    }
  }
  return normalizeBaseUrl(linkBaseUrl);
}

/** Build the hosted guest links from the cloud's answer; tokens that are not in RESTORA's format are dropped. */
export function hostedGuestLinks(qr: WireGuestQr, linkBaseUrl: string): Extract<DesktopGuestQr, { mode: "CLOUD" }> {
  const origin = hostedGuestOrigin(qr.guestBaseUrl, linkBaseUrl);
  const tables: Record<string, string> = {};
  for (const t of qr.tables) if (isGuestTableToken(t.qrToken)) tables[t.code] = guestTableUrl(origin, t.qrToken);
  const commonUrl = qr.commonQrToken && isGuestTableToken(qr.commonQrToken) ? guestTableUrl(origin, qr.commonQrToken) : null;
  return { mode: "CLOUD", origin, tables, commonUrl };
}

export async function desktopGuestQr(db: PrismaClient, ctx: AccessContext, outletId: string): Promise<DesktopGuestQr> {
  assertOutletAccess(ctx, outletId);
  if (!can(ctx, "order.view", outletId) && !can(ctx, "reservation.manage", outletId) && !can(ctx, "outlet.manage", outletId)) throw new ForbiddenError("Missing permission to view tables");
  const link = await getLink(db, ctx.organizationId);
  if (!link || link.localOutletId !== outletId) return { mode: "LOCAL" };
  const origin = normalizeBaseUrl(link.baseUrl);
  const token = readToken(link);
  if (link.status === "AUTH_REQUIRED" || !token) return { mode: "CLOUD_UNAVAILABLE", origin, message: "Sign in to the cloud again (Settings → Cloud sync) to show this restaurant's QR codes." };
  try {
    const qr = await new CloudClient({ baseUrl: link.baseUrl, token }).get<WireGuestQr>(`/api/sync/qr?outletId=${encodeURIComponent(link.cloudOutletId)}`, { background: true });
    return hostedGuestLinks(qr, link.baseUrl);
  } catch (e) {
    // Fixed messages: a cloud error can echo request details.
    const message =
      e instanceof CloudAuthError ? "The cloud ended this computer's session. Sign in again (Settings → Cloud sync) to show QR codes."
      : e instanceof CloudOfflineError ? "The cloud could not be reached, so the QR codes cannot be shown. Check the internet connection and try again."
      : "The cloud did not return this restaurant's QR codes. Try again in a moment.";
    return { mode: "CLOUD_UNAVAILABLE", origin, message };
  }
}
