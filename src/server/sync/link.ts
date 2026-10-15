/**
 * Desktop side: the link between this installation and a cloud outlet — connect (pairing code or one staff
 * password exchange), disconnect, and the status the UI shows.
 *
 * Credentials: a pairing code or password is used once and dropped. What is kept is the cloud's opaque device
 * credential, AES-256-GCM encrypted (server/integrations/secrets.ts) under a key derived from the install secret
 * that the desktop shell protects with the operating system key store. It never reaches the renderer, an IPC message,
 * a log line or a config file. The cloud can revoke that device at any time: the next call fails with 401 and the
 * link flips to AUTH_REQUIRED until someone pairs again.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { decryptSecret, encryptSecret } from "@/server/integrations/secrets";
import { CloudAuthError, CloudClient, CloudHttpError, CloudOfflineError, normalizeBaseUrl, type Transport } from "@/server/sync/cloudClient";
import { desktopSync } from "@/server/sync/desktopDb";
import type { WireOutlet } from "@/lib/sync/wire";

export const connectSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(300),
    email: z.string().trim().email().max(200).optional(),
    password: z.string().min(1).max(200).optional(),
    pairingCode: z.string().trim().min(8).max(20).optional(),
    cloudOutletCode: z.string().trim().max(40).optional(),
    localOutletCode: z.string().trim().max(40).optional(),
    deviceName: z.string().trim().max(80).optional(),
    installId: z.string().trim().min(8).max(80).optional(),
  })
  .refine((d) => Boolean(d.pairingCode) || Boolean(d.email && d.password), { message: "Enter the pairing code from the hosted POS, or a cloud staff email and password" });
export type ConnectInput = z.input<typeof connectSchema>;

function assertSecureStorage(): void {
  if (process.env.AHAROS_DESKTOP === "1" && process.env.NODE_ENV === "production" && process.env.AHAROS_SECURE_STORAGE !== "1") {
    throw new ValidationError("This computer cannot protect cloud credentials with the operating system key store. Unlock it and try again.");
  }
}

export type SyncState = "UNLINKED" | "ONLINE" | "OFFLINE" | "AUTH_REQUIRED";
export type SyncStatusView = {
  state: SyncState;
  baseUrl: string | null;
  cloudOutletCode: string | null;
  userEmail: string | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Seconds since the cache was last confirmed against the cloud (null: never). */
  staleSeconds: number | null;
  pendingOps: number;
  conflictOps: number;
  /** Mirrored orders that cannot be accepted here until the local menu / floor plan matches. */
  ordersWithIssues: number;
};

export async function getLink(db: PrismaClient, organizationId: string) {
  return desktopSync(db).cloudLink.findUnique({ where: { organizationId } });
}

export function readToken(link: { tokenCipher: string | null }): string | null {
  if (!link.tokenCipher) return null;
  try {
    return decryptSecret(link.tokenCipher);
  } catch {
    return null; // wrong key (restored on another machine) or tampering: treated as signed out
  }
}

/** Whether the cloud link was last seen failing for connectivity (as opposed to being healthy). */
export async function syncStatus(db: PrismaClient, organizationId: string, now = new Date()): Promise<SyncStatusView> {
  const link = await getLink(db, organizationId);
  if (!link) return { state: "UNLINKED", baseUrl: null, cloudOutletCode: null, userEmail: null, lastSuccessAt: null, lastAttemptAt: null, lastError: null, staleSeconds: null, pendingOps: 0, conflictOps: 0, ordersWithIssues: 0 };
  const desk = desktopSync(db);
  const [pendingOps, conflictOps, maps] = await Promise.all([
    desk.syncOperation.count({ where: { organizationId, status: "PENDING" } }),
    desk.syncOperation.count({ where: { organizationId, status: { in: ["CONFLICT", "REJECTED"] } } }),
    desk.cloudRecordMap.count({ where: { organizationId, kind: "ORDER", issues: { not: "[]" } } }),
  ]);
  const failing = link.lastError !== null && (!link.lastSuccessAt || (link.lastAttemptAt ?? now) >= link.lastSuccessAt);
  const state: SyncState = link.status === "AUTH_REQUIRED" || !readToken(link) ? "AUTH_REQUIRED" : failing ? "OFFLINE" : "ONLINE";
  return {
    state,
    baseUrl: link.baseUrl,
    cloudOutletCode: link.cloudOutletCode,
    userEmail: link.userEmail,
    lastSuccessAt: link.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: link.lastAttemptAt?.toISOString() ?? null,
    lastError: link.lastError,
    staleSeconds: link.lastSuccessAt ? Math.max(0, Math.round((now.getTime() - link.lastSuccessAt.getTime()) / 1000)) : null,
    pendingOps,
    conflictOps,
    ordersWithIssues: maps,
  };
}

function connectFailure(e: unknown): Error {
  if (e instanceof CloudAuthError) return new ValidationError("The cloud did not accept those details");
  if (e instanceof CloudOfflineError) return new ValidationError("Could not reach the cloud. Check the address and this computer's internet connection.");
  if (e instanceof CloudHttpError) return new ValidationError(e.status === 429 ? "Too many attempts. Wait a few minutes and try again." : e.message || `The cloud refused the link (${e.status}).`);
  return e as Error;
}

