/**
 * Dynamic-UPI-QR adapter for the local bank emulator — TESTS / DEVELOPMENT ONLY.
 *
 * Talks to tests/support/upiBankEmulator.ts over HTTP, exactly the way a
 * direct-bank adapter talks to its bank: create a QR for the server's amount
 * and our transaction reference, ask the bank for the status, accept signed
 * callbacks, refund. It exists so the complete direct-bank checkout (QR on the
 * guest's screen, server-side status polling, callbacks, recovery, kitchen
 * release) is exercised end to end without any bank credentials.
 *
 * It is NOT SBI: the wire format is RESTORA's own. Its mode is MOCK, it is
 * refused wherever mock providers are refused (a production deployment without
 * ALLOW_MOCK_PROVIDERS=true, which startup validation also refuses), and it can
 * never confirm a real payment: the emulator's QR names a payee no UPI app can pay.
 *
 * Configuration: UPI_EMULATOR_BASE, UPI_EMULATOR_API_KEY, UPI_EMULATOR_MERCHANT_ID,
 * UPI_EMULATOR_WEBHOOK_SECRET (all test values).
 */
import { z } from "zod";
import { hmacMatches, stringAt } from "@/integrations/hmac";
import { IntegrationError, requestJson, type FetchLike } from "@/integrations/http";
import { ProviderUnavailableError } from "@/integrations/policy";
import { decideUpiTxn, paiseOf, UPI_CURRENCY, type UpiStatusVocabulary } from "./upiStatus";
import type { CheckoutRequest, CheckoutSession, IntegrationMode, PaymentProvider, PaymentWebhookEvent, ProviderPaymentStatus, RefundRequest, VerifyResult } from "./types";

export type UpiEmulatorConfig = { base?: string; apiKey?: string; merchantId?: string; webhookSecret?: string; fetch?: FetchLike; timeoutMs?: number };

const VOCAB: UpiStatusVocabulary = { success: ["SUCCESS"], failure: ["FAILED", "EXPIRED"] };
const qrAnswer = z.object({ reference: z.string(), merchantId: z.string(), amountPaise: z.number().int(), currency: z.string(), qr: z.string().min(1), expiresAt: z.string() });
const statusAnswer = z.object({ reference: z.string(), merchantId: z.string(), amountPaise: z.number(), currency: z.string(), status: z.string(), rrn: z.string().nullish() });
const callback = z.object({ eventId: z.string().min(1), merchantId: z.string().min(1), reference: z.string().min(1), status: z.string().min(1), amountPaise: z.number().int().nonnegative(), currency: z.string(), rrn: z.string().nullish() });

/** Our transaction reference for a payment: unique per payment attempt, chosen by RESTORA (never the client). */
export const upiReference = (paymentId: string) => `RST${paymentId}`.slice(0, 35);

export class UpiEmulatorPaymentProvider implements PaymentProvider {
  readonly name = "upi_emulator";
  readonly mode: IntegrationMode = "MOCK";
  private readonly base?: string;
  private readonly apiKey?: string;
  private readonly merchantId?: string;
  private readonly webhookSecret?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(cfg: UpiEmulatorConfig = {}) {
    this.base = (cfg.base ?? process.env.UPI_EMULATOR_BASE)?.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey ?? process.env.UPI_EMULATOR_API_KEY;
    this.merchantId = cfg.merchantId ?? process.env.UPI_EMULATOR_MERCHANT_ID;
    this.webhookSecret = cfg.webhookSecret ?? process.env.UPI_EMULATOR_WEBHOOK_SECRET;
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = cfg.timeoutMs ?? 8000;
  }

  get configured(): boolean {
    return Boolean(this.base && this.apiKey && this.merchantId);
  }

  private headers() {
    if (!this.configured) throw new ProviderUnavailableError("The UPI bank emulator is not configured (UPI_EMULATOR_BASE / UPI_EMULATOR_API_KEY / UPI_EMULATOR_MERCHANT_ID)");
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
    const p = schema.safeParse(raw);
    if (!p.success) throw new IntegrationError("MALFORMED", "The bank returned an unexpected response", false);
    return p.data;
  }

