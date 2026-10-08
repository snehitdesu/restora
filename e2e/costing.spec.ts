/**
 * Group 4 through the real screens (production build, real API + DB):
 *  - G4-ME-001 the manager opens menu engineering for this month: the table of
 *    dishes (or, without enough data, the reason) and a CSV through the export
 *    endpoint
 *  - G4-SP-001 the manager opens the supplier price board, a material's quotes
 *    and its purchase price history
 *  - G4-MX-001 the stock matrix: departments across the top; the kitchen sees
 *    no rupee value
 *  - G4-LB-001 the kitchen picks a material, gets a QR label carrying the SKU,
 *    and scanning (typing) the label code shows the stock
 */
import { test, expect } from "@playwright/test";
import { statePath } from "./helpers";

test.describe("costing and inventory (group 4) — manager", () => {
  test.use({ storageState: statePath("manager") });

  test("G4-ME-001 menu engineering: verdicts or the reason there are none, and a CSV", async ({ page }) => {
    await page.goto("/analytics/menu-engineering");
    await expect(page.getByRole("heading", { name: "Menu engineering" })).toBeVisible();
    const table = page.getByRole("table", { name: "Menu engineering by dish" });
    await expect(table.or(page.getByText("Not enough data to classify the menu"))).toBeVisible();
    const download = page.waitForEvent("download");
    const exported = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/exports");
    await page.getByRole("button", { name: /Download CSV/ }).click();
    expect((await exported).status()).toBe(200);
    expect((await download).suggestedFilename()).toMatch(/^menu_engineering-.*\.csv$/);
  });

  test("G4-SP-001 supplier prices: quotes per base unit and the purchase price history", async ({ page }) => {
    await page.goto("/procurement/prices");
    const table = page.getByRole("table", { name: "Supplier price comparison" });
    await expect(table).toBeVisible();
    await table.getByText("Basmati Rice").click();
    const dialog = page.getByRole("dialog", { name: "Basmati Rice" });
    await expect(dialog.getByRole("table", { name: "Vendor quotes for Basmati Rice" })).toBeVisible();
    await expect(dialog.getByRole("table", { name: "Price history for Basmati Rice" }).or(dialog.getByText("Nothing received at this outlet yet."))).toBeVisible();
  });

  test("G4-MX-001 stock matrix: every department across the top, with values for the manager", async ({ page }) => {
    await page.goto("/inventory/matrix");
    const table = page.getByRole("table", { name: "Stock by department" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Value" })).toBeVisible();
    await expect(table.getByText("Basmati Rice")).toBeVisible();
  });
});

test.describe("costing and inventory (group 4) — kitchen", () => {
  test.use({ storageState: statePath("kitchen") });

  test("G4-MX-002 the kitchen's stock matrix has quantities only", async ({ page }) => {
    await page.goto("/inventory/matrix");
    await expect(page.getByRole("table", { name: "Stock by department" })).toBeVisible();
    expect(await page.locator("#main").innerText()).not.toMatch(/₹/);
  });

  test("G4-LB-001 print a QR label and scan it back", async ({ page }) => {
    await page.goto("/inventory/labels");
    await page.getByPlaceholder("Name or SKU").fill("Basmati");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("checkbox", { name: /Basmati Rice/ }).check();
    await expect(page.getByRole("img", { name: "Stock label GR-RICE" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print 1 label" })).toBeEnabled();
    await page.getByLabel("Label code or SKU").fill("RESTORA-STOCK:GR-RICE");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByText(/on hand/)).toBeVisible();
    expect(await page.locator("#main").innerText()).not.toMatch(/₹/);
  });
});
