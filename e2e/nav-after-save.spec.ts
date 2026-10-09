/**
 * Regression: a client navigation that starts right after a page load must commit.
 *
 * With a route-level `loading.tsx` under (app), Next 15.5's router sometimes left a navigation unrendered
 * (the URL never changed although the server had answered and the router's own promise had settled):
 * about 1 in 10 saves of a create dialog, and the same for a bare `router.push`. Each case below repeats
 * the flow 30 times from a fresh page load; the broken build fails at least once in 98% of runs
 * (measured: 11 of 105 stalls for the bare push, 13 of 125 for the dialog). See
 * docs/stabilization-report.md section 4 and tests/ui/no-loading-boundary.test.ts.
 */
import { test, expect } from "@playwright/test";
import { statePath, materialByName } from "./helpers";

test.use({ storageState: statePath("manager") });

const ROUNDS = 30;

test.describe("navigation commits after a page load", () => {
  test("NAV-001 saving a create dialog lands on the new document, every time", async ({ page }) => {
    test.setTimeout(240_000);
    const tomato = await materialByName(page.request, "Tomato");
    for (let i = 0; i < ROUNDS; i++) {
      await page.goto("/inventory/wastage");
      await page.getByRole("button", { name: "Record wastage" }).click();
      const dlg = page.getByRole("dialog", { name: "Record wastage" });
      await dlg.getByLabel("Notes").fill(`navigation regression ${i}`);
      await dlg.getByLabel("Line 1 material").selectOption(tomato.id);
      await dlg.getByLabel("Line 1 Qty").fill("1");
      await dlg.getByRole("button", { name: "Save draft" }).click();
      await expect(page, `round ${i + 1}: the new wastage page opens`).toHaveURL(/\/inventory\/wastage\/[^/]+$/, { timeout: 8000 });
    }
  });

  test("NAV-002 a programmatic router.push to a dynamic page commits, every time", async ({ page }) => {
    test.setTimeout(240_000);
    const tomato = await materialByName(page.request, "Tomato");
    for (let i = 0; i < ROUNDS; i++) {
      await page.goto("/inventory/wastage");
      await page.getByRole("button", { name: "Record wastage" }).waitFor();
      await page.waitForTimeout(700); // the window in which the stall used to happen: just after hydration
      await page.evaluate((id) => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(`/inventory/stock/${id}`), tomato.id);
      await expect(page, `round ${i + 1}: the stock page opens`).toHaveURL(/\/inventory\/stock\/[^/]+$/, { timeout: 8000 });
    }
  });
});
