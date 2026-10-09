/**
 * Invitation e-mail for a new team member (audit PA-03): the one-time link to choose a password, sent through the organization's
 * connected e-mail provider.
 *
 * The link is a credential, so the message is sent straight to the provider and never written down: the outbox row records that an
 * invitation was sent (who to, masked, when, with what outcome) and nothing that would let anyone sign in. For the same reason it is
 * attempted once; if it fails, the creator still holds the link to copy, or can send a new invitation (which retires the old link).
 */
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { writeAudit } from "@/server/audit/log";
import { maskEmail, normalizeEmail } from "@/integrations/messaging";
import { IntegrationError, safeMessage } from "@/integrations/http";
import { effectiveMode, messagingFor, recordHealth } from "@/server/services/integrations";
import { guestBaseUrl } from "@/server/services/masterData";
import { issuePasswordLink } from "@/server/services/staff";
import { log } from "@/server/observability/log";
import { inc } from "@/server/observability/metrics";

export type PasswordLinkSent = { userId: string; email: string; name?: string; token: string; purpose: "SETUP" | "RESET"; expiresAt: Date | string };
export type InviteOutcome = { sent: boolean; to: string; deliveryId: string | null; status: "SENT" | "FAILED" | "NOT_SENT"; reason?: string };

/** Everything that can be checked before a link is issued, so a missing provider or address does not cost the user their old link. */
async function inviteSetup(ctx: AccessContext, db: PrismaClient) {
  const base = guestBaseUrl();
  if (!base) throw new ValidationError("The public address of this app (PUBLIC_BASE_URL) is not set, so a link that works from the person's own phone cannot be built");
  const m = await messagingFor(db, ctx.organizationId, "EMAIL");
  if (!m) throw new ValidationError("No e-mail provider is connected (Integrations > Messaging). Copy the link and send it yourself.");
  return { base, m };
}

/** E-mail a link that already exists (the one just shown to the creator). */
export async function emailPasswordLink(ctx: AccessContext, link: PasswordLinkSent, db: PrismaClient = prisma): Promise<InviteOutcome> {
  const to = normalizeEmail(link.email);
  if (!to) return { sent: false, to: "", deliveryId: null, status: "NOT_SENT", reason: "The person has no valid e-mail address" };
  const masked = maskEmail(to);
  let setup;
  try {
    setup = await inviteSetup(ctx, db);
  } catch (e) {
    return { sent: false, to: masked, deliveryId: null, status: "NOT_SENT", reason: e instanceof ValidationError ? e.message : safeMessage(e) };
  }
  const { base, m } = setup;
  const org = await db.organization.findUnique({ where: { id: ctx.organizationId }, select: { name: true } });
  const inviter = ctx.userId === "system" ? null : (await db.user.findUnique({ where: { id: ctx.userId }, select: { name: true } }))?.name ?? null;
  const url = `${base}/set-password#token=${encodeURIComponent(link.token)}`;
  const expires = new Date(link.expiresAt).toUTCString();
  const setupText = link.purpose === "SETUP" ? "set your password and sign in" : "choose a new password";
  const subject = link.purpose === "SETUP" ? `Your ${org?.name ?? "RESTORA"} account is ready` : `Choose a new password for ${org?.name ?? "RESTORA"}`;
  const body = `Hello${link.name ? ` ${link.name}` : ""},\n\n${inviter ? `${inviter} has` : "You have been"} ${link.purpose === "SETUP" ? "invited you to" : "sent you a link for"} ${org?.name ?? "RESTORA"}. Use this one-time link to ${setupText}:\n\n${url}\n\nThe link works once and expires on ${expires}. If you were not expecting this, ignore this message.`;

  const key = `staffinvite:${link.userId}:${new Date(link.expiresAt).getTime()}`;
  let delivery = await db.integrationDelivery.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: key } } });
  if (delivery) return { sent: delivery.status === "SENT", to: masked, deliveryId: delivery.id, status: delivery.status === "SENT" ? "SENT" : "FAILED", reason: delivery.lastError ?? undefined };
  delivery = await db.integrationDelivery.create({
    data: {
      organizationId: ctx.organizationId, kind: "MESSAGE", provider: m.connection.provider, mode: effectiveMode(m.connection), idempotencyKey: key, target: masked,
      payload: JSON.stringify({ template: "STAFF_INVITE", channel: "EMAIL", purpose: "TRANSACTIONAL", subject, body: "The invitation link is not stored. Send a new invitation to try again." }),
      sourceType: "User", sourceId: link.userId, maxAttempts: 1,
    },
  });
  try {
    const sent = await m.provider.send({ channel: "EMAIL", to, subject, body }, { idempotencyKey: key });
    await recordHealth(db, m.connection.id, true);
    await db.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", attempts: 1, providerRef: sent.providerRef, sentAt: new Date(), lastError: null, nextAttemptAt: null } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "User", entityId: link.userId, after: { template: "STAFF_INVITE", target: masked, provider: m.connection.provider, status: "SENT" } }));
    return { sent: true, to: masked, deliveryId: delivery.id, status: "SENT" };
  } catch (e) {
    inc("restora_integration_failures_total", { kind: "message" });
    log.warn("staff invitation e-mail failed", { event: "integration_failed", kind: "MESSAGE", deliveryId: delivery.id, provider: delivery.provider, retryable: e instanceof IntegrationError ? e.retryable : true, error: e });
    await recordHealth(db, m.connection.id, false, e);
    await db.integrationDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", attempts: 1, lastError: safeMessage(e), nextAttemptAt: null } });
    await db.$transaction((tx) => writeAudit(tx, ctx, { action: "MESSAGE_SEND", entityType: "User", entityId: link.userId, after: { template: "STAFF_INVITE", target: masked, provider: m.connection.provider, status: "FAILED", error: safeMessage(e) } }));
    return { sent: false, to: masked, deliveryId: delivery.id, status: "FAILED", reason: safeMessage(e) };
  }
}

/**
 * Issue a fresh link for somebody (same authority as the "password link" action; the old link stops working) and e-mail it.
 * The link is returned either way, so a failed e-mail never leaves the person without a way in.
 */
export async function sendStaffInvite(ctx: AccessContext, userId: string, db: PrismaClient = prisma) {
  await inviteSetup(ctx, db); // refuse before the old link is retired
  const link = await issuePasswordLink(ctx, userId, db);
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  const invite = await emailPasswordLink(ctx, { ...link, name: user?.name }, db);
  return { link, invite };
}
