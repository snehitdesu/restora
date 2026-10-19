/**
 * Password-reset email through Resend's official emails API
 * (POST https://api.resend.com/emails). Credentials are read from the
 * environment at send time and are never logged. A send resolves only when
 * Resend returns an email id; any other outcome throws, and the caller must
 * not record the link as delivered.
 */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export class PasswordEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordEmailError";
  }
}

export type ResendPasswordConfig = { apiKey: string; from: string; baseUrl: string };

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

/** "Name <addr@host>" or a bare address. Display names and addresses cannot break the header. */
function validFrom(from: string): boolean {
  if (/[\r\n]/.test(from)) return false;
  return /^(?:[^<>\r\n]+ )?<?[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+>?$/.test(from);
}

function safeBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Complete, usable Resend settings, or null when reset email must stay off. */
export function resendPasswordConfig(env: NodeJS.ProcessEnv = process.env): ResendPasswordConfig | null {
  if (resendPasswordProblems(env).length > 0) return null;
  if (!isSet(env.RESEND_API_KEY) || !isSet(env.RESEND_FROM) || !isSet(env.PUBLIC_BASE_URL)) return null;
  const baseUrl = safeBaseUrl(env.PUBLIC_BASE_URL.trim());
  if (!baseUrl) return null;
  return { apiKey: env.RESEND_API_KEY.trim(), from: env.RESEND_FROM.trim(), baseUrl };
}

/**
 * Startup problems for a partial Resend setup. Empty when email is fully
 * configured or entirely unset (unset stays manager-issued, not a boot failure).
 * Messages name variables only.
 */
export function resendPasswordProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM;
  if (!isSet(apiKey) && !isSet(from)) return [];
  const problems: string[] = [];
  if (!isSet(apiKey) || !/^re_[A-Za-z0-9_]{16,}$/.test(apiKey.trim())) {
    problems.push("RESEND_API_KEY must be a Resend API key (re_…) when password-reset email is configured");
  }
  if (!isSet(from) || !validFrom(from.trim())) {
    problems.push("RESEND_FROM must be a verified sender address when password-reset email is configured");
  }
  if (!isSet(env.PUBLIC_BASE_URL)) {
    problems.push("PUBLIC_BASE_URL is required when password-reset email is configured (it is the origin of the reset link)");
  }
  return problems;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Same fragment shape the set-password page reads. The fragment is not sent to the server. */
export function passwordResetUrl(baseUrl: string, token: string): string {
  const url = new URL("/set-password", `${baseUrl.replace(/\/+$/, "")}/`);
  url.hash = `token=${token}`;
  return url.toString();
}

/**
 * Send one reset message. Throws PasswordEmailError when Resend is not
 * configured, the request fails, or the response has no email id.
 */
export async function sendPasswordResetEmail(
  msg: { to: string; name: string; token: string; expiresAt: Date },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const cfg = resendPasswordConfig(env);
  if (!cfg) throw new PasswordEmailError("Password reset email is not configured");
  const link = passwordResetUrl(cfg.baseUrl, msg.token);
  const expires = msg.expiresAt.toISOString();
  const text = [
    "Reset your RESTORA password",
    "",
    `${msg.name}, use this link to choose a new password. It expires at ${expires} and works once.`,
    "",
    link,
    "",
    "If you did not ask for this, you can ignore this email.",
  ].join("\n");
  const html = `<p>${escapeHtml(msg.name)}, use this link to choose a new password. It expires at ${escapeHtml(expires)} and works once.</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>If you did not ask for this, you can ignore this email.</p>`;
  await postResendEmail(cfg, { to: msg.to, subject: "Reset your RESTORA password", text, html }, fetchImpl, "Password reset email was not accepted");
}

export type ResendMessage = { to: string; subject: string; text: string; html: string };

/**
 * POST one message to Resend. Resolves only when Resend returns an email id;
 * a network error, timeout, non-2xx or id-less body throws PasswordEmailError
 * with `failure` (no key, address or body in the message).
 */
export async function postResendEmail(
  cfg: ResendPasswordConfig,
  msg: ResendMessage,
  fetchImpl: typeof fetch = globalThis.fetch,
  failure = "Email was not accepted",
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_EMAILS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new PasswordEmailError(failure);
  }
  let id: unknown;
  try {
    id = (await res.json() as { id?: unknown }).id;
  } catch {
    id = undefined;
  }
  if (!res.ok || typeof id !== "string" || id.length === 0) throw new PasswordEmailError(failure);
}

/** The delivery function for setPasswordLinkDelivery, or null when Resend is not fully configured. */
export function resendPasswordDelivery(env: NodeJS.ProcessEnv = process.env): ((msg: { to: string; name: string; token: string; expiresAt: Date }) => Promise<void>) | null {
  if (!resendPasswordConfig(env)) return null;
  return (msg) => sendPasswordResetEmail(msg, env);
}