  /** A transaction-specific QR for the server's amount. The emulator, like a bank, answers the same reference with the same QR. */
  async createCheckout(input: CheckoutRequest): Promise<CheckoutSession> {
    if (input.currency !== UPI_CURRENCY) throw new IntegrationError("REJECTED", "UPI collects INR only", false);
    const reference = upiReference(input.paymentId);
    const amountPaise = paiseOf(input.amount);
    const raw = await requestJson<unknown>(this.fetchImpl, `${this.base}/v1/qr`, { method: "POST", headers: this.headers(), body: JSON.stringify({ merchantId: this.merchantId, reference, amountPaise, currency: UPI_CURRENCY }), attempts: 2, timeoutMs: this.timeoutMs });
    const qr = this.parse(qrAnswer, raw);
    // The bank must have created exactly what we asked for.
    if (qr.reference !== reference || qr.merchantId !== this.merchantId || qr.amountPaise !== amountPaise || qr.currency !== UPI_CURRENCY) throw new IntegrationError("MALFORMED", "The bank created a QR that does not match the request", false);
    const expiresAt = new Date(qr.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new IntegrationError("MALFORMED", "The bank returned an invalid QR expiry", false);
    return {
      providerRef: reference,
      expiresAt,
      // Public data for the guest's screen only. `qr` is what the QR encodes; on a phone the same
      // string opens a UPI app (intent). Never a credential.
      checkout: { provider: this.name, mode: this.mode, kind: "upi_qr", qr: qr.qr, intentUri: qr.qr, reference, amount: amountPaise, currency: UPI_CURRENCY, expiresAt: expiresAt.toISOString() },
    };
  }

  private async status(reference: string) {
    const raw = await requestJson<unknown>(this.fetchImpl, `${this.base}/v1/qr/${encodeURIComponent(reference)}/status`, { headers: this.headers(), attempts: 2, timeoutMs: this.timeoutMs, backoffMs: 200 });
    return this.parse(statusAnswer, raw);
  }

  async getPaymentStatus(providerRef: string): Promise<ProviderPaymentStatus> {
    const s = await this.status(providerRef);
    const st = s.status.toUpperCase();
    return { providerRef, amount: s.amountPaise / 100, status: st === "SUCCESS" ? "CAPTURED" : VOCAB.failure.includes(st) ? "FAILED" : "PENDING" };
  }

  /** Never trusts the browser: asks the bank, and checks merchant, reference, exact amount, INR and a final status. */
  async verify(input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult> {
    if (!input.providerRef) return { verified: false, pending: true, reason: "No bank reference yet" };
    const s = await this.status(input.providerRef);
    return decideUpiTxn({ reference: input.providerRef, merchantId: this.merchantId!, amountPaise: paiseOf(input.amount) }, { reference: s.reference, merchantId: s.merchantId, amountPaise: s.amountPaise, currency: s.currency, status: s.status, bankRef: s.rrn }, VOCAB);
  }

  verifyWebhook(rawBody: string, signature: string | undefined, secret?: string): boolean {
    return hmacMatches(rawBody, signature, secret ?? this.webhookSecret);
  }

  accountRef(payload: unknown): string | undefined {
    return stringAt(payload, "merchantId");
  }

  /** A callback only says "look again": the payment service re-asks the bank before anything is paid. */
  parseWebhookEvent(payload: unknown): PaymentWebhookEvent {
    const c = callback.parse(payload);
    const st = c.status.toUpperCase();
    const type = st === "SUCCESS" ? "payment.captured" : VOCAB.failure.includes(st) ? "payment.failed" : "unknown";
    return { eventId: c.eventId, type, providerRef: c.reference, amount: c.amountPaise / 100 };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      await requestJson<unknown>(this.fetchImpl, `${this.base}/v1/health`, { headers: this.headers(), attempts: 1, timeoutMs: Math.min(this.timeoutMs, 4000) });
      return true;
    } catch {
      return false;
    }
  }

  /** Not retried automatically (a lost answer is reconciled, not repeated); the key makes a repeat return the same refund. */
  async refund(input: RefundRequest): Promise<{ refundRef: string }> {
    if (input.amount <= 0) throw new IntegrationError("REJECTED", "Refund amount must be positive", false);
    const raw = await requestJson<unknown>(this.fetchImpl, `${this.base}/v1/refunds`, { method: "POST", headers: this.headers(), body: JSON.stringify({ reference: input.providerRef, amountPaise: paiseOf(input.amount), refundKey: input.idempotencyKey }), attempts: 1, timeoutMs: this.timeoutMs });
    const rf = this.parse(z.object({ refundId: z.string().min(1), amountPaise: z.number().int() }), raw);
    if (rf.amountPaise !== paiseOf(input.amount)) throw new IntegrationError("MALFORMED", "The bank returned an unexpected refund", false);
    return { refundRef: rf.refundId };
  }
}
