/**
 * Customer messaging (SMS / WhatsApp / e-mail) through the outbox.
 *
 *  - Order messages (below) are transactional: one per (template, order), off until the organization enables the type.
 *  - Every other message (campaigns, birthday / win-back, feedback requests, booking messages) goes through
 *    `queueCustomerMessage`, the one gate that checks the guest's consent for that channel and purpose, a
 *    connected provider for the channel, an address, quiet hours and the weekly marketing cap before anything is queued.
 *
 *  - Nothing is sent unless the organization connected a messaging provider
 *    AND enabled that message type (ORDER_CONFIRMED / ORDER_READY /
 *    PAYMENT_RECEIVED) — the default is off.
 *  - One message per (template, order): the IntegrationDelivery idempotency key
 *    makes repeated events / retries never send twice. Only the masked phone
 *    number and the message text are stored; no credentials, no full numbers.
 *  - Attempts are bounded (maxAttempts) with backoff; a failure is a FAILED
 *    delivery with a secret-free reason, never an order / payment error.
 *  - A timed-out send may still have reached the provider; it is retried only
 *    by an explicit retry (documented at-least-once risk).
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, assertOutletAccess, ForbiddenError, NotFoundError, ValidationError } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { maskEmail, maskPhone, normalizeEmail, normalizePhone, parseResendEvent, verifyResendWebhook, type MessageChannel } from "@/integrations/messaging";
import { IntegrationError, nextAttemptAt, safeMessage } from "@/integrations/http";
import { effectiveMode, messagingFor, recordHealth } from "@/server/services/integrations";
import { mayMessage, setConsent, type Purpose } from "@/server/services/consent";
import { systemContext } from "@/server/auth/context";
import { getGrowthSettings } from "@/server/services/growthSettings";
import { orgTimeZone } from "@/server/services/businessDay";
import { localHour } from "@/domain/time";
import { money } from "@/domain/money";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

export const MESSAGE_TEMPLATES = ["ORDER_CONFIRMED", "ORDER_READY", "PAYMENT_RECEIVED"] as const;
export type MessageTemplate = (typeof MESSAGE_TEMPLATES)[number];

const ref = (id: string) => id.slice(-6).toUpperCase();

function render(template: MessageTemplate, o: { id: string; total: unknown; outlet: string }): string {
  const total = `Rs.${money(o.total as never).toFixed(2)}`;
  if (template === "ORDER_CONFIRMED") return `${o.outlet}: your order #${ref(o.id)} is confirmed and sent to the kitchen. Total ${total}.`;
  if (template === "ORDER_READY") return `${o.outlet}: your order #${ref(o.id)} is ready.`;
  return `${o.outlet}: payment of ${total} received for order #${ref(o.id)}. Thank you!`;
}

/** DEFERRED: not now (quiet hours); the caller keeps the job and tries again later. */
export type QueueResult = { status: "QUEUED" | "SKIPPED" | "DUPLICATE" | "DEFERRED"; reason?: string; deliveryId?: string };

/**
 * Queue (and send) one customer message for an order. `auto` = triggered by an
 * event: requires the template to be enabled. A manual send (staff) only needs
 * a connected provider. Destination = the order's customer phone.
 */
