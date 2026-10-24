/**
 * Online-payment kitchen gate (kitchenGate.ts) and payment-verification safety.
 *
 * A guest QR order reaches the kitchen only once verified gateway payments
 * cover it: POS submit / accept, captain rounds and fire, desktop Cloud Sync
 * acceptance and counter payments are all refused before that, the guest
 * cannot choose to pay at the counter, a verified payment releases the order
 * exactly once (also under concurrent confirmations), and a gateway timeout or
 * undecided answer never settles anything. Counter POS sales are unaffected.
 *
 * Real services and database (the MOCK gateway adapter stands in for the bank).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, ValidationError } from "@/server/db/scope";
import { createMenuItem } from "@/server/services/menu";
import { submitOrder, fireOrderItems, addOrderRound, placeOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { rotateTableQr } from "@/server/services/masterData";
import { placeGuestOrder, startGuestPayment, confirmGuestPayment, getGuestOrder, PAY_ONLINE_ONLY, ONLINE_PAYMENT_UNAVAILABLE } from "@/server/services/guestOrdering";
import { applySyncOp } from "@/server/sync/cloudFeed";
import { ONLINE_PAYMENT_REQUIRED } from "@/server/services/kitchenGate";
import { recheckPendingPayments } from "@/server/services/paymentRecovery";
import { MockPaymentProvider, type PaymentProvider, type ProviderPaymentStatus } from "@/integrations/payment";
import { IntegrationError } from "@/integrations/http";
import { GUEST_AWAITING_PAYMENT_LABEL } from "@/domain/orderProgress";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string;
let sys: AccessContext, cashier: AccessContext, manager: AccessContext, captain: AccessContext, owner: AccessContext;
let dosa: string, chai: string;
let seq = 0;
const key = () => `pg-${RUN}-${++seq}-abcdef`;
const role = (userId: string, r: string): AccessContext => ({ userId, organizationId: orgId, outletIds: [outletId], roles: [r], outletRoles: { [outletId]: [r] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false });

async function newTable(code: string) {
  const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `${code}-${RUN}` } });
  return (await rotateTableQr(sys, t.id)).qrToken!;
}

/** A fresh guest order (one dosa @ KITCHEN, one chai @ BAR) waiting for its online payment. */
async function guestOrder() {
  const placed = await placeGuestOrder(await newTable(`G${++seq}`), { items: [{ menuItemId: dosa, qty: 1 }, { menuItemId: chai, qty: 1 }], paymentMethod: "ONLINE" }, key());
  return placed;
}

const kotsOf = (orderId: string) => prisma.kot.count({ where: { orderId } });
const invoicesOf = (orderId: string) => prisma.taxInvoice.count({ where: { sourceKey: `inv:${orderId}` } });
const statusOf = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

