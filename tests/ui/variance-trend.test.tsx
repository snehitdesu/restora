// @vitest-environment jsdom
/** The stock-count variance trend (audit IN-09): the verdict in words, and the chart on the report screen. */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { VarianceTrendChart, summarizeTrend, byApproval, type VarianceRow } from "@/features/backoffice/varianceTrend";
import { ReportsScreen } from "@/features/backoffice/reports";
import { state, installFetch, teardown, renderAs } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/reports" }));

const row = (n: number, loss: number, surplus = 0): VarianceRow => ({ number: `CNT-${n}`, approvedAt: `2026-09-${String(n).padStart(2, "0")}T10:00:00Z`, department: "Kitchen", loss, surplus, net: surplus - loss });

describe("summarizeTrend", () => {
  it("says the leak is closing when the later counts lose less", () => {
    const s = summarizeTrend([row(1, 900), row(2, 700), row(3, 300), row(4, 100)]);
    expect(s.verdict).toBe("CLOSING");
    expect(s.text).toMatch(/closing.*fell from about ₹800\.00 to ₹200\.00 across 4 counts/);
  });
  it("says it is widening when they lose more", () => {
    expect(summarizeTrend([row(1, 100), row(2, 120), row(3, 500), row(4, 700)]).verdict).toBe("WIDENING");
  });
  it("calls a change under 10% (or under one rupee) steady", () => {
    expect(summarizeTrend([row(1, 1000), row(2, 1040), row(3, 980), row(4, 1010)]).verdict).toBe("STEADY");
    expect(summarizeTrend([row(1, 0), row(2, 0.5)]).verdict).toBe("STEADY");
  });
  it("needs two counts, and orders them by approval whatever the order they arrive in", () => {
    expect(summarizeTrend([]).verdict).toBe("TOO_FEW");
    expect(summarizeTrend([row(1, 10)]).verdict).toBe("TOO_FEW");
    expect(byApproval([row(3, 1), row(1, 1), row(2, 1)]).map((r) => r.number)).toEqual(["CNT-1", "CNT-2", "CNT-3"]);
    expect(summarizeTrend([row(4, 100), row(3, 300), row(2, 700), row(1, 900)]).verdict).toBe("CLOSING");
  });
});

describe("VarianceTrendChart", () => {
  it("is one image with the answer in its name, one pair of bars per count, and nothing when there are no counts", () => {
    const { container, rerender } = render(<VarianceTrendChart rows={[row(1, 900, 50), row(2, 300, 0)]} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAccessibleName(/2 stock counts, oldest first\. The leak is closing/);
    expect(container.querySelectorAll("svg rect")).toHaveLength(4);
    expect(within(screen.getByTestId("variance-trend")).getByTestId("variance-trend-summary")).toHaveTextContent(/closing/);
    expect(container.querySelector("title")?.textContent).toMatch(/CNT-1 · Kitchen: loss ₹900\.00, surplus ₹50\.00/);
    rerender(<VarianceTrendChart rows={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("report screen", () => {
  beforeEach(installFetch);
  afterEach(teardown);
  it("shows the chart above the table for the variance trend report only", async () => {
    const result = (id: string, rows: unknown[]) => ({ report: id, title: id, columns: [{ key: "number", header: "Count" }], rows, rowCount: rows.length, truncated: false, offset: 0, nextOffset: null });
    state.routes = {
      "GET /api/reports": () => [{ id: "COUNT_VARIANCE_TREND", title: "Stock count variance trend", columns: [{ key: "number", header: "Count" }] }, { id: "DAILY_SALES", title: "Daily sales", columns: [{ key: "number", header: "Count" }] }],
      "GET /api/reports/COUNT_VARIANCE_TREND": () => result("COUNT_VARIANCE_TREND", [row(1, 900), row(2, 200)]),
      "GET /api/reports/DAILY_SALES": () => result("DAILY_SALES", [row(1, 900)]),
    };
    renderAs(<ReportsScreen />, ["reports.view"] as never);
    expect(await screen.findByTestId("variance-trend")).toBeInTheDocument();
    expect(screen.getByTestId("variance-trend-summary")).toHaveTextContent(/closing/);
  });
});
