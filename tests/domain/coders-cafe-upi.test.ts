/**
 * The real restaurant menu (Coders' Cafe, prisma/coders-cafe) through the
 * complete guest transaction with a direct-bank UPI QR:
 *
 *   table QR -> real menu -> cart -> server-priced order -> the bank's
 *   transaction-specific QR (server amount, RESTORA's reference) -> the payer
 *   pays -> the server's own status lookup / signed callbacks -> PAID -> KOT
 *   -> kitchen -> invoice -> sales / payments analytics
 *
 * plus every failure path the bank can produce: decline then a new QR,
 * browser closed before the bank answered, a signed callback the bank's
 * status API does not confirm, duplicate / forged / mismatched / foreign
 * callbacks, and a payment for an order that was meanwhile cancelled.
 *
 * "The bank" here is tests/support/upiBankEmulator.ts (UPI_EMULATOR_BASE, RESTORA's
 * own TEST wire format — not SBI's): the adapter, payment service, webhook
 * pipeline and database are the real code paths; only the bank on the far end
 * of HTTP is emulated. Classification: LOCAL EMULATOR tests (not SBI UAT).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { type AccessContext } from "@/server/db/scope";
import { guestMenu, placeGuestOrder, getGuestOrder, startGuestPayment, confirmGuestPayment, resolveTable } from "@/server/services/guestOrdering";
import { submitOrder, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { listKOTs, updateKOTStatus } from "@/server/services/kot";
import { getOrderBill } from "@/server/services/bill";
import { paymentsByMethod, salesSummary } from "@/server/services/analytics";
import { receiveWebhook } from "@/server/services/webhooks";
import { revokeTableQr } from "@/server/services/masterData";
import { num } from "@/domain/money";
import { seedCodersCafe, legacyCafeTableToken, type CafeSeedResult } from "../../prisma/coders-cafe/seed";
import { CODERS_CAFE_MENU, menuItemCount } from "../../prisma/coders-cafe/menu";
import { UpiBankEmulator, type UpiCallback } from "../support/upiBankEmulator";
import { bindWebhook } from "./webhookBinding";

const RUN = Date.now().toString(36);
const MERCHANT = `EMU-CAFE-${RUN}`;
const bank = new UpiBankEmulator({ apiKey: `cafe-bank-key-${RUN}`, merchantId: MERCHANT, webhookSecret: `cafe-bank-webhook-${RUN}` });
const ENV = ["PAYMENT_PROVIDER", "UPI_EMULATOR_BASE", "UPI_EMULATOR_API_KEY", "UPI_EMULATOR_MERCHANT_ID", "UPI_EMULATOR_WEBHOOK_SECRET"] as const;
const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

let cafe: CafeSeedResult;
let table07: string;
let manager: AccessContext, cashier: AccessContext, chef: AccessContext, owner: AccessContext;
const items = new Map<string, { id: string; variants: Map<string, string>; options: Map<string, string> }>();
let keySeq = 0;
const key = () => `cafe-${RUN}-${++keySeq}-abcdef`;

const ctxFor = async (email: string): Promise<AccessContext> => {
  const { buildAccessContext } = await import("@/server/auth/context");
  const u = await prisma.user.findFirstOrThrow({ where: { email, organizationId: cafe.organizationId } });
  return buildAccessContext(prisma, u.id);
};
/** Deliver a bank callback to RESTORA's webhook pipeline (signed with the bank's secret unless told otherwise). */
const sendCallback = (cb: UpiCallback | string, opts: { secret?: string; signature?: string } = {}) => {
  const rawBody = typeof cb === "string" ? cb : JSON.stringify(cb);
  return receiveWebhook({ kind: "PAYMENT", provider: "upi_emulator", rawBody, signature: opts.signature ?? bank.sign(rawBody, opts.secret) });
};
/** The bank reference RESTORA stored for a payment (the QR's transaction reference). */
const refOf = async (paymentId: string) => (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).providerRef!;
const item = (name: string) => {
  const it = items.get(name);
  if (!it) throw new Error(`not on the Coders' Cafe menu: ${name}`);
  return it;
};
/** Classic Margherita Pizza (Medium) + Make It a Cheese Melt, and 2 × Classic Fries (Large). */
const investorCart = () => ({
  items: [
    { menuItemId: item("Classic Margherita Pizza").id, variantId: item("Classic Margherita Pizza").variants.get("Medium"), modifierOptionIds: [item("Classic Margherita Pizza").options.get("Make It a Cheese Melt")!], qty: 1 },
    { menuItemId: item("Classic Fries").id, variantId: item("Classic Fries").variants.get("Large"), qty: 2 },
  ],
});
const counts = async (orderId: string) => ({
  orders: await prisma.order.count({ where: { id: orderId } }),
  success: await prisma.payment.count({ where: { orderId, status: "SUCCESS" } }),
  kots: await prisma.kot.count({ where: { orderId } }),
  invoices: await prisma.taxInvoice.count({ where: { orderId } }),
});

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  const base = await bank.start();
  Object.assign(process.env, { PAYMENT_PROVIDER: "upi_emulator", UPI_EMULATOR_BASE: base, UPI_EMULATOR_API_KEY: bank.cfg.apiKey, UPI_EMULATOR_MERCHANT_ID: MERCHANT, UPI_EMULATOR_WEBHOOK_SECRET: bank.cfg.webhookSecret });
  cafe = await seedCodersCafe(prisma, { reset: true });
  table07 = cafe.tables.find((t) => t.code === "T07")!.token;
  await bindWebhook({ kind: "PAYMENT", provider: "upi_emulator", organizationId: cafe.organizationId, outletId: cafe.outletId, externalRef: MERCHANT });
  for (const i of await prisma.menuItem.findMany({ where: { organizationId: cafe.organizationId }, include: { variants: true, modifierGroups: { include: { group: { include: { options: true } } } } } })) {
    items.set(i.name, { id: i.id, variants: new Map(i.variants.map((v) => [v.name, v.id])), options: new Map(i.modifierGroups.flatMap((g) => g.group.options.map((o) => [o.name, o.id] as const))) });
  }
  manager = await ctxFor("cafe.manager@demo.local");
  cashier = await ctxFor("cafe.cashier@demo.local");
  chef = await ctxFor("cafe.chef@demo.local");
  owner = await ctxFor("cafe.owner@demo.local");
});

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await bank.stop();
  await prisma.$disconnect();
});

