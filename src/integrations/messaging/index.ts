/**
 * Customer messaging (SMS / WhatsApp) adapters.
 *
 *  - "mock": never contacts anyone. It accepts the message and returns a
 *    MOCK-labelled reference; deliveries made with it are shown as MOCK and
 *    never as delivered to a phone. (Development / demos.)
 *  - "twilio": Twilio Programmable Messaging over REST (SMS, and WhatsApp via
 *    the "whatsapp:" address prefix). Credentials are the tenant's own,
 *    decrypted only for the call; status callbacks are verified with Twilio's
 *    X-Twilio-Signature. Contract-tested against recorded Twilio response
 *    shapes — not run against a live Twilio account here. Its mode (SANDBOX /
 *    LIVE) is what the operator declared for the connection.
 *
 * Neither adapter is called by the domain directly: services/messaging.ts
 * decides IF a message is sent (opt-in per template), records it in the
 * outbox (IntegrationDelivery) and calls the adapter.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { basicAuth, IntegrationError, requestJson, type FetchLike } from "@/integrations/http";
import type { IntegrationMode } from "@/integrations/payment/types";

export type MessageChannel = "SMS" | "WHATSAPP" | "EMAIL";
export const MESSAGE_CHANNELS = ["SMS", "WHATSAPP", "EMAIL"] as const;
/** `to` is an E.164 number for SMS / WhatsApp and an e-mail address for EMAIL; `subject` is used by EMAIL only. */
export type OutboundMessage = { channel: MessageChannel; to: string; body: string; subject?: string };
export type SendOutcome = { providerRef: string; status: "SENT" | "QUEUED" };
export type StatusUpdate = { providerRef: string; status: "SENT" | "DELIVERED" | "FAILED"; error?: string };

export interface MessagingProvider {
  readonly name: string;
  readonly mode: IntegrationMode;
  /** Which channels this provider can carry (a tenant may connect one provider per channel). */
  supports(channel: MessageChannel): boolean;
  send(msg: OutboundMessage, opts?: { statusCallbackUrl?: string; idempotencyKey?: string }): Promise<SendOutcome>;
  /** Verify a status callback; `url` is the exact public URL the provider called. */
  verifyStatusCallback(url: string, params: Record<string, string>, signature: string | undefined): boolean;
  parseStatusCallback(params: Record<string, string>): StatusUpdate | null;
  healthCheck(): Promise<boolean>;
}

/** E.164 for Indian 10-digit numbers; anything else must already be +E.164. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

/** A syntactically plausible address; the provider decides whether it is deliverable. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  return v.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v) ? v : null;
}

/** a***@example.com — what is stored / shown about an e-mail destination. */
export const maskEmail = (email: string) => {
  const [local, domain] = email.split("@");
  return domain ? `${local.slice(0, 1)}***@${domain}` : "***";
};

/** +91******3210 — what is stored / shown about a destination. */
export const maskPhone = (e164: string) => (e164.length > 6 ? `${e164.slice(0, 3)}${"*".repeat(e164.length - 7)}${e164.slice(-4)}` : "***");

