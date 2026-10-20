/**
 * Bill / receipt printing in a real browser (production build, real database).
 * RESTORA prints bills with the browser's print dialog (or "Save as PDF") from
 * /pos/bill/:orderId; a configured network receipt printer is covered by
 * tests/domain/integrations-p7.test.ts and tests/domain/bill-printing.test.ts.
 * No physical printer is involved here: window.print is replaced by a counter,
 * and the print stylesheet is checked with print media emulation.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiAs, apiCall, apiData, order, CENTRAL } from "./helpers";

test.use({ storageState: statePath("cashier") });

const RUN = Date.now().toString(36);

test("BILL-001 unpaid bill then paid receipt: right document, print styles hide the controls, printing twice changes nothing", async ({ page }) => {
  const outlet = await outletByCode(page.request, CENTRAL);
  const cashier = await apiAs("cashier");
  const menu = await apiData<Array<{ id: string; name: string }>>(cashier, `/api/menu?outletId=${outlet.id}&activeOnly=true`);
  const chai = menu.find((m) => m.name === "Masala Chai")!;
  const placed = await apiCall<{ id: string }>(cashier, "POST", "/api/orders", { outletId: outlet.id, channel: "TAKEAWAY", submit: true, items: [{ menuItemId: chai.id, qty: 3 }] }, { "idempotency-key": `e2e-bill-${RUN}` });
  expect(placed.status, JSON.stringify(placed.body?.error)).toBe(200);
  const orderId = placed.body!.data.id;

  // Count print calls instead of opening the system dialog.
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints++;
    };
  });

  // ---- Unpaid: a BILL with the balance due; nothing claims it is paid.
  await page.goto(`/pos/bill/${orderId}`);
  const bill = page.getByRole("article", { name: /^Bill / });
  await expect(bill).toBeVisible();
  await expect(bill).toContainText("Masala Chai");
  await expect(bill).toContainText("₹126.00"); // 3 × 40 × 1.05
  await expect(bill).not.toContainText(/\bPaid\b/);
  await expect(page.getByTestId("invoice-number")).toHaveCount(0);
  await page.getByRole("button", { name: "Print bill" }).click();
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  // The browser never says whether paper came out: the page does not claim it did.
  await expect(page.getByRole("status")).toContainText("Print dialog closed");
  await expect(page.getByRole("status")).not.toContainText(/\bprinted\b/i);

  // ---- Paid at the counter: a RECEIPT with its invoice number.
  const pay = await apiCall<{ id: string }>(cashier, "POST", "/api/payments", { orderId, method: "CASH", amount: 126 }, { "idempotency-key": `e2e-bill-pay-${RUN}` });
  expect((await apiCall(cashier, "POST", `/api/payments/${pay.body!.data.id}/verify`)).status).toBe(200);
  await page.reload();
  const receipt = page.getByRole("article", { name: /^Receipt / });
  await expect(page.getByTestId("bill-payment-status")).toHaveText("Paid");
  await expect(receipt).toContainText("₹126.00");
  const invoice = (await page.getByTestId("invoice-number").innerText()).trim();
  expect(invoice).toMatch(/^HYDC\/\d{4}\/\d{5}$/);
  const text = await receipt.innerText();

  // Print media: the toolbar (back link, print buttons) is hidden; the receipt is not.
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("link", { name: "← Back to POS" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Print receipt" })).toBeHidden();
  await expect(receipt).toBeVisible();
  await page.emulateMedia({ media: "screen" });

  // Printing and reprinting: same document, no new payment / invoice / KOT.
  const before = await order(page.request, orderId);
  await page.getByRole("button", { name: "Print receipt" }).click();
  await page.getByRole("button", { name: "Print receipt" }).click();
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(2); // the page was reloaded: counter reset, then two prints
  await page.reload();
  expect(await page.getByRole("article", { name: /^Receipt / }).innerText()).toBe(text);
  expect((await page.getByTestId("invoice-number").innerText()).trim()).toBe(invoice);
  const after = await order(page.request, orderId);
  expect(after.payments).toEqual(before.payments);
  expect(after.kots).toEqual(before.kots);
  expect(after.status).toBe("PAID");
});
