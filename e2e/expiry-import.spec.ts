/**
 * EXPIRY-001 stock that is about to expire, with batch number and FSSAI lot code, through the real production build.
 * IMPORT-001 a spreadsheet of materials is checked (nothing saved), imported, and imported again (nothing duplicated); a file
 * with a bad line cannot be imported.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, materialByName, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36);

test.describe("expiry (desktop)", () => {
  test.use({ storageState: statePath("manager") });

  test("EXPIRY-001 a received batch shows up with its lot code, expiry and 'use first'", async ({ page }) => {
    const owner = await apiAs("owner");
    const central = await outletByCode(owner, CENTRAL);
    const cashew = await materialByName(owner, "Cashew");
    const vendors = await apiData<{ items: Array<{ id: string; name: string }> }>(owner, "/api/master/vendors?take=200");
    const vendor = vendors.items.find((v) => v.name === "Karachi Bakery Supplies")!;
    const expires = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const grn = await apiCall<{ id: string }>(owner, "POST", "/api/procurement/grns", { outletId: central.id, vendorId: vendor.id, lines: [{ materialId: cashew.id, qty: 2, rate: 800, batchNo: `EXP-${RUN}`, expiryDate: expires, fssaiLot: `LOT-${RUN}` }] }, { "idempotency-key": `exp-grn-${RUN}` });
    expect(grn.status, JSON.stringify(grn.body?.error)).toBe(200);
    expect((await apiCall(owner, "POST", `/api/procurement/grns/${grn.body!.data.id}/post`)).status).toBe(200);

    await page.goto("/inventory/expiry");
    const table = page.getByRole("table", { name: "Expiring batches" });
    const row = table.getByRole("row").filter({ hasText: `EXP-${RUN}` });
    await expect(row).toContainText("Cashew");
    await expect(row).toContainText(`LOT-${RUN}`);
    await expect(row).toContainText(/in [23] days/);
    await expect(page.getByText(/assuming the earliest expiry is used first/)).toBeVisible();

    // A shorter window leaves it out; the server is asked again.
    await page.getByRole("combobox").selectOption("3");
    await expect(table.getByRole("row").filter({ hasText: `EXP-${RUN}` })).toBeVisible();
    await owner.dispose();
  });
});

test.describe("import (desktop)", () => {
  test.use({ storageState: statePath("owner") });

  test("IMPORT-001 check, import, import again; a bad line blocks the file", async ({ page }) => {
    const owner = await apiAs("owner");
    const units = await apiData<Array<{ code: string; kind: string }>>(owner, "/api/master/units");
    const unit = units.find((u) => u.kind === "WEIGHT")!.code;
    const a = `IMP-${RUN}-A`;
    const b = `IMP-${RUN}-B`;
    const csv = `Name,SKU,Brand,Category,Unit\nImported Alpha ${RUN},${a},Brandy,Import ${RUN},${unit}\nImported Beta ${RUN},${b},,Import ${RUN},${unit}\n`;

    await page.goto("/master/materials");
    await page.getByRole("button", { name: "Import" }).click();
    const dlg = page.getByRole("dialog", { name: "Import materials" });
    await dlg.getByLabel(/Or paste the rows/).fill(csv);
    await dlg.getByRole("button", { name: "Check file" }).click();
    await expect(dlg.getByTestId("import-summary")).toContainText("Checked: 2 to create, 0 already there, 0 with errors.");
    await expect(dlg).toContainText(`New categories: Import ${RUN}`);
    expect((await apiData<{ items: unknown[] }>(owner, `/api/master/materials?search=${a}`)).items).toHaveLength(0); // checking saves nothing
    await dlg.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(dlg.getByTestId("import-summary")).toContainText("Imported: 2 to create");
    await dlg.getByRole("button", { name: "Close" }).click();
    await expect(dlg).toBeHidden();
    await page.getByPlaceholder(/Search name, brand or SKU/).fill(`Imported Alpha ${RUN}`);
    const row = page.getByRole("table", { name: "Materials" }).getByRole("row").filter({ hasText: `Imported Alpha ${RUN}` });
    await expect(row).toContainText("Brandy");
    await expect(row).toContainText(`Import ${RUN}`);
    expect((await apiData<{ items: unknown[] }>(owner, `/api/master/materials?search=IMP-${RUN}`)).items).toHaveLength(2);

    // The same file again changes nothing.
    await page.getByRole("button", { name: "Import" }).click();
    const again = page.getByRole("dialog", { name: "Import materials" });
    await again.getByLabel(/Or paste the rows/).fill(csv);
    await again.getByRole("button", { name: "Check file" }).click();
    await expect(again.getByTestId("import-summary")).toContainText("Checked: 0 to create, 2 already there, 0 with errors.");
    await expect(again.getByRole("button", { name: "Import" })).toBeDisabled();

    // One bad line: nothing can be imported until it is fixed.
    await again.getByLabel(/Or paste the rows/).fill(`Name,SKU,Unit\nGood ${RUN},IMP-${RUN}-C,${unit}\nBad ${RUN},IMP-${RUN}-D,furlongs\n`);
    await again.getByRole("button", { name: "Check file" }).click();
    await expect(again.getByTestId("import-summary")).toContainText("1 to create, 0 already there, 1 with errors");
    await expect(again).toContainText("furlongs");
    await expect(again.getByRole("button", { name: "Import" })).toBeDisabled();
    expect((await apiData<{ items: unknown[] }>(owner, `/api/master/materials?search=IMP-${RUN}-C`)).items).toHaveLength(0);
    await owner.dispose();
  });
});
