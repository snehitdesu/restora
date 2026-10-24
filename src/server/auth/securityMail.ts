/**
 * Account-security email: the link that verifies a sign-in address, and the
 * notices sent to a VERIFIED address after a password change or after new
 * recovery codes are generated.
 *
 * Same Resend settings as password-reset email (RESEND_API_KEY, RESEND_FROM,
 * PUBLIC_BASE_URL). When they are missing nothing pretends to send: the
 * verification request fails with EmailNotConfiguredError, and a notice is
 * recorded as not delivered with the reason. Raw tokens, keys and message
 * bodies are never logged or audited.
 */
import type { PrismaClient, Prisma } from "@prisma/client";
import { log } from "@/server/observability/log";
import { escapeHtml, postResendEmail, resendPasswordConfig, resendPasswordProblems, type ResendMessage } from "@/server/auth/passwordResetMail";

type Client = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string; userAgent?: string };

/** The settings a deployment needs for any account email. */
export const EMAIL_SETTINGS = ["RESEND_API_KEY", "RESEND_FROM", "PUBLIC_BASE_URL"] as const;

export const EMAIL_NOT_CONFIGURED_MESSAGE =
  "Email delivery is not configured on this server, so no email was sent. Set RESEND_API_KEY, RESEND_FROM (a verified sender) and PUBLIC_BASE_URL, then restart.";
export const EMAIL_DELIVERY_FAILED_MESSAGE =
  "The email could not be sent: the email provider did not accept it. Check the Resend API key and the verified sender, then try again.";

/** 503: the deployment has no email delivery at all. Not an account fact, so safe to say to anyone. */
export class EmailNotConfiguredError extends Error {
  status = 503;
  constructor(message = EMAIL_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "EmailNotConfigured";
  }
}

/** 503: configured, but the provider rejected or never answered. */
export class EmailDeliveryError extends Error {
  status = 503;
  constructor(message = EMAIL_DELIVERY_FAILED_MESSAGE) {
    super(message);
    this.name = "EmailDeliveryFailed";
  }
}

export type SecurityMailer = { baseUrl: string; send: (msg: ResendMessage) => Promise<void> };

// undefined = derive from the environment; null = explicitly none (tests).
let override: SecurityMailer | null | undefined;
/** Tests: install a mailer, null for "no email", or undefined to go back to the environment. */
export function setSecurityMailer(mailer: SecurityMailer | null | undefined): void {
  override = mailer;
}

/** The sender for account email, or null when this deployment cannot send any. */
export function securityMailer(env: NodeJS.ProcessEnv = process.env): SecurityMailer | null {
  if (override !== undefined) return override;
  const cfg = resendPasswordConfig(env);
  if (!cfg) return null;
  return { baseUrl: cfg.baseUrl, send: (msg) => postResendEmail(cfg, msg, globalThis.fetch, "Security email was not accepted") };
}

/** What the security page shows about email delivery. Names settings, never values. */
export function emailDeliveryStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; problems: string[] } {
  if (securityMailer(env)) return { configured: true, problems: [] };
  const problems = resendPasswordProblems(env);
  return { configured: false, problems: problems.length ? problems : [`Not set: ${EMAIL_SETTINGS.filter((k) => !env[k]?.trim()).join(", ") || "valid Resend settings"}`] };
}

export function verifyEmailUrl(baseUrl: string, token: string): string {
  const url = new URL("/verify-email", `${baseUrl.replace(/\/+$/, "")}/`);
  url.hash = `token=${token}`;
  return url.toString();
}

function message(to: string, subject: string, lines: string[], link?: string): ResendMessage {
  const text = [...lines, ...(link ? ["", link] : [])].join("\n");
  const html = lines.filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join("") + (link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : "");
  return { to, subject, text, html };
}

