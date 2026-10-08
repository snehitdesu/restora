// @vitest-environment jsdom
/**
 * Group 4 screens in a DOM (API mocked): menu engineering (matrix only with
 * enough data, verdicts, re-cost flag, history notes, unscored reasons, CSV
 * through /api/exports), department P&L and daily costing (31-day cap), the
 * stock matrix (values only for cost viewers), the supplier price board with
 * its price history, and QR stock labels (print sheet, scan look-up).
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MenuEngineeringScreen, DepartmentCostingScreen, StockMatrixScreen, SupplierPricesScreen, StockLabelsScreen, type MenuEngineeringRow, type MenuEngineeringResult } from "@/features/backoffice/costing";
import { permissionsForRoles } from "@/server/auth/rbac";
import { state, installFetch, teardown, renderAs, posts, gets, setValue, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

beforeEach(installFetch);
afterEach(teardown);

const MANAGER = [...permissionsForRoles(["MANAGER"])];
const KITCHEN = [...permissionsForRoles(["KITCHEN"])];

const row = (o: Partial<MenuEngineeringRow>): MenuEngineeringRow => ({
  menuItemId: "m", name: "Dish", category: "Mains", price: 100, ingredientCost: 30, overheadPct: 0, plateCost: 30, margin: 70, marginPct: 70, foodCostPct: 30, sold: 10, netRevenue: 1000, totalMargin: 700,
  historicalPlateCost: 30, costChange: 0, marginChange: 0, historicalPrice: 100, priceChange: 0, historicalMarginPct: 70, marginPctChange: 0, costCoverage: 100, confidence: "FULL",
  actualCost: 300, actualGrossMargin: 700, highCost: false, notes: [], class: "STAR", label: "Star", action: "Protect and feature it: never change the recipe or the supplier quietly.", ...o,
});
const result = (o: Partial<MenuEngineeringResult> = {}): MenuEngineeringResult => ({
  sufficient: true, insufficientReason: null, medianSold: 6, medianMarginPct: 65, highFoodCostPct: 38, recostAdvice: "Food cost is above 38%: re-cost the recipe (portion, supplier or price).",
  counts: { STAR: 1, PLOWHORSE: 1, PUZZLE: 0, DOG: 1 }, highCostItems: 1,
  rows: [
    row({ menuItemId: "chai", name: "Masala Chai", sold: 20, marginPct: 82.5 }),
    row({ menuItemId: "lassi", name: "Lassi", sold: 8, marginPct: 50, foodCostPct: 50, highCost: true, class: "PLOWHORSE", label: "Plow-horse", action: "Re-engineer the cost: raise the price a little (₹10–20), trim the portion or re-source." }),
    row({ menuItemId: "bir", name: "Biryani", sold: 3, marginPct: 60, class: "DOG", label: "Dog", action: "Remove it at the next reprint: it only adds stock, prep time and wastage.", historicalPlateCost: 102.3, costChange: 21.46, notes: ["Plate cost rose from ₹102.3 (when these portions were sold) to ₹123.76 today."], confidence: "PARTIAL", costCoverage: 75 }),
  ],
  unscored: [{ menuItemId: "w", name: "Water", sold: 4, reason: "No approved recipe" }],
  basis: "Margin % = …", ...o,
});

describe("menu engineering", () => {
  it("draws the matrix and the verdicts with their advice, history and unscored dishes; CSV goes through the export endpoint", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    state.routes = {
      "GET /api/analytics/menu-engineering": () => result(),
      "POST /api/exports": () => new Response("Dish\r\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="menu_engineering.csv"', "x-row-count": "3" } }),
    };
    renderAs(<MenuEngineeringScreen />, MANAGER);
    expect(await screen.findByRole("img", { name: /Menu engineering matrix: 3 dishes/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Menu engineering by dish" });
    expect(within(table).getByText("Plow-horse")).toBeInTheDocument();
    expect(within(table).getByText(/re-cost the recipe/)).toBeInTheDocument();
    expect(within(table).getByText(/Plate cost rose from ₹102.3/)).toBeInTheDocument();
    expect(within(table).getByText("75% of portions costed")).toBeInTheDocument();
    expect(screen.getByText("No approved recipe")).toBeInTheDocument();
    expect(gets("/api/analytics/menu-engineering")[0].query.get("outletId")).toBe(OUT_A);

    await userEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(posts()[0]).toMatchObject({ path: "/api/exports", body: { report: "MENU_ENGINEERING", mode: "inline", filters: { outletId: OUT_A } } });
  });

  it("without enough data says why and draws no matrix (no verdict is invented)", async () => {
    state.routes = { "GET /api/analytics/menu-engineering": () => result({ sufficient: false, insufficientReason: "No dishes were sold in this period, so there is no volume to compare.", medianSold: null, medianMarginPct: null, rows: result().rows.map((r) => ({ ...r, class: null, label: null, action: null })) }) };
    renderAs(<MenuEngineeringScreen />, MANAGER);
    expect(await screen.findByText("Not enough data to classify the menu")).toBeInTheDocument();
    expect(screen.getByText(/No dishes were sold in this period/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Menu engineering matrix/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Menu engineering by dish" })).queryByText("Star")).not.toBeInTheDocument();
  });
});

describe("department costing", () => {
  it("shows the P&L with totals, switches to daily costing and refuses more than 31 days before asking the server", async () => {
    state.routes = {
      "GET /api/master/departments": () => [{ id: "k", name: "Kitchen", kind: "KITCHEN", active: true, outletId: OUT_A }],
      "GET /api/analytics/department-pnl": () => ({ rows: [{ departmentId: "k", department: "Kitchen", kind: "KITCHEN", sales: 482000, costIssuedIn: 161400, wastage: 7300, grossMargin: 313300, marginPct: 65, recipeCostOfSales: 150000 }], total: { sales: 482000, costIssuedIn: 161400, wastage: 7300, grossMargin: 313300, marginPct: 65 }, basis: "…" }),
      "GET /api/analytics/daily-costing": () => ({ rows: [{ date: "2026-10-08", departmentId: "k", department: "Kitchen", opening: 100, receipts: 50, issuesOut: 0, consumption: 30, wastage: 5, adjustments: 0, closing: 115 }], basis: "…" }),
    };
    renderAs(<DepartmentCostingScreen />, MANAGER);
    const pnl = await screen.findByRole("table", { name: "Department P&L" });
    expect(within(pnl).getAllByText("₹3,13,300.00").length).toBeGreaterThan(0);
    expect(within(pnl).getAllByText("65.0%").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("tab", { name: "Daily costing" }));
    const daily = await screen.findByRole("table", { name: "Daily costing" });
    expect(within(daily).getByText("₹115.00")).toBeInTheDocument();
    const before = gets("/api/analytics/daily-costing").length;
    setValue(screen.getByLabelText("From"), "2026-06-01");
    expect(await screen.findByText(/at most 31 days/)).toBeInTheDocument();
    expect(gets("/api/analytics/daily-costing")).toHaveLength(before);
  });
});

describe("stock matrix", () => {
  const matrix = (value: boolean) => ({
    columns: [{ id: "", name: "Unassigned", kind: "UNASSIGNED" }, { id: "k", name: "Kitchen", kind: "KITCHEN" }],
    rows: [
      { materialId: "t", sku: "TOM", name: "Tomato", category: "Veg", unit: "kg", quantities: { "": 14, k: 17 }, total: 31, par: 10, belowPar: false, negative: false, ...(value ? { avgCost: 38.82, value: 1203.53 } : {}) },
      { materialId: "s", sku: "SUG", name: "Sugar", category: "Dry", unit: "kg", quantities: { "": 1 }, total: 1, par: 5, belowPar: true, negative: false, ...(value ? { avgCost: 45, value: 45 } : {}) },
      { materialId: "o", sku: "OIL", name: "Oil", category: "Dry", unit: "l", quantities: { k: -2 }, total: -2, par: 0, belowPar: false, negative: true, ...(value ? { avgCost: 150, value: -300 } : {}) },
    ],
    showValue: value, ...(value ? { totalValue: 948.53, valueByCategory: [{ category: "Veg", value: 1203.53 }, { category: "Dry", value: -255 }] } : {}),
  });

  it("manager: departments across the top, flags, values and a search that filters", async () => {
    state.routes = { "GET /api/inventory/matrix": () => matrix(true) };
    renderAs(<StockMatrixScreen />, MANAGER);
    const table = await screen.findByRole("table", { name: "Stock by department" });
    expect(within(table).getByRole("columnheader", { name: "Kitchen" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Value" })).toBeInTheDocument();
    expect(within(table).getByText("Negative")).toBeInTheDocument();
    expect(within(table).getByText("Below PAR 5")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Material, SKU or category"), "toma");
    expect(within(table).queryByText("Sugar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download CSV/ })).toBeInTheDocument();
  });

  it("kitchen: quantities only, no value column, no export", async () => {
    state.routes = { "GET /api/inventory/matrix": () => matrix(false) };
    renderAs(<StockMatrixScreen />, KITCHEN);
    const table = await screen.findByRole("table", { name: "Stock by department" });
    expect(within(table).queryByRole("columnheader", { name: "Value" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/₹/);
    expect(screen.queryByRole("button", { name: /Download CSV/ })).not.toBeInTheDocument();
  });
});

describe("supplier prices", () => {
  it("lists the cheapest active vendor per material and opens every quote with the purchase price history", async () => {
    state.routes = {
      "GET /api/procurement/supplier-prices": () => ({ basis: "Rates per base unit.", rows: [{ materialId: "t", sku: "TOM", name: "Tomato", category: "Veg", baseUnit: "kg", purchaseUnit: "crate", packFactor: 12, avgCost: 38.82, lastCost: 36, comparable: 2, spread: 5, quotes: [
        { vendorId: "v2", vendor: "Veg Two", status: "ACTIVE", buyable: true, preferred: false, ratePerBase: 35, ratePerPurchaseUnit: 420, leadTimeDays: 4, lastReceived: { ratePerBase: 36, receivedAt: "2026-10-08T05:00:00Z", grnNumber: "GRN-2" }, cheapest: true, aboveCheapestPct: null },
        { vendorId: "v1", vendor: "Veg One", status: "ACTIVE", buyable: true, preferred: true, ratePerBase: 40, ratePerPurchaseUnit: 480, leadTimeDays: 2, lastReceived: null, cheapest: false, aboveCheapestPct: 14.29 },
        { vendorId: "v3", vendor: "Veg Banned", status: "BLACKLISTED", buyable: false, preferred: false, ratePerBase: 20, ratePerPurchaseUnit: 240, leadTimeDays: 1, lastReceived: null, cheapest: false, aboveCheapestPct: -42.86 },
      ] }] }),
      "GET /api/procurement/price-history": () => ({ name: "Tomato", unit: "kg", avgCost: 38.82, lastCost: 36, window: { receipts: 2, qty: 34, weightedRate: 38.82, low: 36, high: 40 }, receipts: [
        { id: "r2", receivedAt: "2026-10-08T05:00:00Z", qty: 10, ratePerBase: 36, vendor: "Veg Two", document: "GRN-2", changePct: -10 },
        { id: "r1", receivedAt: "2026-10-07T05:00:00Z", qty: 24, ratePerBase: 40, vendor: "Veg One", document: "GRN-1", changePct: null },
      ] }),
    };
    renderAs(<SupplierPricesScreen />, MANAGER);
    const table = await screen.findByRole("table", { name: "Supplier price comparison" });
    expect(within(table).getByText("Veg Two")).toBeInTheDocument();
    expect(within(table).getByText("₹35.00 / kg")).toBeInTheDocument();
    await userEvent.click(within(table).getByText("Tomato"));
    const dialog = await screen.findByRole("dialog", { name: "Tomato" });
    expect(within(dialog).getByText("Veg Banned")).toHaveClass("line-through");
    expect(within(dialog).getByText("+14.29%")).toBeInTheDocument();
    const history = await within(dialog).findByRole("table", { name: "Price history for Tomato" });
    expect(within(history).getByText("-10.0%")).toBeInTheDocument();
    expect(gets("/api/procurement/price-history")[0].query.get("materialId")).toBe("t");
  });
});

describe("stock labels", () => {
  it("prints QR labels carrying the SKU and looks a scanned code up", async () => {
    state.routes = {
      "GET /api/inventory/labels": () => [{ materialId: "t", sku: "RM-0001", name: "Tomato", unit: "kg", category: "Veg", payload: "RESTORA-STOCK:RM-0001" }, { materialId: "o", sku: "RM-0002", name: "Onion", unit: "kg", category: "Veg", payload: "RESTORA-STOCK:RM-0002" }],
      "GET /api/inventory/labels/lookup": () => ({ materialId: "t", sku: "RM-0001", name: "Tomato", active: true, unit: "kg", category: "Veg", onHand: 30, reorderLevel: 10, departments: [{ departmentId: "k", department: "Kitchen", qty: 16 }, { departmentId: null, department: "Unassigned", qty: 14 }] }),
    };
    renderAs(<StockLabelsScreen />, KITCHEN);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Tomato/ }));
    expect(screen.getByRole("img", { name: "Stock label RM-0001" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Stock label RM-0002" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print 1 label" })).toBeEnabled();

    await userEvent.type(screen.getByLabelText("Label code or SKU"), "RESTORA-STOCK:RM-0001{enter}");
    expect(await screen.findByText("Kitchen: 16")).toBeInTheDocument();
    expect(gets("/api/inventory/labels/lookup")[0].query.get("code")).toBe("RESTORA-STOCK:RM-0001");
    expect(document.body.textContent).not.toMatch(/₹/);
  });
});
