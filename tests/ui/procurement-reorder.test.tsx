// @vitest-environment jsdom
/**
 * Group 2 reorder screen in a DOM (GET /api/procurement/reorder mocked):
 * vendor grouping, draft visibility, only eligible vendors offered, pack hint,
 * permission-gated actions, the PO / request bodies (Idempotency-Key, asOf,
 * expectedIncoming, purchase unit), the 409 banner, and the nav entry.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReorderScreen, type ReorderData, type ReorderRow } from "@/features/backoffice/reorder";
import { navFor, NAV_ITEMS } from "@/lib/nav";
import { state, installFetch, teardown, renderAs, posts, fail, setValue, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/procurement/reorder" }));

beforeEach(installFetch);
afterEach(teardown);

const AS_OF = "2026-10-08T04:00:00.000Z";
const row = (o: Partial<ReorderRow> & Pick<ReorderRow, "materialId" | "name">): ReorderRow => ({
  sku: `SKU-${o.materialId}`, category: null, baseUnitId: "kg", baseUnit: "kg", priority: "NORMAL", reasons: ["BELOW_REORDER_POINT"],
  onHand: 2, onHandClamped: 2, incoming: 0, incomingDocs: [], includesDrafts: false, position: 2, safetyStock: 0, reorderLevel: 5, parLevel: 10,
  reorderPoint: 5, target: 10, usedInWindow: 14, observedDays: 14, avgDailyUse: 1, daysOfCover: 2, stockoutDate: null, historyStatus: "OK", leadTimeDays: 1,
  suggestedBaseQty: 8, order: { unitId: "kg", unitCode: "kg", qty: 8, packFactor: null }, vendor: null, blockedVendorNote: null, alternatives: [],
  unitCost: 10, costSource: "AVG_COST", estimatedValue: 80, poRate: 10, departments: [], ...o,
});
const paneer = row({
  materialId: "m-paneer", name: "Paneer", priority: "CRITICAL", reasons: ["OUT_OF_STOCK", "BELOW_REORDER_POINT", "STOCKOUT_BEFORE_DELIVERY"], onHand: 0, onHandClamped: 0,
  suggestedBaseQty: 24, order: { unitId: "case", unitCode: "case", qty: 2, packFactor: 12 }, poRate: 1200, estimatedValue: 2280,
  vendor: { id: "v-fresh", name: "Fresh Dairy", rate: 100, leadTimeDays: 2, selectedBecause: "LOWEST_RATE" },
  blockedVendorNote: "Milky Way is awaiting approval",
  alternatives: [{ vendorId: "v-fresh", name: "Fresh Dairy", rate: 100, leadTimeDays: 2, estimatedValue: 2400 }, { vendorId: "v-city", name: "City Dairy", rate: 110, leadTimeDays: 1, estimatedValue: 2640 }],
});
const rice = row({
  materialId: "m-rice", name: "Rice", incoming: 3, includesDrafts: true, reasons: ["BELOW_REORDER_POINT", "PARTLY_ON_ORDER", "INCLUDES_DRAFTS"],
  incomingDocs: [{ type: "PO", id: "po-7", number: "PO-0007", status: "DRAFT", qty: 3, draft: true }],
  vendor: { id: "v-grain", name: "Grain Co", rate: 40, leadTimeDays: 1, selectedBecause: "ONLY_ELIGIBLE" },
  alternatives: [{ vendorId: "v-grain", name: "Grain Co", rate: 40, leadTimeDays: 1, estimatedValue: 200 }], suggestedBaseQty: 5, order: { unitId: "kg", unitCode: "kg", qty: 5, packFactor: null }, poRate: 40,
});
const salt = row({ materialId: "m-salt", name: "Salt", reasons: ["BELOW_REORDER_POINT", "NO_VENDOR", "PREFERRED_VENDOR_BLOCKED"], blockedVendorNote: "Salty Ltd is blacklisted" });
const data = (): ReorderData => ({
  outletId: OUT_A, asOf: AS_OF, lookbackDays: 14, rows: [paneer, rice, salt],
  needsSetup: [{ materialId: "m-oil", sku: "OIL", name: "Oil", reason: "NO_REORDER_SETTINGS", usedInWindow: 9, onHand: 1, blockedVendorNote: null }],
  coveredByDrafts: [{ materialId: "m-sugar", sku: "SUG", name: "Sugar", baseUnit: "kg", onHand: 0, reorderPoint: 5, incoming: 10, draftIncoming: 10, drafts: [{ type: "INDENT", id: "ind-3", number: "IND-0003", status: "DRAFT", qty: 10, draft: true }] }],
  summary: { items: 3, critical: 1, high: 0, normal: 2, budget: 2440, noVendor: 1, includesDrafts: 1, coveredByDrafts: 1, byVendor: [] },
});
const base = (extra: Record<string, (c: never) => unknown> = {}) => ({
  "GET /api/procurement/reorder": () => data(),
  "GET /api/master/departments": () => [{ id: "d-k", name: "Kitchen", kind: "KITCHEN", active: true, outletId: OUT_A }],
  ...extra,
});

describe("reorder screen", () => {
  it("groups by vendor (no-vendor last), shows drafts with number/status/qty and the blocked-vendor note", async () => {
    state.routes = base();
    renderAs(<ReorderScreen />, ["purchase.view", "purchase.create"]);
    const groups = await screen.findAllByRole("region");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Vendor Fresh Dairy", "Vendor Grain Co", "No eligible vendor"]);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Includes draft documents");
    expect(within(note).getByRole("list", { name: "Covered only by draft documents" })).toHaveTextContent("Sugar");
    expect(within(note).getByRole("link", { name: "IND-0003" })).toHaveAttribute("href", "/procurement/indents/ind-3");
    const incoming = screen.getByRole("list", { name: "Incoming documents for Rice" });
    expect(incoming).toHaveTextContent("PO-0007 · DRAFT · 3");
    expect(within(incoming).getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Milky Way is awaiting approval")).toBeInTheDocument();
    const call = state.calls.find((c) => c.path === "/api/procurement/reorder")!;
    expect(call.query.get("outletId")).toBe(OUT_A);
    expect(call.query.get("lookbackDays")).toBe("14");
  });

  it("offers only the server's eligible vendors; a pack line shows its base quantity", async () => {
    state.routes = base();
    renderAs(<ReorderScreen />, ["purchase.view", "purchase.create"]);
    const vendorSelect = await screen.findByLabelText("Vendor for Paneer");
    expect([...(vendorSelect as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "v-fresh", "v-city"]);
    expect(screen.queryByLabelText("Vendor for Salt")).toBeNull();
    expect(screen.getByText("= 24 kg")).toBeInTheDocument();
    setValue(screen.getByLabelText("Order quantity for Paneer"), "3");
    expect(await screen.findByText("= 36 kg")).toBeInTheDocument();
  });

  it("read-only without purchase.create: no checkboxes, inputs or raise buttons", async () => {
    state.routes = base();
    renderAs(<ReorderScreen />, ["purchase.view"]);
    await screen.findAllByRole("region");
    expect(screen.queryByRole("button", { name: /Raise purchase/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText("Order quantity for Paneer")).toBeNull();
  });

  it("raises one DRAFT PO per vendor with asOf, purchase unit, rate and expectedIncoming; rows without a vendor are left out", async () => {
    state.routes = base({ "POST /api/procurement/reorder/purchase-orders": () => ({ purchaseOrders: [{ id: "po-1", number: "PO-0101", vendorId: "v-fresh", total: "2400" }, { id: "po-2", number: "PO-0102", vendorId: "v-grain", total: "200" }], replayed: false }) });
    renderAs(<ReorderScreen />, ["purchase.view", "purchase.create"]);
    await userEvent.click(await screen.findByRole("button", { name: "Raise purchase orders (2)" }));
    const dlg = await screen.findByRole("dialog", { name: "Raise purchase orders" });
    expect(within(dlg).getByRole("table", { name: "Purchase orders to create" })).toHaveTextContent("Fresh Dairy");
    expect(dlg).toHaveTextContent("1 selected item has no vendor");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create 2 draft POs" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const [sent] = posts();
    expect(sent.path).toBe("/api/procurement/reorder/purchase-orders");
    expect(sent.headers["Idempotency-Key"]).toMatch(/^reorder-po-/);
    expect(sent.body).toEqual({
      outletId: OUT_A, asOf: AS_OF, lookbackDays: 14,
      lines: [
        { materialId: "m-paneer", vendorId: "v-fresh", qty: 2, unitId: "case", rate: 1200, expectedIncoming: 0 },
        { materialId: "m-rice", vendorId: "v-grain", qty: 5, unitId: "kg", rate: 40, expectedIncoming: 3 },
      ],
    });
    const banner = (await screen.findAllByRole("status")).find((el) => el.textContent?.includes("Raised as drafts"))!;
    expect(within(banner).getByRole("link", { name: "PO-0101" })).toHaveAttribute("href", "/procurement/purchase-orders/po-1");
  });

  it("a stale screen (409) shows a banner with Reload; the purchase request carries the department", async () => {
    let n = 0;
    state.routes = base({
      "POST /api/procurement/reorder/indents": () => (++n === 1 ? fail(409, "ConflictError", "Rice was ordered since you loaded this screen (PO-0009). Reload the reorder screen.") : { indent: { id: "ind-9", number: "IND-0009" }, replayed: false }),
    });
    renderAs(<ReorderScreen />, ["purchase.view", "purchase.create"]);
    await userEvent.click(await screen.findByLabelText("Include Paneer"));
    await userEvent.click(screen.getByRole("button", { name: "Raise purchase request (2)" }));
    const dlg = await screen.findByRole("dialog", { name: "Raise purchase request" });
    await userEvent.selectOptions(await within(dlg).findByLabelText(/Requesting department/), "d-k");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create draft request" }));
    // The dialog shows the server's message, and the screen keeps a banner with Reload.
    await waitFor(() => expect(screen.getAllByRole("alert").some((el) => within(el).queryByRole("button", { name: "Reload" }))).toBe(true));
    const banner = screen.getAllByRole("alert").find((el) => within(el).queryByRole("button", { name: "Reload" }))!;
    expect(banner).toHaveTextContent(/Rice was ordered since you loaded this screen \(PO-0009\)/);
    const sent = posts()[0];
    expect(sent.body).toMatchObject({ outletId: OUT_A, asOf: AS_OF, departmentId: "d-k", lines: [{ materialId: "m-rice", qty: 5, unitId: "kg", expectedIncoming: 3 }, { materialId: "m-salt", qty: 8, unitId: "kg", expectedIncoming: 0 }] });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^reorder-ind-/);
  });

  it("Needs setup lists items without levels with a link to set them", async () => {
    state.routes = base();
    renderAs(<ReorderScreen />, ["purchase.view"]);
    await userEvent.click(await screen.findByRole("tab", { name: "Needs setup (1)" }));
    const t = screen.getByRole("table", { name: "Needs setup" });
    expect(t).toHaveTextContent("Oil");
    expect(within(t).getByRole("link", { name: /Set levels/ })).toHaveAttribute("href", "/master/materials/m-oil");
  });

  it("nav: Reorder is the first Purchasing entry, gated by purchase.view", () => {
    expect(navFor("/procurement/reorder")).toMatchObject({ permission: "purchase.view" });
    expect(NAV_ITEMS.filter((i) => i.section === "Purchasing")[0].href).toBe("/procurement/reorder");
  });
});
