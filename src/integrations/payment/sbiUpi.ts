/**
 * State Bank of India — direct UPI collection (dynamic QR / intent).
 *
 * NOT IMPLEMENTED, deliberately. SBI publishes no API specification for
 * merchant UPI collection (checked 2026-10-20; docs/sbi-upi-integration.md),
 * and none has been supplied to this project. Endpoints, payloads,
 * authentication, signing, certificates, status codes and QR strings are
 * therefore unknown, and none is guessed here.
 *
 * Until it is implemented from SBI's own documentation and passes SBI UAT:
 *  - every network operation refuses with ProviderUnavailableError, so
 *    nothing can be created, verified, refunded or reconciled through it;
 *  - healthCheck() is false, so guest QR ordering reports online payment as
 *    unavailable (never a fallback to another provider, never a success);
 *  - callbacks are refused (verifyWebhook is false: 401, nothing recorded as paid).
 *
 * Implementing it: keep this class's name ("sbi_upi") and fill each method from
 * SBI's spec; decide status answers with decideUpiTxn (upiStatus.ts) so the
 * merchant / reference / amount / INR / final-status rules stay the same as
 * the emulator's; read credentials only from server-side environment
 * variables (never return them in `checkout`); then flip SBI_UPI_IMPLEMENTED.
 */
import { ProviderUnavailableError } from "@/integrations/policy";
import type { CheckoutRequest, CheckoutSession, IntegrationMode, PaymentProvider, PaymentWebhookEvent, ProviderPaymentStatus, RefundRequest, VerifyResult } from "./types";

/** Flip only with an implementation written from SBI's specification and verified in SBI UAT. */
export const SBI_UPI_IMPLEMENTED = false;
export const SBI_UPI_UNAVAILABLE = "SBI UPI is not available yet: RESTORA is waiting for SBI's API specification and UAT access (docs/sbi-upi-integration.md)";

export class SbiUpiPaymentProvider implements PaymentProvider {
  readonly name = "sbi_upi";
  readonly implemented = SBI_UPI_IMPLEMENTED;

  /** SBI_UPI_ENVIRONMENT=production is the only LIVE setting; anything else is SBI's UAT. */
  get mode(): IntegrationMode {
    return process.env.SBI_UPI_ENVIRONMENT?.trim().toLowerCase() === "production" ? "LIVE" : "SANDBOX";
  }

  private unavailable(): never {
    throw new ProviderUnavailableError(SBI_UPI_UNAVAILABLE);
  }

  async createCheckout(_input: CheckoutRequest): Promise<CheckoutSession> {
    return this.unavailable();
  }
  async getPaymentStatus(_providerRef: string): Promise<ProviderPaymentStatus> {
    return this.unavailable();
  }
  async verify(_input: { orderId: string; amount: number; providerRef?: string; payload?: unknown }): Promise<VerifyResult> {
    return this.unavailable();
  }
  /** No callback can be authenticated without SBI's scheme: refuse every one. */
  verifyWebhook(_rawBody: string, _signature: string | undefined, _secret?: string): boolean {
    return false;
  }
  accountRef(_payload: unknown): string | undefined {
    return undefined;
  }
  parseWebhookEvent(_payload: unknown): PaymentWebhookEvent {
    return this.unavailable();
  }
  async healthCheck(): Promise<boolean> {
    return false;
  }
  async refund(_input: RefundRequest): Promise<{ refundRef: string }> {
    return this.unavailable();
  }
}
