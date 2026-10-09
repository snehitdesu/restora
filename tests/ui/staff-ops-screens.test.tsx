// @vitest-environment jsdom
/** The roster, checklists and invitation-e-mail screens (SO-03, SO-07, PA-03). */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterScreen, ChecklistsScreen } from "@/features/backoffice/staffOps";
import { TeamScreen } from "@/features/backoffice/staff";
import { state, installFetch, teardown, renderAs, posts, gets, ME, OUT_A } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/staff/roster" }));
beforeEach(installFetch);
afterEach(teardown);

const monday = (() => {
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.parse(`${day}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
})();
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function grid(over: { people?: unknown[]; onFirstDay?: unknown[] } = {}) {
  const shifts = (date: string) => [
    { shiftId: "s1", name: "Lunch", startTime: "11:00", endTime: "15:00", people: date === monday ? over.onFirstDay ?? [] : [] },
    { shiftId: "s2", name: "Dinner", startTime: "18:00", endTime: "23:00", people: [] },
  ];
  return { outletId: OUT_A, from: monday, days: Array.from({ length: 7 }, (_, i) => ({ date: addDays(monday, i), shifts: shifts(addDays(monday, i)) })), people: over.people ?? [{ id: "u2", name: "Bala" }, { id: "u3", name: "Chitra" }] };
}
const mine = [{ id: "a1", date: addDays(monday, 1), outletId: OUT_A, outlet: "Andheri", shift: "Lunch", startTime: "11:00", endTime: "15:00" }];

describe("roster", () => {
  it("a manager sees the week, puts someone on a shift, sees leave flagged, and takes someone off", async () => {
    state.routes = {
      "GET /api/staff/roster": () => grid({ onFirstDay: [{ assignmentId: "as1", userId: "u2", name: "Bala", onLeave: true }] }),
      "GET /api/staff/my-shifts": () => mine,
      "POST /api/staff/roster": () => ({ created: true }),
      "DELETE /api/staff/roster/as1": () => ({ removed: true }),
    };
    renderAs(<RosterScreen />, ["staff.manage"]);
    const table = await screen.findByRole("table", { name: /Roster for the week starting/ });
    expect(gets("/api/staff/roster")[0].query.get("outletId")).toBe(OUT_A);
    expect(gets("/api/staff/roster")[0].query.get("days")).toBe("7");
    const lunch = within(table).getByRole("row", { name: /Lunch/ });
    expect(within(lunch).getByText("Bala")).toBeInTheDocument();
    expect(within(lunch).getByText("On leave")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "My upcoming shifts" })).getByText(/Lunch · 11:00–15:00/)).toBeInTheDocument();

    await userEvent.click(within(table).getByRole("button", { name: `Put someone on Dinner on ${addDays(monday, 2)}` }));
    const dlg = await screen.findByRole("dialog", { name: /Dinner/ });
    await userEvent.selectOptions(within(dlg).getByRole("combobox"), "u3");
    await userEvent.click(within(dlg).getByRole("button", { name: "Put on shift" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ shiftId: "s2", userId: "u3", date: addDays(monday, 2) });

    await userEvent.click(within(table).getByRole("button", { name: `Remove Bala from Lunch on ${monday}` }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Take Bala off Lunch?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posts().some((p) => p.method === "DELETE")).toBe(true));
  });

  it("the server's reason (an overlapping shift) stays in the dialog", async () => {
    state.routes = {
      "GET /api/staff/roster": () => grid(), "GET /api/staff/my-shifts": () => [],
      "POST /api/staff/roster": () => ({ __status: 422, error: { code: "ValidationError", message: "Bala is already on Dinner (18:00–23:00) on 2026-10-12, which overlaps" } }),
    };
    renderAs(<RosterScreen />, ["staff.manage"]);
    const table = await screen.findByRole("table", { name: /Roster for the week starting/ });
    await userEvent.click(within(table).getByRole("button", { name: `Put someone on Lunch on ${monday}` }));
    const dlg = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dlg).getByRole("combobox"), "u2");
    await userEvent.click(within(dlg).getByRole("button", { name: "Put on shift" }));
    expect(await within(dlg).findByText(/which overlaps/)).toBeInTheDocument();
  });

  it("paging moves a week at a time; no shifts says so and offers to add one", async () => {
    state.routes = { "GET /api/staff/roster": () => ({ ...grid(), days: grid().days.map((d) => ({ ...d, shifts: [] })) }), "GET /api/staff/my-shifts": () => [], "POST /api/staff/shifts": () => ({ id: "s9" }) };
    renderAs(<RosterScreen />, ["staff.manage"]);
    expect(await screen.findByText("No shifts yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(gets("/api/staff/roster").at(-1)!.query.get("from")).toBe(addDays(monday, 7)));
    await userEvent.click(screen.getByRole("button", { name: /New shift/ }));
    const dlg = await screen.findByRole("dialog", { name: "New shift" });
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "Brunch");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add shift" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ outletId: OUT_A, name: "Brunch", startTime: "09:00", endTime: "17:00" });
  });

  it("everyone else sees only their own shifts, and the grid is never requested", async () => {
    state.routes = { "GET /api/staff/my-shifts": () => mine };
    renderAs(<RosterScreen />, ["order.view"]);
    expect(await screen.findByRole("list", { name: "My upcoming shifts" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: /New shift/ })).toBeNull();
    expect(gets("/api/staff/roster")).toHaveLength(0);
  });
});

describe("checklists", () => {
  const tpl = (over: Record<string, unknown> = {}) => ({ id: "t1", name: "Opening", kind: "OPENING", active: true, items: [{ id: "i1", title: "Unlock the door", description: null, priority: "MEDIUM" }, { id: "i2", title: "Switch on the fridges", description: null, priority: "HIGH" }], run: null, ...over });

  it("shows today's progress; a manager starts a list for today; others cannot", async () => {
    state.routes = { "GET /api/staff/checklists": () => [tpl({ run: { total: 2, open: 0, inProgress: 0, done: 1, verified: 1 } }), tpl({ id: "t2", name: "Closing", kind: "CLOSING" })], "POST /api/staff/checklists/t2/start": () => ({ created: 2, existing: 0 }) };
    const a = renderAs(<ChecklistsScreen />, ["task.view", "task.manage"]);
    const table = await screen.findByRole("table", { name: "Checklists" });
    expect(gets("/api/staff/checklists")[0].query.get("date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(within(table).getByLabelText("2 of 2 done today")).toBeInTheDocument();
    expect(within(table).getByText("Not started")).toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "Start Closing for today" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].path).toBe("/api/staff/checklists/t2/start");
    expect(within(table).getByRole("button", { name: "Start Opening for today" })).toHaveTextContent("Add missing tasks");
    a.unmount();

    renderAs(<ChecklistsScreen />, ["task.view"]);
    await screen.findByRole("table", { name: "Checklists" });
    expect(screen.queryByRole("button", { name: /Start/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /New checklist/ })).toBeNull();
  });

  it("a new checklist posts its items (empty rows dropped); editing keeps the ids of items that stay", async () => {
    state.routes = { "GET /api/staff/checklists": () => [tpl()], "POST /api/staff/checklists": () => ({ id: "t9" }), "PATCH /api/staff/checklists/t1": () => ({ id: "t1" }) };
    renderAs(<ChecklistsScreen />, ["task.view", "task.manage"]);
    await screen.findByRole("table", { name: "Checklists" });
    await userEvent.click(screen.getByRole("button", { name: /New checklist/ }));
    const dlg = await screen.findByRole("dialog", { name: "New checklist" });
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "Deep clean");
    await userEvent.type(within(dlg).getByLabelText("Item 1"), "Degrease the hood");
    await userEvent.click(within(dlg).getByRole("button", { name: /Add item/ }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Create checklist" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ outletId: OUT_A, name: "Deep clean", kind: "OPENING", items: [{ title: "Degrease the hood", priority: "MEDIUM" }] });

    await userEvent.click(screen.getByRole("button", { name: "Edit Opening" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Opening" });
    await userEvent.click(within(edit).getByRole("button", { name: "Remove item 1" }));
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1].method).toBe("PATCH");
    expect(posts()[1].body).toEqual({ name: "Opening", kind: "OPENING", items: [{ id: "i2", title: "Switch on the fridges", priority: "HIGH" }] });
  });
});

describe("invitation e-mail", () => {
  const roles = { permissions: [], roles: [{ role: "OWNER", rank: 100, permissions: [], grantable: false }, { role: "CASHIER", rank: 20, permissions: [], grantable: true }] };
  const team = { items: [{ id: ME, email: "a@x", name: "Asha", phone: null, active: true, lastLoginAt: null, memberships: [] }, { id: "u2", email: "b@x", name: "Bala", phone: null, active: true, lastLoginAt: null, memberships: [{ id: "m1", role: "CASHIER", outletId: OUT_A }] }], nextCursor: null };
  const link = { token: "tok_123", purpose: "SETUP", expiresAt: new Date(Date.now() + 86_400_000).toISOString() };

  it("adding someone can e-mail the invitation; the dialog says whether it went and still shows the link", async () => {
    state.routes = { "GET /api/staff/roles": () => roles, "GET /api/staff": () => team, "POST /api/staff": () => ({ id: "u9", email: "new@x", name: "New", setup: link, invite: { sent: true, to: "n***@x", status: "SENT" } }) };
    renderAs(<TeamScreen />, ["staff.manage"]);
    await screen.findByRole("table", { name: "Staff" });
    await userEvent.click(screen.getByRole("button", { name: /Add staff/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add staff member" });
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "New");
    await userEvent.type(within(dlg).getByLabelText(/^Email/), "new@x.test");
    await userEvent.selectOptions(within(dlg).getByLabelText(/^Role/), "CASHIER");
    await userEvent.click(within(dlg).getByLabelText(/E-mail them the invitation/));
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ name: "New", email: "new@x.test", role: "CASHIER", emailInvite: true });
    const shown = await screen.findByRole("dialog", { name: "Password setup link" });
    expect(within(shown).getByTestId("invite-status")).toHaveTextContent("Invitation e-mailed to n***@x");
    expect((within(shown).getByTestId("password-link") as HTMLInputElement).value).toContain("#token=tok_123");
  });

  it("without the box ticked nothing about e-mail is sent or shown", async () => {
    state.routes = { "GET /api/staff/roles": () => roles, "GET /api/staff": () => team, "POST /api/staff": () => ({ id: "u9", email: "new@x", name: "New", setup: link }) };
    renderAs(<TeamScreen />, ["staff.manage"]);
    await screen.findByRole("table", { name: "Staff" });
    await userEvent.click(screen.getByRole("button", { name: /Add staff/ }));
    const dlg = await screen.findByRole("dialog", { name: "Add staff member" });
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "New");
    await userEvent.type(within(dlg).getByLabelText(/^Email/), "new@x.test");
    await userEvent.selectOptions(within(dlg).getByLabelText(/^Role/), "CASHIER");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).not.toHaveProperty("emailInvite");
    expect(within(await screen.findByRole("dialog", { name: "Password setup link" })).queryByTestId("invite-status")).toBeNull();
  });

  it("the Invite action on a row sends a fresh invitation and reports a failure with the link to copy", async () => {
    state.routes = { "GET /api/staff/roles": () => roles, "GET /api/staff": () => team, "POST /api/staff/users/u2/invite": () => ({ link: { email: "b@x", ...link }, invite: { sent: false, to: "b***@x", status: "FAILED", reason: "Resend is down" } }) };
    renderAs(<TeamScreen />, ["staff.manage"]);
    const table = await screen.findByRole("table", { name: "Staff" });
    expect(within(within(table).getByText("Asha").closest("tr")!).queryByRole("button", { name: /invitation/ })).toBeNull(); // not for yourself
    await userEvent.click(within(within(table).getByText("Bala").closest("tr")!).getByRole("button", { name: "E-mail an invitation to Bala" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "E-mail an invitation to Bala?" })).getByRole("button", { name: "Send invitation" }));
    const shown = await screen.findByRole("dialog", { name: "Password setup link" });
    expect(within(shown).getByTestId("invite-status")).toHaveTextContent("not sent: Resend is down");
    expect((within(shown).getByTestId("password-link") as HTMLInputElement).value).toContain("#token=tok_123");
  });
});
