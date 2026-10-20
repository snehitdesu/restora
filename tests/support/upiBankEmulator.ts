/**
 * Dynamic-UPI-QR bank emulator — TEST SUPPORT ONLY.
 *
 * A local HTTP server that plays a bank offering API-based UPI collection:
 * create a transaction-specific QR for a fixed amount and merchant reference,
 * answer status inquiries, send signed callbacks, and refund. Test controls
 * play the payer's side (pay, decline, let the QR expire) and the bank's bad
 * days (slow or failing answers, a wrong amount / merchant / currency).
 *
 * Its wire format is RESTORA's own invention for testing
 * (integrations/payment/upiEmulator.ts). It is NOT State Bank of India's API,
 * whose specification RESTORA does not have (docs/sbi-upi-integration.md), and
 * nothing proven against it is evidence that SBI behaves the same way. Its QR
 * strings name the payee `restora-emulator@invalid`, which no UPI app can pay.
 *
 * Auth: `Authorization: Bearer <apiKey>`. Callback signature:
 * `x-upi-emulator-signature: HMAC-SHA256(webhookSecret, raw body)` (hex).
 */
import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export type UpiEmulatorConfig = { apiKey: string; merchantId: string; webhookSecret: string; port?: number; webhookUrl?: string; qrTtlSec?: number };

export type UpiTxnStatus = "PENDING" | "SUCCESS" | "FAILED" | "EXPIRED";
export type UpiTxn = { reference: string; merchantId: string; amountPaise: number; currency: string; status: UpiTxnStatus; rrn: string | null; createdAt: number; expiresAt: number; refundedPaise: number };
export type UpiCallback = { eventId: string; merchantId: string; reference: string; status: UpiTxnStatus; amountPaise: number; currency: string; rrn: string | null };

/** What the status endpoint should answer instead of the truth (bank faults). */
export type StatusFault = { delayMs?: number; httpStatus?: number; override?: Partial<Pick<UpiTxn, "amountPaise" | "merchantId" | "currency" | "reference" | "status">>; malformed?: boolean };

const rid = (p: string) => `${p}${randomBytes(6).toString("hex").toUpperCase()}`;

export class UpiBankEmulator {
  readonly txns = new Map<string, UpiTxn>();
  readonly refunds = new Map<string, { refundId: string; reference: string; amountPaise: number }>();
  /** Every authenticated API call ("no QR was created twice"). */
  readonly calls: Array<{ method: string; path: string }> = [];
  /** Fault applied to status inquiries for one reference ("*" = every reference). */
  readonly faults = new Map<string, StatusFault>();
  /** The next N QR-creation calls answer 503 (the bank is down while the guest asks for a QR). */
  createFailures = 0;
  private server: http.Server | null = null;
  url = "";

  constructor(readonly cfg: UpiEmulatorConfig) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.cfg.port ?? 0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  // ---------------- the payer's side ----------------

  /** The payer authorises the payment in their UPI app (or the bank declines it). Optionally sends the callback. */
  async pay(reference: string, outcome: "SUCCESS" | "FAILED" = "SUCCESS", opts: { callback?: boolean } = {}): Promise<UpiCallback> {
    const t = this.txn(reference);
    if (t.status !== "PENDING") throw new Error(`emulator: ${reference} is already ${t.status}`);
    t.status = outcome;
    if (outcome === "SUCCESS") t.rrn = String(Date.now()).slice(-12);
    const cb = this.callbackFor(t);
    if (opts.callback !== false && this.cfg.webhookUrl) await this.deliver(cb);
    return cb;
  }

  /** The QR's validity ends without payment. */
  expire(reference: string): void {
    const t = this.txn(reference);
    if (t.status === "PENDING") t.status = "EXPIRED";
  }

  callbackFor(t: UpiTxn, eventId = `${t.reference}:${t.status}`): UpiCallback {
    return { eventId, merchantId: t.merchantId, reference: t.reference, status: t.status, amountPaise: t.amountPaise, currency: t.currency, rrn: t.rrn };
  }

