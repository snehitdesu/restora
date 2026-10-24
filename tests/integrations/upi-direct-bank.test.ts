/**
 * Direct-bank UPI provider boundary: the shared status decision (upiStatus.ts),
 * the bank-emulator adapter against the local emulator over real HTTP, and the
 * SBI adapter's deliberate unavailability.
 *
 * Classification: LOCAL UNIT / EMULATOR tests. The emulator's wire format is
 * RESTORA's own; nothing here is SBI UAT or production evidence.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { decideUpiTxn } from "@/integrations/payment/upiStatus";
import { UpiEmulatorPaymentProvider, upiReference } from "@/integrations/payment/upiEmulator";
import { SbiUpiPaymentProvider, SBI_UPI_IMPLEMENTED } from "@/integrations/payment/sbiUpi";
import { getPaymentProvider, getCheckoutProvider, CHECKOUT_PROVIDERS, GATEWAY_PROVIDERS, RazorpayPaymentProvider } from "@/integrations/payment";
import { ProviderUnavailableError } from "@/integrations/policy";
import { IntegrationError } from "@/integrations/http";
import { UpiBankEmulator } from "../support/upiBankEmulator";

const VOCAB = { success: ["SUCCESS"], failure: ["FAILED", "EXPIRED"] };
const expected = { reference: "RSTabc", merchantId: "M1", amountPaise: 15750 };
const ok = { reference: "RSTabc", merchantId: "M1", amountPaise: 15750, currency: "INR", status: "SUCCESS", bankRef: "123456789012" };

describe("decideUpiTxn: only our exact, final, INR success verifies", () => {
  it("a matching final success verifies with our reference and the bank's RRN", () => {
    expect(decideUpiTxn(expected, ok, VOCAB)).toEqual({ verified: true, providerRef: "RSTabc", bankRef: "123456789012" });
  });
  it.each([
    ["merchant", { merchantId: "M2" }, "merchant does not match"],
    ["reference", { reference: "RSTother" }, "transaction reference does not match"],
    ["amount", { amountPaise: 15749 }, "does not match"],
    ["fractional amount", { amountPaise: 15750.4 }, "does not match"],
    ["currency", { currency: "USD" }, "currency is USD"],
  ])("a success with a different %s is a mismatch: never paid, never failed", (_n, patch, text) => {
    const r = decideUpiTxn(expected, { ...ok, ...patch }, VOCAB);
    expect(r.verified).toBe(false);
    expect(r.pending).toBe(true);
    expect(r.mismatch).toContain(text);
  });
  it("final failure and expiry are definitive", () => {
    for (const status of ["FAILED", "expired"]) {
      const r = decideUpiTxn(expected, { ...ok, status }, VOCAB);
      expect(r.verified).toBe(false);
      expect(r.pending).toBeFalsy();
    }
  });
  it("pending, deemed, unknown and empty statuses stay undecided", () => {
    for (const status of ["PENDING", "DEEMED", "SUCCESSFUL?", ""]) expect(decideUpiTxn(expected, { ...ok, status }, VOCAB)).toMatchObject({ verified: false, pending: true });
  });
  it("a failure answer about another transaction is not our failure", () => {
    expect(decideUpiTxn(expected, { ...ok, status: "FAILED", reference: "RSTx" }, VOCAB)).toMatchObject({ verified: false, pending: true });
  });
});

describe("bank emulator adapter over HTTP", () => {
  const cfg = { apiKey: "emu-key", merchantId: "EMU-MERCHANT", webhookSecret: "emu-webhook-secret" };
  const bank = new UpiBankEmulator({ ...cfg, qrTtlSec: 60 });
  let upi: UpiEmulatorPaymentProvider;
  beforeAll(async () => {
    const base = await bank.start();
    upi = new UpiEmulatorPaymentProvider({ base, apiKey: cfg.apiKey, merchantId: cfg.merchantId, webhookSecret: cfg.webhookSecret, timeoutMs: 300 });
  });
  afterAll(() => bank.stop());
  afterEach(() => bank.faults.clear());

  it("creates a transaction-specific QR for the exact amount and our reference; asking again returns the same QR", async () => {
    const a = await upi.createCheckout({ paymentId: "pay1", orderId: "o1", amount: 157.5, currency: "INR" });
    expect(a.providerRef).toBe(upiReference("pay1"));
    expect(a.checkout).toMatchObject({ kind: "upi_qr", amount: 15750, currency: "INR", mode: "MOCK" });
    expect(String(a.checkout.qr)).toContain("restora-emulator@invalid");
    expect(a.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    const b = await upi.createCheckout({ paymentId: "pay1", orderId: "o1", amount: 157.5, currency: "INR" });
    expect(b.checkout.qr).toBe(a.checkout.qr);
    expect(bank.txns.size).toBe(1);
    // No credential ever reaches the browser's checkout data.
    expect(JSON.stringify(a.checkout)).not.toContain(cfg.apiKey);
  });

  it("verify: pending until paid; success only after the bank says so", async () => {
    const s = await upi.createCheckout({ paymentId: "pay2", orderId: "o2", amount: 100, currency: "INR" });
    expect(await upi.verify({ orderId: "o2", amount: 100, providerRef: s.providerRef })).toMatchObject({ verified: false, pending: true });
    await bank.pay(s.providerRef);
    expect(await upi.verify({ orderId: "o2", amount: 100, providerRef: s.providerRef })).toMatchObject({ verified: true, providerRef: s.providerRef });
    expect((await upi.getPaymentStatus(s.providerRef)).status).toBe("CAPTURED");
  });

  it("verify: the browser's payload is ignored — a forged 'success' cannot pass", async () => {
    const s = await upi.createCheckout({ paymentId: "pay3", orderId: "o3", amount: 100, currency: "INR" });
    expect(await upi.verify({ orderId: "o3", amount: 100, providerRef: s.providerRef, payload: { status: "SUCCESS", paid: true } })).toMatchObject({ verified: false, pending: true });
  });

  it("verify: an expired QR and a declined payment are definitive failures", async () => {
    const e = await upi.createCheckout({ paymentId: "pay4", orderId: "o4", amount: 50, currency: "INR" });
    bank.expire(e.providerRef);
    const r = await upi.verify({ orderId: "o4", amount: 50, providerRef: e.providerRef });
    expect(r.verified).toBe(false);
    expect(r.pending).toBeFalsy();
    const d = await upi.createCheckout({ paymentId: "pay5", orderId: "o5", amount: 50, currency: "INR" });
    await bank.pay(d.providerRef, "FAILED");
    expect((await upi.getPaymentStatus(d.providerRef)).status).toBe("FAILED");
  });

  it("verify: a bank success with the wrong amount / merchant / currency is a mismatch", async () => {
    const s = await upi.createCheckout({ paymentId: "pay6", orderId: "o6", amount: 80, currency: "INR" });
    await bank.pay(s.providerRef);
    for (const override of [{ amountPaise: 1 }, { merchantId: "OTHER" }, { currency: "USD" }]) {
      bank.faults.set(s.providerRef, { override });
      expect(await upi.verify({ orderId: "o6", amount: 80, providerRef: s.providerRef })).toMatchObject({ verified: false, pending: true });
    }
  });

  it("a slow bank times out, a failing one is retryable, a malformed one is refused — none decides anything", async () => {
    const s = await upi.createCheckout({ paymentId: "pay7", orderId: "o7", amount: 80, currency: "INR" });
    bank.faults.set(s.providerRef, { delayMs: 1500 });
    await expect(upi.verify({ orderId: "o7", amount: 80, providerRef: s.providerRef })).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    bank.faults.set(s.providerRef, { httpStatus: 503 });
    await expect(upi.verify({ orderId: "o7", amount: 80, providerRef: s.providerRef })).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    bank.faults.set(s.providerRef, { malformed: true });
    await expect(upi.verify({ orderId: "o7", amount: 80, providerRef: s.providerRef })).rejects.toBeInstanceOf(IntegrationError);
  });

  it("callbacks: HMAC over the raw body; a tampered or unsigned one is refused; parsing maps statuses", async () => {
    const s = await upi.createCheckout({ paymentId: "pay8", orderId: "o8", amount: 80, currency: "INR" });
    const cb = await bank.pay(s.providerRef, "SUCCESS", { callback: false });
    const body = JSON.stringify(cb);
    expect(upi.verifyWebhook(body, bank.sign(body))).toBe(true);
    expect(upi.verifyWebhook(body.replace("8000", "1"), bank.sign(body))).toBe(false);
    expect(upi.verifyWebhook(body, undefined)).toBe(false);
    expect(upi.verifyWebhook(body, bank.sign(body, "another-secret"))).toBe(false);
    expect(upi.accountRef(cb)).toBe(cfg.merchantId);
    expect(upi.parseWebhookEvent(cb)).toEqual({ eventId: cb.eventId, type: "payment.captured", providerRef: s.providerRef, amount: 80 });
    expect(upi.parseWebhookEvent({ ...cb, status: "EXPIRED" }).type).toBe("payment.failed");
    expect(upi.parseWebhookEvent({ ...cb, status: "PENDING" }).type).toBe("unknown");
    expect(() => upi.parseWebhookEvent({ ...cb, amountPaise: "8000" })).toThrow();
  });

  it("refunds once per key and never more than was paid", async () => {
    const s = await upi.createCheckout({ paymentId: "pay9", orderId: "o9", amount: 80, currency: "INR" });
    await bank.pay(s.providerRef, "SUCCESS", { callback: false });
    const a = await upi.refund({ providerRef: s.providerRef, amount: 30, idempotencyKey: "rk-1" });
    expect((await upi.refund({ providerRef: s.providerRef, amount: 30, idempotencyKey: "rk-1" })).refundRef).toBe(a.refundRef);
    await expect(upi.refund({ providerRef: s.providerRef, amount: 60, idempotencyKey: "rk-2" })).rejects.toMatchObject({ code: "REJECTED" });
  });

  it("is unavailable, not silently successful, without configuration", async () => {
    const bare = new UpiEmulatorPaymentProvider({ base: "", apiKey: "", merchantId: "" });
    expect(await bare.healthCheck()).toBe(false);
    await expect(bare.createCheckout({ paymentId: "p", orderId: "o", amount: 1, currency: "INR" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("SBI adapter: explicitly unavailable until built from SBI's specification", () => {
  const sbi = new SbiUpiPaymentProvider();
  it("is not implemented, reports unhealthy, and refuses every operation", async () => {
    expect(SBI_UPI_IMPLEMENTED).toBe(false);
    expect(sbi.implemented).toBe(false);
    expect(await sbi.healthCheck()).toBe(false);
    await expect(sbi.createCheckout({ paymentId: "p", orderId: "o", amount: 1, currency: "INR" })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(sbi.verify({ orderId: "o", amount: 1, providerRef: "x" })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(sbi.getPaymentStatus("x")).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(sbi.refund({ providerRef: "x", amount: 1 })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(sbi.verifyWebhook("{}", "anything", "anything")).toBe(false);
    expect(() => sbi.parseWebhookEvent({})).toThrow(ProviderUnavailableError);
  });
  it("is LIVE only with SBI_UPI_ENVIRONMENT=production", () => {
    vi.stubEnv("SBI_UPI_ENVIRONMENT", "production");
    expect(new SbiUpiPaymentProvider().mode).toBe("LIVE");
    vi.stubEnv("SBI_UPI_ENVIRONMENT", "uat");
    expect(new SbiUpiPaymentProvider().mode).toBe("SANDBOX");
    vi.unstubAllEnvs();
  });
});

describe("provider selection: Razorpay is legacy-only, mocks never in production", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("new checkouts can use only SBI, the emulator or the mock; never Razorpay", () => {
    expect([...CHECKOUT_PROVIDERS].sort()).toEqual(["mock", "sbi_upi", "upi_emulator"]);
    vi.stubEnv("PAYMENT_PROVIDER", "razorpay");
    expect(() => getCheckoutProvider()).toThrow(ProviderUnavailableError);
    vi.stubEnv("PAYMENT_PROVIDER", "sbi_upi");
    expect(getCheckoutProvider().name).toBe("sbi_upi");
  });
  it("Razorpay stays resolvable by name for legacy verification / webhooks / refunds, without any checkout capability", () => {
    expect(GATEWAY_PROVIDERS.has("razorpay")).toBe(true);
    const rzp = getPaymentProvider("razorpay");
    expect(rzp).toBeInstanceOf(RazorpayPaymentProvider);
    expect(rzp.createCheckout).toBeUndefined();
    expect(rzp.resumeCheckout).toBeUndefined();
    expect(typeof rzp.verify).toBe("function");
    expect(typeof rzp.refund).toBe("function");
  });
  it("the emulator and the mock are refused where mock providers are refused (production)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_MOCK_PROVIDERS", "");
    for (const name of ["upi_emulator", "mock"]) expect(() => getPaymentProvider(name)).toThrow(ProviderUnavailableError);
    vi.stubEnv("PAYMENT_PROVIDER", "upi_emulator");
    expect(() => getCheckoutProvider()).toThrow(ProviderUnavailableError);
    expect(getPaymentProvider("sbi_upi").mode).not.toBe("MOCK");
  });
});
