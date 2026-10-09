// @vitest-environment jsdom
/**
 * The captain's floor operations in a DOM (audit MB-03): moving an order to another table, merging another table's order
 * into it, splitting lines onto a new bill, and switching between the bills of one table. The server's refusals are shown
 * as they are; the split is one keyed request that a retry repeats with the same key.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CaptainApp } from "@/features/mobile/CaptainApp";
import { state, installFetch, teardown, renderAs, posts, fail, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/captain" }));
beforeEach(installFetch);
afterEach(teardown);

const now = new Date().toISOString();
const PERMS = ["order.view", "order.create", "order.modify", "kot.serve"] as never;
const perms = { create: true, modify: true, serve: true };

const free = (id: string, code: string) => ({ id, code, capacity: 4, floor: null, status: "AVAILABLE", order: null, others: [], tags: ["available"] });
const busy = (id: string, code: string, orderId: string, total: number, extra: Record<string, unknown> = {}, others: unknown[] = []) => ({
  id, code, capacity: 4, floor: null, status: "OCCUPIED", others, tags: ["occupied"],
  order: { id: orderId, status: "SENT", total, paid: 0, due: total, items: 2, unsent: 0, kots: { live: 0, ready: 0, served: 1, cancelled: 0 }, payment: "UNPAID", openedAt: now, elapsedMinutes: 20, openedBy: "Asha", ...extra },
});
const board = (tables: unknown[]) => ({ tables, counts: { all: tables.length, available: 1, occupied: 1, kitchen: 0, ready: 0, payment: 0 } });
const item = (id: string, name: string, qty: number, line: number) => ({ id, name, qty: String(qty), unitPrice: String(line / qty), lineTotal: String(line), notes: null, menuItemId: `m-${id}`, modifiers: [] });
const order = (id: string, status: string, items: unknown[], extra: Record<string, unknown> = {}) => ({
  id, outletId: OUT_A, channel: "DINE_IN", status, tableId: "t2", customerId: null, covers: 3, notes: null, subtotal: "0", discount: "0", tax: "0", total: "420", createdAt: now,
  items, payments: [], kots: [{ id: "k1", number: 4, status: "SERVED", items: items.map((i) => ({ orderItemId: (i as { id: string }).id, status: "SERVED" })) }], ...extra,
});
const base = { "GET /api/notifications/unread-count": () => ({ unread: 0 }) };
const open = async (code = "T2") => userEvent.click(await screen.findByTestId(`table-${code}`));

describe("table actions on a running order", () => {
  const items = [item("i1", "Masala Dosa", 2, 240), item("i2", "Filter Coffee", 1, 40)];

  it("only the people who may change orders see the actions", async () => {
    state.routes = { ...base, "GET /api/mobile/tables": () => board([busy("t2", "T2", "o2", 420)]), "GET /api/orders/o2": () => order("o2", "SENT", items) };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={{ create: false, modify: false, serve: false }} />, ["order.view"] as never);
    await open();
    await screen.findByText("2 × Masala Dosa");
    expect(screen.queryByRole("region", { name: "Table actions" })).toBeNull();
  });

  it("Move lists only free tables, sends the transfer, and follows the order to its new table", async () => {
    let moved = false;
    state.routes = {
      ...base,
      "GET /api/mobile/tables": () => board(moved ? [free("t1", "T1"), busy("t3", "T3", "o3", 300), busy("t4", "T4", "o2", 420), free("t2", "T2")] : [free("t1", "T1"), busy("t2", "T2", "o2", 420), busy("t3", "T3", "o3", 300), free("t4", "T4")]),
      "GET /api/orders/o2": () => order("o2", "SENT", items, { tableId: moved ? "t4" : "t2" }),
      "POST /api/orders/o2/transfer": () => { moved = true; return { unchanged: false }; },
    };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={perms} />, PERMS);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Move/ }));
    const dlg = await screen.findByRole("dialog", { name: "Move to another table" });
    const options = within(dlg).getAllByRole("button", { name: /^Move to table/ }).map((b) => b.getAttribute("aria-label"));
    expect(options).toEqual(["Move to table T1", "Move to table T4"]); // T3 is busy, T2 is where it is
    await userEvent.click(within(dlg).getByRole("button", { name: "Move to table T4" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/orders/o2/transfer", body: { tableId: "t4" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Table T4/ })).toBeInTheDocument()); // the panel follows the order
    expect(await screen.findByText("2 × Masala Dosa")).toBeInTheDocument();
  });

  it("Merge offers the other running orders (not billed ones, not itself), asks first, and shows the server's refusal", async () => {
    let attempt = 0;
    state.routes = {
      ...base,
      "GET /api/mobile/tables": () => board([busy("t2", "T2", "o2", 420), busy("t3", "T3", "o3", 300), busy("t5", "T5", "o5", 99, { status: "BILLED" })]),
      "GET /api/orders/o2": () => order("o2", "SENT", items),
      "POST /api/orders/o2/merge": () => (++attempt === 1 ? fail(422, "ValidationError", "Cannot merge order #O3: it carries a discount of 20.00; remove it first") : { replayed: false }),
    };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={perms} />, PERMS);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Merge/ }));
    const dlg = await screen.findByRole("dialog", { name: "Merge another order into this one" });
    const rows = within(dlg).getAllByRole("button", { name: /^Merge table/ });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAccessibleName("Merge table T3 order #O3");
    await userEvent.click(rows[0]);
    expect(within(dlg).getByRole("status")).toHaveTextContent(/₹300\.00.*into order/);
    expect(posts()).toHaveLength(0); // nothing is sent before the captain confirms
    await userEvent.click(within(dlg).getByRole("button", { name: "Merge" }));
    expect(await screen.findByText(/carries a discount/)).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Merge another order into this one" })).getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toMatchObject({ path: "/api/orders/o2/merge", body: { fromOrderId: "o3" } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Merge another order into this one" })).toBeNull());
  });

  it("Split: choose lines (or part of a line), one keyed request, a retry repeats the key, the new bill appears beside the old one", async () => {
    let attempt = 0;
    let split = false;
    state.routes = {
      ...base,
      "GET /api/mobile/tables": () => board([busy("t2", "T2", "o2", split ? 300 : 420, {}, split ? [{ id: "o9", status: "SENT", total: 120, due: 120 }] : [])]),
      "GET /api/orders/o2": () => order("o2", "SENT", split ? [item("i1", "Masala Dosa", 1, 120), item("i2", "Filter Coffee", 1, 40)] : items),
      "GET /api/orders/o9": () => order("o9", "SENT", [item("n1", "Masala Dosa", 1, 120)], { total: "126" }),
      "POST /api/orders/o2/split": () => { if (++attempt === 1) return fail(500, "InternalError", "boom"); split = true; return { replayed: false, order: order("o9", "SENT", [item("n1", "Masala Dosa", 1, 120)], { total: "126" }) }; },
    };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={perms} />, PERMS);
    await open();
    await userEvent.click(await screen.findByRole("button", { name: /Split/ }));
    const dlg = await screen.findByRole("dialog", { name: "Split the bill" });
    const go = () => within(dlg).getByRole("button", { name: /^Split/ });
    expect(go()).toBeDisabled();
    await userEvent.click(within(dlg).getByRole("button", { name: "More Masala Dosa on the new bill" })); // 1 of 2
    expect(go()).toHaveTextContent("Split · 1 item");
    // Everything onto the new bill is refused up front.
    await userEvent.click(within(dlg).getByRole("button", { name: "More Masala Dosa on the new bill" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "More Filter Coffee on the new bill" }));
    expect(within(dlg).getByRole("alert")).toHaveTextContent(/Leave at least one item/);
    expect(go()).toBeDisabled();
    await userEvent.click(within(dlg).getByRole("button", { name: "Fewer Filter Coffee on the new bill" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Fewer Masala Dosa on the new bill" })); // back to 1 of 2

    await userEvent.click(go());
    await screen.findAllByText(/Something went wrong on the server/);
    await userEvent.click(go());
    await waitFor(() => expect(posts()).toHaveLength(2));
    const [first, second] = posts();
    expect(first.path).toBe("/api/orders/o2/split");
    expect(first.body).toEqual({ lines: [{ orderItemId: "i1", qty: 1 }], covers: 1 });
    expect(first.headers["Idempotency-Key"]).toMatch(/^split-/);
    expect(second.headers["Idempotency-Key"]).toBe(first.headers["Idempotency-Key"]); // the retry is the same request
    // The panel shows the new bill, and the old one is one tap away.
    expect(await screen.findByText(/New bill #/)).toBeInTheDocument();
    const bills = await screen.findByRole("group", { name: "Bills at this table" });
    expect(within(bills).getAllByRole("button")).toHaveLength(2);
    expect(within(bills).getByRole("button", { name: /Bill 2/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(bills).getByRole("button", { name: /Bill 1/ }));
    // The panel reloads while switching, so the chips are new elements: look them up again.
    await waitFor(() => expect(screen.getByRole("button", { name: /Bill 1/ })).toHaveAttribute("aria-pressed", "true"));
  });

  it("a bill with a payment cannot be split and says why; a bill that asked for payment cannot take another order in", async () => {
    state.routes = {
      ...base,
      "GET /api/mobile/tables": () => board([busy("t2", "T2", "o2", 420, { payment: "PARTIAL" })]),
      "GET /api/orders/o2": () => order("o2", "SENT", items, { payments: [{ id: "p1", method: "CASH", status: "SUCCESS", amount: "100" }] }),
    };
    const { unmount } = renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={perms} />, PERMS);
    await open();
    expect(await screen.findByRole("button", { name: /Split/ })).toBeDisabled();
    expect(screen.getByText(/already has a payment, so it cannot be split/)).toBeInTheDocument();
    unmount();

    state.routes = { ...base, "GET /api/mobile/tables": () => board([busy("t2", "T2", "o2", 420, { status: "BILLED" })]), "GET /api/orders/o2": () => order("o2", "BILLED", items) };
    renderAs(<CaptainApp outletId={OUT_A} outletName="Andheri" perms={perms} />, PERMS);
    await open();
    expect(await screen.findByRole("button", { name: /Merge/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Split/ })).toBeEnabled(); // a billed order can still be split
  });
});
