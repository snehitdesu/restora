/**
 * "Your table is ready" for a party on the walk-in waitlist (audit RS-03).
 *
 * The message goes through the same gate as every other guest message (queueCustomerMessage): a connected provider for
 * the channel, a mobile number, no opt-out, an idempotency key, a masked target in the outbox, retries with backoff. It is a
 * transactional message (the guest asked to be told), so marketing consent is not needed and quiet hours do not apply.
 * A party that left only a name and number becomes a customer record (with the default consent: told about their table,
 * nothing promotional) so the outbox, opt-outs and the unsubscribe rules work the same for them as for anyone else.
 *
 * When no message can be sent (no provider connected, no usable number, the guest opted out) the answer says so in plain
 * words and nothing is marked as notified: the host tells the party in person.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { systemContext } from "@/server/auth/context";
import { writeAudit } from "@/server/audit/log";
import { normalizePhone, type MessageChannel } from "@/integrations/messaging";
import { queueCustomerMessage } from "@/server/services/messaging";

export const WAITLIST_MAX_NOTIFICATIONS = 3;
/** A second tap within this long is a double tap, not a reminder. */
export const WAITLIST_MIN_GAP_MS = 2 * 60_000;
const CHANNELS: MessageChannel[] = ["WHATSAPP", "SMS"];

export type WaitlistNotifyResult =
  | { sent: true; channel: MessageChannel; count: number; notifiedAt: string }
  | { sent: false; reason: string };

const waitMinutes = z.number().int().min(1).max(120);

export async function notifyWaitlistEntry(ctx: AccessContext, entryId: string, opts: { holdMinutes?: number; now?: Date } = {}, db: PrismaClient = prisma): Promise<WaitlistNotifyResult> {
  const now = opts.now ?? new Date();
  const hold = waitMinutes.parse(opts.holdMinutes ?? 10);
  const entry = await db.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.organizationId !== ctx.organizationId) throw new NotFoundError("Waitlist entry not found");
  assertOutletAccess(ctx, entry.outletId);
  assertCan(ctx, "reservation.manage", entry.outletId);
  if (entry.status !== "WAITING") throw new ValidationError(`Only a party that is still waiting can be told (this one is ${entry.status.toLowerCase()})`);
  const phone = normalizePhone(entry.phone);
  if (!phone) return { sent: false, reason: "This party left no usable mobile number; tell them in person" };
  if (entry.notifyCount >= WAITLIST_MAX_NOTIFICATIONS) throw new ValidationError(`They have been told ${entry.notifyCount} times already`);
  if (entry.notifiedAt && now.getTime() - entry.notifiedAt.getTime() < WAITLIST_MIN_GAP_MS) throw new ValidationError("They were told a moment ago");

  const system = systemContext(ctx.organizationId);
  const org = await db.organization.findUnique({ where: { id: ctx.organizationId }, select: { name: true } });
  const customer = await customerForPhone(db, ctx.organizationId, entry.customerName, phone);
  const text = `${org?.name ?? "The restaurant"}: your table for ${entry.partySize} is ready. Please come to the host stand within ${hold} minutes.`;
  const key = `waitlist:${entry.id}:${entry.notifyCount + 1}`;

  const reasons: string[] = [];
  for (const channel of CHANNELS) {
    const r = await queueCustomerMessage(system, { customerId: customer.id, channel, purpose: "TRANSACTIONAL", key, template: "WAITLIST_READY", body: text, outletId: entry.outletId, about: { type: "Customer", id: customer.id }, now }, db);
    if (r.status === "QUEUED" || r.status === "DUPLICATE") {
      const count = entry.notifyCount + 1;
      const claimed = await db.waitlistEntry.updateMany({ where: { id: entry.id, notifyCount: entry.notifyCount }, data: { notifiedAt: now, notifyCount: count } });
      if (claimed.count === 0) return { sent: false, reason: "Someone else just told them" };
      await db.$transaction((tx) => writeAudit(tx, ctx, { action: "UPDATE", entityType: "WaitlistEntry", entityId: entry.id, outletId: entry.outletId, after: { notified: channel, count } }));
      return { sent: true, channel, count, notifiedAt: now.toISOString() };
    }
    if (r.reason) reasons.push(r.reason);
  }
  return { sent: false, reason: `${[...new Set(reasons)].join("; ") || "No message provider is connected"}. Tell them in person.` };
}

/** The guest record for a mobile number: an existing customer (any way the number was typed), or a new one. */
async function customerForPhone(db: PrismaClient, organizationId: string, name: string, phone: string) {
  const digits = phone.replace(/\D/g, "");
  const forms = [...new Set([phone, digits, digits.slice(-10), `+${digits}`])];
  const existing = await db.customer.findFirst({ where: { organizationId, phone: { in: forms } }, select: { id: true } });
  if (existing) return existing;
  try {
    return await db.customer.create({ data: { organizationId, name: name.trim() || "Walk-in guest", phone }, select: { id: true } });
  } catch (e) {
    // Two taps at once: the other one created the record first.
    if ((e as { code?: string })?.code === "P2002") {
      const again = await db.customer.findFirst({ where: { organizationId, phone: { in: forms } }, select: { id: true } });
      if (again) return again;
    }
    throw e;
  }
}
