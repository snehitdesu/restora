/**
 * Owner offline recovery codes.
 *
 * An active organization-wide OWNER can generate a set of RECOVERY_CODE_COUNT
 * codes after re-entering their password (step-up scope "security.manage").
 * Each code is 16 Crockford base32 characters from the OS CSPRNG (80 bits),
 * shown once as XXXX-XXXX-XXXX-XXXX. Only SHA-256("restora-recovery-v1:" +
 * userId + ":" + code) is stored, so a code is bound to its owner and a
 * leaked database yields nothing usable. A new set deletes the previous one.
 *
 * Redeeming a code (email + code + new password, no session) is the recovery
 * path for an owner who cannot receive email or has no email configured
 * (offline desktop). It consumes exactly that code atomically, sets the
 * password, retires every outstanding password link and revokes every session
 * of the account. There is no master or universal code: a code only ever works
 * for the owner it was generated for, and only while they are an active owner.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { PASSWORD_MAX_BYTES } from "@/constants/password";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/server/db/scope";
import { hashPassword } from "@/server/auth/password";
import { retireUserTokens } from "@/server/auth/passwordTokens";
import { runInTx } from "@/server/services/_workflow";
import { runAfterResponse } from "@/server/api/afterResponse";
import { assertPasswordPolicy } from "@/server/auth/account";
import { deliverSecurityNotice, noticePlan, passwordChangedMessage, recoveryCodesMessage, type NoticeOutcome } from "@/server/auth/securityMail";

type Client = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string; userAgent?: string };

export const RECOVERY_CODE_COUNT = 10;
/** Crockford base32: no I, L, O or U, so codes survive being read aloud or handwritten. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16;
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

export const INVALID_RECOVERY_MESSAGE = "That email and recovery code do not match an owner account, or the code was already used.";

/** One code from 10 random bytes (80 bits, exactly 16 base32 symbols). */
export function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

export function formatRecoveryCode(code: string): string {
  return code.match(/.{1,4}/g)!.join("-");
}

/** Accept what a person types: any case, spaces or dashes, and O/I/L for 0/1. Null when it cannot be a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_PATTERN.test(c) ? c : null;
}

export function hashRecoveryCode(userId: string, code: string): string {
  return createHash("sha256").update(`restora-recovery-v1:${userId}:${code}`).digest("hex");
}

/** Is the user an active organization-wide OWNER of their own organization? */
export async function isRecoveryEligible(db: Client, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { active: true, organizationId: true } });
  if (!user?.active) return false;
  const owner = await db.membership.count({ where: { userId, organizationId: user.organizationId, role: "OWNER", outletId: null, active: true } });
  return owner > 0;
}

export type RecoveryStatus = {
  eligible: boolean;
  remaining: number;
  total: number;
  generatedAt: Date | null;
  activeOwners: number;
};

export async function recoveryStatus(db: Client, userId: string): Promise<RecoveryStatus> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
  if (!user) throw new UnauthorizedError();
  const [eligible, codes, activeOwners] = await Promise.all([
    isRecoveryEligible(db, userId),
    db.recoveryCode.findMany({ where: { userId }, select: { usedAt: true, createdAt: true } }),
    db.user.count({ where: { organizationId: user.organizationId, active: true, memberships: { some: { role: "OWNER", outletId: null, active: true } } } }),
  ]);
  return {
    eligible,
    remaining: eligible ? codes.filter((c) => !c.usedAt).length : 0,
    total: codes.length,
    generatedAt: codes.length ? new Date(Math.max(...codes.map((c) => c.createdAt.getTime()))) : null,
    activeOwners,
  };
}

export type RecoveryGap = "no_codes" | "few_codes" | "email_not_verified" | "sole_owner";

/**
 * What an owner still has to set up so a lost password never locks the
 * business out. Empty for non-owners (their recovery is an owner-issued link).
 */
export async function recoverySetupGaps(db: Client, userId: string): Promise<RecoveryGap[]> {
  const [status, user] = await Promise.all([recoveryStatus(db, userId), db.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } })]);
  if (!status.eligible) return [];
  const gaps: RecoveryGap[] = [];
  if (status.total === 0 || status.remaining === 0) gaps.push("no_codes");
  else if (status.remaining <= 2) gaps.push("few_codes");
  if (!user?.emailVerifiedAt) gaps.push("email_not_verified");
  if (status.activeOwners < 2) gaps.push("sole_owner");
  return gaps;
}

/**
 * Replace the user's recovery codes with a fresh set and return the plaintext
 * codes (the only time they exist). The caller must already hold a fresh
 * "security.manage" step-up grant (requireFreshAuth in the route).
 */