export function verificationMessage(m: { to: string; name: string; link: string; expiresAt: Date }): ResendMessage {
  return message(m.to, "Confirm your RESTORA email address", [
    `${m.name}, open this link to confirm that ${m.to} is your address. It expires at ${m.expiresAt.toISOString()} and works once.`,
    "Password reset links and security notices are only sent to a confirmed address.",
    "If you did not ask for this, you can ignore this email.",
  ], m.link);
}

export type PasswordChangeMethod = "change" | "reset_link" | "recovery_code";
const METHOD_TEXT: Record<PasswordChangeMethod, string> = {
  change: "from a signed-in session (the current password was entered)",
  reset_link: "with a one-time password link",
  recovery_code: "with an owner recovery code",
};

export function passwordChangedMessage(m: { to: string; name: string; method: PasswordChangeMethod; at: Date; ip?: string; remainingCodes?: number }): ResendMessage {
  return message(m.to, "Your RESTORA password was changed", [
    `${m.name}, the password for ${m.to} was changed at ${m.at.toISOString()} ${METHOD_TEXT[m.method]}${m.ip ? ` from IP address ${m.ip}` : ""}.`,
    "Every other signed-in session of this account was signed out.",
    ...(m.method === "recovery_code" && m.remainingCodes !== undefined ? [`${m.remainingCodes} unused recovery code${m.remainingCodes === 1 ? "" : "s"} remain. Generate a new set from Account security once you are signed in.`] : []),
    "If this was not you, sign in with a recovery code or ask another owner to issue you a password link, and then review the audit log.",
  ]);
}

export function recoveryCodesMessage(m: { to: string; name: string; at: Date; count: number }): ResendMessage {
  return message(m.to, "New RESTORA recovery codes were generated", [
    `${m.name}, ${m.count} new recovery codes were generated for ${m.to} at ${m.at.toISOString()}. Every earlier recovery code stopped working.`,
    "If this was not you, change your password now and generate a new set.",
  ]);
}

export type NoticeOutcome = "sent" | "not_verified" | "not_configured";

/**
 * Whether a notice WILL be attempted for this user. Decided before the work is
 * scheduled so the API can tell the person what to expect.
 */
export function noticePlan(user: { emailVerifiedAt: Date | null }): NoticeOutcome {
  if (!user.emailVerifiedAt) return "not_verified";
  return securityMailer() ? "sent" : "not_configured";
}

/**
 * Send one security notice to a verified address and record the outcome as a
 * SECURITY_NOTICE audit row ({ kind, delivered, reason }). Never throws: the
 * change it reports has already been committed.
 */
export async function deliverSecurityNotice(
  db: Client,
  user: { id: string; organizationId: string; email: string; emailVerifiedAt: Date | null },
  kind: "password_changed" | "recovery_codes_generated",
  msg: ResendMessage,
  meta: Meta = {},
): Promise<{ delivered: boolean; reason?: string }> {
  const mailer = user.emailVerifiedAt ? securityMailer() : null;
  let outcome: { delivered: boolean; reason?: string };
  if (!user.emailVerifiedAt) outcome = { delivered: false, reason: "email_not_verified" };
  else if (!mailer) outcome = { delivered: false, reason: "email_not_configured" };
  else {
    try {
      await mailer.send(msg);
      outcome = { delivered: true };
    } catch (e) {
      log.error("security notice delivery failed", { event: "security_notice_failed", kind, userId: user.id, error: e instanceof Error ? e.name : "Error" });
      outcome = { delivered: false, reason: "provider_rejected" };
    }
  }
  if (outcome.reason === "email_not_configured") log.warn("security notice not sent: email delivery is not configured", { event: "security_notice_unconfigured", kind, userId: user.id });
  await db.auditLog
    .create({ data: { organizationId: user.organizationId, actorId: null, action: "SECURITY_NOTICE", entityType: "User", entityId: user.id, after: JSON.stringify({ kind, ...outcome }), ip: meta.ip, userAgent: meta.userAgent } })
    .catch((e) => log.error("security notice audit failed", { event: "security_notice_audit_failed", userId: user.id, error: e instanceof Error ? e.name : "Error" }));
  return outcome;
}
