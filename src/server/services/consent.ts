/**
 * Who may be messaged, on which channel, and for what (proposal p. 17: "no spam"; DPDP / TRAI rules).
 *
 *  - TRANSACTIONAL: messages about the guest's own order, booking, bill or feedback question. Allowed unless the guest
 *    opted out of that channel.
 *  - MARKETING: offers, campaigns, birthday and win-back messages. Allowed only after an explicit yes.
 *
 * One row per (customer, channel). A guest with no row has not agreed to marketing and has not opted out of
 * transactional messages. Every change is audited with who made it and where the yes came from.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, NotFoundError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { systemContext } from "@/server/auth/context";
import { DEV_AUTH_SECRET_PLACEHOLDER } from "@/server/config/env";
import { type Client, type Tx, runInTx } from "@/server/services/_workflow";
import { MESSAGE_CHANNELS, type MessageChannel } from "@/integrations/messaging";

export type Purpose = "MARKETING" | "TRANSACTIONAL";
export const CONSENT_SOURCES = ["STAFF", "GUEST_QR", "IMPORT", "GUEST_REPLY"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export type ConsentView = { channel: MessageChannel; marketing: boolean; transactional: boolean; source: string | null; updatedAt: Date | null };

const patchSchema = z.object({
  channel: z.enum(MESSAGE_CHANNELS),
  marketing: z.boolean().optional(),
  transactional: z.boolean().optional(),
}).refine((p) => p.marketing !== undefined || p.transactional !== undefined, { message: "Nothing to change" });
const inputSchema = z.array(patchSchema).min(1).max(3);

async function loadCustomer(db: PrismaClient | Tx, ctx: AccessContext, customerId: string) {
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, organizationId: true } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  return c;
}

/** The three channels for one guest, defaults filled in. */
export async function getConsent(db: PrismaClient, ctx: AccessContext, customerId: string): Promise<ConsentView[]> {
  assertCan(ctx, "customer.view");
  await loadCustomer(db, ctx, customerId);
  const rows = await db.customerConsent.findMany({ where: { organizationId: ctx.organizationId, customerId } });
  return MESSAGE_CHANNELS.map((channel) => {
    const r = rows.find((x) => x.channel === channel);
    return { channel, marketing: r?.marketing ?? false, transactional: r?.transactional ?? true, source: r?.source ?? null, updatedAt: r?.updatedAt ?? null };
  });
}

/**
 * Record a guest's choice. Staff (customer.manage) note what the guest told them; guest-facing flows pass `source`
 * GUEST_QR / GUEST_REPLY with a system context. Only the fields given change.
 */
export async function setConsent(ctx: AccessContext, customerId: string, patch: z.input<typeof inputSchema>, source: ConsentSource = "STAFF", db: Client = prisma) {
  if (source === "STAFF") assertCan(ctx, "customer.manage");
  const changes = inputSchema.parse(patch);
  return runInTx(db, async (tx) => {
    await loadCustomer(tx, ctx, customerId);
    for (const ch of changes) {
      const before = await tx.customerConsent.findUnique({ where: { customerId_channel: { customerId, channel: ch.channel } } });
      const data = { marketing: ch.marketing ?? before?.marketing ?? false, transactional: ch.transactional ?? before?.transactional ?? true };
      if (before && before.marketing === data.marketing && before.transactional === data.transactional) continue;
      const row = await tx.customerConsent.upsert({
        where: { customerId_channel: { customerId, channel: ch.channel } },
        create: { organizationId: ctx.organizationId, customerId, channel: ch.channel, ...data, source, updatedById: ctx.userId === "system" ? null : ctx.userId },
        update: { ...data, source, updatedById: ctx.userId === "system" ? null : ctx.userId },
      });
      await writeAudit(tx, ctx, { action: "UPDATE", entityType: "CustomerConsent", entityId: row.id, before: before ? { marketing: before.marketing, transactional: before.transactional } : null, after: { channel: ch.channel, ...data, source } });
    }
    return (await tx.customerConsent.findMany({ where: { organizationId: ctx.organizationId, customerId } })).map((r) => ({ channel: r.channel, marketing: r.marketing, transactional: r.transactional, source: r.source }));
  });
}

