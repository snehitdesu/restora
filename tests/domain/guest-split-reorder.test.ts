/**
 * Guest QR ordering, audit QR-08: "order the same again" and splitting the bill between the phones at a table.
 *
 * Real services, real database; the guest goes through the same functions the /api/qr routes call. The amount of every part is
 * the server's: the guest only says how many people are splitting.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext } from "@/server/db/scope";
import { createMenuItem, addVariant, createModifierGroup, addModifierOption, attachModifierGroup, setOutletMenuItem } from "@/server/services/menu";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { rotateTableQr } from "@/server/services/masterData";
import { placeGuestOrder, getGuestOrder, quoteGuestCart, startGuestPayment, confirmGuestPayment } from "@/server/services/guestOrdering";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
let orgId: string, outletId: string, sys: AccessContext;
let biryani: string, naan: string, large: string, spiceHot: string, extraCheese: string;
let seq = 0;
const key = () => `split-${RUN}-${++seq}-abcdef`;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Split Org ${RUN}` } })).id;
  outletId = (await prisma.outlet.create({ data: { organizationId: orgId, code: `SP${RUN}`, name: "Split Central" } })).id;
  sys = systemContext(orgId, [outletId]);
  await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId, name: "KITCHEN", kind: "KITCHEN" } });
  biryani = (await createMenuItem(sys, { name: `Biryani ${RUN}`, price: 300, taxPct: 5, station: "KITCHEN" })).id;
  naan = (await createMenuItem(sys, { name: `Naan ${RUN}`, price: 60, taxPct: 5, station: "KITCHEN" })).id;
  large = (await addVariant(sys, { menuItemId: biryani, name: "Large", priceDelta: 80 })).id;
  const spice = await createModifierGroup(sys, { name: `Spice ${RUN}`, minSelect: 1, maxSelect: 1 });
  spiceHot = (await addModifierOption(sys, { groupId: spice.id, name: "Hot", priceDelta: 0 })).id;
  await attachModifierGroup(sys, biryani, spice.id);
  const extras = await createModifierGroup(sys, { name: `Extras ${RUN}`, minSelect: 0, maxSelect: 2 });
  extraCheese = (await addModifierOption(sys, { groupId: extras.id, name: "Cheese", priceDelta: 30 })).id;
  await attachModifierGroup(sys, naan, extras.id);
});

/** A table of its own for every order: a table may only have a few unaccepted guest orders waiting at once. */
let tables = 0;
async function freshTable() {
  const t = await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId, code: `S${++tables}` } });
  return (await rotateTableQr(sys, t.id)).qrToken!;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const dishes = () => ({ items: [{ menuItemId: biryani, variantId: large, modifierOptionIds: [spiceHot], qty: 2, notes: "no onions" }, { menuItemId: naan, modifierOptionIds: [extraCheese], qty: 3 }] });
const place = async () => placeGuestOrder(await freshTable(), dishes(), key());

describe("order the same again", () => {
  it("returns the dishes as a cart: item, size, add-ons, quantity and note, and nothing else the guest could tamper with", async () => {
    const placed = await place();
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    expect(view.reorder).toHaveLength(2);
    expect(view.reorder[0]).toMatchObject({ menuItemId: biryani, variantId: large, modifierOptionIds: [spiceHot], qty: 2, notes: "no onions" });
    expect(view.reorder[1]).toMatchObject({ menuItemId: naan, modifierOptionIds: [extraCheese], qty: 3 });
    expect(view.reorder[1].notes).toBeUndefined();
    expect(Object.keys(view.reorder[0]).sort()).toEqual(["menuItemId", "modifierLabels", "modifiersPerUnit", "name", "notes", "qty", "taxPct", "unitPrice", "variantId", "modifierOptionIds"].sort());
  });

  it("the lines price again through the cart quote: the same total today, the new price after a change, a flag when a dish is gone", async () => {
    const placed = await place();
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    const asCart = () => ({ items: view.reorder.map((l) => ({ menuItemId: l.menuItemId, ...(l.variantId ? { variantId: l.variantId } : {}), modifierOptionIds: l.modifierOptionIds, qty: l.qty, ...(l.notes ? { notes: l.notes } : {}) })) });

    const token = await freshTable();
    const same = await quoteGuestCart(token, asCart());
    expect(same.allAvailable).toBe(true);
    expect(same.total).toBe(view.bill.total);

    await setOutletMenuItem(sys, { outletId, menuItemId: naan, price: 70 });
    const dearer = await quoteGuestCart(token, asCart());
    expect(num(dearer.total)).toBeGreaterThan(num(same.total)); // the old price is not honoured
    await setOutletMenuItem(sys, { outletId, menuItemId: naan, price: 60 });

    await setOutletMenuItem(sys, { outletId, menuItemId: naan, soldOut: true });
    const gone = await quoteGuestCart(token, asCart());
    expect(gone.allAvailable).toBe(false);
    expect(gone.lines.filter((l) => !l.ok)).toHaveLength(1);
    await setOutletMenuItem(sys, { outletId, menuItemId: naan, soldOut: false });
  });

  it("is not available for another guest's order: the key still gates the view", async () => {
    const placed = await place();
    await expect(getGuestOrder(placed.orderId, "wrong-key")).rejects.toThrow(/not found/i);
    await expect(getGuestOrder(placed.orderId, null)).rejects.toThrow(/not found/i);
  });
});