export async function generateRecoveryCodes(db: PrismaClient, userId: string, meta: Meta = {}): Promise<{ codes: string[]; generatedAt: Date; notice: NoticeOutcome }> {
  const result = await runInTx(db, async (tx) => {
    if (!(await isRecoveryEligible(tx, userId))) throw new ForbiddenError("Only an active organization owner can generate recovery codes");
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const now = new Date();
    const batchId = randomUUID();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    if (new Set(codes).size !== codes.length) throw new Error("recovery code collision"); // 2^-80 per pair; never expected
    const replaced = await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ organizationId: user.organizationId, userId, batchId, codeHash: hashRecoveryCode(userId, c), createdAt: now })) });
    await tx.auditLog.create({
      data: { organizationId: user.organizationId, actorId: userId, action: "RECOVERY_CODES_GENERATED", entityType: "User", entityId: userId, after: JSON.stringify({ batchId, count: codes.length, replaced: replaced.count }), ip: meta.ip, userAgent: meta.userAgent },
    });
    return { user, codes, now };
  });
  const { user, codes, now } = result;
  const notice = noticePlan(user);
  runAfterResponse("recovery-codes-notice", () =>
    deliverSecurityNotice(db, user, "recovery_codes_generated", recoveryCodesMessage({ to: user.email, name: user.name, at: now, count: codes.length }), meta));
  return { codes: codes.map(formatRecoveryCode), generatedAt: now, notice };
}

export const redeemSchema = z.object({
  email: z.string().email().max(200),
  code: z.string().min(1).max(64),
  newPassword: z.string().max(PASSWORD_MAX_BYTES * 4),
});

/**
 * Recover an owner account with one code. Every way the email/code pair can be
 * wrong (unknown email, inactive user, not an owner, wrong, used or replaced
 * code) gives the same error after the same two lookups, so neither the answer
 * nor its timing says whether the email has an account. A wrong code for a
 * real account is audited after the response.
 */
export async function redeemRecoveryCode(db: PrismaClient, input: z.input<typeof redeemSchema>, meta: Meta = {}): Promise<{ email: string; remaining: number; sessionsRevoked: number; notice: NoticeOutcome }> {
  const { email, code, newPassword } = redeemSchema.parse(input);
  const normalized = normalizeRecoveryCode(code);
  const user = await db.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  // Unknown email or malformed code: still look up a hash that matches nothing.
  const hash = hashRecoveryCode(user?.id ?? "nobody", normalized ?? "0".repeat(CODE_LENGTH));
  const row = await db.recoveryCode.findUnique({ where: { codeHash: hash } });
  const usable = !!user && !!normalized && !!row && row.userId === user.id && !row.usedAt && (await isRecoveryEligible(db, user.id));
  if (!usable) {
    if (user) {
      runAfterResponse("recovery-code-failed-audit", () =>
        db.auditLog.create({ data: { organizationId: user.organizationId, actorId: null, action: "RECOVERY_CODE_FAILED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent } }));
    }
    throw new ValidationError(INVALID_RECOVERY_MESSAGE, { fieldErrors: { code: [INVALID_RECOVERY_MESSAGE] } });
  }
  // The policy is checked before the code is consumed, so a rejected password does not burn it.
  assertPasswordPolicy(newPassword, { email: user.email, name: user.name });
  const passwordHash = await hashPassword(newPassword);
  const done = await runInTx(db, async (tx) => {
    const now = new Date();
    const spent = await tx.recoveryCode.updateMany({ where: { id: row.id, userId: user.id, usedAt: null }, data: { usedAt: now } });
    if (spent.count !== 1 || !(await isRecoveryEligible(tx, user.id))) throw new ValidationError(INVALID_RECOVERY_MESSAGE, { fieldErrors: { code: [INVALID_RECOVERY_MESSAGE] } });
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
    await retireUserTokens(tx, user.id, now);
    const revoked = await tx.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now, reauthScope: null, reauthExpiresAt: null } });
    const remaining = await tx.recoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await tx.auditLog.create({
      data: { organizationId: user.organizationId, actorId: user.id, action: "RECOVERY_CODE_USED", entityType: "User", entityId: user.id, after: JSON.stringify({ batchId: row.batchId, remaining, sessionsRevoked: revoked.count }), ip: meta.ip, userAgent: meta.userAgent },
    });
    return { now, remaining, sessionsRevoked: revoked.count };
  });
  const notice = noticePlan(user);
  runAfterResponse("password-changed-notice", () =>
    deliverSecurityNotice(db, user, "password_changed", passwordChangedMessage({ to: user.email, name: user.name, method: "recovery_code", at: done.now, ip: meta.ip, remainingCodes: done.remaining }), meta));
  return { email: user.email, remaining: done.remaining, sessionsRevoked: done.sessionsRevoked, notice };
}