/** May this guest be sent a message of this kind on this channel right now? (Internal gate: no permission check.) */
export async function mayMessage(db: PrismaClient | Tx, organizationId: string, customerId: string, channel: MessageChannel, purpose: Purpose): Promise<boolean> {
  const r = await db.customerConsent.findUnique({ where: { customerId_channel: { customerId, channel } } });
  if (r && r.organizationId !== organizationId) return false;
  return purpose === "MARKETING" ? r?.marketing === true : r?.transactional !== false;
}

/** Counts for the Growth screen. */
export async function consentSummary(db: PrismaClient, ctx: AccessContext) {
  assertCan(ctx, "growth.view");
  const grouped = await db.customerConsent.groupBy({ by: ["channel"], where: { organizationId: ctx.organizationId, marketing: true }, _count: { _all: true } });
  const optedOut = await db.customerConsent.groupBy({ by: ["channel"], where: { organizationId: ctx.organizationId, transactional: false }, _count: { _all: true } });
  const total = await db.customer.count({ where: { organizationId: ctx.organizationId } });
  return { customers: total, marketingOptIn: Object.fromEntries(MESSAGE_CHANNELS.map((c) => [c, grouped.find((g) => g.channel === c)?._count._all ?? 0])), transactionalOptOut: Object.fromEntries(MESSAGE_CHANNELS.map((c) => [c, optedOut.find((g) => g.channel === c)?._count._all ?? 0])) };
}

// ---------------------------------------------------------------- one-click unsubscribe

function unsubKey(): Buffer {
  const secret = process.env.AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : DEV_AUTH_SECRET_PLACEHOLDER);
  if (!secret) throw new Error("AUTH_SECRET is required to sign unsubscribe links");
  return Buffer.from(hkdfSync("sha256", secret, "restora-unsubscribe", "marketing-optout-v1", 32));
}
const sign = (customerId: string, channel: string) => createHmac("sha256", unsubKey()).update(`${customerId}.${channel}`).digest("base64url").slice(0, 22);

/**
 * The credential in every marketing message's unsubscribe link: `customerId.CHANNEL.signature`. It can only ever turn
 * marketing OFF for that guest on that channel, so it needs no expiry (an old message keeps working, as the law expects).
 */
export function unsubscribeToken(customerId: string, channel: MessageChannel): string {
  return `${customerId}.${channel}.${sign(customerId, channel)}`;
}

export type UnsubscribeInfo = { customerId: string; channel: MessageChannel; organizationId: string; restaurant: string };

/** Verify a token and say whom it concerns (for the confirmation page). */
export async function unsubscribeInfo(db: PrismaClient, token: unknown): Promise<UnsubscribeInfo | null> {
  if (typeof token !== "string" || token.length > 120) return null;
  const [customerId, channel, sig] = token.split(".");
  if (!customerId || !sig || !(MESSAGE_CHANNELS as readonly string[]).includes(channel)) return null;
  const expected = Buffer.from(sign(customerId, channel));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const c = await db.customer.findUnique({ where: { id: customerId }, select: { id: true, organizationId: true } });
  if (!c) return null;
  const org = await db.organization.findUnique({ where: { id: c.organizationId }, select: { name: true } });
  return { customerId: c.id, channel: channel as MessageChannel, organizationId: c.organizationId, restaurant: org?.name ?? "" };
}

/** The guest pressed Unsubscribe. Idempotent; only marketing on that channel is switched off. */
export async function applyUnsubscribe(token: unknown, db: Client = prisma): Promise<{ ok: boolean; restaurant?: string }> {
  const info = await unsubscribeInfo(db as PrismaClient, token);
  if (!info) return { ok: false };
  await setConsent(systemContext(info.organizationId), info.customerId, [{ channel: info.channel, marketing: false }], "GUEST_REPLY", db);
  return { ok: true, restaurant: info.restaurant };
}
