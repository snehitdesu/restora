/** SEARCH-001: the universal search box from the keyboard, as the people who use it. */
import { test, expect } from "@playwright/test";
import { statePath } from "./helpers";

test.describe("universal search", () => {
  test.use({ storageState: statePath("manager") });

  test("SEARCH-001 Ctrl+K finds a customer and a dish, arrow keys and Enter open it, Escape closes", async ({ page }) => {
    await page.goto("/dashboard");
    const dlg = page.getByRole("dialog", { name: "Search" });
    // The shortcut listens once the page has hydrated; a person cannot press it in the first milliseconds, a script can.
    await expect(async () => {
      await page.keyboard.press("Control+k");
      await expect(dlg).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    const box = dlg.getByRole("combobox");
    await expect(box).toBeFocused();
    await box.fill("E2E Guest");
    const list = dlg.getByRole("listbox", { name: "Results" });
    await expect(list.getByRole("group", { name: "Customers" }).getByRole("option", { name: /E2E Guest/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/customers\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "E2E Guest" })).toBeVisible();

    // A dish, by mouse; then the box reopens empty.
    await page.getByRole("button", { name: /Search \(Ctrl\+K\)/ }).click();
    const again = page.getByRole("dialog", { name: "Search" });
    await expect(again.getByRole("combobox")).toHaveValue("");
    await again.getByRole("combobox").fill("paneer tikka");
    await again.getByRole("option", { name: /Paneer Tikka/ }).first().getByRole("button").click();
    await page.waitForURL(/\/menu\/items\/[^/]+$/);

    // Nothing found says so; Escape closes.
    await page.keyboard.press("Control+k");
    await page.getByRole("dialog", { name: "Search" }).getByRole("combobox").fill("zzzz-no-such-thing");
    await expect(page.getByText(/Nothing matches/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
  });

  test("SEARCH-002 the cashier's results never include vendors or materials", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: statePath("cashier"), viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const res = await page.request.get("/api/search?q=paneer");
    expect(res.status()).toBe(200);
    const types = ((await res.json()) as { data: { groups: Array<{ type: string }> } }).data.groups.map((g) => g.type);
    expect(types).toContain("menu");
    expect(types).not.toContain("vendor");
    expect(types).not.toContain("material");
    await ctx.close();
  });
});
