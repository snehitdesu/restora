/**
 * Direct-bank UPI checkout, end to end through the real services and database:
 * guest order → transaction-specific QR for the server's amount → the bank's
 * verdict (status API, signed callback, recovery worker) → one verified
 * payment, one invoice, one set of KOTs. Pending, failed, expired, mismatched,
 * timed-out, late, cancelled, raced and split payments included.
 *
 * Classification: LOCAL EMULATOR tests. The bank is tests/support/upiBankEmulator.ts
 * (RESTORA's own wire format, reached over real HTTP by the upi_emulator adapter).
 * This is NOT SBI UAT and NOT production evidence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { submitOrder, cancelOrder, listOrders } from "@/server/services/orders";
import { refundPayment, verifyPayment } from "@/server/services/payment";
import { rotateTableQr } from "@/server/services/masterData";
import { placeGuestOrder, startGuestPayment, confirmGuestPayment, getGuestOrder, ORDER_TOO_OLD_TO_PAY } from "@/server/services/guestOrdering";
import { recheckPendingPayments } from "@/server/services/paymentRecovery";
import { receiveWebhook } from "@/server/services/webhooks";
import { fulfilmentWindowMs } from "@/server/services/kitchenGate";
import { UpiBankEmulator } from "../support/upiBankEmulator";

const RUN = Date.now().toString(36);
const MERCHANT = `EMU-${RUN}`;
const bank = new UpiBankEmulator({ apiKey: `key-${RUN}`, merchantId: MERCHANT, webhookSecret: `whsec-${RUN}`, qrTtlSec: 300 });
let orgId: string, outletId: string;
let sys: AccessContext, manager: AccessContext;
let dosa: string, chai: string;
let seq = 0;
const key = () => `upi-${RUN}-${++seq}-abcdef`;

async function guestOrder() {
  const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `U${++seq}-${RUN}` } });
  const token = (await rotateTableQr(sys, t.id)).qrToken!;
  return placeGuestOrder(token, { items: [{ menuItemId: dosa, qty: 1 }, { menuItemId: chai, qty: 1 }], paymentMethod: "ONLINE" }, key());
}
type Placed = Awaited<ReturnType<typeof guestOrder>>;
const start = (g: Placed, input: unknown = {}) => startGuestPayment(g.orderId, g.accessKey, key(), input);
const confirm = (g: Placed, paymentId: string, gateway?: Record<string, string>) => confirmGuestPayment(g.orderId, g.accessKey, { paymentId, ...(gateway ? { gateway } : {}) });
const kotsOf = (orderId: string) => prisma.kot.count({ where: { orderId } });
const invoicesOf = (orderId: string) => prisma.taxInvoice.count({ where: { sourceKey: `inv:${orderId}` } });
const order = (orderId: string) => prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } });
const pay = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const anomalies = (entityId: string) => prisma.anomaly.findMany({ where: { organizationId: orgId, entityId } });
/** Make a payment old enough for the recovery worker (it leaves payments under 2 minutes to the guest's own screen). */
const age = (paymentId: string, ms = 3 * 60_000) => prisma.payment.update({ where: { id: paymentId }, data: { createdAt: new Date(Date.now() - ms) } });
const ageOrder = (orderId: string, ms: number) => prisma.order.update({ where: { id: orderId }, data: { createdAt: new Date(Date.now() - ms) } });
const callback = (body: string, signature = bank.sign(body)) => receiveWebhook({ kind: "PAYMENT", provider: "upi_emulator", rawBody: body, signature });