describe("Coders' Cafe dataset", () => {
  it("is the board menu: every category, item, price and size, priced by the server", async () => {
    const menu = await guestMenu(table07);
    expect(menu.restaurant.name).toBe("Coders' Cafe");
    expect(menu.table.code).toBe("T07");
    expect(menu.menu).toHaveLength(menuItemCount());
    for (const cat of CODERS_CAFE_MENU) {
      for (const it of cat.items) {
        const m = menu.menu.find((x) => x.name === it.name)!;
        expect(m, it.name).toBeTruthy();
        expect(m.category?.name).toBe(cat.name);
        expect(m.price).toBe(it.price);
        expect(m.isVeg).toBe(it.isVeg);
        expect(m.variants.map((v) => [v.name, it.price + v.priceDelta]).sort()).toEqual((it.sizes ?? []).map((s) => [s.name, s.price]).sort());
      }
    }
    expect(menu.payment).toMatchObject({ online: true, testMode: false, mode: "MOCK" }); // emulated bank, labelled as such
  });

  it("tables T01–T10 resolve to the cafe's own outlet; their tokens are random, not derivable", async () => {
    for (const t of cafe.tables) expect(t.token).not.toBe(legacyCafeTableToken(t.code));
    const t = await resolveTable(table07);
    expect(t.outlet.id).toBe(cafe.outletId);
    expect(t.ctx.organizationId).toBe(cafe.organizationId);
  });
});

