// @vitest-environment jsdom
/**
 * Counter and host-stand extras in a DOM: the POS hold list (MB-09) — naming a bill when it is saved, the Held tab, the held
 * count on the Open orders button — and the waitlist's "Table ready" message (RS-03) with the honest answer when none could be sent.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PosScreen } from "@/features/pos/components/PosScreen";
import { ReservationsScreen } from "@/features/backoffice/reservations";
import { state, installFetch, teardown, renderAs, posts, gets, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/pos" }));
beforeEach(installFetch);
afterEach(teardown);

const perms = { pay: true, discount: true, cancel: true, customerView: true, customerManage: true };
const dosa = { id: "i-dosa", name: "Masala Dosa", description: null, price: "120", taxPct: "5", station: "KITCHEN", isVeg: true, active: true, soldOut: false, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [], effectivePrice: 120, offered: true, effectiveSoldOut: false };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const heldRow = (id: string, label: string | null, ageMin: number) => ({ id, channel: "TAKEAWAY", source: "POS", status: "OPEN", total: "126", createdAt: minutesAgo(ageMin), heldAt: minutesAgo(ageMin), holdLabel: label, tableId: null, table: null, customer: null, kots: [] });
const POS = ["order.view", "order.create"] as never;

const posRoutes = (over: Record<string, (c: never) => unknown> = {}) => ({
  "GET /api/menu": () => [dosa],
  "GET /api/master/tables": () => [],
  "GET /api/orders": () => ({ items: [], nextCursor: null }),
  "GET /api/notifications/unread-count": () => ({ unread: 0 }),
  ...over,
});

describe("POS hold list", () => {
  it("Save sends the bill's name with a hold flag", async () => {
    state.routes = posRoutes({
      "POST /api/orders": () => ({ id: "cmorder000777", outletId: OUT_A, channel: "TAKEAWAY", status: "OPEN", tableId: null, customerId: null, customer: null, covers: 1, items: [], total: "126" }),
      "GET /api/orders/cmorder000777": () => ({ id: "cmorder000777", outletId: OUT_A, channel: "TAKEAWAY", status: "OPEN", tableId: null, customerId: null, customer: null, covers: 1, items: [], total: "126" }),
    });
    renderAs(<PosScreen outletId={OUT_A} perms={perms} />, POS);
    expect(screen.queryByLabelText("Bill name (optional)")).toBeNull(); // nothing to hold yet
    await userEvent.click(await screen.findByRole("button", { name: /Masala Dosa/ }));
    await userEvent.click(screen.getByRole("radio", { name: "Takeaway" }));
    await userEvent.type(screen.getByLabelText("Bill name (optional)"), "  Window table ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ submit: false, hold: true, holdLabel: "Window table" });
    expect(await screen.findByText(/saved as “Window table”/)).toBeInTheDocument();
  });

  it("a bill sent to the kitchen carries no hold", async () => {
    state.routes = posRoutes({ "POST /api/orders": () => ({ id: "cmorder000778", outletId: OUT_A, channel: "TAKEAWAY", status: "SENT", tableId: null, items: [], total: "126" }) });
    renderAs(<PosScreen outletId={OUT_A} perms={perms} />, POS);
    await userEvent.click(await screen.findByRole("button", { name: /Masala Dosa/ }));
    await userEvent.click(screen.getByRole("radio", { name: "Takeaway" }));
    await userEvent.type(screen.getByLabelText("Bill name (optional)"), "ignored");
    await userEvent.click(screen.getByRole("button", { name: "Send to kitchen" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ submit: true });
    expect(posts()[0].body).not.toHaveProperty("hold");
    expect(posts()[0].body).not.toHaveProperty("holdLabel");
  });

  it("the Held tab lists held bills oldest first with their names, flags an old one, and opens one on a tap; the button counts them", async () => {
    state.routes = posRoutes({
      "GET /api/orders": (c: { query: URLSearchParams }) => ({ items: c.query.get("held") === "true" ? [heldRow("cmheld0000aa", "Ravi", 200), heldRow("cmheld0000bb", null, 10)] : [heldRow("cmheld0000aa", "Ravi", 200), heldRow("cmheld0000bb", null, 10)], nextCursor: null }),
      "GET /api/orders/cmheld0000aa": () => ({ id: "cmheld0000aa", outletId: OUT_A, channel: "TAKEAWAY", status: "OPEN", tableId: null, customerId: null, customer: null, covers: 1, items: [], total: "126" }),
    });
    renderAs(<PosScreen outletId={OUT_A} perms={perms} />, POS);
    const button = await screen.findByRole("button", { name: /^Open orders, 2 held$/ });
    await userEvent.click(button);
    const dlg = await screen.findByRole("dialog", { name: "Open orders" });
    await userEvent.click(within(dlg).getByRole("tab", { name: "Held" }));
    await waitFor(() => expect(gets("/api/orders").some((c) => c.query.get("held") === "true")).toBe(true));
    const rows = await within(dlg).findAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Held · Ravi · old"); // 200 minutes: nobody came back for it
    expect(rows[1]).toHaveTextContent(/Held/);
    expect(rows[1]).not.toHaveTextContent("old");
    await userEvent.click(within(rows[0]).getAllByRole("button")[0]);
    await waitFor(() => expect(gets("/api/orders/cmheld0000aa").length).toBeGreaterThan(0));
  });

  it("an empty hold list says how to use it", async () => {
    state.routes = posRoutes();
    renderAs(<PosScreen outletId={OUT_A} perms={perms} />, POS);
    await userEvent.click(await screen.findByRole("button", { name: "Open orders" }));
    const dlg = await screen.findByRole("dialog", { name: "Open orders" });
    await userEvent.click(within(dlg).getByRole("tab", { name: "Held" }));
    expect(await within(dlg).findByText("No held bills")).toBeInTheDocument();
    expect(within(dlg).getByText(/Save a bill from the till/)).toBeInTheDocument();
  });
});

describe("waitlist: Table ready", () => {
  const entry = (over: Record<string, unknown> = {}) => ({ id: "w1", customerName: "Rao", phone: "9876543210", partySize: 2, status: "WAITING", estWaitMins: 15, createdAt: new Date().toISOString(), notifiedAt: null, notifyCount: 0, ...over });
  const open = async (rows: unknown[], routes: Record<string, (c: never) => unknown> = {}) => {
    state.routes = { "GET /api/reservations": () => ({ items: [], nextCursor: null }), "GET /api/master/tables": () => [], "GET /api/reservations/waitlist": () => rows, ...routes };
    renderAs(<ReservationsScreen />, ["reservation.manage"]);
    await userEvent.click(await screen.findByRole("tab", { name: "Waitlist" }));
    return screen.findByRole("table", { name: "Waitlist" });
  };

  it("offered only to a waiting party with a number; says who was told, by what, and offers a reminder afterwards", async () => {
    let told = false;
    const table = await open([entry(), entry({ id: "w2", customerName: "No Phone", phone: null }), entry({ id: "w3", customerName: "Here", status: "ARRIVED" })], {
      "GET /api/reservations/waitlist": () => [entry({ notifiedAt: told ? new Date().toISOString() : null, notifyCount: told ? 1 : 0 }), entry({ id: "w2", customerName: "No Phone", phone: null }), entry({ id: "w3", customerName: "Here", status: "ARRIVED" })],
      "POST /api/reservations/waitlist/w1/notify": () => { told = true; return { sent: true, channel: "SMS", count: 1, notifiedAt: new Date().toISOString() }; },
    });
    await within(table).findByText("Rao");
    expect(within(table).getAllByRole("button", { name: /table is ready/ })).toHaveLength(1); // not for the party without a number, not for one that has arrived
    await userEvent.click(within(table).getByRole("button", { name: "Tell Rao the table is ready" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toMatchObject({ path: "/api/reservations/waitlist/w1/notify", body: {} });
    expect(await screen.findByText("Rao was told by SMS")).toBeInTheDocument();
    expect(await within(table).findByTestId("told-w1")).toHaveTextContent(/Told .* ago/);
    expect(within(table).getByRole("button", { name: "Tell Rao the table is ready" })).toHaveTextContent("Tell again");
  });

  it("when no message could go, the reason is shown as it is and nothing is marked as told", async () => {
    const table = await open([entry()], { "POST /api/reservations/waitlist/w1/notify": () => ({ sent: false, reason: "No SMS provider is connected. Tell them in person." }) });
    await userEvent.click(await within(table).findByRole("button", { name: "Tell Rao the table is ready" }));
    expect(await screen.findByText("No SMS provider is connected. Tell them in person.")).toBeInTheDocument();
    expect(within(table).queryByTestId("told-w1")).toBeNull();
  });
});
