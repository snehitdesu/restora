/**
 * Password lifecycle: complete a setup/reset link, request a reset, change a
 * password. Transport-agnostic (route handlers add origin checks, body caps and
 * rate limits). Raw passwords and raw tokens are never logged or audited.
 */
import { log } from "@/server/observability/log";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { passwordProblems, PASSWORD_MAX_BYTES } from "@/constants/password";
import { ValidationError, UnauthorizedError } from "@/server/db/scope";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/session";
import { runInTx, type Tx } from "@/server/services/_workflow";
import { issuePasswordToken, retireUserTokens, findUsablePasswordToken, consumePasswordToken, INVALID_TOKEN_MESSAGE } from "@/server/auth/passwordTokens";
import { resendPasswordDelivery } from "@/server/auth/passwordResetMail";
import { runAfterResponse } from "@/server/api/afterResponse";
import { deliverSecurityNotice, noticePlan, passwordChangedMessage, type NoticeOutcome } from "@/server/auth/securityMail";

type Meta = { ip?: string; userAgent?: string };

// Generous upper bound so the policy (not zod) reports over-long passwords with a clear message.
const passwordField = z.string().max(PASSWORD_MAX_BYTES * 4);

/** Throws a 422 listing every policy problem. */
export function assertPasswordPolicy(password: string, ctx: { email?: string; name?: string } = {}): void {
  const problems = passwordProblems(password, ctx);
  if (problems.length) throw new ValidationError(problems[0], { fieldErrors: { password: problems } });
}

async function audit(tx: Tx, row: { organizationId: string; actorId: string | null; action: string; entityId: string; after?: unknown } & Meta): Promise<string> {
  const created = await tx.auditLog.create({
    data: {
      organizationId: row.organizationId, actorId: row.actorId, action: row.action, entityType: "User", entityId: row.entityId,
      after: row.after === undefined ? null : JSON.stringify(row.after), ip: row.ip, userAgent: row.userAgent,
    },
    select: { id: true },
  });
  return created.id;
}

// ---------------- Complete a setup / reset link ----------------

export const completeSchema = z.object({ token: z.string().min(1).max(200), password: passwordField });

/**
 * Set the password for the token's user. The policy is checked BEFORE the token
 * is consumed, so a rejected password does not burn the link. On success the
 * token (and every other outstanding token of the user) is spent and all of the
 * user's sessions are revoked. The user then signs in normally. A verified
 * address is told about the change (after the response).
 */
export async function completePasswordToken(db: PrismaClient, input: z.input<typeof completeSchema>, meta: Meta = {}): Promise<{ email: string; purpose: "SETUP" | "RESET"; notice: NoticeOutcome }> {
  const { token, password } = completeSchema.parse(input);
  const row = await findUsablePasswordToken(db, token);
  assertPasswordPolicy(password, { email: row.user.email, name: row.user.name });
  const passwordHash = await hashPassword(password);
  const done = await runInTx(db, async (tx) => {
    const now = new Date();
    await consumePasswordToken(tx, row.id, now);
    const updated = await tx.user.updateMany({ where: { id: row.userId, active: true }, data: { passwordHash } });
    if (updated.count !== 1) throw new ValidationError(INVALID_TOKEN_MESSAGE);
    await retireUserTokens(tx, row.userId, now);
    const revoked = await tx.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    await audit(tx, { organizationId: row.organizationId, actorId: row.userId, action: "PASSWORD_SET", entityId: row.userId, after: { purpose: row.purpose, sessionsRevoked: revoked.count }, ...meta });
    return { email: row.user.email, purpose: row.purpose as "SETUP" | "RESET", now };
  });
  const notice = notifyPasswordChanged(db, row.user, "reset_link", done.now, meta);
  return { email: done.email, purpose: done.purpose, notice };
}