beforeAll(async () => {
  const base = await bank.start();
  vi.stubEnv("PAYMENT_PROVIDER", "upi_emulator");
  vi.stubEnv("UPI_EMULATOR_BASE", base);
  vi.stubEnv("UPI_EMULATOR_API_KEY", bank.cfg.apiKey);
  vi.stubEnv("UPI_EMULATOR_MERCHANT_ID", MERCHANT);
  vi.stubEnv("UPI_EMULATOR_WEBHOOK_SECRET", bank.cfg.webhookSecret);
  orgId = (await prisma.organization.create({ data: { name: `UPI Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `UP${RUN}`, name: "UPI Café" } })).id;
  sys = systemContext(orgId, [outletId]);
  manager = { userId: `mgr-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: ["MANAGER"], outletRoles: { [outletId]: ["MANAGER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
  for (const s of ["KITCHEN", "BAR"]) await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: s, kind: s } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 120, taxPct: 5, station: "KITCHEN" })).id;
  chai = (await createMenuItem(sys, { name: `Chai ${RUN}`, price: 30, taxPct: 5, station: "BAR" })).id;
  // Callbacks are bound to this restaurant by the bank's merchant id (webhookTenant.ts).
  await prisma.integrationConnection.create({ data: { organizationId: orgId, outletId, kind: "PAYMENT", provider: "upi_emulator", externalRef: MERCHANT, status: "CONNECTED", mode: "MOCK" } });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await bank.stop();
});
beforeEach(() => bank.faults.clear());
afterEach(() => vi.restoreAllMocks());

describe("dynamic QR for the authoritative amount", () => {
  it("the QR is created by the bank for the server's total and our reference; a refresh shows the same QR", async () => {
    const g = await guestOrder();
    const o = await order(g.orderId);
    const s = await start(g);
    expect(s.provider).toBe("upi_emulator");
    expect(s.checkout).toMatchObject({ kind: "upi_qr", amount: Math.round(Number(o.total) * 100), currency: "INR" });
    const p = await pay(s.paymentId);
    const txn = bank.txn(p.providerRef!);
    expect(txn).toMatchObject({ amountPaise: Math.round(Number(o.total) * 100), merchantId: MERCHANT, currency: "INR" });
    expect(p.checkoutExpiresAt).toBeInstanceOf(Date);
    // Refresh: a new start (new key) resumes the same payment and the same QR — no second bank transaction.
    const created = bank.calls.filter((c) => c.path === "/v1/qr").length;
    const again = await start(g);
    expect(again.paymentId).toBe(s.paymentId);
    expect(again.checkout?.qr).toBe(s.checkout?.qr);
    expect(bank.calls.filter((c) => c.path === "/v1/qr").length).toBe(created);
  });
});

describe("the bank is down while the QR is created", () => {
  it("nothing is shown as payable; the payment stays PENDING without a reference and the next attempt resumes it", async () => {
    const g = await guestOrder();
    bank.createFailures = 2; // the adapter tries twice
    await expect(start(g)).rejects.toBeTruthy();
    const rows = await prisma.payment.findMany({ where: { orderId: g.orderId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "PENDING", providerRef: null, checkoutData: null });
    const again = await start(g);
    expect(again.paymentId).toBe(rows[0].id);
    expect(again.checkout).toMatchObject({ kind: "upi_qr" });
    expect(await kotsOf(g.orderId)).toBe(0);
  });
});

describe("the bank's verdict", () => {
  it("pending: nothing is paid and nothing reaches the kitchen", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const r = await confirm(g, s.paymentId);
    expect(r).toMatchObject({ paymentStatus: "PENDING", pending: true });
    expect(await kotsOf(g.orderId)).toBe(0);
    expect((await order(g.orderId)).status).toBe("OPEN");
  });

  it("success: verified once, then exactly one payment result, invoice and kitchen ticket set; the screen shows it only after the server committed it", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    const view = await confirm(g, s.paymentId);
    expect(view.paymentStatus).toBe("SUCCESS");
    expect(view.bill.paymentStatus).toBe("PAID");
    const o = await order(g.orderId);
    expect(o.status).toBe("PAID");
    expect(o.payments.filter((p) => p.status === "SUCCESS")).toHaveLength(1);
    expect(await kotsOf(g.orderId)).toBe(2); // KITCHEN + BAR
    expect(await invoicesOf(g.orderId)).toBe(1);
    // Asking again changes nothing.
    await confirm(g, s.paymentId);
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });

  it("the browser's claim is never proof: a forged gateway payload or 'I paid' does not verify", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const r = await confirm(g, s.paymentId, { status: "SUCCESS", paid: "true", rrn: "999999999999" });
    expect(r.paymentStatus).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("a definitive failure and an expired QR fail the attempt; the guest can get a new QR", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await bank.pay((await pay(s.paymentId)).providerRef!, "FAILED", { callback: false });
    expect((await confirm(g, s.paymentId)).paymentStatus).toBe("FAILED");
    const s2 = await start(g);
    expect(s2.paymentId).not.toBe(s.paymentId);
    bank.expire((await pay(s2.paymentId)).providerRef!);
    expect((await confirm(g, s2.paymentId)).paymentStatus).toBe("FAILED");
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it.each([
    ["amount", { amountPaise: 1 }],
    ["merchant", { merchantId: "SOMEONE-ELSE" }],
    ["currency", { currency: "USD" }],
    ["reference", { reference: "RSTnot-ours" }],
  ])("a bank 'success' with the wrong %s is never paid: the payment stays pending and staff are alerted", async (_n, override) => {
    const g = await guestOrder();
    const s = await start(g);
    const ref = (await pay(s.paymentId)).providerRef!;
    await bank.pay(ref, "SUCCESS", { callback: false });
    bank.faults.set(ref, { override });
    const r = await confirm(g, s.paymentId);
    expect(r.paymentStatus).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
    const a = await anomalies(s.paymentId);
    expect(a.map((x) => [x.type, x.severity])).toContainEqual(["RECONCILIATION_MISMATCH", "HIGH"]);
  });
});

describe("callbacks", () => {
  it("an authentic callback releases the order once; replays and duplicates change nothing", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const cb = await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    const body = JSON.stringify(cb);
    expect(await callback(body)).toMatchObject({ status: "PROCESSED", httpStatus: 200 });
    expect((await order(g.orderId)).status).toBe("PAID");
    expect(await callback(body)).toMatchObject({ status: "DUPLICATE", httpStatus: 200 });
    // A different event id for the same success (a bank retry) settles nothing new.
    expect((await callback(JSON.stringify({ ...cb, eventId: `${cb.eventId}:retry` }))).httpStatus).toBe(200);
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });

  it("a forged or tampered callback is refused and pays nothing — and a signed 'success' the bank does not confirm pays nothing either", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const ref = (await pay(s.paymentId)).providerRef!;
    const forged = JSON.stringify({ eventId: `forged-${RUN}`, merchantId: MERCHANT, reference: ref, status: "SUCCESS", amountPaise: 15750, currency: "INR" });
    expect(await callback(forged, "0".repeat(64))).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    expect(await callback(forged, bank.sign(forged, "a-stolen-guess"))).toMatchObject({ httpStatus: 401 });
    // Correctly signed (e.g. a leaked secret), but the bank's status API says the QR is unpaid: nothing is paid.
    const signed = await callback(forged);
    expect(signed.httpStatus).toBe(503); // "not visible at the bank yet": the bank may redeliver
    expect((await pay(s.paymentId)).status).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
  });
});

describe("timeouts, closed browsers and recovery", () => {
  it("a bank timeout leaves the payment pending; the recovery worker settles it later, once", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const ref = (await pay(s.paymentId)).providerRef!;
    await bank.pay(ref, "SUCCESS", { callback: false });
    bank.faults.set(ref, { delayMs: 10_000 });
    vi.stubEnv("UPI_EMULATOR_TIMEOUT_MS", "300");
    const r = await confirm(g, s.paymentId);
    expect(r).toMatchObject({ paymentStatus: "PENDING", pending: true });
    expect(await kotsOf(g.orderId)).toBe(0);
    bank.faults.clear();
    vi.stubEnv("UPI_EMULATOR_TIMEOUT_MS", "");
    await age(s.paymentId);
    const rec = await recheckPendingPayments(prisma, new Date(), { organizationId: orgId });
    expect(rec.settled).toBe(1);
    expect((await order(g.orderId)).status).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect((await recheckPendingPayments(prisma, new Date(), { organizationId: orgId })).settled).toBe(0);
  }, 30_000);

  it("the guest closed the browser after paying: recovery settles the payment and releases the order", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    await age(s.paymentId);
    await recheckPendingPayments(prisma, new Date(), { organizationId: orgId });
    expect((await getGuestOrder(g.orderId, g.accessKey)).bill.paymentStatus).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
  });
});

