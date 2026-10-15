// @vitest-environment jsdom
/**
 * KDS timing (audit MB-07, MB-08): the board flags a ticket from what its dishes MEASURABLY take (not a fixed line), the
 * banner counts late tickets, a ticket that is ready is never "late" for the kitchen, and the report shows the numbers.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/Toast";
import { KitchenScreen } from "@/features/kitchen/components/KitchenScreen";
import { TicketCard } from "@/features/kitchen/components/TicketCard";
import { PrepTimesScreen } from "@/features/backoffice/prepTimes";
import { NO_EXPECTATIONS, expectationsFrom, expectedMinutes, lateSummary, ticketLateness, type KdsTicket } from "@/features/kitchen/kds";
import { state, installFetch, teardown, renderAs } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/kitchen" }));
beforeEach(installFetch);
afterEach(teardown);

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();
const ticket = (over: Partial<KdsTicket> & { dish?: [string, string | null] } = {}): KdsTicket => {
  const [name, menuItemId] = over.dish ?? ["Masala Dosa", "m-dosa"];
  const { dish: _dish, ...rest } = over;
  void _dish;
  return {
    id: "k1", number: 7, status: "PREPARING", createdAt: ago(5), orderId: "cmorder000123", station: { id: "s1", name: "Main" },
    order: { id: "cmorder000123", channel: "DINE_IN", source: "POS", covers: 2, notes: null, createdAt: "", table: { code: "T3" } },
    items: [{ id: "ki1", name, qty: "1", status: "NEW", notes: null, orderItem: { menuItemId, notes: null, modifiers: [] } }],
    ...rest,
  };
};
const measured = expectationsFrom([
  { menuItemId: "m-dosa", name: "Masala Dosa", medianMinutes: 8, reliable: true },
  { menuItemId: "m-biryani", name: "Biryani", medianMinutes: 20, reliable: true },
  { menuItemId: "m-rare", name: "Chef Special", medianMinutes: 40, reliable: false },
  { menuItemId: null, name: "Open Item", medianMinutes: 6, reliable: true },
]);

describe("late tickets from measured times", () => {
  it("only dishes with enough measured tickets become expectations", () => {
    expect(measured).toEqual({ byItem: { "m-dosa": 8, "m-biryani": 20 }, byName: { "Open Item": 6 } });
  });

  it("a ticket is expected when its slowest dish usually is; unknown dishes give no expectation", () => {
    const two = ticket({ items: [ticket().items[0], { ...ticket().items[0], id: "ki2", name: "Biryani", orderItem: { menuItemId: "m-biryani", notes: null, modifiers: [] } }] });
    expect(expectedMinutes(two, measured)).toBe(20);
    expect(expectedMinutes(ticket({ dish: ["Chef Special", "m-rare"] }), measured)).toBeNull(); // unreliable
    expect(expectedMinutes(ticket({ dish: ["Open Item", null] }), measured)).toBe(6); // by name when it has no menu item
    expect(expectedMinutes(ticket(), NO_EXPECTATIONS)).toBeNull();
  });

  it("warns at the usual time and is late at half as long again (at least 3 minutes over)", () => {
    const dosa = (min: number) => ticketLateness(ticket({ createdAt: ago(min) }), NOW, measured);
    expect(dosa(7).level).toBe("normal");
    expect(dosa(8).level).toBe("warn");
    expect(dosa(11).level).toBe("warn"); // 8 -> late at max(12, 11) = 12
    expect(dosa(12).level).toBe("late");
    expect(dosa(12)).toMatchObject({ expected: 8 });
    // A fast dish: 2 minutes usually -> late at 5 (3 minutes over beats 1.5x).
    const fast = expectationsFrom([{ menuItemId: "m-dosa", name: "Masala Dosa", medianMinutes: 2, reliable: true }]);
    expect(ticketLateness(ticket({ createdAt: ago(4) }), NOW, fast).level).toBe("warn");
    expect(ticketLateness(ticket({ createdAt: ago(5) }), NOW, fast).level).toBe("late");
  });

  it("without a measurement the fixed 10 / 20 minute lines apply; READY food is never late for the kitchen", () => {
    expect(ticketLateness(ticket({ createdAt: ago(9) }), NOW).level).toBe("normal");
    expect(ticketLateness(ticket({ createdAt: ago(12) }), NOW).level).toBe("warn");
    expect(ticketLateness(ticket({ createdAt: ago(25) }), NOW).level).toBe("late");
    expect(ticketLateness(ticket({ status: "READY", createdAt: ago(60) }), NOW, measured).level).toBe("normal");
  });

  it("counts late and due tickets for the banner", () => {
    const list = [ticket({ id: "a", createdAt: ago(20) }), ticket({ id: "b", createdAt: ago(9) }), ticket({ id: "c", createdAt: ago(2) }), ticket({ id: "d", status: "READY", createdAt: ago(90) })];
    expect(lateSummary(list, NOW, measured)).toEqual({ late: 1, due: 1 });
    expect(lateSummary([], NOW, measured)).toEqual({ late: 0, due: 0 });
  });
});

describe("the board", () => {
  it("shows a banner and a 'running late' mark from the outlet's own measured times; a ticket card says what is usual", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    state.routes = {
      "GET /api/kitchen/stations": () => [{ id: "s1", name: "Main", kind: "KITCHEN" }],
      "GET /api/kitchen/kots": () => [ticket({ id: "a", number: 1, createdAt: ago(20) }), ticket({ id: "b", number: 2, createdAt: ago(9) }), ticket({ id: "c", number: 3, createdAt: ago(2) })],
      "GET /api/kitchen/prep-times": () => ({ dishes: [{ menuItemId: "m-dosa", name: "Masala Dosa", medianMinutes: 8, reliable: true }] }),
    };
    render(<ToastProvider><KitchenScreen outletId="out1" canUpdate /></ToastProvider>);
    vi.useRealTimers();
    const banner = await screen.findByTestId("kds-late-banner");
    expect(banner).toHaveTextContent("1 ticket is running late · 1 at their usual time");
    expect(banner).toHaveAttribute("role", "status");
    const late = screen.getByRole("article", { name: /KOT 1,/ });
    expect(late).toHaveTextContent("Running late");
    expect(within(late).getByTestId("kds-usual")).toHaveTextContent("usually ~8 min");
    expect(screen.getByRole("article", { name: /KOT 3,/ })).not.toHaveTextContent("Running late");
    expect(state.calls.find((c) => c.path === "/api/kitchen/prep-times")!.query.get("days")).toBe("14");
  });

  it("when the measured times cannot be loaded the board still works with the fixed lines", async () => {
    state.routes = {
      "GET /api/kitchen/stations": () => [],
      "GET /api/kitchen/kots": () => [ticket({ id: "a", number: 1, createdAt: new Date(Date.now() - 25 * 60000).toISOString() })],
    };
    render(<ToastProvider><KitchenScreen outletId="out1" canUpdate /></ToastProvider>);
    expect(await screen.findByTestId("kds-late-banner")).toHaveTextContent("1 ticket is running late");
    expect(screen.queryByTestId("kds-usual")).toBeNull();
  });

  it("a ticket card without expectations shows no 'usually' line", () => {
    render(<TicketCard ticket={ticket()} now={NOW} pending={false} canUpdate onAction={() => undefined} />);
    expect(screen.queryByTestId("kds-usual")).toBeNull();
  });
});

describe("prep times report", () => {
  it("shows the typical and slow ticket, each dish with what the KDS expects, and says when there are too few tickets", async () => {
    state.routes = {
      "GET /api/kitchen/prep-times": (c) => {
        expect(c.query.get("outletId")).toBe("out-a");
        return {
          days: 30, minSamples: 3, truncated: false,
          overall: { tickets: 40, averageMinutes: 11.2, medianMinutes: 10, p90Minutes: 19.5, cookMedianMinutes: 7.5 },
          dishes: [
            { key: "m-biryani", menuItemId: "m-biryani", name: "Biryani", tickets: 12, averageMinutes: 21, medianMinutes: 20, p90Minutes: 30, cookMedianMinutes: 15, reliable: true },
            { key: "m-rare", menuItemId: "m-rare", name: "Chef Special", tickets: 2, averageMinutes: 40, medianMinutes: 40, p90Minutes: 41, cookMedianMinutes: null, reliable: false },
          ],
          stations: [{ stationId: "s1", name: "Main", tickets: 40, averageMinutes: 11.2, medianMinutes: 10, p90Minutes: 19.5, cookMedianMinutes: 7.5 }],
        };
      },
    };
    renderAs(<PrepTimesScreen />, ["kot.view"]);
    const dishes = await screen.findByRole("table", { name: "Preparation time by dish" });
    expect(within(dishes).getByText("Biryani").closest("tr")).toHaveTextContent("~20 min");
    expect(within(dishes).getByText("Chef Special").closest("tr")).toHaveTextContent("too few tickets");
    expect(screen.getByText("Tickets measured").parentElement).toHaveTextContent("40");
    expect(screen.getByText("Typical ticket (median)").parentElement).toHaveTextContent("10.0 min");
    expect(screen.getByText("Cooking only (median)").parentElement).toHaveTextContent("7.5 min");
    await userEvent.selectOptions(screen.getByLabelText("Period"), "7");
    await waitFor(() => expect(state.calls.filter((c) => c.path === "/api/kitchen/prep-times").at(-1)!.query.get("days")).toBe("7"));
  });

  it("an outlet with no finished tickets says so instead of showing zeros as facts", async () => {
    state.routes = { "GET /api/kitchen/prep-times": () => ({ days: 30, minSamples: 3, truncated: false, overall: { tickets: 0, averageMinutes: 0, medianMinutes: 0, p90Minutes: 0, cookMedianMinutes: null }, dishes: [], stations: [] }) };
    renderAs(<PrepTimesScreen />, ["kot.view"]);
    expect(await screen.findByText("No finished tickets in this period")).toBeInTheDocument();
  });
});