/** Schedule the "your password was changed" notice; returns what the person should expect. */
function notifyPasswordChanged(
  db: PrismaClient,
  user: { id: string; organizationId: string; email: string; name: string; emailVerifiedAt: Date | null },
  method: "change" | "reset_link",
  at: Date,
  meta: Meta,
): NoticeOutcome {
  const plan = noticePlan(user);
  runAfterResponse("password-changed-notice", () =>
    deliverSecurityNotice(db, user, "password_changed", passwordChangedMessage({ to: user.email, name: user.name, method, at, ip: meta.ip }), meta));
  return plan;
}

// ---------------- Self-service reset request ----------------

export const resetRequestSchema = z.object({ email: z.string().email().max(200) });

/** The public response, identical for existing, unknown and inactive accounts (no account enumeration). */
export const RESET_ACCEPTED_MESSAGE =
  "If an active account with a confirmed email address exists for that email, a reset link will be sent to it. If nothing arrives, ask your manager to issue a password link (owners can also use a recovery code).";

/**
 * The response when this deployment has no reset email at all. Whether email is
 * set up is a property of the deployment, not of any account, so saying so
 * reveals nothing about who has an account — and promising a link that cannot
 * be sent would leave the person waiting for nothing.
 */
export const RESET_MANAGER_MESSAGE =
  "Password reset by email is not set up for this workspace, so no email was sent. Ask your owner or manager to issue a password link from Staff.";

export type ResetDelivery = "email" | "manager";

/** What the forgot-password page may promise. Same answer for every email address. */
export function resetRequestOutcome(): { delivery: ResetDelivery; message: string } {
  registerPasswordResetDelivery();
  return delivery ? { delivery: "email", message: RESET_ACCEPTED_MESSAGE } : { delivery: "manager", message: RESET_MANAGER_MESSAGE };
}

/**
 * Out-of-band delivery of a reset link. Resend is registered when
 * RESEND_API_KEY, RESEND_FROM and PUBLIC_BASE_URL are all set. Until then the
 * request is recorded and NO token is created — a link nobody can receive
 * would only widen the attack surface. A manager can still issue a link
 * (staff `password-link`).
 */
export type PasswordLinkDelivery = (msg: { to: string; name: string; token: string; expiresAt: Date }) => Promise<void>;
let delivery: PasswordLinkDelivery | null = null;
export function setPasswordLinkDelivery(fn: PasswordLinkDelivery | null): void {
  delivery = fn;
}
/** Whether a reset link can be delivered out of band (Resend registered). */
export function passwordLinkDeliveryConfigured(): boolean {
  return delivery !== null;
}

/**
 * Install the Resend sender when RESEND_API_KEY, RESEND_FROM and PUBLIC_BASE_URL
 * are set. Called from server startup and again on each reset request so a
 * separate serverless bundle still has the sender. An already registered
 * function (tests, or an earlier call) is left in place.
 */
export function registerPasswordResetDelivery(): void {
  if (delivery) return;
  const send = resendPasswordDelivery();
  if (send) setPasswordLinkDelivery(send);
}

/**
 * Always resolves the same way whether or not the account exists (no account
 * enumeration). Links are only emailed to a VERIFIED address (emailVerifiedAt):
 * an address nobody ever confirmed may be mistyped or belong to someone else.
 * Delivery failures are logged without the token. The HTTP route
 * runs this after its response (server/api/afterResponse.ts), so the response
 * time does not depend on whether an account exists or an email was sent.
 */
