// @vitest-environment jsdom
/** The procurement queue screen (audit PP-04): tabs with counts, one list for both kinds, approval from the row, paging. */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProcurementQueueScreen } from "@/features/backoffice/procurementQueue";
import { state, installFetch, teardown, renderAs, posts, gets } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/procurement/queue" }));
beforeEach(installFetch);
afterEach(teardown);

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const item = (over: Record<string, unknown>) => ({ kind: "PURCHASE_ORDER", id: "p1", number: "PO-0007", status: "SUBMITTED", outletId: "out-a", createdAt: ago(90), lines: 3, total: 4200.5, vendorId: "v1", source: null, href: "/procurement/purchase-orders/p1", ...over });
const counts = { "needs-approval": 2, "in-progress": 5, done: 9 };
const base = { "GET /api/master/vendors": () => ({ items: [{ id: "v1", name: "Fresh Farms" }], nextCursor: null }) };

describe("procurement queue", () => {
  it("shows both kinds in one list, with counts on the tabs; the number links to the document", async () => {
    state.routes = { ...base, "GET /api/procurement/queue": () => ({ items: [item({}), item({ kind: "INDENT", id: "i1", number: "IND-0003", total: null, vendorId: null, lines: 2, href: "/procurement/indents/i1", source: "REORDER" })], nextCursor: null, counts, includesPurchaseOrders: true }) };
    renderAs(<ProcurementQueueScreen />, ["purchase.view"] as never);
    const table = await screen.findByRole("table", { name: "Procurement queue" });
    expect(screen.getByRole("tab", { name: "Needs approval · 2" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "In progress · 5" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Done · 9" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Purchase order");
    expect(rows[0]).toHaveTextContent("PO-0007");
    expect(rows[0]).toHaveTextContent("₹4,200.50");
    expect(within(rows[0]).getByRole("link", { name: "PO-0007" })).toHaveAttribute("href", "/procurement/purchase-orders/p1");
    expect(rows[1]).toHaveTextContent("Indent");
    expect(rows[1]).toHaveTextContent("Reorder");
    expect(rows[1]).toHaveTextContent("—"); // an indent has no amount
    const q = gets("/api/procurement/queue")[0].query;
    expect(q.get("tab")).toBe("needs-approval");
    expect(q.get("outletId")).toBe("out-a");
  });

  it("changing the tab or the kind asks the server again from the first page", async () => {
    state.routes = { ...base, "GET /api/procurement/queue": () => ({ items: [], nextCursor: null, counts, includesPurchaseOrders: true }) };
    renderAs(<ProcurementQueueScreen />, ["purchase.view"] as never);
    await screen.findByText("Nothing is waiting for approval");
    await userEvent.click(screen.getByRole("tab", { name: "Done · 9" }));
    await waitFor(() => expect(gets("/api/procurement/queue").at(-1)!.query.get("tab")).toBe("done"));
    expect(await screen.findByText("Nothing here")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox"), "indent");
    await waitFor(() => expect(gets("/api/procurement/queue").at(-1)!.query.get("kind")).toBe("indent"));
    expect(gets("/api/procurement/queue").at(-1)!.query.get("cursor")).toBeNull();
  });

  it("approving a submitted document asks first, then uses the ordinary transition endpoint; without purchase.approve there is no button", async () => {
    let approved = false;
    state.routes = {
      ...base,
      "GET /api/procurement/queue": () => ({ items: approved ? [] : [item({}), item({ kind: "INDENT", id: "i1", number: "IND-0003", total: null, vendorId: null, href: "/procurement/indents/i1" })], nextCursor: null, counts, includesPurchaseOrders: true }),
      "POST /api/procurement/purchase-orders/p1/transition": () => { approved = true; return { id: "p1", status: "APPROVED" }; },
      "POST /api/procurement/indents/i1/transition": () => ({ id: "i1", status: "APPROVED" }),
    };
    const first = renderAs(<ProcurementQueueScreen />, ["purchase.view"] as never);
    await screen.findByRole("table", { name: "Procurement queue" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    first.unmount();

    renderAs(<ProcurementQueueScreen />, ["purchase.view", "purchase.approve"] as never);
    const table = await screen.findByRole("table", { name: "Procurement queue" });
    await userEvent.click(within(within(table).getAllByRole("row")[1]).getByRole("button", { name: "Approve" }));
    const dlg = await screen.findByRole("dialog");
    expect(dlg).toHaveTextContent(/₹4,200\.50/);
    expect(posts()).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/procurement/purchase-orders/p1/transition", body: { to: "APPROVED" } });
    await waitFor(() => expect(screen.getByText("Nothing is waiting for approval")).toBeInTheDocument());
  });

  it("a kitchen login (indents only) gets no 'kind' filter; paging passes the cursor back", async () => {
    let pages = 0;
    state.routes = {
      "GET /api/procurement/queue": (c) => {
        pages++;
        return c.query.get("cursor") ? { items: [item({ kind: "INDENT", id: "i9", number: "IND-0009", total: null })], nextCursor: null, counts, includesPurchaseOrders: false } : { items: [item({ kind: "INDENT", id: "i8", number: "IND-0008", total: null })], nextCursor: "2026-10-01T00:00:00.000Z|i8", counts, includesPurchaseOrders: false };
      },
    };
    renderAs(<ProcurementQueueScreen />, ["indent.create"] as never);
    await screen.findByText("IND-0008");
    expect(screen.queryByRole("combobox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("IND-0009");
    expect(gets("/api/procurement/queue").at(-1)!.query.get("cursor")).toBe("2026-10-01T00:00:00.000Z|i8");
    expect(pages).toBeGreaterThanOrEqual(2);
  });
});
