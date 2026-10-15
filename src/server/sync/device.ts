/**
 * Cloud-side device identity for the installed desktop POS.
 *
 * Staff never embed a secret in the packaged app. An authenticated manager either
 * (a) creates a short-lived, single-use pairing code on the hosted POS, which the
 * desktop redeems, or (b) signs in once from the desktop with their own password.
 * Both paths issue a revocable per-device credential. Only the SHA-256 of that
 * credential is stored. Subsequent /api/sync (and forwarded payment) calls present
 * it as `Authorization: Bearer`; they do not use a staff session, so the POS idle
 * timeout cannot silently kill the link.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { can } from "@/server/auth/rbac";
import { buildAccessContext } from "@/server/auth/context";
import { writeAudit } from "@/server/audit/log";
import { hashToken, generateToken, ACTIVITY_WRITE_INTERVAL_MS } from "@/server/auth/session";
import { loginWithPassword } from "@/server/auth/login";
import { type AccessContext, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/server/db/scope";
import type { Current, CurrentUser } from "@/server/auth/current-user";
import type { WireOutlet } from "@/lib/sync/wire";

const PAIRING_TTL_MS = 10 * 60_000;
const DEVICE_TTL_MS = 90 * 24 * 60 * 60_000;
/** Crockford base32 without I, L, O, U — easier to read out over a counter. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const PAIRING_CODE_RE = /^[0-9A-HJ-NP-TV-Z]{8}$/i;

export const createPairingSchema = z.object({
  outletId: z.string().min(1),
  deviceName: z.string().trim().max(80).optional(),
});
export const completePairingSchema = z.object({
  code: z.string().trim().min(8).max(20),
  deviceName: z.string().trim().max(80).optional(),
  installId: z.string().trim().min(8).max(80).optional(),
});
export const enrollSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  outletCode: z.string().trim().max(40).optional(),
  deviceName: z.string().trim().max(80).optional(),
  installId: z.string().trim().min(8).max(80).optional(),
});

export type DeviceCredential = {
  token: string;
  deviceId: string;
  outlet: WireOutlet;
  expiresAt: string;
  userEmail: string;
};

export type PairingView = { code: string; expiresAt: string; outletId: string; outletCode: string };
export type DeviceView = {
  id: string;
  name: string;
  outletId: string;
  outletCode: string;
  enrolledByEmail: string;
  status: string;
  lastSeenAt: string | null;
  expiresAt: string;
  createdAt: string;
};

function randomCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

function normalizeCode(raw: string): string {
  const code = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!PAIRING_CODE_RE.test(code)) throw new ValidationError("Enter the 8-character pairing code from the hosted POS");
  return code;
}

async function outletFor(db: PrismaClient, organizationId: string, outletId: string): Promise<WireOutlet> {
  const o = await db.outlet.findFirst({ where: { id: outletId, organizationId, active: true }, select: { id: true, code: true, name: true } });
  if (!o) throw new NotFoundError("Outlet not found");
  return o;
}

async function issueDevice(
  db: PrismaClient,
  input: { organizationId: string; outletId: string; enrolledById: string; name: string; installId?: string; actor: AccessContext }
): Promise<DeviceCredential> {
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_TTL_MS);
  if (input.installId) {
    await db.cloudDevice.updateMany({
      where: { organizationId: input.organizationId, installId: input.installId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: now, revokedById: input.enrolledById, installId: null },
    });
    // Already-revoked rows must also drop the install id: the unique key is (organization, installId).
    await db.cloudDevice.updateMany({
      where: { organizationId: input.organizationId, installId: input.installId },
      data: { installId: null },
    });
  }
  const row = await db.cloudDevice.create({
    data: {
      organizationId: input.organizationId,
      outletId: input.outletId,
      enrolledById: input.enrolledById,
      name: input.name.slice(0, 80) || "Desktop POS",
      installId: input.installId ?? null,
      tokenHash: hashToken(token),
      status: "ACTIVE",
      expiresAt,
    },
  });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, input.actor, {
      action: "CREATE",
      entityType: "CloudDevice",
      entityId: row.id,
      outletId: input.outletId,
      after: { name: row.name, outletId: input.outletId },
    });
  });
  const outlet = await outletFor(db, input.organizationId, input.outletId);
  const user = await db.user.findUniqueOrThrow({ where: { id: input.enrolledById }, select: { email: true } });
  return { token, deviceId: row.id, outlet, expiresAt: expiresAt.toISOString(), userEmail: user.email };
}

/** Hosted POS: create a one-time pairing code bound to this staff member and outlet. */
export async function createPairing(db: PrismaClient, ctx: AccessContext, input: z.input<typeof createPairingSchema>): Promise<PairingView> {
  const data = createPairingSchema.parse(input);
  if (!can(ctx, "outlet.manage", data.outletId) && !can(ctx, "integration.manage", data.outletId)) throw new ForbiddenError("Only a manager can pair a desktop at this outlet");
  if (!can(ctx, "order.view", data.outletId)) throw new ForbiddenError("That account cannot view orders at this outlet");
  const outlet = await outletFor(db, ctx.organizationId, data.outletId);
  const code = randomCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.devicePairing.create({
    data: {
      organizationId: ctx.organizationId,
      outletId: data.outletId,
      createdById: ctx.userId,
      codeHash: hashToken(code),
      expiresAt,
    },
  });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "DevicePairing", entityId: data.outletId, outletId: data.outletId, after: { outlet: outlet.code, expiresAt: expiresAt.toISOString() } });
  });
  return { code, expiresAt: expiresAt.toISOString(), outletId: outlet.id, outletCode: outlet.code };
}