async function expectGate(p: Promise<unknown>) {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as ValidationError).details).toEqual({ code: ONLINE_PAYMENT_REQUIRED });
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Gate Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `PG${RUN}`, name: "Gate Café" } })).id;
  sys = systemContext(orgId, [outletId]);
  cashier = role(`cash-${RUN}`, "CASHIER");
  manager = role(`mgr-${RUN}`, "MANAGER");
  captain = role(`cap-${RUN}`, "CAPTAIN");
  owner = { ...role(`own-${RUN}`, "OWNER"), orgRoles: ["OWNER"], isOrgWide: true };
  for (const s of ["KITCHEN", "BAR"]) await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: s, kind: s } });
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 120, taxPct: 5, station: "KITCHEN" })).id;
  chai = (await createMenuItem(sys, { name: `Chai ${RUN}`, price: 30, taxPct: 5, station: "BAR" })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("pending online QR payment: nothing releases the order to the kitchen", () => {
  it("POS submit / accept is refused for every staff role, including owner and manager", async () => {
    const g = await guestOrder();
    expect(await statusOf(g.orderId)).toBe("OPEN");
    for (const who of [cashier, manager, owner]) await expectGate(submitOrder(who, g.orderId));
    expect(await kotsOf(g.orderId)).toBe(0);
    expect(await statusOf(g.orderId)).toBe("OPEN");
  });

  it("POS submit never settles an unpaid guest order whose items are already ticketed (inconsistent data fails closed)", async () => {
    const g = await guestOrder();
    // Not reachable through the services (every ticket passes the gate): rows written outside them, e.g. legacy data.
    const items = await prisma.orderItem.findMany({ where: { orderId: g.orderId } });
    await prisma.kot.create({ data: { organizationId: orgId, outletId, orderId: g.orderId, number: 900000 + seq, status: "NEW", items: { create: items.map((it) => ({ orderItemId: it.id, name: it.name, qty: it.qty, status: "NEW" })) } } });
    await expectGate(submitOrder(manager, g.orderId));
    expect(await statusOf(g.orderId)).toBe("OPEN");
    expect(await invoicesOf(g.orderId)).toBe(0);
  });

  it("captain rounds (fire) and fire-items are refused; nothing is half-added", async () => {
    const g = await guestOrder();
    const before = await prisma.orderItem.count({ where: { orderId: g.orderId } });
    await expectGate(addOrderRound(captain, g.orderId, { items: [{ menuItemId: chai, qty: 1 }], fire: true }, `rnd-${RUN}-${++seq}`));
    expect(await prisma.orderItem.count({ where: { orderId: g.orderId } })).toBe(before); // the round rolled back with its refusal
    await expect(fireOrderItems(captain, g.orderId)).rejects.toBeInstanceOf(ValidationError);
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("desktop Cloud Sync acceptance is answered CONFLICT and creates no ticket; a retry replays the receipt", async () => {
    const g = await guestOrder();
    const opId = `op-${RUN}-${++seq}-accept`;
    const r = await applySyncOp(cashier, { action: "ACCEPT", opId, orderId: g.orderId });
    expect(r.outcome).toBe("CONFLICT");
    expect(r.detail).toMatch(/online payment/);
    expect(r.order.status).toBe("OPEN");
    expect(r.order.kots).toHaveLength(0);
    const again = await applySyncOp(cashier, { action: "ACCEPT", opId, orderId: g.orderId });
    expect(again).toMatchObject({ outcome: "CONFLICT", replayed: true });
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("counter payments (cash, till UPI, card) cannot settle it — there is no manager override", async () => {
    const g = await guestOrder();
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: g.orderId } })).total);
    for (const method of ["CASH", "UPI", "CARD"] as const) {
      for (const who of [cashier, manager]) await expectGate(createPayment(who, g.orderId, { method, amount: total }));
    }
    // A counter payment that already exists (created before the rule) cannot be verified into a settlement either.
    const legacy = await prisma.payment.create({ data: { organizationId: orgId, outletId, orderId: g.orderId, method: "CASH", status: "PENDING", amount: total } });
    await expectGate(verifyPayment(manager, legacy.id));
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe("PENDING");
    expect(await statusOf(g.orderId)).toBe("OPEN");
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("the guest sees the order waiting for its payment, not for the restaurant", async () => {
    const g = await guestOrder();
    const view = await getGuestOrder(g.orderId, g.accessKey);
    expect(view.fulfilmentLabel).toBe(GUEST_AWAITING_PAYMENT_LABEL);
    expect(view.canPay).toBe(true);
  });
});

describe("guest checkout cannot choose a pay-at-the-counter path", () => {
  it("paymentMethod CASH is refused and creates nothing", async () => {
    const tok = await newTable("CASH");
    const before = await prisma.order.count({ where: { organizationId: orgId } });
    await expect(placeGuestOrder(tok, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "CASH" }, key())).rejects.toThrow(PAY_ONLINE_ONLY);
    expect(await prisma.order.count({ where: { organizationId: orgId } })).toBe(before);
  });

  it("an order without a payment method waits for online payment (never dispatched)", async () => {
    const placed = await placeGuestOrder(await newTable("NOPM"), { items: [{ menuItemId: dosa, qty: 1 }] }, key());
    expect(await statusOf(placed.orderId)).toBe("OPEN");
    expect(await kotsOf(placed.orderId)).toBe(0);
  });

  it("ordering is refused while online payment is unavailable", async () => {
    vi.spyOn(MockPaymentProvider.prototype, "healthCheck").mockResolvedValue(false);
    const tok = await newTable("DOWN");
    await expect(placeGuestOrder(tok, { items: [{ menuItemId: dosa, qty: 1 }], paymentMethod: "ONLINE" }, key())).rejects.toThrow(ONLINE_PAYMENT_UNAVAILABLE);
  });
});

describe("a verified payment releases the order exactly once", () => {
  it("confirming sends it to the kitchen once (one KOT per station, one invoice); repeats change nothing", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    const first = await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    expect(first.paymentStatus).toBe("SUCCESS");
    expect(await statusOf(g.orderId)).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
    // A double tap, a refresh, the webhook, staff verify: no second release.
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    await verifyPayment(manager, pay.paymentId);
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
    // Once paid, staff accept is a no-op refusal, not a second ticket.
    await expect(submitOrder(cashier, g.orderId)).rejects.toBeInstanceOf(ValidationError);
    expect(await kotsOf(g.orderId)).toBe(2);
  });

  it("concurrent confirmations of one payment settle it once: no duplicate KOTs or invoices", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId })),
      verifyPayment(sys, pay.paymentId),
      verifyPayment(manager, pay.paymentId),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThan(0);
    expect(await statusOf(g.orderId)).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: g.orderId, status: "SUCCESS" } })).toBe(1);
  });

  /** Razorpay-shaped checkouts: every call opens a new gateway order (its own reference), slowly enough for starts to overlap. */
  function gatewayOrders() {
    let n = 0;
    return vi.spyOn(MockPaymentProvider.prototype, "createCheckout").mockImplementation(async (input) => {
      const ref = `gworder_${input.paymentId}_${++n}`;
      await new Promise((r) => setTimeout(r, 25));
      return { providerRef: ref, checkout: { provider: "mock", mode: "MOCK", orderId: ref, amount: Math.round(input.amount * 100), currency: input.currency } };
    });
  }

  it("concurrent payment starts resuming one payment all get its single gateway reference", async () => {
    const g = await guestOrder();
    // A checkout that failed to open leaves the payment PENDING without a reference; the next starts resume it.
    vi.spyOn(MockPaymentProvider.prototype, "createCheckout").mockRejectedValueOnce(new IntegrationError("TIMEOUT", "gateway timed out", true));
    await expect(startGuestPayment(g.orderId, g.accessKey, key())).rejects.toThrow(/timed out/);
    const opened = gatewayOrders();
    const starts = await Promise.all(Array.from({ length: 4 }, () => startGuestPayment(g.orderId, g.accessKey, key())));
    expect(opened.mock.calls.length).toBeGreaterThan(1); // the starts really raced (each opened its own gateway order)
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: starts[0].paymentId } });
    expect(payment).toMatchObject({ status: "PENDING" });
    expect(payment.providerRef).toMatch(/^gworder_/);
    // One reference was stored; every start, winner or not, returns the checkout for that one reference.
    for (const s of starts) {
      expect(s.paymentId).toBe(payment.id);
      expect(s.checkout?.orderId).toBe(payment.providerRef);
    }
  });

  it("a payment decided while its checkout was being opened is refused, never returned with an empty checkout; a retry opens a new one", async () => {
    const g = await guestOrder();
    vi.spyOn(MockPaymentProvider.prototype, "createCheckout").mockRejectedValueOnce(new IntegrationError("TIMEOUT", "gateway timed out", true));
    await expect(startGuestPayment(g.orderId, g.accessKey, key())).rejects.toThrow(/timed out/);
    const open = await prisma.payment.findFirstOrThrow({ where: { orderId: g.orderId, status: "PENDING" } });
    const opened = gatewayOrders();
    // While the gateway opens the checkout, another tab confirms the reference-less payment as declined.
    const declinedMeanwhile = opened.getMockImplementation()!;
    opened.mockImplementationOnce(async (input) => {
      await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: open.id, gateway: { mockOutcome: "decline" } });
      return declinedMeanwhile(input);
    });
    const err = await startGuestPayment(g.orderId, g.accessKey, key()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: open.id } })).toMatchObject({ status: "FAILED", providerRef: null });
    const retry = await startGuestPayment(g.orderId, g.accessKey, key());
    expect(retry.paymentId).not.toBe(open.id);
    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: retry.paymentId } });
    expect(stored).toMatchObject({ status: "PENDING" });
    expect(stored.providerRef).toMatch(/^gworder_/);
    expect(retry.checkout?.orderId).toBe(stored.providerRef);
  });

  it("a split bill reaches the kitchen only when the last online part is verified", async () => {
    const g = await guestOrder();
    const a = await startGuestPayment(g.orderId, g.accessKey, key(), { parts: 2 });
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: a.paymentId });
    expect(await statusOf(g.orderId)).toBe("OPEN");
    expect(await kotsOf(g.orderId)).toBe(0);
    await expectGate(submitOrder(manager, g.orderId)); // half paid is not paid
    const b = await startGuestPayment(g.orderId, g.accessKey, key(), { parts: 2 });
    await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: b.paymentId });
    expect(await statusOf(g.orderId)).toBe("PAID");
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });
});

