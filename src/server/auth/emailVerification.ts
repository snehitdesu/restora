/**
 * Verify a user's sign-in address. A signed-in user asks for a link; it is
 * emailed (Resend) as a one-time VERIFY_EMAIL token (only its SHA-256 is
 * stored, 24 h, single use). Opening it sets User.emailVerifiedAt. Only a
 * verified address receives password-reset links and security notices, so a
 * mistyped or stale address never becomes a way into the account.
 *
 * The request is synchronous and honest: an unconfigured deployment or a
 * rejected send is reported to the signed-in user (it reveals nothing about
 * other accounts), and an undelivered link is retired at once.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { log } from "@/server/observability/log";
import { UnauthorizedError, ValidationError } from "@/server/db/scope";
import { hashToken } from "@/server/auth/session";
import { issuePasswordToken, findUsablePasswordToken, consumePasswordToken, INVALID_TOKEN_MESSAGE } from "@/server/auth/passwordTokens";
import { runInTx } from "@/server/services/_workflow";
import { EmailDeliveryError, EmailNotConfiguredError, securityMailer, verificationMessage, verifyEmailUrl } from "@/server/auth/securityMail";

type Meta = { ip?: string; userAgent?: string };

export const INVALID_VERIFY_MESSAGE = "This verification link is invalid or has expired. Send a new one from Account security.";

async function audit(db: PrismaClient, row: { organizationId: string; actorId: string | null; action: string; entityId: string; after?: unknown } & Meta) {
  await db.auditLog.create({
    data: { organizationId: row.organizationId, actorId: row.actorId, action: row.action, entityType: "User", entityId: row.entityId, after: row.after === undefined ? null : JSON.stringify(row.after), ip: row.ip, userAgent: row.userAgent },
  });
}

export async function requestEmailVerification(db: PrismaClient, userId: string, meta: Meta = {}): Promise<{ status: "sent" | "already_verified"; email: string; expiresAt?: Date }> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) throw new UnauthorizedError();
  if (user.emailVerifiedAt) return { status: "already_verified", email: user.email };
  const mailer = securityMailer();
  if (!mailer) {
    log.warn("email verification requested but email delivery is not configured", { event: "email_verification_unconfigured", userId });
    throw new EmailNotConfiguredError();
  }
  const issued = await issuePasswordToken(db, { organizationId: user.organizationId, userId, purpose: "VERIFY_EMAIL", createdById: userId });
  try {
    await mailer.send(verificationMessage({ to: user.email, name: user.name, link: verifyEmailUrl(mailer.baseUrl, issued.token), expiresAt: issued.expiresAt }));
  } catch (e) {
    log.error("email verification delivery failed", { event: "email_verification_failed", userId, error: e instanceof Error ? e.name : "Error" });
    await db.passwordToken.updateMany({ where: { tokenHash: hashToken(issued.token), usedAt: null }, data: { usedAt: new Date() } });
    await audit(db, { organizationId: user.organizationId, actorId: userId, action: "EMAIL_VERIFICATION_FAILED", entityId: userId, ...meta });
    throw new EmailDeliveryError();
  }
  await audit(db, { organizationId: user.organizationId, actorId: userId, action: "EMAIL_VERIFICATION_SENT", entityId: userId, after: { expiresAt: issued.expiresAt }, ...meta });
  return { status: "sent", email: user.email, expiresAt: issued.expiresAt };
}

export const verifySchema = z.object({ token: z.string().min(1).max(200) });

/** Consume a VERIFY_EMAIL token and mark the address verified. Password tokens are refused here (and vice versa). */
export async function confirmEmailVerification(db: PrismaClient, input: z.input<typeof verifySchema>, meta: Meta = {}): Promise<{ email: string }> {
  const { token } = verifySchema.parse(input);
  let row: Awaited<ReturnType<typeof findUsablePasswordToken>>;
  try {
    row = await findUsablePasswordToken(db, token, new Date(), ["VERIFY_EMAIL"]);
  } catch {
    throw new ValidationError(INVALID_VERIFY_MESSAGE);
  }
  return runInTx(db, async (tx) => {
    const now = new Date();
    try {
      await consumePasswordToken(tx, row.id, now);
    } catch (e) {
      if (e instanceof ValidationError && e.message === INVALID_TOKEN_MESSAGE) throw new ValidationError(INVALID_VERIFY_MESSAGE);
      throw e;
    }
    // The address verified is the one on the account now, which is the one the link was mailed to.
    await tx.user.updateMany({ where: { id: row.userId, active: true, email: row.user.email }, data: { emailVerifiedAt: now } });
    await tx.auditLog.create({ data: { organizationId: row.organizationId, actorId: row.userId, action: "EMAIL_VERIFIED", entityType: "User", entityId: row.userId, ip: meta.ip, userAgent: meta.userAgent } });
    return { email: row.user.email };
  });
}
