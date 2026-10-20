// @vitest-environment jsdom
/**
 * POS "Open orders": a guest's QR order paying at the counter goes straight to
 * the kitchen (SENT) — it must stay visible to the cashier as an unpaid QR
 * order, while the "new QR order" badge counts only orders nobody accepted yet.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenOrdersDialog, isIncomingQr, type OpenOrder } from "@/features/pos/components/OpenOrdersDialog";
import { installFetch, state, teardown } from "./harness";

const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const ORDERS: OpenOrder[] = [
  { id: "cm-pos-walkin-000001", channel: "TAKEAWAY", source: "POS", status: "SENT", total: "210.00", createdAt: at(2), tableId: null, kots: [{ status: "NEW" }] },
  { id: "cm-qr-cash-sent-000002", channel: "QR", source: "QR", status: "SENT", total: "89.25", createdAt: at(5), tableId: "t1", table: { code: "T01" }, kots: [{ status: "NEW" }] },
  { id: "cm-qr-online-open-0003", channel: "QR", source: "QR", status: "OPEN", total: "136.50", createdAt: at(9), tableId: "t2", table: { code: "T02" }, kots: [] },
  { id: "cm-qr-cash-ready-00004", channel: "QR", source: "QR", status: "READY", total: "40.00", createdAt: at(20), tableId: "t3", table: { code: "T03" }, kots: [{ status: "READY" }] },
];

beforeEach(() => {
  installFetch();
  state.routes = { "GET /api/orders": () => ({ items: ORDERS }) };
});
afterEach(teardown);

describe("POS open orders and QR visibility", () => {
  it("the new-order badge counts only QR orders nobody has accepted (not cash orders already in the kitchen)", () => {
    expect(ORDERS.filter(isIncomingQr).map((o) => o.id)).toEqual(["cm-qr-online-open-0003"]);
  });

  it("lists cash QR orders already sent to the kitchen as unpaid QR orders, with their kitchen stage; new ones first", async () => {
    render(<OpenOrdersDialog outletId="out-a" tableCode={() => null} onOpen={vi.fn()} onClose={vi.fn()} />);
    const rows = await screen.findAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent("New QR order · awaiting online payment");
    expect(rows[0]).toHaveTextContent("Table T02");
    const cash = rows.find((r) => r.textContent?.includes("Table T01"))!;
    expect(within(cash).getByText("QR · unpaid")).toBeInTheDocument();
    expect(within(cash).getByText("SENT")).toBeInTheDocument();
    expect(within(cash).getByText("Sent to the kitchen")).toBeInTheDocument();
    const ready = rows.find((r) => r.textContent?.includes("Table T03"))!;
    expect(within(ready).getByText("Ready")).toBeInTheDocument();
    expect(state.calls[0].query.get("active")).toBe("true");
  });

  it("filters to QR orders and back", async () => {
    const user = userEvent.setup();
    render(<OpenOrdersDialog outletId="out-a" tableCode={() => null} onOpen={vi.fn()} onClose={vi.fn()} />);
    await screen.findAllByRole("listitem");
    const toggle = screen.getByRole("button", { name: "QR orders only" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByText(/takeaway/i)).toBeNull();
    await user.click(toggle);
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("opens an order for the cashier to take payment", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<OpenOrdersDialog outletId="out-a" tableCode={() => null} onOpen={onOpen} onClose={vi.fn()} />);
    const rows = await screen.findAllByRole("listitem");
    const cash = rows.find((r) => r.textContent?.includes("Table T01"))!;
    await user.click(within(cash).getAllByRole("button")[0]);
    expect(onOpen).toHaveBeenCalledWith("cm-qr-cash-sent-000002");
  });
});
