/**
 * Group 3 through the real screens (production build, real API + DB):
 *  - G3-MD-001 today's open orders keep the day from closing (the screen
 *    says why); yesterday, which had no trading in this dataset, is declared
 *    (zero), counted, given a bank deposit (with an Idempotency-Key) and
 *    closed from the screen; the deposit nobody expected becomes a
 *    discrepancy; the closed day refuses a worksheet entry (409) and is
 *    reopened through the real password re-confirmation. Never skipped.
 *  - G3-KP-001 the kitchen records prepared portions and wasted portions on
 *    the dish worksheet and never sees a rupee figure.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiAs, confirmPasswordIfPrompted, CENTRAL } from "./helpers";

type Desk = {
  businessDate: string; status: string; channels: Array<{ key: string; billed: number }>; collections: Array<{ method: string; expected: number }>; blockers: string[];
  bank: { deposited: number }; closes: Array<{ revision: number; status: string; reopenReason: string | null }>;
};

test.describe("money desk (group 3)", () => {
  test.use({ storageState: statePath("manager") });

  test("G3-MD-001 declare -> count -> deposit -> close (locked) -> reopen with password", async ({ page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const deskOf = (date: string) => apiData<Desk>(page.request, `/api/finance/money-desk?outletId=${outlet.id}&businessDate=${date}`);
    await page.goto("/finance/money-desk");
    await expect(page.getByRole("table", { name: "Revenue by channel" })).toBeVisible();
    const dateInput = page.getByLabel("Business date");
    const today = await deskOf(await dateInput.inputValue());

    // Today has the seeded / earlier specs' open orders: the screen says why it cannot close.
    if (today.blockers.length) {
      await expect(page.getByRole("note")).toContainText(today.blockers[0]);
      await expect(page.getByRole("button", { name: "Close day" })).toBeDisabled();
    }

    // Yesterday had no trading in this dataset: declare it, count it, bank it and close it from the screen.
    const [y, m, dd] = today.businessDate.split("-").map(Number);
    const yesterday = new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
    await dateInput.fill(yesterday);
    const day = await deskOf(yesterday);
    expect(day.status).toBe("OPEN");
    const declared = page.getByRole("table", { name: "Revenue by channel" }).getByLabel(/^Declared /);
    await expect(declared.first()).toBeVisible();
    const channelInputs = await declared.count();
    for (let i = 0; i < channelInputs; i++) await declared.nth(i).fill(String(day.channels[i]?.billed ?? 0));
    await page.getByRole("button", { name: "Save declared revenue" }).click();
    await expect(page.getByText("Declared revenue saved")).toBeVisible();
    const counted = page.getByLabel(/^Counted /);
    const countInputs = await counted.count();
    expect(countInputs).toBeGreaterThan(0);
    for (let i = 0; i < countInputs; i++) await counted.nth(i).fill(String(day.collections[i]?.expected ?? 0));
    await page.getByRole("button", { name: "Save counted money" }).click();
    await expect(page.getByText("Counted money saved")).toBeVisible();

    await page.getByRole("button", { name: /Record deposit/ }).click();
    const dlg = page.getByRole("dialog", { name: /reached the bank/ });
    await dlg.getByLabel(/^Amount/).fill("150.75");
    await dlg.getByLabel(/Slip \/ UTR reference/).fill("E2E-SLIP-1");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/finance/money-desk/deposits");
    await dlg.getByRole("button", { name: "Record" }).click();
    expect((await created).request().headers()["idempotency-key"]).toMatch(/^dep-/);
    await expect(page.getByRole("table", { name: "Deposit entries" }).getByText("E2E-SLIP-1")).toBeVisible();

    expect((await deskOf(yesterday)).blockers).toEqual([]);
    await page.getByRole("button", { name: "Close day" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Close day|Confirm/ }).click();
    await expect(page.getByRole("button", { name: "Reopen day" })).toBeVisible();
    const closed = await deskOf(yesterday);
    expect(closed.status).toBe("CLOSED");
    expect(closed.bank.deposited).toBe(150.75);
    // Nothing was expected to bank, so the deposit is a discrepancy raised by the close.
    await expect(page.getByText(/deposited ₹150\.75 vs expected ₹0/)).toBeVisible();

    // Locked: a worksheet entry dated into the closed day is refused.
    const kitchen = await apiAs("kitchen");
    const menu = await (await kitchen.get("/api/menu?activeOnly=true")).json();
    const locked = await kitchen.post("/api/inventory/worksheet", { data: { outletId: outlet.id, businessDate: yesterday, menuItemId: menu.data[0].id, preparedQty: 3 }, headers: { origin: `http://localhost:${process.env.E2E_PORT ?? 3210}` } });
    expect(locked.status()).toBe(409);
    await kitchen.dispose();
    await expect(page.getByLabel(/^Declared /)).toHaveCount(0);

    await page.getByRole("button", { name: "Reopen day" }).click();
    const reopen = page.getByRole("dialog", { name: /Reopen/ });
    await reopen.getByLabel(/Why is the day being reopened/).fill("E2E: reopen to correct the deposit");
    await reopen.getByRole("button", { name: "Reopen day" }).click();
    await confirmPasswordIfPrompted(page, page.getByText("Reopened", { exact: true }).first());
    const reopened = await deskOf(yesterday);
    expect(reopened.status).toBe("REOPENED");
    expect(reopened.closes).toEqual([expect.objectContaining({ revision: 1, status: "REOPENED", reopenReason: "E2E: reopen to correct the deposit" })]);
  });
});

test.describe("dish worksheet (group 3)", () => {
  test.use({ storageState: statePath("kitchen") });

  test("G3-KP-001 the kitchen records prepared and wasted portions and sees no costs", async ({ page }) => {
    await page.goto("/inventory/worksheet");
    const table = page.getByRole("table", { name: "Dish production worksheet" });
    await expect(table.or(page.getByText("Nothing prepared, sold or wasted on this day"))).toBeVisible();
    const add = page.getByLabel("Add a dish to the worksheet");
    const dish = (await add.locator("option").nth(1).innerText()).trim();
    await add.selectOption({ label: dish });
    const prepared = page.getByLabel(`Prepared ${dish}`);
    await prepared.fill("7");
    const saved = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/inventory/worksheet");
    await page.getByRole("button", { name: `Save prepared ${dish}` }).click();
    expect((await saved).status()).toBe(200);
    await page.getByRole("button", { name: `Add wasted ${dish}` }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel(/Portions wasted/).fill("1");
    const wasted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/inventory/worksheet/wastage");
    await dlg.getByRole("button", { name: "Record wasted portions" }).click();
    const res = await wasted;
    expect(res.request().headers()["idempotency-key"]).toMatch(/^wsw-/);
    // A posted loss, or (above the approval threshold) a draft waiting for a manager: both are fine; never a 500.
    expect(res.status()).toBe(200);
    await expect(table.getByRole("row").filter({ hasText: dish })).toBeVisible();
    expect(await page.locator("#main").innerText()).not.toMatch(/₹/);
  });
});
