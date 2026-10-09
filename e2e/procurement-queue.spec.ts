/**
 * PROC-Q-001 the procurement queue through the real production build: a submitted purchase order and a submitted indent
 * appear together under "Needs approval" with a count; approving from the row moves the purchase order out of the tab
 * (approved, with who and when on the document); the tabs and the kind filter ask the server again.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, materialByName, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36);

test.describe("procurement queue (desktop)", () => {
  test.use({ storageState: statePath("manager") });

  test("PROC-Q-001 one queue for orders and indents; approve from the row", async ({ page }) => {
    const owner = await apiAs("owner");
    const central = await outletByCode(owner, CENTRAL);
    const cashew = await materialByName(owner, "Cashew");
    const vendors = await apiData<{ items: Array<{ id: string; name: string }> }>(owner, "/api/master/vendors?take=200");
    const vendor = vendors.items.find((v) => v.name === "Karachi Bakery Supplies")!;

    const po = await apiCall<{ id: string; number: string }>(owner, "POST", "/api/procurement/purchase-orders", { outletId: central.id, vendorId: vendor.id, notes: `Queue ${RUN}`, lines: [{ materialId: cashew.id, qty: 3, rate: 800 }] }, { "idempotency-key": `queue-po-${RUN}` });
    expect(po.status, JSON.stringify(po.body?.error)).toBe(200);
    expect((await apiCall(owner, "POST", `/api/procurement/purchase-orders/${po.body!.data.id}/transition`, { to: "SUBMITTED" })).status).toBe(200);
    const indent = await apiCall<{ id: string; number: string }>(owner, "POST", "/api/procurement/indents", { outletId: central.id, lines: [{ materialId: cashew.id, qty: 1 }] });
    expect(indent.status, JSON.stringify(indent.body?.error)).toBe(200);
    expect((await apiCall(owner, "POST", `/api/procurement/indents/${indent.body!.data.id}/transition`, { to: "SUBMITTED" })).status).toBe(200);

    await page.goto("/procurement/queue");
    await expect(page.getByRole("tab", { name: /^Needs approval · \d+$/ })).toHaveAttribute("aria-selected", "true");
    const table = page.getByRole("table", { name: "Procurement queue" });
    const poRow = table.getByRole("row").filter({ hasText: po.body!.data.number });
    const indentRow = table.getByRole("row").filter({ hasText: indent.body!.data.number });
    await expect(poRow).toContainText("Purchase order");
    await expect(poRow).toContainText("₹2,400.00");
    await expect(indentRow).toContainText("Indent");

    await poRow.getByRole("button", { name: "Approve" }).click();
    const dlg = page.getByRole("dialog", { name: `Approve ${po.body!.data.number}?` });
    await expect(dlg).toContainText("₹2,400.00");
    await dlg.getByRole("button", { name: "Approve" }).click();
    await expect(poRow).toHaveCount(0);
    const approved = await apiData<{ status: string; approvedAt: string | null }>(owner, `/api/procurement/purchase-orders/${po.body!.data.id}`);
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedAt).not.toBeNull();

    // The approved order now lives under In progress; the indent is still waiting.
    await page.getByRole("tab", { name: /^In progress/ }).click();
    await expect(table.getByRole("row").filter({ hasText: po.body!.data.number })).toBeVisible();
    await page.getByRole("tab", { name: /^Needs approval/ }).click();
    await expect(table.getByRole("row").filter({ hasText: indent.body!.data.number })).toBeVisible();
    await page.getByRole("combobox").selectOption("purchase-order");
    await expect(table.getByRole("row").filter({ hasText: indent.body!.data.number })).toHaveCount(0);
    await owner.dispose();
  });
});