describe("timeouts and undecided gateway answers never settle a payment", () => {
  it("a gateway timeout leaves the payment PENDING and the order out of the kitchen", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    vi.spyOn(MockPaymentProvider.prototype, "verify").mockRejectedValue(new IntegrationError("TIMEOUT", "gateway timed out", true));
    const res = await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    expect(res).toMatchObject({ pending: true, paymentStatus: "PENDING", status: "OPEN" });
    await expect(verifyPayment(sys, pay.paymentId)).rejects.toBeInstanceOf(IntegrationError); // staff / webhook path: an error, no change
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
    expect(await invoicesOf(g.orderId)).toBe(0);
  });

  it("an undecided answer (pending at the gateway) keeps it PENDING — neither paid nor failed", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    vi.spyOn(MockPaymentProvider.prototype, "verify").mockResolvedValue({ verified: false, pending: true, reason: "Payment is authorized" });
    const res = await confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId });
    expect(res).toMatchObject({ pending: true, paymentStatus: "PENDING", status: "OPEN" });
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("the gateway answer is not applied to a payment whose amount changed while the gateway was asked", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    vi.spyOn(MockPaymentProvider.prototype, "verify").mockImplementation(async (input) => {
      await prisma.payment.update({ where: { id: pay.paymentId }, data: { amount: 1 } }); // tampering mid-call
      return { verified: true, providerRef: input.providerRef };
    });
    await expect(verifyPayment(sys, pay.paymentId)).rejects.toThrow(/changed while it was being verified/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
  });
});