function desktopInstallId(explicit?: string): string | undefined {
  const v = (explicit ?? (process.env.AHAROS_DESKTOP === "1" ? process.env.AHAROS_INSTALL_ID : undefined) ?? "").trim();
  return v.length >= 8 && v.length <= 80 ? v : undefined;
}

/** Pair this installation to a cloud outlet (pairing code or one password exchange). */
export async function connectCloud(ctx: AccessContext, input: ConnectInput, db: PrismaClient, transport?: Transport): Promise<SyncStatusView> {
  assertCan(ctx, "integration.manage");
  assertSecureStorage();
  const data = connectSchema.parse(input);
  const baseUrl = normalizeBaseUrl(data.baseUrl);
  const client = new CloudClient({ baseUrl, transport });
  const installId = desktopInstallId(data.installId);

  let issued: { token: string; outlet: WireOutlet; userEmail: string };
  try {
    issued = data.pairingCode
      ? await client.completePairing({ code: data.pairingCode, deviceName: data.deviceName, installId })
      : await client.enroll({ email: data.email!.toLowerCase(), password: data.password!, outletCode: data.cloudOutletCode, deviceName: data.deviceName, installId });
  } catch (e) {
    throw connectFailure(e);
  }
  const cloudOutlet = issued.outlet;
  const abandon = () => new CloudClient({ baseUrl, token: issued.token, transport }).revokeSelf();

  const localOutlets = await db.outlet.findMany({ where: { organizationId: ctx.organizationId, active: true, id: { in: ctx.outletIds } }, select: { id: true, code: true } });
  const wanted = (data.localOutletCode ?? "").toLowerCase();
  const localOutlet = wanted
    ? localOutlets.find((o) => o.code.toLowerCase() === wanted)
    : localOutlets.length === 1
      ? localOutlets[0]
      : localOutlets.find((o) => o.code.toLowerCase() === cloudOutlet.code.toLowerCase());
  if (!localOutlet) {
    await abandon();
    throw new ValidationError(localOutlets.length ? `Choose the outlet on this computer to link: ${localOutlets.map((o) => o.code).join(", ")}` : "This computer has no outlet you can use");
  }

  const previous = await getLink(db, ctx.organizationId);
  const sameTarget = previous && previous.cloudOutletId === cloudOutlet.id && previous.baseUrl === baseUrl;
  let tokenCipher: string;
  try {
    tokenCipher = encryptSecret(issued.token);
  } catch {
    await abandon();
    throw new ValidationError("This computer cannot protect cloud credentials. Pair again after the operating system key store is available.");
  }
  await desktopSync(db).cloudLink.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, baseUrl, cloudOutletId: cloudOutlet.id, cloudOutletCode: cloudOutlet.code, localOutletId: localOutlet.id, userEmail: issued.userEmail, tokenCipher, status: "LINKED" },
    // Re-pairing to the same outlet keeps the feed position and the queue; pointing elsewhere starts the feed afresh.
    update: { baseUrl, cloudOutletId: cloudOutlet.id, cloudOutletCode: cloudOutlet.code, localOutletId: localOutlet.id, userEmail: issued.userEmail, tokenCipher, status: "LINKED", lastError: null, ...(sameTarget ? {} : { cursor: null }) },
  });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CloudLink", entityId: ctx.organizationId, outletId: localOutlet.id, after: { baseUrl, cloudOutlet: cloudOutlet.code, account: issued.userEmail } });
  });
  if (previous?.tokenCipher) {
    const old = readToken(previous);
    if (old) await new CloudClient({ baseUrl: previous.baseUrl, token: old, transport }).revokeSelf();
  }
  return syncStatus(db, ctx.organizationId);
}

/** Sign out of the cloud and forget the token. Refused while staff actions are still waiting to reach the cloud, unless discarded explicitly. */
export async function disconnectCloud(ctx: AccessContext, db: PrismaClient, opts: { discardPending?: boolean; transport?: Transport } = {}): Promise<SyncStatusView> {
  assertCan(ctx, "integration.manage");
  const link = await getLink(db, ctx.organizationId);
  if (!link) throw new NotFoundError("This computer is not linked to a cloud");
  const desk = desktopSync(db);
  const pending = await desk.syncOperation.count({ where: { organizationId: ctx.organizationId, status: "PENDING" } });
  if (pending && !opts.discardPending) throw new ConflictError(`${pending} action${pending === 1 ? " is" : "s are"} still waiting to reach the cloud. Reconnect and let them send, or discard them.`);
  const token = readToken(link);
  if (token) await new CloudClient({ baseUrl: link.baseUrl, token, transport: opts.transport }).revokeSelf();
  if (pending) await desk.syncOperation.updateMany({ where: { organizationId: ctx.organizationId, status: "PENDING" }, data: { status: "REJECTED", lastError: "Discarded when the cloud link was removed", completedAt: new Date() } });
  await desk.cloudLink.delete({ where: { organizationId: ctx.organizationId } });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CloudLink", entityId: ctx.organizationId, outletId: link.localOutletId, before: { baseUrl: link.baseUrl, cloudOutlet: link.cloudOutletCode }, after: { linked: false, discardedOperations: pending } });
  });
  return syncStatus(db, ctx.organizationId);
}