  sign(rawBody: string, secret = this.cfg.webhookSecret): string {
    return createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  /** POST a (signed) callback to RESTORA, as the bank would. */
  async deliver(cb: UpiCallback | string, signature?: string): Promise<Response> {
    const body = typeof cb === "string" ? cb : JSON.stringify(cb);
    return fetch(this.cfg.webhookUrl!, { method: "POST", headers: { "content-type": "application/json", "x-upi-emulator-signature": signature ?? this.sign(body) }, body });
  }

  txn(reference: string): UpiTxn {
    const t = this.txns.get(reference);
    if (!t) throw new Error(`emulator: unknown reference ${reference}`);
    return t;
  }

  // ---------------- the bank's API ----------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${this.cfg.apiKey}`) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://x");
    this.calls.push({ method: req.method ?? "GET", path: url.pathname });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    } catch {
      return send(400, { error: "bad json" });
    }

    if (req.method === "POST" && url.pathname === "/v1/qr") {
      if (this.createFailures > 0) {
        this.createFailures--;
        return send(503, { error: "bank unavailable" });
      }
      const { merchantId, reference, amountPaise, currency } = body as { merchantId?: string; reference?: string; amountPaise?: number; currency?: string };
      if (merchantId !== this.cfg.merchantId) return send(403, { error: "unknown merchant" });
      if (!reference || !Number.isInteger(amountPaise) || (amountPaise as number) <= 0 || currency !== "INR") return send(422, { error: "invalid request" });
      const existing = this.txns.get(reference);
      // The merchant reference is unique: asking again for the same one returns the same QR (idempotent), never a second.
      if (existing && existing.amountPaise !== amountPaise) return send(409, { error: "reference reused with a different amount" });
      const now = Date.now();
      const t: UpiTxn = existing ?? { reference, merchantId, amountPaise: amountPaise as number, currency, status: "PENDING", rrn: null, createdAt: now, expiresAt: now + (this.cfg.qrTtlSec ?? 300) * 1000, refundedPaise: 0 };
      this.txns.set(reference, t);
      const qr = `upi://pay?pa=restora-emulator@invalid&pn=RESTORA%20TEST&tr=${encodeURIComponent(reference)}&am=${(t.amountPaise / 100).toFixed(2)}&cu=INR&mode=EMULATOR`;
      return send(200, { reference, merchantId, amountPaise: t.amountPaise, currency, qr, expiresAt: new Date(t.expiresAt).toISOString() });
    }

    const status = url.pathname.match(/^\/v1\/qr\/([^/]+)\/status$/);
    if (req.method === "GET" && status) {
      const reference = decodeURIComponent(status[1]);
      const t = this.txns.get(reference);
      if (!t) return send(404, { error: "unknown reference" });
      if (t.status === "PENDING" && Date.now() > t.expiresAt) t.status = "EXPIRED";
      const fault = this.faults.get(reference) ?? this.faults.get("*");
      if (fault?.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault?.httpStatus) return send(fault.httpStatus, { error: "bank fault" });
      if (fault?.malformed) return send(200, "{\"status\":");
      return send(200, { reference: t.reference, merchantId: t.merchantId, amountPaise: t.amountPaise, currency: t.currency, status: t.status, rrn: t.rrn, ...fault?.override });
    }

    if (req.method === "POST" && url.pathname === "/v1/refunds") {
      const { reference, amountPaise, refundKey } = body as { reference?: string; amountPaise?: number; refundKey?: string };
      const t = reference ? this.txns.get(reference) : undefined;
      if (!t || t.status !== "SUCCESS") return send(422, { error: "not refundable" });
      const prior = refundKey ? this.refunds.get(refundKey) : undefined;
      if (prior) return send(200, prior);
      if (!Number.isInteger(amountPaise) || (amountPaise as number) <= 0 || t.refundedPaise + (amountPaise as number) > t.amountPaise) return send(422, { error: "invalid amount" });
      t.refundedPaise += amountPaise as number;
      const rf = { refundId: rid("RF"), reference: t.reference, amountPaise: amountPaise as number };
      this.refunds.set(refundKey ?? rf.refundId, rf);
      return send(200, rf);
    }

    if (req.method === "GET" && url.pathname === "/v1/health") return send(200, { ok: true });
    return send(404, { error: "not found" });
  }
}