describe("pending-payment recheck job", () => {
  const later = () => new Date(Date.now() + 5 * 60_000); // past the job's minimum age
  const probe = (status: ProviderPaymentStatus["status"] | Error): ((name: string) => PaymentProvider) => () => {
    const p = new MockPaymentProvider();
    p.getPaymentStatus = async (providerRef: string) => {
      if (status instanceof Error) throw status;
      return { status, amount: 0, providerRef };
    };
    return p;
  };

  it("UNKNOWN / PENDING at the gateway, or a timeout, leave the payment PENDING", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    for (const p of [probe("UNKNOWN"), probe("PENDING"), probe(new IntegrationError("TIMEOUT", "timed out", true))]) {
      await recheckPendingPayments(prisma, later(), { organizationId: orgId, providerFor: p });
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("PENDING");
    expect(await kotsOf(g.orderId)).toBe(0);
  });

  it("the default MOCK adapter (UNKNOWN) never settles an abandoned checkout", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    const r = await recheckPendingPayments(prisma, later(), { organizationId: orgId });
    expect(r.settled).toBe(0);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("PENDING");
  });

  it("a capture the browser never reported is settled once and the order released; reruns change nothing", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    const first = await recheckPendingPayments(prisma, later(), { organizationId: orgId, providerFor: probe("CAPTURED") });
    expect(first.settled).toBeGreaterThanOrEqual(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("SUCCESS");
    expect(await statusOf(g.orderId)).toBe("PAID");
    await Promise.all([recheckPendingPayments(prisma, later(), { organizationId: orgId, providerFor: probe("CAPTURED") }), confirmGuestPayment(g.orderId, g.accessKey, { paymentId: pay.paymentId })]);
    expect(await kotsOf(g.orderId)).toBe(2);
    expect(await invoicesOf(g.orderId)).toBe(1);
  });

  it("payments younger than the minimum age are left to the guest's own checkout", async () => {
    const g = await guestOrder();
    const pay = await startGuestPayment(g.orderId, g.accessKey, key());
    await recheckPendingPayments(prisma, new Date(), { organizationId: orgId, providerFor: probe("CAPTURED") });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.paymentId } })).status).toBe("PENDING");
  });
});

describe("counter POS sales are unaffected", () => {
  it("cash, UPI and card split payments settle a staff order with one invoice; its kitchen flow is unchanged", async () => {
    const o = await placeOrder(cashier, { outletId, channel: "DINE_IN", items: [{ menuItemId: dosa, qty: 2 }, { menuItemId: chai, qty: 2 }], submit: true, idempotencyKey: key() });
    expect(o.status).toBe("SENT");
    expect(await kotsOf(o.id)).toBe(2);
    await addOrderRound(captain, o.id, { items: [{ menuItemId: chai, qty: 1 }], fire: true }, `rnd-${RUN}-${++seq}`);
    expect(await kotsOf(o.id)).toBe(3);
    const total = Number((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).total);
    const cash = Math.round(total * 0.3 * 100) / 100;
    const upi = Math.round(total * 0.3 * 100) / 100;
    const card = Math.round((total - cash - upi) * 100) / 100;
    for (const [method, amount] of [["CASH", cash], ["UPI", upi], ["CARD", card]] as const) {
      const p = await createPayment(cashier, o.id, { method, amount });
      await verifyPayment(cashier, p.id);
    }
    expect(await statusOf(o.id)).toBe("PAID");
    expect(await invoicesOf(o.id)).toBe(1);
    expect(await kotsOf(o.id)).toBe(3);
  });

  it("a saved (OPEN) counter order is still sent to the kitchen by staff before payment", async () => {
    const o = await placeOrder(cashier, { outletId, channel: "TAKEAWAY", items: [{ menuItemId: dosa, qty: 1 }], idempotencyKey: key() });
    await submitOrder(cashier, o.id);
    expect(await kotsOf(o.id)).toBe(1);
  });
});