export async function queueOrderMessage(ctx: AccessContext, input: { template: MessageTemplate; orderId: string; auto?: boolean; channel?: MessageChannel }, db: PrismaClient = prisma): Promise<QueueResult> {
  const m = await messagingFor(db, ctx.organizationId);
  if (!m) return { status: "SKIPPED", reason: "Messaging is not connected" };
  if (input.auto && !m.config.templates[input.template]) return { status: "SKIPPED", reason: `${input.template} messages are turned off` };
  const order = await db.order.findUnique({ where: { id: input.orderId }, select: { id: true, organizationId: true, outletId: true, total: true, customerId: true, customer: { select: { phone: true } } } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  const phone = normalizePhone(order.customer?.phone);
  if (!phone) return { status: "SKIPPED", reason: "The order has no customer mobile number" };
  const outlet = await db.outlet.findUniqueOrThrow({ where: { id: order.outletId }, select: { name: true } });
  const channel = input.channel ?? m.config.channel;
  if (order.customerId && !(await mayMessage(db, ctx.organizationId, order.customerId, channel, "TRANSACTIONAL"))) return { status: "SKIPPED", reason: "The guest opted out of messages on this channel" };
  const key = `msg:${input.template}:${order.id}:${channel}`;
  const prior = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
  if (prior) return { status: "DUPLICATE", deliveryId: prior.id };
  let delivery;
  try {
    delivery = await db.integrationDelivery.create({
      data: {
        organizationId: ctx.organizationId, outletId: order.outletId, kind: "MESSAGE", provider: m.connection.provider, mode: effectiveMode(m.connection),
        idempotencyKey: key, target: maskPhone(phone), payload: JSON.stringify({ template: input.template, channel, body: render(input.template, { id: order.id, total: order.total, outlet: outlet.name }) }),
        sourceType: "Order", sourceId: order.id, maxAttempts: 3,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { status: "DUPLICATE" };
    throw e;
  }
  await deliverMessage(ctx, delivery.id, db, phone);
  return { status: "QUEUED", deliveryId: delivery.id };
}

/** Where a stored delivery goes: re-read from the guest's own record at send time, never kept in the outbox. */
async function recipientFor(db: PrismaClient, d: { sourceType: string | null; sourceId: string | null }, channel: MessageChannel): Promise<string | undefined> {
  if (!d.sourceId) return undefined;
  if (d.sourceType === "Digest") {
    const g = await db.growthSettings.findUnique({ where: { organizationId: d.sourceId }, select: { digestPhone: true } });
    return channel === "EMAIL" ? undefined : normalizePhone(g?.digestPhone) ?? undefined;
  }
  let customer: { phone: string | null; email: string | null } | null | undefined;
  if (d.sourceType === "Order") customer = (await db.order.findUnique({ where: { id: d.sourceId }, select: { customer: { select: { phone: true, email: true } } } }))?.customer;
  else if (d.sourceType === "Reservation") customer = (await db.reservation.findUnique({ where: { id: d.sourceId }, select: { customer: { select: { phone: true, email: true } } } }))?.customer;
  else if (d.sourceType === "Customer" || d.sourceType === "Marketing") customer = await db.customer.findUnique({ where: { id: d.sourceId }, select: { phone: true, email: true } });
  if (!customer) return undefined;
  return (channel === "EMAIL" ? normalizeEmail(customer.email) : normalizePhone(customer.phone)) ?? undefined;
}

/**
 * Send (or re-send) a MESSAGE delivery. The full phone number / address is never stored:
 * a retry re-reads it from the customer behind the order, booking or guest the message is about.
 */
export async function deliverMessage(ctx: AccessContext, deliveryId: string, db: PrismaClient = prisma, phone?: string) {
  const d = await db.integrationDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || d.organizationId !== ctx.organizationId || d.kind !== "MESSAGE") throw new NotFoundError("Delivery not found");
  if (d.status === "SENT" || d.status === "DELIVERED") return d;
  if (d.attempts >= d.maxAttempts) throw new ValidationError(`Gave up after ${d.maxAttempts} attempts`);
  const payload = JSON.parse(d.payload) as { channel: MessageChannel; body: string; subject?: string };
  const m = await messagingFor(db, ctx.organizationId, payload.channel);
  const to = phone ?? (await recipientFor(db, d, payload.channel));
  const attempts = d.attempts + 1;
  if (!m || !to) {
    return db.integrationDelivery.update({ where: { id: d.id }, data: { status: "FAILED", attempts, lastError: !m ? "Messaging is not connected" : payload.channel === "EMAIL" ? "No customer e-mail address" : "No customer mobile number" } });
  }
  try {
    const statusCallbackUrl = process.env.PUBLIC_BASE_URL && m.provider.name !== "mock" ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/webhooks/messaging/${m.provider.name}` : undefined;
    const sent = await m.provider.send({ channel: payload.channel, to, body: payload.body, subject: payload.subject }, { statusCallbackUrl, idempotencyKey: d.idempotencyKey });
    await recordHealth(db, m.connection.id, true);
    const updated = await db.integrationDelivery.update({ where: { id: d.id }, data: { status: "SENT", attempts, providerRef: sent.providerRef, sentAt: new Date(), lastError: null, nextAttemptAt: null } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "IntegrationDelivery", entityId: d.id, outletId: d.outletId ?? undefined, after: { provider: d.provider, mode: d.mode, target: d.target, status: "SENT", attempt: attempts } }));
    return updated;
  } catch (e) {
    const retryable = e instanceof IntegrationError ? e.retryable : true;
    inc("restora_integration_failures_total", { kind: "message" });
    log.warn("message delivery failed", { event: "integration_failed", kind: "MESSAGE", deliveryId: d.id, provider: d.provider, attempt: attempts, retryable, error: e });
    await recordHealth(db, m.connection.id, false, e);
    const updated = await db.integrationDelivery.update({
      where: { id: d.id },
      data: { status: "FAILED", attempts, lastError: safeMessage(e), nextAttemptAt: retryable && attempts < d.maxAttempts ? nextAttemptAt(attempts) : null },
    });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "IntegrationDelivery", entityId: d.id, outletId: d.outletId ?? undefined, after: { provider: d.provider, mode: d.mode, target: d.target, status: "FAILED", attempt: attempts, error: safeMessage(e) } }));
    return updated;
  }
}

const statusRank: Record<string, number> = { PENDING: 0, FAILED: 1, SENT: 2, DELIVERED: 3 };

/**
 * Provider delivery-status callback (e.g. Twilio StatusCallback). The delivery
 * is found by the provider's message id; the signature is verified with THAT
 * organization's credentials (tenant binding through the outbox row, never a
 * tenant id in the request). Status only moves forward; repeats are no-ops.
 */
export async function handleMessagingStatus(db: PrismaClient, provider: string, url: string, params: Record<string, string>, signature: string | undefined): Promise<{ httpStatus: number; status: string }> {
  const sid = params.MessageSid;
  if (!sid) return { httpStatus: 400, status: "MALFORMED" };
  const d = await db.integrationDelivery.findFirst({ where: { provider, providerRef: sid, kind: "MESSAGE" } });
  if (!d) return { httpStatus: 404, status: "UNKNOWN_MESSAGE" };
  const m = await messagingFor(db, d.organizationId, (JSON.parse(d.payload) as { channel: MessageChannel }).channel);
  if (!m || m.provider.name !== provider || !m.provider.verifyStatusCallback(url, params, signature)) return { httpStatus: 401, status: "INVALID_SIGNATURE" };
  const update = m.provider.parseStatusCallback(params);
  if (!update) return { httpStatus: 200, status: "IGNORED" };
  if ((statusRank[update.status] ?? 0) <= (statusRank[d.status] ?? 0) && !(update.status === "FAILED" && d.status === "SENT")) return { httpStatus: 200, status: "DUPLICATE" };
  await db.integrationDelivery.update({ where: { id: d.id }, data: { status: update.status, lastError: update.error ?? null } });
  return { httpStatus: 200, status: "PROCESSED" };
}

/**
 * Resend delivery events (Svix-signed JSON). The delivery is found by the provider's e-mail id and the signature is
 * checked with THAT organization's webhook secret, so a forged event for another tenant's message is refused.
 */
export async function handleEmailWebhook(db: PrismaClient, rawBody: string, headers: { id?: string; timestamp?: string; signature?: string }): Promise<{ httpStatus: number; status: string }> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, status: "MALFORMED" };
  }
  const update = parseResendEvent(payload);
  if (!update) return { httpStatus: 200, status: "IGNORED" };
  const d = await db.integrationDelivery.findFirst({ where: { provider: "resend", providerRef: update.providerRef, kind: "MESSAGE" } });
  if (!d) return { httpStatus: 404, status: "UNKNOWN_MESSAGE" };
  const m = await messagingFor(db, d.organizationId, "EMAIL");
  const secret = m && m.provider.name === "resend" ? (m.provider as unknown as { webhookSecret?: string }).webhookSecret : undefined;
  if (!secret || !verifyResendWebhook(secret, rawBody, headers)) return { httpStatus: 401, status: "INVALID_SIGNATURE" };
  if ((statusRank[update.status] ?? 0) <= (statusRank[d.status] ?? 0) && !(update.status === "FAILED" && (d.status === "SENT" || d.status === "DELIVERED"))) return { httpStatus: 200, status: "DUPLICATE" };
  await db.integrationDelivery.update({ where: { id: d.id }, data: { status: update.status, lastError: update.error ?? null } });
  // A spam complaint is the strongest "stop": withdraw the guest's marketing consent on e-mail at once.
  if (update.error === "Marked as spam" && d.sourceType === "Marketing" && d.sourceId) {
    await setConsent(systemContext(d.organizationId), d.sourceId, [{ channel: "EMAIL", marketing: false }], "GUEST_REPLY", db).catch((e) => log.warn("could not withdraw consent after a spam complaint", { event: "consent_withdraw_failed", error: e }));
  }
  return { httpStatus: 200, status: "PROCESSED" };
}

export type CustomerMessageInput = {
  customerId: string;
  channel: MessageChannel;
  purpose: Purpose;
  /** Idempotency key: the same event never sends twice (e.g. `camp:<id>:<customer>`, `life:BIRTHDAY:<customer>:2026`). */
  key: string;
  /** What kind of message (stored with the delivery). */
  template: string;
  body: string;
  subject?: string;
  outletId?: string | null;
  /** Transactional messages name what they are about (Order, Reservation, FeedbackRequest ...). Marketing is always about the guest. */
  about?: { type: "Order" | "Reservation" | "Customer"; id: string };
  batchId?: string;
  now?: Date;
};

/**
 * The 9 AM summary to the number the owner configured (Digest source = the organization; the number is re-read from
 * the settings on every attempt). One per organization per day. Not a guest message: no consent applies.
 */
export async function queueDigestMessage(ctx: AccessContext, input: { date: string; channel: "SMS" | "WHATSAPP"; body: string }, db: PrismaClient = prisma): Promise<QueueResult> {
  const settings = await getGrowthSettings(db, ctx.organizationId);
  const phone = normalizePhone(settings.digestPhone);
  if (!phone) return { status: "SKIPPED", reason: "No summary number is configured" };
  const m = await messagingFor(db, ctx.organizationId, input.channel);
  if (!m) return { status: "SKIPPED", reason: `No ${input.channel} provider is connected` };
  const key = `digest:${ctx.organizationId}:${input.date}`;
  if (await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } })) return { status: "DUPLICATE" };
  let delivery;
  try {
    delivery = await db.integrationDelivery.create({
      data: { organizationId: ctx.organizationId, kind: "MESSAGE", provider: m.connection.provider, mode: effectiveMode(m.connection), idempotencyKey: key, target: maskPhone(phone), payload: JSON.stringify({ template: "DAILY_SUMMARY", channel: input.channel, purpose: "TRANSACTIONAL", body: input.body }), sourceType: "Digest", sourceId: ctx.organizationId, maxAttempts: 3 },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { status: "DUPLICATE" };
    throw e;
  }
  await deliverMessage(ctx, delivery.id, db, phone);
  return { status: "QUEUED", deliveryId: delivery.id };
}

/** Marketing quiet hours in the organization's time zone: start inclusive, end exclusive, wrapping midnight. */
export function inQuietHours(now: Date, tz: string, start: number, end: number): boolean {
  if (start === end) return false;
  const h = localHour(now, tz);
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/**
 * The one gate for every message that is not an order receipt. Nothing is queued unless: a provider for the channel
 * is connected; the guest has an address on that channel; the guest agreed (marketing: explicit yes; transactional:
 * not opted out); for marketing, it is outside quiet hours and the guest is under the weekly cap. Internal: callers
 * authorized the action themselves.
 */
export async function queueCustomerMessage(ctx: AccessContext, input: CustomerMessageInput, db: PrismaClient = prisma): Promise<QueueResult> {
  const now = input.now ?? new Date();
  const m = await messagingFor(db, ctx.organizationId, input.channel);
  if (!m) return { status: "SKIPPED", reason: `No ${input.channel} provider is connected` };
  const customer = await db.customer.findUnique({ where: { id: input.customerId }, select: { id: true, organizationId: true, phone: true, email: true } });
  if (!customer || customer.organizationId !== ctx.organizationId) throw new NotFoundError("Customer not found");
  const address = input.channel === "EMAIL" ? normalizeEmail(customer.email) : normalizePhone(customer.phone);
  if (!address) return { status: "SKIPPED", reason: input.channel === "EMAIL" ? "The guest has no e-mail address" : "The guest has no mobile number" };
  if (!(await mayMessage(db, ctx.organizationId, customer.id, input.channel, input.purpose))) {
    return { status: "SKIPPED", reason: input.purpose === "MARKETING" ? "The guest has not agreed to offers on this channel" : "The guest opted out of messages on this channel" };
  }
  const prior = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: input.key } } });
  if (prior) return { status: "DUPLICATE", deliveryId: prior.id };
  if (input.purpose === "MARKETING") {
    const settings = await getGrowthSettings(db, ctx.organizationId);
    const tz = await orgTimeZone(db, ctx);
    if (inQuietHours(now, tz, settings.quietHoursStart, settings.quietHoursEnd)) return { status: "DEFERRED", reason: "Quiet hours" };
    const recent = await db.integrationDelivery.count({ where: { organizationId: ctx.organizationId, kind: "MESSAGE", sourceType: "Marketing", sourceId: customer.id, createdAt: { gte: new Date(now.getTime() - 7 * 86400_000) }, status: { not: "SKIPPED" } } });
    if (recent >= settings.marketingWeeklyCap) return { status: "SKIPPED", reason: "Weekly message limit reached for this guest" };
  }
  const about = input.purpose === "MARKETING" ? { type: "Marketing", id: customer.id } : input.about ?? { type: "Customer", id: customer.id };
  let delivery;
  try {
    delivery = await db.integrationDelivery.create({
      data: {
        organizationId: ctx.organizationId, outletId: input.outletId ?? null, kind: "MESSAGE", provider: m.connection.provider, mode: effectiveMode(m.connection),
        idempotencyKey: input.key, target: input.channel === "EMAIL" ? maskEmail(address) : maskPhone(address),
        payload: JSON.stringify({ template: input.template, channel: input.channel, purpose: input.purpose, subject: input.subject, body: input.body }),
        sourceType: about.type, sourceId: about.id, batchId: input.batchId, maxAttempts: 3,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { status: "DUPLICATE" };
    throw e;
  }
  await deliverMessage(ctx, delivery.id, db, address);
  return { status: "QUEUED", deliveryId: delivery.id };
}

// ---------------- staff-facing ----------------

const listSchema = z.object({ kind: z.enum(["MESSAGE", "AGGREGATOR_STATUS", "ACCOUNTING_VOUCHER"]).optional(), status: z.enum(["PENDING", "SENT", "DELIVERED", "FAILED", "SKIPPED"]).optional(), take: z.coerce.number().int().min(1).max(200).default(50) });

/** Outbox (integration.manage): what was sent where, status, attempts, last error. */
export async function listDeliveries(db: PrismaClient, ctx: AccessContext, input: z.input<typeof listSchema> = {}) {
  if (!can(ctx, "integration.manage")) throw new ForbiddenError('Missing permission "integration.manage"');
  const f = listSchema.parse(input);
  const rows = await db.integrationDelivery.findMany({ where: { organizationId: ctx.organizationId, ...(f.kind ? { kind: f.kind } : {}), ...(f.status ? { status: f.status } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: f.take });
  return rows.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, mode: r.mode, target: r.target, status: r.status, attempts: r.attempts, maxAttempts: r.maxAttempts, lastError: r.lastError, providerRef: r.providerRef, sourceType: r.sourceType, sourceId: r.sourceId, createdAt: r.createdAt, sentAt: r.sentAt, nextAttemptAt: r.nextAttemptAt }));
}

/** Staff send of a receipt / status message for one order (customer must have a mobile number). */
export async function sendOrderMessage(ctx: AccessContext, orderId: string, template: MessageTemplate, db: PrismaClient = prisma) {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { organizationId: true, outletId: true } });
  if (!order || order.organizationId !== ctx.organizationId) throw new NotFoundError("Order not found");
  assertOutletAccess(ctx, order.outletId);
  if (!can(ctx, "customer.view", order.outletId) || !can(ctx, "order.view", order.outletId)) throw new ForbiddenError("Missing permission to message customers");
  return queueOrderMessage(ctx, { template, orderId }, db);
}