describe("splitting the bill between phones", () => {
  it("three people each pay their part from their own phone; the parts add up to the bill and the last payer closes it", async () => {
    const placed = await place();
    const total = num((await getGuestOrder(placed.orderId, placed.accessKey)).bill.total); // 2 × 380 + 3 × 90 = 1030 + 5% tax
    expect((await getGuestOrder(placed.orderId, placed.accessKey)).split).toEqual({ sharesPaid: 0, minParts: 2, maxParts: 12 });

    const paid: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 3 });
      expect(start.share).toMatchObject({ parts: 3, remainingParts: 3 - i, last: i === 2 });
      paid.push(num(start.amount));
      const res = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: start.paymentId });
      expect(res.paymentStatus).toBe("SUCCESS");
      expect(res.split.sharesPaid).toBe(i + 1);
      expect(res.status).toBe(i === 2 ? "PAID" : "OPEN");
      expect(res.canPay).toBe(i < 2);
    }
    expect(Math.round(paid.reduce((a, b) => a + b, 0) * 100) / 100).toBe(total);
    expect(Math.max(...paid) - Math.min(...paid)).toBeLessThan(0.05);
    const payments = await prisma.payment.findMany({ where: { orderId: placed.orderId } });
    expect(payments).toHaveLength(3);
    expect(payments.every((p) => p.status === "SUCCESS" && p.method === "ONLINE")).toBe(true);
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 3 })).rejects.toThrow(/already paid/);
  });

  it("each phone has its own payment, and a retry from the same phone returns the same one", async () => {
    const placed = await place();
    const k1 = key();
    const a = await startGuestPayment(placed.orderId, placed.accessKey, k1, { parts: 2 });
    const again = await startGuestPayment(placed.orderId, placed.accessKey, k1, { parts: 2 });
    const b = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 2 });
    expect(again.paymentId).toBe(a.paymentId);
    expect(b.paymentId).not.toBe(a.paymentId);
    expect(b.amount).toBe(a.amount); // neither has paid yet: both are asked for half
    // A phone that opens a whole-bill payment is not put on somebody's share.
    const whole = await startGuestPayment(placed.orderId, placed.accessKey, key());
    expect(whole.paymentId).not.toBe(a.paymentId);
    expect(whole.paymentId).not.toBe(b.paymentId);
    expect(whole).not.toHaveProperty("share");
    expect(num(whole.amount)).toBeGreaterThan(num(a.amount));
  });

  it("works from what is still due: cash taken at the counter in between is respected", async () => {
    const placed = await place();
    const view = await getGuestOrder(placed.orderId, placed.accessKey);
    const total = num(view.bill.total);
    const first = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 4 });
    await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: first.paymentId });
    const cashier: AccessContext = { userId: `cash-${RUN}`, organizationId: orgId, outletIds: [outletId], roles: ["CASHIER"], outletRoles: { [outletId]: ["CASHIER"] }, orgRoles: [], isOrgWide: false, isSuperAdmin: false };
    const cash = await createPayment(cashier, placed.orderId, { method: "CASH", amount: 300 });
    await verifyPayment(cashier, cash.id);
    const due = Math.round((total - num(first.amount) - 300) * 100) / 100;
    const next = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 4 });
    // 4 people, one part paid online (the cash was not a part): three still to pay what is due, rounded down.
    expect(next.share).toMatchObject({ parts: 4, remainingParts: 3, last: false });
    expect(num(next.amount)).toBe(Math.floor((due / 3) * 100) / 100);
  });

  it("refuses a split of fewer than 2 or more than 12, a fraction, extra fields and a client-chosen amount", async () => {
    const placed = await place();
    for (const parts of [0, 1, 13, 2.5, -3, "3", null]) await expect(startGuestPayment(placed.orderId, placed.accessKey, key(), { parts })).rejects.toBeInstanceOf(ZodError);
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 3, amount: 1 })).rejects.toBeInstanceOf(ZodError);
    await expect(startGuestPayment(placed.orderId, placed.accessKey, key(), { amount: 1 })).rejects.toBeInstanceOf(ZodError);
    expect(await prisma.payment.count({ where: { orderId: placed.orderId } })).toBe(0);
  });

  it("a wrong order key cannot start a part payment", async () => {
    const placed = await place();
    await expect(startGuestPayment(placed.orderId, "wrong-key", key(), { parts: 2 })).rejects.toThrow(/not found/i);
    await expect(startGuestPayment(placed.orderId, null, key(), { parts: 2 })).rejects.toThrow(/not found/i);
  });

  it("a declined part is a failed payment only: nothing is collected and the next try is a new payment", async () => {
    const placed = await place();
    const a = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 2 });
    const declined = await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: a.paymentId, gateway: { mockOutcome: "decline" } });
    expect(declined).toMatchObject({ paymentStatus: "FAILED", status: "OPEN", canPay: true });
    expect(declined.split.sharesPaid).toBe(0);
    expect(declined.bill.paid).toBe("0.00");
    const b = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 2 });
    expect(b.paymentId).not.toBe(a.paymentId);
    expect(b.amount).toBe(a.amount);
  });

  it("the audit trail records every part as its own payment", async () => {
    const placed = await place();
    for (let i = 0; i < 2; i++) {
      const s = await startGuestPayment(placed.orderId, placed.accessKey, key(), { parts: 2 });
      await confirmGuestPayment(placed.orderId, placed.accessKey, { paymentId: s.paymentId });
    }
    const ids = (await prisma.payment.findMany({ where: { orderId: placed.orderId }, select: { id: true } })).map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, entityType: "Payment", entityId: { in: ids } } })).toBeGreaterThanOrEqual(2);
  });
});