/** Desktop: redeem a pairing code for a device credential. The code cannot be reused. */
export async function completePairing(
  db: PrismaClient,
  input: z.input<typeof completePairingSchema>,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<DeviceCredential> {
  const data = completePairingSchema.parse(input);
  const code = normalizeCode(data.code);
  const row = await db.devicePairing.findUnique({ where: { codeHash: hashToken(code) } });
  const now = new Date();
  if (!row || row.usedAt || row.expiresAt.getTime() <= now.getTime()) throw new UnauthorizedError("That pairing code is not valid");
  const claimed = await db.devicePairing.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (claimed.count !== 1) throw new UnauthorizedError("That pairing code is not valid");
  const actor = await buildAccessContext(db, row.createdById);
  const user = await db.user.findUnique({ where: { id: row.createdById } });
  if (!user?.active) throw new UnauthorizedError("That pairing code is not valid");
  void meta;
  return issueDevice(db, {
    organizationId: row.organizationId,
    outletId: row.outletId,
    enrolledById: row.createdById,
    name: data.deviceName?.trim() || "Desktop POS",
    installId: data.installId,
    actor,
  });
}

/** Desktop: sign in once with a staff password and exchange it for a device credential. The password is not kept. */
export async function enrollWithPassword(
  db: PrismaClient,
  input: z.input<typeof enrollSchema>,
  meta: { ip?: string; userAgent?: string } = {}
): Promise<DeviceCredential> {
  const data = enrollSchema.parse(input);
  const { session, user } = await loginWithPassword(db, { email: data.email, password: data.password }, meta);
  try {
    const ctx = await buildAccessContext(db, user.id);
    if (!can(ctx, "outlet.manage") && !can(ctx, "integration.manage")) throw new ForbiddenError("Only a manager can link this computer to the cloud");
    const outlets = await db.outlet.findMany({
      where: { organizationId: ctx.organizationId, active: true, id: { in: ctx.outletIds } },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });
    const usable = outlets.filter((o) => can(ctx, "order.view", o.id));
    const wanted = (data.outletCode ?? "").toLowerCase();
    const outlet = wanted ? usable.find((o) => o.code.toLowerCase() === wanted) : usable.length === 1 ? usable[0] : undefined;
    if (!outlet) {
      throw new ValidationError(usable.length ? `Choose the cloud outlet to link: ${usable.map((o) => o.code).join(", ")}` : "That cloud account cannot view orders at any outlet");
    }
    return issueDevice(db, {
      organizationId: ctx.organizationId,
      outletId: outlet.id,
      enrolledById: user.id,
      name: data.deviceName?.trim() || "Desktop POS",
      installId: data.installId,
      actor: ctx,
    });
  } finally {
    await db.session.updateMany({ where: { id: session.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}

export async function listDevices(db: PrismaClient, ctx: AccessContext): Promise<DeviceView[]> {
  if (!can(ctx, "outlet.manage") && !can(ctx, "integration.manage")) throw new ForbiddenError("Only a manager can list linked desktops");
  const rows = await db.cloudDevice.findMany({
    where: { organizationId: ctx.organizationId, outletId: { in: ctx.outletIds } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.enrolledById))] } }, select: { id: true, email: true } });
  const email = new Map(users.map((u) => [u.id, u.email]));
  const outlets = await db.outlet.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.outletId))] } }, select: { id: true, code: true } });
  const code = new Map(outlets.map((o) => [o.id, o.code]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    outletId: r.outletId,
    outletCode: code.get(r.outletId) ?? r.outletId,
    enrolledByEmail: email.get(r.enrolledById) ?? "",
    status: r.status,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The calling device revokes its own credential (desktop disconnect). */
export async function revokeSelf(db: PrismaClient, ctx: AccessContext, deviceId: string | undefined): Promise<{ revoked: true }> {
  if (!deviceId) throw new ValidationError("No device is associated with this request");
  const row = await db.cloudDevice.findUnique({ where: { id: deviceId } });
  if (!row || row.organizationId !== ctx.organizationId) throw new NotFoundError("Device not found");
  if (row.status === "REVOKED") return { revoked: true };
  await db.cloudDevice.update({ where: { id: row.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: ctx.userId } });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CloudDevice", entityId: row.id, outletId: row.outletId, after: { status: "REVOKED", by: "device" } });
  });
  return { revoked: true };
}