describe("a bank UPI QR through the guest QR flow", () => {
  it("success: one QR for the server's amount, verified by the bank, PAID, one KOT, kitchen, invoice, analytics", async () => {
    const placed = await placeGuestOrder(table07, investorCart(), key());
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    // (160 + 60) + 2 × 110 = 440, GST 5% = 22.00
    expect(view.bill).toMatchObject({ subtotal: "440.00", total: "462.00", balanceDue: "462.00" });
    expect(view.bill.lines.map((l) => l.name)).toEqual(["Classic Margherita Pizza (Medium)", "Classic Fries (Large)"]);

    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(start).toMatchObject({ provider: "upi_emulator", amount: "462.00", checkout: { provider: "upi_emulator", kind: "upi_qr", amount: 46200, currency: "INR" } });
    const ref = await refOf(start.paymentId);
    expect(bank.txn(ref)).toMatchObject({ amountPaise: 46200, merchantId: MERCHANT, status: "PENDING" });
    // A refresh mid-payment shows the same QR (stored), never a second bank transaction.
    const again = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(again.paymentId).toBe(start.paymentId);
    expect(again.checkout).toMatchObject({ qr: start.checkout!.qr, reference: ref });
    expect(bank.calls.filter((c) => c.method === "POST" && c.path === "/v1/qr")).toHaveLength(1);

    const cb = await bank.pay(ref, "SUCCESS", { callback: false });
    const confirmed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId });
    expect(confirmed).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID", pending: false });
    // The bank's own callback for the same payment changes nothing.
    expect(await sendCallback(cb)).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(await sendCallback(cb)).toMatchObject({ status: "DUPLICATE" });
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });

    // The manager sees the same order; the kitchen gets the same items as a KOT.
    const kots = await listKOTs(prisma, chef, { outletId: cafe.outletId });
    const kot = kots.find((k) => k.orderId === placed.orderId)!;
    expect(kot.items.map((i) => [i.name, num(i.qty)])).toEqual([["Classic Margherita Pizza (Medium)", 1], ["Classic Fries (Large)", 2]]);
    for (const st of ["ACCEPTED", "PREPARING", "READY", "SERVED"] as const) await updateKOTStatus(chef, kot.id, st);
    await expect(updateKOTStatus(chef, kot.id, "PREPARING")).rejects.toThrow(); // invalid transition
    await expect(updateKOTStatus(cashier, kot.id, "SERVED")).rejects.toThrow();

    const bill = await getOrderBill(prisma, manager, placed.orderId);
    expect(bill).toMatchObject({ total: "462.00", paid: "462.00", balanceDue: "0.00", paymentStatus: "PAID", table: "T07" });
    expect(bill.payments).toEqual([expect.objectContaining({ method: "ONLINE", status: "SUCCESS", amount: "462.00" })]);
    const inv = await prisma.taxInvoice.findFirstOrThrow({ where: { orderId: placed.orderId } });
    expect(num(inv.total)).toBe(462);
    expect(inv.number).toMatch(/^CC\//);

    const range = { outletId: cafe.outletId, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 60_000) };
    const byMethod = await paymentsByMethod(prisma, owner, range);
    expect(byMethod.find((r) => r.method === "ONLINE")?.amount).toBeGreaterThanOrEqual(462);
    expect((await salesSummary(prisma, owner, range)).orders).toBeGreaterThanOrEqual(1);
    expect(await prisma.auditLog.count({ where: { entityType: "Payment", entityId: start.paymentId, action: "PAYMENT" } })).toBe(1);
  });

  it("the payer's bank declines; a new QR is paid: nothing doubles", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Loaded Chicken Nachos").id, qty: 1 }] }, key()); // 160 + 8 = 168
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const declined = await bank.pay(await refOf(start.paymentId), "FAILED", { callback: false });
    expect(await sendCallback(declined)).toMatchObject({ status: "PROCESSED" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("FAILED");
    // The guest asks for a new QR: a new payment and a new bank transaction.
    const retry = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(retry.paymentId).not.toBe(start.paymentId);
    const ok = await bank.pay(await refOf(retry.paymentId), "SUCCESS", { callback: false });
    const confirmed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: retry.paymentId });
    expect(confirmed).toMatchObject({ paymentStatus: "SUCCESS", status: "PAID" });
    expect(await sendCallback(ok)).toMatchObject({ ok: true });
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(2);
  });

  it("the browser closed before the bank answered: the payment stays PENDING (not failed) and the bank's late callback settles it", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Simply Veg").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const closed = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId });
    expect(closed).toMatchObject({ paymentStatus: "PENDING", pending: true, status: "OPEN", canPay: true, pendingPaymentId: start.paymentId });
    expect(await prisma.notification.count({ where: { type: "PAYMENT_FAILED", body: { contains: placed.orderId.slice(-6).toUpperCase() } } })).toBe(0);
    // Paid later (from another phone, after the tab closed): only the bank's callback arrives.
    const late = await bank.pay(await refOf(start.paymentId), "SUCCESS", { callback: false });
    expect(await sendCallback(late)).toMatchObject({ status: "PROCESSED" });
    const v = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(v.status).toBe("PAID");
    expect(await counts(placed.orderId)).toEqual({ orders: 1, success: 1, kots: 1, invoices: 1 });
  });

  it("a signed callback the bank's status API does not confirm is retried, not applied; once the bank confirms it settles", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Corn Special").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const ref = await refOf(start.paymentId);
    expect(await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId })).toMatchObject({ paymentStatus: "PENDING", pending: true });
    // The callback says SUCCESS, the bank's status API still says PENDING: 503, the bank redelivers.
    const claim = bank.callbackFor({ ...bank.txn(ref), status: "SUCCESS" }, `${ref}:early`);
    expect(await sendCallback(claim)).toMatchObject({ status: "FAILED", httpStatus: 503 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("OPEN");
    const real = await bank.pay(ref, "SUCCESS", { callback: false });
    expect(await sendCallback(real)).toMatchObject({ status: "PROCESSED" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).status).toBe("PAID");
  });

  it("forged, tampered and foreign callbacks — and the browser's own 'proof' — change nothing", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Farmpizza").id, qty: 1 }] }, key());
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    const ref = await refOf(start.paymentId);
    const cb = await bank.pay(ref, "SUCCESS", { callback: false });
    expect(await sendCallback(cb, { secret: "not-the-secret" })).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    const raw = JSON.stringify(cb);
    expect(await sendCallback(raw.replace(`"amountPaise":${cb.amountPaise}`, `"amountPaise":100`), { signature: bank.sign(raw) })).toMatchObject({ status: "INVALID_SIGNATURE", httpStatus: 401 });
    expect(await sendCallback({ ...cb, eventId: `${cb.eventId}:cheap`, amountPaise: 100 })).toMatchObject({ status: "FAILED", reason: "Amount mismatch" });
    expect(await sendCallback({ ...cb, eventId: `${cb.eventId}:foreign`, merchantId: "EMU-NOBODY" })).toMatchObject({ status: "FAILED", reason: "Unknown integration account" });
    const malformed = await receiveWebhook({ kind: "PAYMENT", provider: "upi_emulator", rawBody: "{not json", signature: "x" });
    expect(malformed.ok).toBe(false);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).status).toBe("PENDING");
    // The browser's "proof" is not looked at; the server asks the bank, which says SUCCESS for our exact payment.
    // ...and the browser cannot point verification at another bank transaction.
    await expect(confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId, providerRef: "RSTsomeone-else" })).rejects.toThrow(/does not match/);
    // The genuine callback lands.
    expect(await sendCallback(cb)).toMatchObject({ status: "PROCESSED" });
    expect(await counts(placed.orderId)).toMatchObject({ success: 1, kots: 1, invoices: 1 });
  });

  it("a payment for an order that can no longer take it (cancelled meanwhile) is surfaced for refund, never applied", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Chicken Nuggets").id, qty: 1 }] }, key()); // 150 + 7.50
    const start = await startGuestPayment(placed.orderId, placed.accessKey, key());
    // The counter cannot settle a QR order waiting for its online payment; the guest left and staff cancelled it.
    await expect(createPayment(cashier, placed.orderId, { method: "CASH", amount: 157.5 })).rejects.toThrow(/cannot be settled at the counter/);
    await cancelOrder(manager, placed.orderId, "guest left");
    const late = await bank.pay(await refOf(start.paymentId), "SUCCESS", { callback: false });
    expect(await sendCallback(late)).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: start.paymentId } })).toMatchObject({ status: "FAILED" });
    expect(await prisma.payment.count({ where: { orderId: placed.orderId, status: "SUCCESS" } })).toBe(0);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: placed.orderId } })).toMatchObject({ status: "CANCELLED" });
    expect(await prisma.kot.count({ where: { orderId: placed.orderId } })).toBe(0); // never released to the kitchen
    const anomaly = await prisma.anomaly.findFirstOrThrow({ where: { organizationId: cafe.organizationId, entityType: "Payment", entityId: start.paymentId } });
    expect(anomaly).toMatchObject({ type: "RECONCILIATION_MISMATCH", severity: "HIGH", status: "OPEN" });
    expect(anomaly.message).toMatch(/Refund the guest/);
    // Redelivery does not raise it twice.
    expect(await sendCallback(late)).toMatchObject({ status: "DUPLICATE" });
    expect(await prisma.anomaly.count({ where: { entityType: "Payment", entityId: start.paymentId } })).toBe(1);
  });
});