describe("races", () => {
  it("callback, the guest's status check and the recovery worker at the same moment: one settlement", async () => {
    const g = await guestOrder();
    const s = await start(g);
    const cb = await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    await age(s.paymentId);
    await Promise.allSettled([callback(JSON.stringify(cb)), confirm(g, s.paymentId), confirm(g, s.paymentId), recheckPendingPayments(prisma, new Date(), { organizationId: orgId }), verifyPayment(sys, s.paymentId)]);
    const o = await order(g.orderId);
    expect(o.status).toBe("PAID");
    expect(o.payments.filter((p) => p.status === "SUCCESS")).toHaveLength(1);
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });

  it("two payment attempts on the same order (two phones) both paid at the bank: settled at most once, the capture that cannot be applied is flagged for refund", async () => {
    const g = await guestOrder();
    const a = await start(g);
    // A second phone asks to pay half (split) while the first QR for the whole bill is open: a second, separate payment.
    const b = await startGuestPayment(g.orderId, g.accessKey, key(), { parts: 2 });
    expect(b.paymentId).not.toBe(a.paymentId);
    const refA = (await pay(a.paymentId)).providerRef!;
    const refB = (await pay(b.paymentId)).providerRef!;
    await bank.pay(refA, "SUCCESS", { callback: false });
    await bank.pay(refB, "SUCCESS", { callback: false });
    await Promise.allSettled([confirm(g, a.paymentId), confirm(g, b.paymentId)]);
    await Promise.allSettled([confirm(g, a.paymentId), confirm(g, b.paymentId)]);
    const o = await order(g.orderId);
    const attempts = o.payments.filter((p) => p.id === a.paymentId || p.id === b.paymentId);
    const unapplied = attempts.filter((p) => p.status !== "SUCCESS");
    // Exactly one capture cannot be applied (the whole bill after a half, or a half after the whole bill), and it is
    // never silently kept: a HIGH anomaly asks staff to refund it.
    expect(unapplied).toHaveLength(1);
    expect((await anomalies(unapplied[0].id)).some((x) => x.type === "RECONCILIATION_MISMATCH" && x.severity === "HIGH")).toBe(true);
    if (unapplied[0].id === b.paymentId) {
      // The whole bill was applied: released once.
      expect(o.status).toBe("PAID");
      expect(await kotsOf(g.orderId)).toBe(2);
      expect(await invoicesOf(g.orderId)).toBe(1);
    } else {
      // Half was applied first: still waiting for the other half, nothing in the kitchen yet.
      expect(o.status).toBe("OPEN");
      expect(await kotsOf(g.orderId)).toBe(0);
    }
    const paidSum = o.payments.filter((p) => p.status === "SUCCESS").reduce((t, p) => t + Number(p.amount), 0);
    expect(paidSum).toBeLessThanOrEqual(Number(o.total));
  });
});