export async function revokeDevice(db: PrismaClient, ctx: AccessContext, deviceId: string): Promise<{ revoked: true }> {
  const row = await db.cloudDevice.findUnique({ where: { id: deviceId } });
  if (!row || row.organizationId !== ctx.organizationId || !ctx.outletIds.includes(row.outletId)) throw new NotFoundError("Device not found");
  if (!can(ctx, "outlet.manage", row.outletId) && !can(ctx, "integration.manage", row.outletId)) throw new ForbiddenError("Only a manager can revoke a desktop at this outlet");
  if (row.status === "REVOKED") return { revoked: true };
  await db.cloudDevice.update({ where: { id: row.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: ctx.userId } });
  await db.$transaction(async (tx) => {
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CloudDevice", entityId: row.id, outletId: row.outletId, after: { status: "REVOKED" } });
  });
  return { revoked: true };
}

function readBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] ?? null;
}

/** Resolve a device credential into the same Current shape as a staff session, scoped to the paired outlet. */
export async function resolveFromDeviceToken(
  db: PrismaClient,
  authorization: string | null | undefined,
  opts: { touch?: boolean; now?: Date } = {}
): Promise<Current | null> {
  const token = readBearer(authorization ?? null);
  if (!token) return null;
  const now = opts.now ?? new Date();
  const row = await db.cloudDevice.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return null;
  if (row.status !== "ACTIVE" || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.cloudDevice.updateMany({ where: { id: row.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    return null;
  }
  const user = await db.user.findUnique({ where: { id: row.enrolledById } });
  if (!user?.active) return null;
  const full = await buildAccessContext(db, user.id);
  if (!full.outletIds.includes(row.outletId) && !full.isOrgWide && !full.isSuperAdmin) return null;
  if (opts.touch !== false) {
    const last = row.lastSeenAt?.getTime() ?? 0;
    if (now.getTime() - last >= ACTIVITY_WRITE_INTERVAL_MS) {
      await db.cloudDevice.updateMany({ where: { id: row.id, status: "ACTIVE" }, data: { lastSeenAt: now } });
    }
  }
  const ctx: AccessContext = {
    ...full,
    outletIds: [row.outletId],
    isOrgWide: false,
    isSuperAdmin: false,
  };
  const currentUser: CurrentUser = { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, isSuperAdmin: false };
  return { ctx, user: currentUser, session: { id: `device:${row.id}`, userId: user.id, reauthScope: null, reauthExpiresAt: null }, deviceId: row.id };
}