describe("Coders' Cafe isolation and table QR control", () => {
  it("another restaurant's staff cannot read or settle the cafe's orders", async () => {
    const placed = await placeGuestOrder(table07, { items: [{ menuItemId: item("Classic Fries").id, qty: 1 }] }, key());
    const other = await prisma.organization.create({ data: { name: `Other ${RUN}` } });
    const otherOutlet = await prisma.outlet.create({ data: { organizationId: other.id, code: `OT${RUN}`, name: "Other" } });
    const intruder: AccessContext = { userId: `intr-${RUN}`, organizationId: other.id, outletIds: [otherOutlet.id], roles: ["OWNER"], outletRoles: {}, orgRoles: ["OWNER"], isOrgWide: true, isSuperAdmin: false };
    await expect(getOrderBill(prisma, intruder, placed.orderId)).rejects.toThrow(/not found/i);
    await expect(createPayment(intruder, placed.orderId, { method: "CASH", amount: 89.25 })).rejects.toThrow(/not found/i);
    await expect(submitOrder(intruder, placed.orderId)).rejects.toThrow();
    await expect(getGuestOrder(placed.orderId, "wrong-key")).rejects.toThrow(/not found/i);
  });

  it("revoking a table's QR disables ordering there at once; other tables keep working", async () => {
    const t03 = cafe.tables.find((t) => t.code === "T03")!;
    await expect(revokeTableQr(cashier, t03.id)).rejects.toThrow(); // outlet.manage only
    await revokeTableQr(manager, t03.id);
    await expect(guestMenu(t03.token)).rejects.toThrow(/not valid/);
    await expect(placeGuestOrder(t03.token, { items: [{ menuItemId: item("Classic Fries").id, qty: 1 }] }, key())).rejects.toThrow(/not valid/);
    expect((await guestMenu(table07)).table.code).toBe("T07");
    expect(await prisma.auditLog.count({ where: { entityType: "RestaurantTable", entityId: t03.id, action: "UPDATE" } })).toBeGreaterThanOrEqual(1);
  });
});