export class MockMessagingProvider implements MessagingProvider {
  readonly name = "mock";
  readonly mode: IntegrationMode = "MOCK";
  readonly sent: OutboundMessage[] = [];
  supports(): boolean {
    return true;
  }
  async send(msg: OutboundMessage): Promise<SendOutcome> {
    this.sent.push(msg);
    return { providerRef: `mockmsg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, status: "SENT" };
  }
  verifyStatusCallback(): boolean {
    return false; // a mock never calls back
  }
  parseStatusCallback(): StatusUpdate | null {
    return null;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
}

export type TwilioCredentials = { accountSid: string; authToken: string; smsFrom?: string; whatsappFrom?: string };
export const twilioCredentialsSchema = z.object({
  accountSid: z.string().regex(/^AC[a-f0-9]{32}$/i, "Twilio Account SID starts with AC"),
  authToken: z.string().min(16).max(64),
  smsFrom: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  whatsappFrom: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
}).strict();

const TWILIO_API = "https://api.twilio.com/2010-04-01";
const twilioMessage = z.object({ sid: z.string(), status: z.string() });

export class TwilioMessagingProvider implements MessagingProvider {
  readonly name = "twilio";
  private readonly fetchImpl: FetchLike;
  constructor(private readonly creds: TwilioCredentials, readonly mode: IntegrationMode, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  supports(channel: MessageChannel): boolean {
    return channel === "SMS" || channel === "WHATSAPP";
  }

  /** Not retried inside the call: an SMS whose response was lost may have been sent — the outbox decides. */
  async send(msg: OutboundMessage, opts: { statusCallbackUrl?: string } = {}): Promise<SendOutcome> {
    if (msg.channel === "EMAIL") throw new IntegrationError("NOT_CONFIGURED", "Twilio does not send e-mail: connect an e-mail provider", false);
    const from = msg.channel === "WHATSAPP" ? this.creds.whatsappFrom : this.creds.smsFrom;
    if (!from) throw new IntegrationError("NOT_CONFIGURED", `No ${msg.channel === "WHATSAPP" ? "WhatsApp" : "SMS"} sender number is configured`, false);
    const prefix = msg.channel === "WHATSAPP" ? "whatsapp:" : "";
    const form = new URLSearchParams({ To: `${prefix}${msg.to}`, From: `${prefix}${from}`, Body: msg.body });
    if (opts.statusCallbackUrl) form.set("StatusCallback", opts.statusCallbackUrl);
    const raw = await requestJson<unknown>(this.fetchImpl, `${TWILIO_API}/Accounts/${encodeURIComponent(this.creds.accountSid)}/Messages.json`, {
      method: "POST", attempts: 1, timeoutMs: 10000,
      headers: { Authorization: basicAuth(this.creds.accountSid, this.creds.authToken), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const m = twilioMessage.safeParse(raw);
    if (!m.success) throw new IntegrationError("MALFORMED", "Twilio returned an unexpected response", false);
    if (m.data.status === "failed" || m.data.status === "undelivered") throw new IntegrationError("REJECTED", `Twilio did not accept the message (${m.data.status})`, false);
    return { providerRef: m.data.sid, status: m.data.status === "sent" || m.data.status === "delivered" ? "SENT" : "QUEUED" };
  }

  /** Twilio: base64(HMAC-SHA1(authToken, url + Σ sorted(key + value))). */
  verifyStatusCallback(url: string, params: Record<string, string>, signature: string | undefined): boolean {
    if (!signature) return false;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
    const expected = Buffer.from(createHmac("sha1", this.creds.authToken).update(data).digest("base64"));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  parseStatusCallback(params: Record<string, string>): StatusUpdate | null {
    const sid = params.MessageSid;
    const s = (params.MessageStatus ?? "").toLowerCase();
    if (!sid || !s) return null;
    if (s === "delivered" || s === "read") return { providerRef: sid, status: "DELIVERED" };
    if (s === "failed" || s === "undelivered") return { providerRef: sid, status: "FAILED", error: params.ErrorCode ? `Twilio error ${params.ErrorCode}` : "Not delivered" };
    if (s === "sent") return { providerRef: sid, status: "SENT" };
    return null; // queued / accepted / sending: no change
  }

  async healthCheck(): Promise<boolean> {
    try {
      await requestJson<unknown>(this.fetchImpl, `${TWILIO_API}/Accounts/${encodeURIComponent(this.creds.accountSid)}.json`, { headers: { Authorization: basicAuth(this.creds.accountSid, this.creds.authToken) }, attempts: 2 });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- e-mail (Resend)

export type ResendCredentials = { apiKey: string; from: string; replyTo?: string; webhookSecret?: string };
/** `from` is a verified sender: an address or `Name <address>`. The webhook secret is Resend's `whsec_...` signing secret. */
export const resendCredentialsSchema = z.object({
  apiKey: z.string().regex(/^re_[A-Za-z0-9_]{16,120}$/, "A Resend API key starts with re_"),
  from: z.string().trim().min(5).max(200).regex(/^(?:[^<>@\r\n]{1,100}\s)?<?[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+>?$/, "An address, or Name <address>"),
  replyTo: z.string().trim().email().max(200).optional(),
  webhookSecret: z.string().regex(/^whsec_[A-Za-z0-9+/=]{16,200}$/, "Resend signing secrets start with whsec_").optional(),
}).strict();

const RESEND_API = "https://api.resend.com";
const resendSent = z.object({ id: z.string().min(1) });

/**
 * E-mail through the Resend REST API. Contract-tested against the documented request / response shapes;
 * never run against a live account in this repository. The tenant's own key is decrypted only for the call.
 * Delivery events arrive as Svix-signed webhooks (verifyResendWebhook / parseResendEvent below).
 */
export class ResendEmailProvider implements MessagingProvider {
  readonly name = "resend";
  private readonly fetchImpl: FetchLike;
  constructor(private readonly creds: ResendCredentials, readonly mode: IntegrationMode, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }
  supports(channel: MessageChannel): boolean {
    return channel === "EMAIL";
  }
  /** `idempotencyKey` makes a retried POST return the first message instead of sending a second one. */
  async send(msg: OutboundMessage, opts: { statusCallbackUrl?: string; idempotencyKey?: string } = {}): Promise<SendOutcome> {
    if (msg.channel !== "EMAIL") throw new IntegrationError("NOT_CONFIGURED", "This provider only sends e-mail", false);
    const raw = await requestJson<unknown>(this.fetchImpl, `${RESEND_API}/emails`, {
      method: "POST", attempts: 1, timeoutMs: 10000,
      headers: { Authorization: `Bearer ${this.creds.apiKey}`, "Content-Type": "application/json", ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey.slice(0, 256) } : {}) },
      body: JSON.stringify({ from: this.creds.from, to: [msg.to], subject: msg.subject ?? "A message from the restaurant", text: msg.body, ...(this.creds.replyTo ? { reply_to: this.creds.replyTo } : {}) }),
    });
    const m = resendSent.safeParse(raw);
    if (!m.success) throw new IntegrationError("MALFORMED", "Resend returned an unexpected response", false);
    return { providerRef: m.data.id, status: "QUEUED" };
  }
  verifyStatusCallback(): boolean {
    return false; // Resend signs its webhooks differently: see verifyResendWebhook
  }
  parseStatusCallback(): StatusUpdate | null {
    return null;
  }
  async healthCheck(): Promise<boolean> {
    try {
      await requestJson<unknown>(this.fetchImpl, `${RESEND_API}/domains`, { headers: { Authorization: `Bearer ${this.creds.apiKey}` }, attempts: 1, timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }
  get webhookSecret(): string | undefined {
    return this.creds.webhookSecret;
  }
}

/**
 * Svix signature (what Resend sends): header `svix-signature` = space separated `v1,<base64 HMAC-SHA256>` over
 * `<svix-id>.<svix-timestamp>.<raw body>`, keyed with the base64 part of the `whsec_` secret. Replays older than
 * `toleranceSeconds` are refused.
 */
export function verifyResendWebhook(secret: string, rawBody: string, h: { id?: string; timestamp?: string; signature?: string }, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  if (!secret.startsWith("whsec_") || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;
  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest("base64");
  const exp = Buffer.from(expected);
  return h.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === exp.length && timingSafeEqual(given, exp);
  });
}

/** email.delivered / email.bounced / email.complained / email.delivery_delayed → what the outbox records. */
export function parseResendEvent(payload: unknown): StatusUpdate | null {
  const p = z.object({ type: z.string(), data: z.object({ email_id: z.string().min(1) }).passthrough() }).safeParse(payload);
  if (!p.success) return null;
  const ref = p.data.data.email_id;
  switch (p.data.type) {
    case "email.sent":
      return { providerRef: ref, status: "SENT" };
    case "email.delivered":
      return { providerRef: ref, status: "DELIVERED" };
    case "email.bounced":
      return { providerRef: ref, status: "FAILED", error: "Bounced" };
    case "email.complained":
      return { providerRef: ref, status: "FAILED", error: "Marked as spam" };
    default:
      return null;
  }
}
