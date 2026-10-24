/**
 * The restaurant's common QR in real browsers (docs/common-qr-ordering.md):
 *   MANAGER : issues the restaurant QR (one code for every table)
 *   GUEST   : scans it on a phone -> "Sit anywhere" -> orders and pays online without choosing a table
 *   CASHIER : POS -> Open orders -> QR tables -> the order shows "no table yet" -> assigns a table
 * Every step is checked against the server. The payment uses the development
 * (mock) gateway of this disposable deployment, verified by the server as usual.
 */
import { test, expect, type Browser } from "@playwright/test";
import { statePath, outletByCode, order, openPos, apiAs, apiCall, CENTRAL } from "./helpers";

test.use({ storageState: statePath("cashier") });

type TableRow = { id: string; code: string; status: string };

async function guestPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); // no session cookie
  return { context, page: await context.newPage() };
}

test.describe("common restaurant QR", () => {
  test("CQR-001 one code for every table: order and pay without a table, staff assign it", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const manager = await apiAs("manager");
    const issued = await apiCall<{ qrToken: string }>(manager, "POST", `/api/master/outlets/${outlet.id}/common-qr`);
    expect(issued.status).toBe(200);
    const token = issued.body!.data.qrToken;

    try {
      // ---- GUEST: no table anywhere, and nothing asks for one.
      const guest = await guestPhone(browser);
      const g = guest.page;
      await g.goto(`/t/${token}`);
      await expect(g.getByLabel("Sit anywhere")).toBeVisible();
      await g.getByRole("button", { name: "Add Paneer Tikka" }).click();
      await g.getByRole("link", { name: /^View cart/ }).click();
      await g.waitForURL(/\/cart$/);
      await expect(g.getByText(/Sit anywhere · 1 item/)).toBeVisible();
      await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
      await g.waitForURL(/\/checkout$/);
      await expect(g.getByTestId("sit-anywhere-hint")).toBeVisible();
      await g.getByRole("radio", { name: /Pay online|Simulated online payment/ }).check();
      const placed = g.waitForResponse((r) => r.request().method() === "POST" && /\/api\/qr\/t\/.+\/orders$/.test(r.url()));
      await g.getByRole("button", { name: /^Place order/ }).click();
      expect((await placed).status()).toBe(200);
      await g.waitForURL(/\/o\/[^/#]+#k=/);
      const orderId = decodeURIComponent(new URL(g.url()).pathname.split("/").pop()!);

      let o = await order(page.request, orderId);
      expect(o).toMatchObject({ status: "OPEN", channel: "QR", tableId: null });
      expect(o.kots ?? []).toHaveLength(0);

      // ---- GUEST pays; the server-verified payment sends it to the kitchen, still with no table.
      // The test gateway opens on the order page by itself (as in QR-001).
      await g.getByRole("region", { name: "Test payment gateway" }).getByRole("button", { name: "Approve payment" }).click();
      await expect(g.getByText("Payment successful. Thank you!")).toBeVisible();
      o = await order(page.request, orderId);
      expect(o).toMatchObject({ status: "PAID", tableId: null });
      expect(o.kots).toHaveLength(1);
      await guest.context.close();

      // ---- CASHIER: the order waits under QR tables as "no table yet"; assign one.
      // A table of its own: the seeded tables belong to other specs, which count the orders on them.
      const made = await apiCall<TableRow>(manager, "POST", "/api/master/tables", { outletId: outlet.id, code: `CQR${Date.now().toString(36).slice(-5).toUpperCase()}`, capacity: 2 });
      expect(made.status).toBe(200);
      const target = made.body!.data;
      await openPos(page);
      await page.getByRole("button", { name: /^Open orders/ }).click();
      const dialog = page.getByRole("dialog", { name: "Open orders" });
      await dialog.getByRole("tab", { name: "QR tables" }).click();
      const ref = orderId.slice(-6).toUpperCase();
      const row = dialog.getByTestId("qr-table-row").filter({ hasText: `#${ref}` });
      await expect(row).toContainText(/no table yet/i);
      await row.getByRole("button", { name: `Assign a table to order ${ref}` }).click();
      await page.getByRole("dialog", { name: "Choose table" }).getByRole("button", { name: new RegExp(`^Table ${target.code},`) }).click();
      await expect(dialog.getByTestId("qr-table-row").filter({ hasText: `#${ref}` })).toContainText(`Table ${target.code}`);
      expect((await order(page.request, orderId)).tableId).toBe(target.id);
    } finally {
      // Leave the shared E2E database as other specs expect it: no restaurant QR issued.
      await apiCall(manager, "POST", `/api/master/outlets/${outlet.id}/common-qr/revoke`);
      await manager.dispose();
    }
  });
});
