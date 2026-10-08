// @vitest-environment jsdom
/**
 * Group 3 screens in a DOM (API mocked): the dish production worksheet
 * (prepared entry, add wasted with an Idempotency-Key, dish sales log, costs
 * only for cost viewers), the consumption-variance report, the money desk
 * (three-way figures, declared revenue body, deposits, close gated by
 * blockers, closed day: reopen + "changed since close"), cost columns hidden
 * from the kitchen on the stock screen, and the navigation entries.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorksheetScreen, VarianceScreen } from "@/features/backoffice/kitchen";
import { MoneyDeskScreen, type MoneyDesk } from "@/features/backoffice/moneyDesk";
import { StockScreen, WastageScreen } from "@/features/backoffice/inventory";
import { visibleNav, navFor } from "@/lib/nav";
import { permissionsForRoles } from "@/server/auth/rbac";
import { state, installFetch, teardown, renderAs, posts, setValue, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

beforeEach(installFetch);
afterEach(teardown);

const KITCHEN = [...permissionsForRoles(["KITCHEN"])];
const MANAGER = [...permissionsForRoles(["MANAGER"])];
const CASHIER = [...permissionsForRoles(["CASHIER"])];

const sheet = (showCost: boolean) => ({
  outletId: OUT_A, businessDate: "2026-10-08", showCost,
  rows: [{ menuItemId: "d-rice", name: "Rice bowl", departmentId: "k", department: "Kitchen", prepared: 40, sold: 31, wasted: 3, wastedPending: 0, variance: 6, notes: null, updatedAt: null, ...(showCost ? { plateCost: 18, wastageCost: 54, varianceCost: 108 } : {}) }],
  totals: { prepared: 40, sold: 31, wasted: 3, unexplained: 6, ...(showCost ? { wastageCost: 54, varianceCost: 108 } : {}) },
});
const menu = [{ id: "d-rice", name: "Rice bowl", active: true, station: "KITCHEN" }, { id: "d-curry", name: "Curry", active: true, station: "KITCHEN" }];

describe("dish production worksheet", () => {
  it("manager: figures with costs, saves prepared portions, records wasted portions with an Idempotency-Key", async () => {
    state.routes = {
      "GET /api/inventory/worksheet": () => sheet(true),
      "GET /api/menu": () => menu,
      "GET /api/master/departments": () => [],
      "POST /api/inventory/worksheet": () => ({ id: "x" }),
      "POST /api/inventory/worksheet/wastage": () => ({ posted: true, awaitingApproval: false }),
    };
    renderAs(<WorksheetScreen />, MANAGER);
    const table = await screen.findByRole("table", { name: "Dish production worksheet" });
    expect(within(table).getByText("Rice bowl")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Unexplained ₹" })).toBeInTheDocument();
    expect(within(table).getByText("₹108.00")).toBeInTheDocument();

    const prepared = within(table).getByLabelText("Prepared Rice bowl");
    setValue(prepared, "42");
    await userEvent.click(within(table).getByRole("button", { name: "Save prepared Rice bowl" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/inventory/worksheet")).toBeTruthy());
    expect(posts().find((c) => c.path === "/api/inventory/worksheet")!.body).toMatchObject({ outletId: OUT_A, menuItemId: "d-rice", preparedQty: 42 });

    await userEvent.click(within(table).getByRole("button", { name: "Add wasted Rice bowl" }));
    const dialog = await screen.findByRole("dialog");
    setValue(within(dialog).getByLabelText(/Portions wasted/), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record wasted portions" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/inventory/worksheet/wastage")).toBeTruthy());
    const sent = posts().find((c) => c.path === "/api/inventory/worksheet/wastage")!;
    expect(sent.body).toMatchObject({ menuItemId: "d-rice", qty: 2, reason: "OVERPRODUCTION" });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^wsw-/);
  });

  it("kitchen: quantities only, and the dish sales log sends whole lines with a key", async () => {
    state.routes = {
      "GET /api/inventory/worksheet": () => sheet(false),
      "GET /api/menu": () => menu,
      "GET /api/master/departments": () => [],
      "POST /api/inventory/manual-sales": () => ({ order: { id: "o1" }, duplicate: false }),
    };
    renderAs(<WorksheetScreen />, KITCHEN);
    const table = await screen.findByRole("table", { name: "Dish production worksheet" });
    expect(within(table).queryByRole("columnheader", { name: "Plate cost" })).not.toBeInTheDocument();
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Log dish sales/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Dish 1"), "d-curry");
    setValue(within(dialog).getByLabelText("Quantity 1"), "3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record sales" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/inventory/manual-sales")).toBeTruthy());
    const sent = posts().find((c) => c.path === "/api/inventory/manual-sales")!;
    expect(sent.body).toMatchObject({ outletId: OUT_A, lines: [{ menuItemId: "d-curry", qty: 3 }] });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^msl-/);
  });
});

describe("consumption variance", () => {
  it("shows the leakage summary and materials ranked by rupee variance", async () => {
    state.routes = {
      "GET /api/master/departments": () => [],
      "GET /api/analytics/consumption-variance": () => ({
        rows: [{ materialId: "m1", sku: "ON", name: "Onion", unit: "kg", category: null, expectedQty: 0, expectedCost: 0, wastageQty: 0.4, wastageCost: 12, countLossQty: 1, countLossCost: 30, actualQty: 1.4, actualCost: 42, varianceQty: 1.4, varianceCost: 42, variancePct: null }],
        totals: { expectedCost: 100, wastageCost: 12, countLossCost: 30, actualCost: 142, varianceCost: 42, variancePct: 42 },
        leakage: { revenue: 1000, theoreticalFoodCost: 100, wastage: 12, countVarianceLoss: 30, actualFoodCost: 142, leakage: 42, pct: { theoretical: 10, wastage: 1.2, countVariance: 3, actual: 14.2, leakage: 4.2 } },
      }),
      "GET /api/analytics/count-variance-trend": () => ({
        rows: [
          { countId: "c1", number: "SC-0001", approvedAt: "2026-10-01T10:00:00.000Z", department: "Kitchen", itemsCounted: 30, itemsAdjusted: 4, loss: 900, surplus: 0, net: -900 },
          { countId: "c2", number: "SC-0002", approvedAt: "2026-10-08T10:00:00.000Z", department: "Kitchen", itemsCounted: 30, itemsAdjusted: 2, loss: 300, surplus: 50, net: -250 },
        ],
        trend: { earlierAvgLoss: 900, laterAvgLoss: 300, direction: "CLOSING" },
      }),
    };
    renderAs(<VarianceScreen />, MANAGER);
    const table = await screen.findByRole("table", { name: "Consumption variance by material" });
    expect(within(table).getByText("Onion")).toBeInTheDocument();
    expect(within(table).getByText("no sales")).toBeInTheDocument();
    expect(screen.getByText("Leakage gap")).toBeInTheDocument();
    // Variance over counts: the trend sentence and one row per approved count.
    expect(await screen.findByText(/The leak is closing/)).toHaveTextContent("₹900.00 in the earlier counts, ₹300.00 in the later ones");
    expect(within(screen.getByRole("table", { name: "Stock count variance by count" })).getAllByRole("row")).toHaveLength(3);
  });
});

const desk = (o: Partial<MoneyDesk> = {}): MoneyDesk => ({
  outletId: OUT_A, businessDate: "2026-10-08", timezone: "Asia/Kolkata", status: "OPEN",
  pos: { orders: 4, grossSales: 1150, discounts: 0, tax: 10, billed: 1160, refunds: 10, refundCount: 1, fullyDiscountedOrders: 0, atMenuPrice: 1190, billedItems: 1150, menuPriceGap: -40, unpricedLines: 3 },
  channels: [
    { key: "DINE_IN", label: "Dine-in (incl. table QR)", orders: 2, billed: 510, declared: null, difference: null, note: null, aggregator: false, commissionPct: null, commission: null, commissionBasis: null, expectedPayout: null },
    { key: "ZOMATO", label: "Zomato", orders: 1, billed: 500, declared: null, difference: null, note: null, aggregator: true, commissionPct: 25, commission: 125, commissionBasis: "rate", expectedPayout: 375 },
  ],
  declaredTotal: null, declaredDifference: null, commissionTotal: 125,
  collections: [{ method: "CASH", expected: 200, declared: null, difference: null }, { method: "UPI", expected: 300, declared: null, difference: null }],
  bank: { rows: [{ method: "CASH", expected: 200, basis: "system", deposited: 0, gap: -200 }, { method: "UPI", expected: 300, basis: "system", deposited: 0, gap: -300 }, { method: "CARD", expected: 0, basis: "system", deposited: 0, gap: 0 }], expected: 500, deposited: 0, gap: -500, deposits: [] },
  pettyCash: { opening: 0, inflow: 1000, outflow: 150.5, closing: 849.5, byCategory: [{ category: "GAS", amount: 120 }], monthToDate: { outflow: 150.5, byCategory: [{ category: "GAS", amount: 120 }] } },
  expenses: { total: 0, count: 0 }, drawers: { open: 0, closedVariance: 0 },
  reconciliations: { payments: null, sales: null }, unsettledOrders: 0,
  blockers: ["money counted per payment method has not been entered", "revenue per channel has not been declared"], readyToClose: false,
  closes: [], discrepancies: [], changedSinceClose: [], ...o,
});

describe("money desk", () => {
  it("open day: three-way figures, declared revenue body, deposit with a key, close disabled while blocked", async () => {
    state.routes = {
      "GET /api/finance/money-desk": () => desk(),
      "GET /api/finance/money-desk/closes": () => [],
      "GET /api/finance/vendor-dues": () => [{ vendorId: "v1", vendorName: "Fresh Dairy", openBills: 2, billed: 900, paid: 0, due: 900, overdue: 400 }],
      "POST /api/finance/money-desk/declare": () => ({ id: "r1" }),
      "POST /api/finance/money-desk/deposits": () => ({ id: "dep1" }),
    };
    renderAs(<MoneyDeskScreen />, MANAGER);
    await screen.findByRole("table", { name: "Revenue by channel" });
    expect(screen.getAllByText("POS rang").length).toBeGreaterThan(0);
    expect(screen.getByText("Expected to bank")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("revenue per channel has not been declared");
    expect(screen.getByRole("button", { name: "Close day" })).toBeDisabled();
    expect(await screen.findByText("Fresh Dairy")).toBeInTheDocument();
    expect(screen.getByText("Petty cash spent this month")).toBeInTheDocument();

    setValue(screen.getByLabelText("Declared Dine-in (incl. table QR)"), "509.99");
    setValue(screen.getByLabelText("Declared Zomato"), "500");
    await userEvent.click(screen.getByRole("button", { name: "Save declared revenue" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/finance/money-desk/declare")).toBeTruthy());
    expect(posts().find((c) => c.path === "/api/finance/money-desk/declare")!.body).toMatchObject({ businessDate: "2026-10-08", declared: [{ channel: "DINE_IN", amount: 509.99 }, { channel: "ZOMATO", amount: 500 }] });

    await userEvent.click(screen.getByRole("button", { name: /Record deposit/ }));
    const dialog = await screen.findByRole("dialog");
    setValue(within(dialog).getByLabelText(/Amount/), "190");
    await userEvent.type(within(dialog).getByLabelText(/Slip \/ UTR reference/), "SLIP-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/finance/money-desk/deposits")).toBeTruthy());
    const dep = posts().find((c) => c.path === "/api/finance/money-desk/deposits")!;
    expect(dep.body).toMatchObject({ businessDate: "2026-10-08", method: "CASH", amount: 190, reference: "SLIP-1" });
    expect(dep.headers["Idempotency-Key"]).toMatch(/^dep-/);
  });

  it("ready day closes after confirmation; a closed day shows reopen and what changed since", async () => {
    let closed = false;
    state.routes = {
      "GET /api/finance/money-desk": () => (closed
        ? desk({ status: "CLOSED", blockers: [], readyToClose: false, closes: [{ id: "c1", revision: 1, status: "CLOSED", closedAt: "2026-10-08T17:00:00.000Z", closedById: "u1", notes: null, reopenedAt: null, reopenedById: null, reopenReason: null }], changedSinceClose: [{ figure: "Billed", atClose: 1160, now: 1200 }] })
        : desk({ blockers: [], readyToClose: true })),
      "GET /api/finance/money-desk/closes": () => [],
      "GET /api/finance/vendor-dues": () => [],
      "POST /api/finance/money-desk/close": () => { closed = true; return { close: { revision: 1 } }; },
    };
    renderAs(<MoneyDeskScreen />, MANAGER);
    const close = await screen.findByRole("button", { name: "Close day" });
    expect(close).toBeEnabled();
    await userEvent.click(close);
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: /Close day|Confirm/ }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/finance/money-desk/close")).toBeTruthy());
    expect(await screen.findByRole("button", { name: "Reopen day" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Changed since the day was closed");
    expect(screen.queryByLabelText("Declared Zomato")).not.toBeInTheDocument(); // locked
  });

  it("a day without sales or payments can still be declared (zero) and counted from the screen", async () => {
    state.routes = {
      "GET /api/finance/money-desk": () => desk({ pos: { ...desk().pos, orders: 0, billed: 0 }, channels: [], collections: [] }),
      "GET /api/finance/money-desk/closes": () => [],
      "GET /api/finance/vendor-dues": () => [],
      "POST /api/finance/money-desk/declare": () => ({ id: "r1" }),
      "POST /api/finance/reconciliations/daily": () => ({ id: "r2" }),
    };
    renderAs(<MoneyDeskScreen />, MANAGER);
    setValue(await screen.findByLabelText("Declared Dine-in (incl. table QR)"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save declared revenue" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/finance/money-desk/declare")).toBeTruthy());
    expect(posts().find((c) => c.path === "/api/finance/money-desk/declare")!.body).toMatchObject({ declared: [{ channel: "DINE_IN", amount: 0 }] });

    expect(screen.getByText(/No payments were taken on this day/)).toBeInTheDocument();
    setValue(screen.getByLabelText("Counted Cash"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save counted money" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/finance/reconciliations/daily")).toBeTruthy());
    expect(posts().find((c) => c.path === "/api/finance/reconciliations/daily")!.body).toMatchObject({ businessDate: "2026-10-08", actuals: [{ method: "CASH", actual: 0 }] });
  });

  it("finance.view without reconcile rights reads only", async () => {
    state.routes = { "GET /api/finance/money-desk": () => desk(), "GET /api/finance/money-desk/closes": () => [], "GET /api/finance/vendor-dues": () => [] };
    renderAs(<MoneyDeskScreen />, CASHIER);
    await screen.findByRole("table", { name: "Revenue by channel" });
    expect(screen.queryByLabelText("Declared Zomato")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close day" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Record deposit/ })).not.toBeInTheDocument();
  });
});

describe("kitchen sees quantities, not costs", () => {
  it("the stock screen drops the cost columns and the stock value for a kitchen login", async () => {
    state.routes = {
      "GET /api/inventory/stock": () => [{ materialId: "m1", quantity: 5, avgCost: null, value: null, name: "Onion", sku: "ON", unit: "kg", reorderLevel: 0, active: true, categoryId: null }],
      "GET /api/inventory/low-stock": () => [],
      "GET /api/inventory/unmapped": () => ({ items: [], nextCursor: null }),
    };
    renderAs(<StockScreen />, KITCHEN);
    const table = await screen.findByRole("table", { name: "Stock on hand" });
    expect(within(table).queryByRole("columnheader", { name: "Avg cost" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stock value")).not.toBeInTheDocument();
  });
});

describe("kitchen wastage", () => {
  it("lists materials from the outlet's stock (no master-data access) and can log whole dishes", async () => {
    state.routes = {
      "GET /api/inventory/wastage": () => ({ items: [], nextCursor: null }),
      "GET /api/inventory/stock": () => [{ materialId: "m-tom", quantity: 4, avgCost: null, value: null, name: "Tomato", sku: "TOM", unit: "kg", reorderLevel: 0, active: true, categoryId: null }],
      "GET /api/master/departments": () => [],
      "GET /api/menu": () => menu,
      "POST /api/inventory/wastage/dish": () => ({ id: "w1" }),
    };
    renderAs(<WastageScreen />, KITCHEN);
    await userEvent.click(await screen.findByRole("button", { name: /Record wastage/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("option", { name: /Tomato \(TOM\)/ })).toBeInTheDocument();
    expect(state.calls.some((c) => c.path === "/api/master/materials")).toBe(false);
    await userEvent.click(within(dialog).getByRole("tab", { name: "Whole dishes" }));
    await userEvent.selectOptions(within(dialog).getByLabelText(/Dish/), "d-rice");
    setValue(within(dialog).getByLabelText(/Portions/), "3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(posts().find((c) => c.path === "/api/inventory/wastage/dish")).toBeTruthy());
    const sent = posts().find((c) => c.path === "/api/inventory/wastage/dish")!;
    expect(sent.body).toMatchObject({ outletId: OUT_A, menuItemId: "d-rice", qty: 3 });
    expect(sent.headers["Idempotency-Key"]).toMatch(/^wst-/);
  });
});

describe("navigation", () => {
  it("money desk for finance, dish production for the kitchen, variance for reports, indents for whoever may raise one", () => {
    const labels = (roles: string[]) => visibleNav(permissionsForRoles(roles)).map((n) => n.label);
    expect(labels(["KITCHEN"])).toEqual(expect.arrayContaining(["Dish production", "Production", "Wastage", "Indents"]));
    expect(labels(["KITCHEN"])).not.toContain("Variance");
    expect(labels(["KITCHEN"])).not.toContain("Money desk");
    expect(labels(["MANAGER"])).toEqual(expect.arrayContaining(["Money desk", "Variance", "Dish production"]));
    expect(labels(["CASHIER"])).toContain("Money desk");
    expect(navFor("/finance/money-desk")?.permission).toBe("finance.view");
  });
});