describe("late and cancelled orders", () => {
  it("a verified payment after the fulfilment window is recorded, but the order is held for staff (no KOT, no 'preparing'), with a HIGH anomaly", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await ageOrder(g.orderId, fulfilmentWindowMs() + 60_000);
    await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    const view = await confirm(g, s.paymentId);
    expect(view.paymentStatus).toBe("SUCCESS"); // the money is recorded truthfully
    const o = await order(g.orderId);
    expect(o.status).toBe("OPEN");
    expect(await kotsOf(g.orderId)).toBe(0);
    expect(await invoicesOf(g.orderId)).toBe(0);
    expect(view.heldForReview).toBe(true);
    expect(view.tracker.confirmed).toBe(false);
    expect((await anomalies(g.orderId)).map((a) => [a.type, a.severity])).toContainEqual(["LATE_PAYMENT_HELD", "HIGH"]);
    // The POS sees it as paid and waiting for a decision.
    const listed = (await listOrders(prisma, manager, { outletId, active: true, take: 100 })).items.find((x) => x.id === g.orderId)!;
    expect(listed.heldForReview).toBe(true);
    // Staff decide to cook it: Send releases the tickets once and settles the bill.
    await submitOrder(manager, g.orderId);
    expect((await order(g.orderId)).status).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });

  it("…or they refund it and cancel the order: nothing reaches the kitchen", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await ageOrder(g.orderId, fulfilmentWindowMs() + 60_000);
    await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    await confirm(g, s.paymentId);
    await expect(cancelOrder(manager, g.orderId, "guest left")).rejects.toBeInstanceOf(ValidationError); // money first
    const p = await pay(s.paymentId);
    await refundPayment(manager, s.paymentId, { amount: Number(p.amount), reason: "late payment, guest left", idempotencyKey: `rf-${RUN}-late` });
    expect(bank.txn(p.providerRef!).refundedPaise).toBe(Math.round(Number(p.amount) * 100));
    await cancelOrder(manager, g.orderId, "guest left");
    expect((await order(g.orderId)).status).toBe("CANCELLED");
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("no new QR is issued for an order already past the fulfilment window", async () => {
    const g = await guestOrder();
    await ageOrder(g.orderId, fulfilmentWindowMs() + 60_000);
    const created = bank.calls.filter((c) => c.path === "/v1/qr").length;
    await expect(start(g)).rejects.toThrow(ORDER_TOO_OLD_TO_PAY);
    expect(bank.calls.filter((c) => c.path === "/v1/qr").length).toBe(created);
    expect((await getGuestOrder(g.orderId, g.accessKey)).canPay).toBe(false);
  });

  it("a payment for an order staff cancelled is never released; a HIGH anomaly asks for the refund", async () => {
    const g = await guestOrder();
    const s = await start(g);
    await cancelOrder(manager, g.orderId, "guest walked out");
    await bank.pay((await pay(s.paymentId)).providerRef!, "SUCCESS", { callback: false });
    await confirm(g, s.paymentId).catch(() => undefined);
    expect((await order(g.orderId)).status).toBe("CANCELLED");
    expect(await kotsOf(g.orderId)).toBe(0);
    expect((await anomalies(s.paymentId)).some((a) => a.type === "RECONCILIATION_MISMATCH" && a.severity === "HIGH")).toBe(true);
  });
});

describe("split bill", () => {
  it("parts are paid by QR one by one; the kitchen gets the order once, when the whole bill is verified", async () => {
    const g = await guestOrder();
    const first = await startGuestPayment(g.orderId, g.accessKey, key(), { parts: 2 });
    await bank.pay((await pay(first.paymentId)).providerRef!, "SUCCESS", { callback: false });
    expect((await confirm(g, first.paymentId)).paymentStatus).toBe("SUCCESS");
    expect((await order(g.orderId)).status).toBe("OPEN");
    expect(await kotsOf(g.orderId)).toBe(0);
    const second = await startGuestPayment(g.orderId, g.accessKey, key(), { parts: 2 });
    expect(second.share?.last).toBe(true);
    await bank.pay((await pay(second.paymentId)).providerRef!, "SUCCESS", { callback: false });
    await confirm(g, second.paymentId);
    expect((await order(g.orderId)).status).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });
});
