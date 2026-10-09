/**
 * PURCH-RULES-001 purchasing approval rules through the real production build: the owner sets a small-order and a large-order
 * limit (after confirming their password); a small order approves itself on submission; a large order needs two different
 * approvers, one of whom reviews the lines first (a quantity is cut, the original kept in view), and the first approver cannot
 * give the second approval. The rules are cleared at the end so no other spec is affected.
 */
import { test, expect } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, materialByName, confirmPasswordIfPrompted, toast, PASSWORD, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36);
type Rules = { autoApproveBelow: number | null; dualApprovalAtOrAbove: number | null };

test.describe("purchasing rules (desktop)", () => {
  test("PURCH-RULES-001 small orders approve themselves; large orders need two approvers", async ({ browser }) => {
    const ownerCtx = await browser.newContext({ storageState: statePath("owner"), viewport: { width: 1440, height: 900 } });
    const managerCtx = await browser.newContext({ storageState: statePath("manager"), viewport: { width: 1440, height: 900 } });
    const owner = await apiAs("owner");
    const ownerPage = await ownerCtx.newPage();
    const managerPage = await managerCtx.newPage();
    try {
      // 1. The owner sets the rules in the app; the password is asked for.
      await ownerPage.goto("/settings/purchasing");
      const auto = ownerPage.getByLabel(/Approve small orders automatically/);
      await expect(auto).toBeVisible();
      await auto.fill("300");
      await ownerPage.getByLabel(/Need two approvers from/).fill("3000");
      await expect(ownerPage.getByRole("list", { name: "What this means" })).toContainText("Orders in between");
      await ownerPage.getByRole("button", { name: "Save rules" }).click();
      await confirmPasswordIfPrompted(ownerPage, toast(ownerPage, "Purchasing rules saved"));
      expect(await apiData<Rules>(owner, "/api/procurement/rules")).toEqual({ autoApproveBelow: 300, dualApprovalAtOrAbove: 3000 });

      const central = await outletByCode(owner, CENTRAL);
      const cashew = await materialByName(owner, "Cashew");
      const vendors = await apiData<{ items: Array<{ id: string; name: string }> }>(owner, "/api/master/vendors?take=200");
      const vendor = vendors.items.find((v) => v.name === "Karachi Bakery Supplies")!;
      const make = async (qty: number, rate: number, key: string) => {
        const po = await apiCall<{ id: string; number: string }>(owner, "POST", "/api/procurement/purchase-orders", { outletId: central.id, vendorId: vendor.id, notes: `Rules ${RUN}`, lines: [{ materialId: cashew.id, qty, rate }] }, { "idempotency-key": `rules-${key}-${RUN}` });
        expect(po.status, JSON.stringify(po.body?.error)).toBe(200);
        expect((await apiCall(owner, "POST", `/api/procurement/purchase-orders/${po.body!.data.id}/transition`, { to: "SUBMITTED" })).status).toBe(200);
        return po.body!.data;
      };

      // 2. A small order (₹200) approves itself when it is submitted.
      const small = await make(1, 200, "small");
      await managerPage.goto(`/procurement/purchase-orders/${small.id}`);
      await expect(managerPage.getByTestId("approval-note")).toContainText("Approved automatically");
      await expect(managerPage.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
      expect((await apiData<{ status: string }>(owner, `/api/procurement/purchase-orders/${small.id}`)).status).toBe("APPROVED");

      // 3. A large order (₹8,000) waits. The manager reviews the lines, cutting the quantity; ₹4,000 is still above the limit.
      const large = await make(10, 800, "large");
      await managerPage.goto(`/procurement/purchase-orders/${large.id}`);
      await expect(managerPage.getByTestId("approval-note")).toContainText("needs two different approvers");
      await managerPage.getByRole("button", { name: "Review lines" }).click();
      const review = managerPage.getByRole("dialog", { name: `Review PO ${large.number}` });
      const qty = review.getByLabel("Quantity of Cashew");
      await qty.fill("5");
      await expect(review).toContainText("1 change; 1 line stays on the order.");
      await review.getByRole("button", { name: "Save review" }).click();
      await expect(review).toBeHidden();
      const lines = managerPage.getByRole("table", { name: "PO lines" });
      await expect(lines).toContainText("was 10");
      expect(Number((await apiData<{ total: string }>(owner, `/api/procurement/purchase-orders/${large.id}`)).total)).toBe(4000);

      // 4. The manager gives the first approval; the second must be somebody else.
      await managerPage.getByRole("button", { name: "Approve (1 of 2)" }).click();
      await expect(toast(managerPage, "First approval recorded")).toBeVisible();
      await expect(managerPage.getByTestId("approval-note")).toContainText("(you); a second approver has to give the other");
      await expect(managerPage.getByRole("button", { name: /^Approve/ })).toHaveCount(0);
      expect((await apiData<{ status: string }>(owner, `/api/procurement/purchase-orders/${large.id}`)).status).toBe("SUBMITTED");
      const sameAgain = await apiCall(await apiAs("manager"), "POST", `/api/procurement/purchase-orders/${large.id}/transition`, { to: "APPROVED" });
      expect(sameAgain.status).toBeGreaterThanOrEqual(400); // the server refuses the same person twice, whatever the screen shows

      // 5. The owner is the second approver; the order is then approved, and the note names both.
      await ownerPage.goto(`/procurement/purchase-orders/${large.id}`);
      await expect(ownerPage.getByTestId("approval-note")).toContainText("gave the first approval");
      await ownerPage.getByRole("button", { name: "Approve (2 of 2)" }).click();
      await expect(toast(ownerPage, "Approved")).toBeVisible();
      await expect(ownerPage.getByTestId("approval-note")).toContainText(/Approved by .+ and .+/);
      expect((await apiData<{ status: string }>(owner, `/api/procurement/purchase-orders/${large.id}`)).status).toBe("APPROVED");
    } finally {
      // Leave no rules behind: other specs approve orders with a single approver.
      expect((await apiCall(owner, "POST", "/api/auth/reauth", { password: PASSWORD, scope: "settings.manage" })).status).toBe(200);
      await apiCall(owner, "POST", "/api/procurement/rules", { autoApproveBelow: null, dualApprovalAtOrAbove: null });
      await ownerCtx.close();
      await managerCtx.close();
      await owner.dispose();
    }
  });
});
