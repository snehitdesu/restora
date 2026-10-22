// @vitest-environment jsdom
/**
 * Common QR on screen: the counter's "QR tables" tab lists QR orders without a
 * table first and assigns one through POST /api/orders/:id/table; the kitchen
 * ticket says plainly that it has no table; the guest is never asked to pick one.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OpenOrdersDialog } from "@/features/pos/components/OpenOrdersDialog";
import { qrOrderStage, type QrTableOrder } from "@/features/pos/components/QrTablesPanel";
import { TicketCard } from "@/features/kitchen/components/TicketCard";
import { guestSeat } from "@/features/guest/storefront";
import { ToastProvider } from "@/components/ui/Toast";
import type { TableDTO } from "@/features/pos/types";
import type { KdsTicket } from "@/features/kitchen/kds";
import { fail, installFetch, state, teardown } from "./harness";

const now = new Date().toISOString();
const ORDERS: QrTableOrder[] = [
  { id: "cm-common-unassigned-01", status: "PAID", total: "126.00", createdAt: now, notes: null, tableId: null, table: null, customer: { name: "Asha" }, kots: [{ status: "PREPARING" }] },
  { id: "cm-common-assigned-0002", status: "PAID", total: "60.00", createdAt: now, notes: null, tableId: "t1", table: { code: "T01" }, customer: null, kots: [{ status: "READY" }] },
];
const TABLES = [
  { id: "t1", code: "T01", capacity: 4, status: "AVAILABLE", floor: null },
  { id: "t2", code: "T02", capacity: 2, status: "OCCUPIED", floor: null },
] as unknown as TableDTO[];

beforeEach(() => {
  installFetch();
  state.routes = {
    "GET /api/orders": () => ({ items: [] }),
    "GET /api/orders/qr-tables": () => ORDERS,
    "POST /api/orders/cm-common-unassigned-01/table": () => ({ unchanged: false, fromTable: null, toTable: "T02" }),
  };
});
afterEach(teardown);

describe("counter: QR tables", () => {
  it("lists the order without a table first and assigns the chosen table through the server", async () => {
    const user = userEvent.setup();
    render(<ToastProvider><OpenOrdersDialog outletId="out-a" tableCode={() => null} tables={TABLES} onOpen={vi.fn()} onClose={vi.fn()} /></ToastProvider>);
    await user.click(screen.getByRole("tab", { name: "QR tables" }));
    const rows = await screen.findAllByTestId("qr-table-row");
    expect(rows[0]).toHaveTextContent(/no table yet/i);
    expect(rows[0]).toHaveTextContent("paid · in the kitchen");
    expect(rows[1]).toHaveTextContent("Table T01");
    expect(within(rows[1]).getByRole("button")).toHaveTextContent("Change table");
    await user.click(within(rows[0]).getByRole("button", { name: /Assign a table/ }));
    await user.click(await screen.findByRole("button", { name: /Table T02/ }));
    const post = state.calls.find((c) => c.method === "POST" && c.path === "/api/orders/cm-common-unassigned-01/table");
    expect(post?.body).toEqual({ tableId: "t2", fromTableId: null }); // the order had no table in this list
  });

  it("over the table's guest limits: shows the server's numbers and assigns only when staff choose to override", async () => {
    let attempts = 0;
    state.routes["POST /api/orders/cm-common-unassigned-01/table"] = (c: { body?: unknown }) => {
      attempts++;
      if (!(c.body as { overrideGuestLimits?: boolean }).overrideGuestLimits) {
        return fail(409, "TableGuestLimit", "With this order table T02 has 4 QR orders waiting for payment (guest limit 3) and 4 unsettled (limit 6). Its QR will refuse new guest orders until some are paid.", { table: "T02", waiting: 4, waitingLimit: 3, unsettled: 4, unsettledLimit: 6 });
      }
      return { unchanged: false, fromTable: null, toTable: "T02" };
    };
    const user = userEvent.setup();
    render(<ToastProvider><OpenOrdersDialog outletId="out-a" tableCode={() => null} tables={TABLES} onOpen={vi.fn()} onClose={vi.fn()} /></ToastProvider>);
    await user.click(screen.getByRole("tab", { name: "QR tables" }));
    const rows = await screen.findAllByTestId("qr-table-row");
    await user.click(within(rows[0]).getByRole("button", { name: /Assign a table/ }));
    await user.click(await screen.findByRole("button", { name: /Table T02/ }));
    const dialog = await screen.findByRole("dialog", { name: /over its guest limits/i });
    expect(dialog).toHaveTextContent("4 QR orders waiting for payment (guest limit 3)");
    // Cancelling sends nothing more.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(attempts).toBe(1);
    // Choosing it again and overriding sends the explicit flag once.
    await user.click(within((await screen.findAllByTestId("qr-table-row"))[0]).getByRole("button", { name: /Assign a table/ }));
    await user.click(await screen.findByRole("button", { name: /Table T02/ }));
    await user.click(within(await screen.findByRole("dialog", { name: /over its guest limits/i })).getByRole("button", { name: "Assign anyway" }));
    const posts = state.calls.filter((c) => c.method === "POST" && c.path === "/api/orders/cm-common-unassigned-01/table");
    expect(posts.map((p) => p.body)).toEqual([{ tableId: "t2", fromTableId: null }, { tableId: "t2", fromTableId: null }, { tableId: "t2", fromTableId: null, overrideGuestLimits: true }]);
  });

  it("describes each stage in the counter's words", () => {
    expect(qrOrderStage({ status: "OPEN", kots: [] })).toBe("waiting for the guest's payment");
    expect(qrOrderStage({ status: "PAID", kots: [{ status: "READY" }] })).toBe("paid · ready to serve");
  });
});

describe("kitchen ticket", () => {
  const ticket = (table: { code: string } | null): KdsTicket => ({
    id: "k1", number: 7, status: "PREPARING", createdAt: now, orderId: "cm-order-0000000001", station: null, items: [],
    order: { id: "cm-order-0000000001", channel: "QR", source: "QR", covers: 0, notes: null, createdAt: now, table },
  } as unknown as KdsTicket);

  it("marks a common-QR ticket without a table, and drops the mark once a table is assigned", () => {
    const { rerender } = render(<TicketCard ticket={ticket(null)} now={Date.now()} pending={false} canUpdate onAction={() => undefined} />);
    expect(screen.getByTestId("kot-no-table")).toHaveTextContent(/No table yet/);
    expect(screen.getByRole("article")).toHaveAccessibleName(/QR · no table yet/);
    rerender(<TicketCard ticket={ticket({ code: "T05" })} now={Date.now()} pending={false} canUpdate onAction={() => undefined} />);
    expect(screen.queryByTestId("kot-no-table")).toBeNull();
    expect(screen.getByRole("article")).toHaveAccessibleName(/Table T05 · QR/);
  });
});

describe("guest", () => {
  it("is told to sit anywhere instead of being asked for a table", () => {
    expect(guestSeat(null)).toBe("Sit anywhere");
    expect(guestSeat({ code: "T03" })).toBe("Table T03");
  });
});
