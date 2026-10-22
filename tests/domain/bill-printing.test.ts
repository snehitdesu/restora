/**
 * Bill / receipt printing against the real services:
 *  - a counter-POS paid bill: lines, discount, tax after discount, payment, invoice, INR
 *  - unpaid / partly paid / cancelled bills never claim to be paid; refunds are shown as refunds
 *  - viewing, printing and reprinting a receipt never creates a payment, an
 *    invoice number, stock consumption or a KOT (the bill is a rendering of the order)
 *  - the ESC/POS receipt fits 58 mm (32 columns) and 80 mm (48 columns) paper
 *  - no receipt printer / a simulated printer: an honest answer, never "printed"
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { placeOrder, applyDiscount, cancelOrder } from "@/server/services/orders";
import { createPayment, verifyPayment, refundPayment } from "@/server/services/payment";
import { createMenuItem } from "@/server/services/menu";
import { getOrderBill } from "@/server/services/bill";
import { createPrinter, printReceipt } from "@/server/services/printing";
import { createRecipe, approveRecipeVersion } from "@/server/services/recipe";
import { plain, receiptDoc } from "@/integrations/printer/escpos";
import { num } from "@/domain/money";

const RUN = Date.now().toString(36);
const GSTIN_TS = "36ABCDE1234F1Z1"; // Telangana, checksum-valid
let orgId: string, A: string, NOPRINTER: string;
let sys: AccessContext;
let dosa: string, cola: string, paneer: string;

async function counterOrder(outletId: string, items: Array<{ menuItemId: string; qty: number }>, discount = 0) {
  const o = await placeOrder(sys, { outletId, channel: "TAKEAWAY", submit: true, items });
  if (discount) await applyDiscount(sys, o.id, discount);
  return prisma.order.findUniqueOrThrow({ where: { id: o.id } });
}

async function pay(orderId: string, amount: number) {
  const p = await createPayment(sys, orderId, { method: "CASH", amount });
  await verifyPayment(sys, p.id);
}

/** Everything a print could wrongly create, for one organization. */
async function sideEffects() {
  const where = { organizationId: orgId };
  return {
    payments: await prisma.payment.count({ where }),
    invoices: await prisma.taxInvoice.count({ where }),
    ledger: await prisma.inventoryLedger.count({ where }),
    kots: await prisma.kot.count({ where }),
    orders: await prisma.order.count({ where }),
  };
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Bill Org ${RUN}`, legalName: "Bill Foods Pvt Ltd" } })).id;
  A = (await prisma.outlet.create({ data: { organizationId: orgId, code: `BA${RUN}`, name: "Bill A", address: "1 Road, Hyderabad", gstin: GSTIN_TS, invoiceSeries: "BILA" } })).id;
  NOPRINTER = (await prisma.outlet.create({ data: { organizationId: orgId, code: `BN${RUN}`, name: "Bill N", invoiceSeries: "BILN" } })).id;
  sys = systemContext(orgId, [A, NOPRINTER]);
  dosa = (await createMenuItem(sys, { name: `Dosa ${RUN}`, price: 100, taxPct: 5 })).id;
  cola = (await createMenuItem(sys, { name: `Cola ${RUN}`, price: 99.99, taxPct: 18 })).id;
  // An approved recipe, so a sale really consumes stock (and a reprint must not consume it again).
  paneer = (await createMenuItem(sys, { name: `Paneer Roll ${RUN}`, price: 150, taxPct: 5 })).id;
  const kg = (await prisma.unit.create({ data: { organizationId: orgId, code: `kg${RUN}`, name: "kg" } })).id;
  const mat = (await prisma.material.create({ data: { organizationId: orgId, sku: `P-${RUN}`, name: "Paneer", baseUnitId: kg } })).id;
  const { version } = await createRecipe(sys, { name: `Paneer Roll ${RUN}`, outputType: "MENU_ITEM", menuItemId: paneer, lines: [{ componentType: "MATERIAL", materialId: mat, qty: 0.1 }] });
  await approveRecipeVersion(sys, version.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("bill content", () => {
  it("counter-POS paid bill: lines, discount, tax after discount, payment, invoice and INR all match the order", async () => {
    const o = await counterOrder(A, [{ menuItemId: dosa, qty: 2 }, { menuItemId: cola, qty: 1 }], 20);
    await pay(o.id, num(o.total));
    const bill = await getOrderBill(prisma, sys, o.id);
    expect(bill).toMatchObject({ kind: "RECEIPT", paymentStatus: "PAID", orderStatus: "PAID", balanceDue: "0.00" });
    expect(bill.restaurant).toMatchObject({ outletName: "Bill A", address: "1 Road, Hyderabad", currency: "INR" });
    expect(bill.lines.map((l) => [l.name, Number(l.qty), Number(l.unitPrice)])).toEqual([[`Dosa ${RUN}`, 2, 100], [`Cola ${RUN}`, 1, 99.99]]);
    expect(Number(bill.subtotal)).toBeCloseTo(299.99, 2);
    expect(Number(bill.discount)).toBeCloseTo(20, 2);
    // Tax is charged after the discount: the bill adds up, per rate and in total.
    expect(Number(bill.taxes.reduce((s, t) => s + Number(t.amount), 0).toFixed(2))).toBeCloseTo(Number(bill.tax), 2);
    expect(Number(bill.subtotal) - Number(bill.discount) + Number(bill.tax)).toBeCloseTo(Number(bill.total), 2);
    expect(Number(bill.tax)).toBeLessThan((200 * 0.05 + 99.99 * 0.18)); // less tax than on the undiscounted lines
    expect(bill.total).toBe(num(o.total).toFixed(2));
    expect(bill.payments).toEqual([expect.objectContaining({ method: "CASH", status: "SUCCESS", amount: bill.total })]);
    expect(bill.paid).toBe(bill.total);
    expect(bill.invoice?.number).toMatch(/^BILA\/\d{4}\/\d{5}$/);
  });

  it("an unpaid bill is a BILL with no invoice; a part payment shows the balance; a cancelled order says so", async () => {
    const o = await counterOrder(A, [{ menuItemId: dosa, qty: 1 }]);
    let bill = await getOrderBill(prisma, sys, o.id);
    expect(bill).toMatchObject({ kind: "BILL", paymentStatus: "UNPAID", paid: "0.00", invoice: null });
    expect(bill.balanceDue).toBe(bill.total);

    await pay(o.id, 50);
    bill = await getOrderBill(prisma, sys, o.id);
    expect(bill.paymentStatus).toBe("PARTIALLY_PAID");
    expect(Number(bill.paid)).toBe(50);
    expect(Number(bill.balanceDue)).toBeCloseTo(Number(bill.total) - 50, 2);
    expect(bill.invoice).toBeNull(); // the invoice is issued when the order is paid in full

    const c = await counterOrder(A, [{ menuItemId: dosa, qty: 1 }]);
    await cancelOrder(sys, c.id, "Guest left");
    expect((await getOrderBill(prisma, sys, c.id)).paymentStatus).toBe("CANCELLED");
  });

  it("a part refund and a full refund are shown as such, with the amounts, and never as an amount still due", async () => {
    const o = await counterOrder(A, [{ menuItemId: dosa, qty: 2 }]);
    const p = await createPayment(sys, o.id, { method: "CASH", amount: num(o.total) });
    await verifyPayment(sys, p.id);
    await refundPayment(sys, p.id, { amount: 50, reason: "Wrong item" });
    let bill = await getOrderBill(prisma, sys, o.id);
    expect(bill).toMatchObject({ kind: "RECEIPT", paymentStatus: "PARTIALLY_REFUNDED", refunded: "50.00" });
    expect(bill.refunds.map((r) => r.amount)).toEqual(["50.00"]);
    expect(bill.invoice).not.toBeNull(); // the paid invoice stays; the refund is its own record

    await refundPayment(sys, p.id, { amount: num(o.total) - 50, reason: "Guest complaint" });
    bill = await getOrderBill(prisma, sys, o.id);
    expect(bill.paymentStatus).toBe("REFUNDED");
    expect(bill.refunded).toBe(bill.total);
  });
});

describe("printing and reprinting", () => {
  it("viewing, printing and reprinting never create a payment, an invoice, stock consumption or a KOT", async () => {
    await createPrinter(sys, { outletId: A, name: `Counter ${RUN}`, role: "RECEIPT", transport: "SIMULATED" });
    const o = await counterOrder(A, [{ menuItemId: paneer, qty: 2 }]);
    await pay(o.id, num(o.total));
    expect(await prisma.inventoryLedger.count({ where: { organizationId: orgId, sourceId: o.id } })).toBeGreaterThan(0); // the sale consumed stock
    const before = await sideEffects();
    const first = await getOrderBill(prisma, sys, o.id);

    const printed = await printReceipt(sys, o.id);
    expect(printed).toMatchObject({ status: "SIMULATED", duplicate: false }); // a simulated printer is never reported as printed on paper
    expect(await printReceipt(sys, o.id)).toMatchObject({ id: printed.id, duplicate: true });
    await expect(printReceipt(sys, o.id, { reprint: true })).rejects.toThrow(); // a reprint needs a reason
    const again = await printReceipt(sys, o.id, { reprint: true, reason: "Guest asked for a copy" });
    expect(again).toMatchObject({ duplicate: false, reason: "Guest asked for a copy" });
    expect(again.id).not.toBe(printed.id);

    // The paper itself tells the two copies apart: only the reprint carries the marker.
    const [firstContent, reprintContent] = await Promise.all(
      [printed.id, again.id].map(async (id) => (await prisma.printJob.findUniqueOrThrow({ where: { id }, select: { content: true } })).content)
    );
    expect(firstContent).not.toMatch(/REPRINT/);
    expect(reprintContent).toMatch(/\*\*\* REPRINT \*\*\*/);

    expect(await sideEffects()).toEqual(before);
    const after = await getOrderBill(prisma, sys, o.id);
    expect(after).toEqual(first); // same invoice number, totals and payments: a reprint is identical
    expect(await prisma.printJob.count({ where: { organizationId: orgId, sourceId: o.id, kind: "RECEIPT" } })).toBe(2);
  });

  it("no receipt printer at the outlet: a clear refusal, nothing recorded as printed", async () => {
    const o = await counterOrder(NOPRINTER, [{ menuItemId: dosa, qty: 1 }]);
    await expect(printReceipt(sys, o.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.printJob.count({ where: { organizationId: orgId, sourceId: o.id } })).toBe(0);
  });

  it("the ESC/POS receipt fits 58 mm (32 columns) and 80 mm (48 columns) paper and carries the totals", async () => {
    const o = await counterOrder(A, [{ menuItemId: dosa, qty: 3 }, { menuItemId: cola, qty: 2 }], 15);
    await pay(o.id, num(o.total));
    const bill = await getOrderBill(prisma, sys, o.id);
    for (const width of [32, 48]) {
      const text = plain(receiptDoc(bill, width, { timeLabel: "20 Oct 2026, 10:00" }));
      for (const line of text.split("\n")) expect(line.length, `"${line}" on ${width} columns`).toBeLessThanOrEqual(width);
      expect(text).toContain(`Rs.${bill.total}`);
      expect(text).toContain(`-Rs.${bill.discount}`);
      expect(text).toContain(`Paid CASH`);
      expect(text).toContain(bill.invoice!.number);
      expect(text).not.toMatch(/Balance due/);
    }
  });
});