export async function requestPasswordReset(db: PrismaClient, input: z.input<typeof resetRequestSchema>, meta: Meta = {}): Promise<void> {
  registerPasswordResetDelivery();
  const email = resetRequestSchema.parse(input).email.toLowerCase().trim();
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active) return;
  if (!user.emailVerifiedAt) {
    await audit(db as unknown as Tx, { organizationId: user.organizationId, actorId: null, action: "PASSWORD_RESET_REQUEST", entityId: user.id, after: { delivered: false, reason: "email_not_verified" }, ...meta });
    return;
  }
  const send = delivery;
  const issued = await runInTx(db, async (tx) => {
    const t = send ? await issuePasswordToken(tx, { organizationId: user.organizationId, userId: user.id, purpose: "RESET", createdById: null }) : null;
    // The request row says delivered: false; a PASSWORD_RESET_DELIVERED row follows once Resend
    // accepts the message. A token that was issued and then rejected is retired below.
    await audit(tx, { organizationId: user.organizationId, actorId: null, action: "PASSWORD_RESET_REQUEST", entityId: user.id, after: { delivered: false, expiresAt: t?.expiresAt ?? null }, ...meta });
    return { token: t };
  });
  if (!issued.token || !send) return;
  try {
    await send({ to: user.email, name: user.name, token: issued.token.token, expiresAt: issued.token.expiresAt });
  } catch (e) {
    log.error("password reset delivery failed", { event: "password_reset_delivery_failed", userId: user.id, error: e instanceof Error ? e.name : "Error" });
    // Only the link that was not delivered: a concurrent request may already have
    // issued (and delivered) a newer one, which must keep working.
    await db.passwordToken.updateMany({ where: { tokenHash: hashToken(issued.token.token), usedAt: null }, data: { usedAt: new Date() } }).catch((err) => {
      log.error("password reset token could not be retired after a failed delivery", { event: "password_reset_retire_failed", userId: user.id, error: err instanceof Error ? err.name : "Error" });
    });
    return;
  }
  // The audit log is append-only (database triggers): the delivery is recorded as its own row.
  await audit(db as unknown as Tx, { organizationId: user.organizationId, actorId: null, action: "PASSWORD_RESET_DELIVERED", entityId: user.id, after: { delivered: true, expiresAt: issued.token.expiresAt }, ...meta }).catch((e) => {
    log.error("password reset audit could not record delivery", { event: "password_reset_audit_failed", userId: user.id, error: e instanceof Error ? e.name : "Error" });
  });
}

// ---------------- Authenticated change ----------------

export const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordField });

/**
 * Change the caller's password. Requires the current password; the new one
 * must satisfy the policy and differ from the current one. Every OTHER session
 * of the user is revoked; the session making the request stays signed in. A
 * verified address is told about the change (after the response).
 */
export async function changePassword(
  db: PrismaClient,
  caller: { userId: string; sessionToken: string },
  input: z.input<typeof changeSchema>,
  meta: Meta = {}
): Promise<{ sessionsRevoked: number; notice: NoticeOutcome }> {
  const { currentPassword, newPassword } = changeSchema.parse(input);
  const user = await db.user.findUnique({ where: { id: caller.userId } });
  if (!user || !user.active) throw new UnauthorizedError();
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new ValidationError("Current password is incorrect", { fieldErrors: { currentPassword: ["Current password is incorrect"] } });
  if (newPassword === currentPassword) throw new ValidationError("The new password must be different from the current one", { fieldErrors: { newPassword: ["Must differ from the current password"] } });
  assertPasswordPolicy(newPassword, { email: user.email, name: user.name });
  const passwordHash = await hashPassword(newPassword);
  const keep = hashToken(caller.sessionToken);
  const done = await runInTx(db, async (tx) => {
    const now = new Date();
    // Optimistic guard: fails if the password changed since it was verified above.
    const updated = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash } });
    if (updated.count !== 1) throw new ValidationError("Your password was changed elsewhere. Sign in again and retry.");
    const revoked = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null, tokenHash: { not: keep } }, data: { revokedAt: now } });
    await retireUserTokens(tx, user.id, now);
    await audit(tx, { organizationId: user.organizationId, actorId: user.id, action: "PASSWORD_CHANGE", entityId: user.id, after: { sessionsRevoked: revoked.count }, ...meta });
    return { sessionsRevoked: revoked.count, now };
  });
  return { sessionsRevoked: done.sessionsRevoked, notice: notifyPasswordChanged(db, user, "change", done.now, meta) };
}
