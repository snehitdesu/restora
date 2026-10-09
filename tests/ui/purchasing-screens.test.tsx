// @vitest-environment jsdom
/**
 * Purchasing screens added with the approval rules and the master-data work: the rules form (PP-07), the line review and the
 * approval note on a purchase order (PP-06), the expiry list (IN-14), importing a spreadsheet (MD-21) and vendor contacts (MD-15).
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PurchasingRulesScreen } from "@/features/backoffice/procurementRules";
import { ExpiryScreen } from "@/features/backoffice/expiry";
import { IndentDetail, PurchaseOrderDetail } from "@/features/backoffice/procurement";
import { MaterialsScreen, VendorDetail, VendorsScreen } from "@/features/backoffice/master";
import { state, installFetch, teardown, renderAs, posts, gets, fail, OUT_A, type Call } from "./harness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/procurement" }));
beforeEach(installFetch);
afterEach(teardown);

describe("purchasing rules screen", () => {
  const rules = (r: { autoApproveBelow: number | null; dualApprovalAtOrAbove: number | null }) => ({ "GET /api/procurement/rules": () => r });

  it("shows the current rules in plain words and saves only valid, changed values", async () => {
    let saved: unknown;
    state.routes = { ...rules({ autoApproveBelow: 500, dualApprovalAtOrAbove: null }), "POST /api/procurement/rules": (c) => { saved = c.body; return c.body; } };
    renderAs(<PurchasingRulesScreen />, ["purchase.view", "org.manage"] as never);
    const auto = await screen.findByLabelText(/Approve small orders automatically/);
    await waitFor(() => expect(auto).toHaveValue(500));
    expect(screen.getByLabelText(/Need two approvers from/)).toHaveValue(null);
    expect(screen.getByRole("list", { name: "What this means" })).toHaveTextContent(/₹500\.00 or less is approved the moment it is submitted/);
    expect(screen.getByRole("list", { name: "What this means" })).toHaveTextContent("One approver is always enough.");
    expect(screen.getByRole("button", { name: "Save rules" })).toBeDisabled(); // nothing changed yet

    await userEvent.type(screen.getByLabelText(/Need two approvers from/), "5000");
    expect(screen.getByRole("list", { name: "What this means" })).toHaveTextContent(/above ₹500\.00, below ₹5,000\.00\) need one approver/);
    await userEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(saved).toEqual({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 }));
  });

  it("refuses limits that overlap, and an empty box turns that rule off", async () => {
    state.routes = { ...rules({ autoApproveBelow: 500, dualApprovalAtOrAbove: 5000 }), "POST /api/procurement/rules": (c) => c.body };
    renderAs(<PurchasingRulesScreen />, ["purchase.view", "org.manage"] as never);
    const auto = await screen.findByLabelText(/Approve small orders automatically/);
    await waitFor(() => expect(auto).toHaveValue(500));
    await userEvent.clear(auto);
    await userEvent.type(auto, "9000");
    expect(screen.getByRole("alert")).toHaveTextContent(/must be smaller than the orders that need two approvers/);
    expect(screen.getByRole("button", { name: "Save rules" })).toBeDisabled();
    await userEvent.clear(auto);
    expect(screen.getByRole("list", { name: "What this means" })).toHaveTextContent("Every order waits for an approver.");
    await userEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await waitFor(() => expect(posts()[0]?.body).toEqual({ autoApproveBelow: null, dualApprovalAtOrAbove: 5000 }));
  });

  it("shows the server's reason when saving fails", async () => {
    state.routes = { ...rules({ autoApproveBelow: null, dualApprovalAtOrAbove: null }), "POST /api/procurement/rules": () => fail(403, "ForbiddenError", "Missing permission \"org.manage\"") };
    renderAs(<PurchasingRulesScreen />, ["purchase.view"] as never);
    await userEvent.type(await screen.findByLabelText(/Approve small orders automatically/), "100");
    await userEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(await screen.findByText(/Missing permission/)).toBeInTheDocument();
  });
});

describe("expiry list", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    outletId: OUT_A, asOf: "2026-10-09", days: 7,
    rows: [
      { materialId: "m1", name: "Paneer", sku: "PAN-1", unit: "kg", batchNo: "B-9", fssaiLot: "FSSAI-1", expiryDate: "2026-10-07", daysLeft: -2, status: "EXPIRED", remaining: 2, useFirst: true },
      { materialId: "m2", name: "Curd", sku: "CUR-1", unit: "kg", batchNo: null, fssaiLot: null, expiryDate: "2026-10-12", daysLeft: 3, status: "SOON", remaining: 5, useFirst: false },
    ],
    counts: { expired: 1, today: 0, soon: 1 }, basis: "What is left of each batch is worked out from the stock on hand, assuming the earliest expiry is used first.", ...over,
  });

  it("lists the batches with their lot codes, counts and the honest basis; the window is sent to the server", async () => {
    state.routes = { "GET /api/inventory/expiring": () => report() };
    renderAs(<ExpiryScreen />, ["inventory.view"]);
    const table = await screen.findByRole("table", { name: "Expiring batches" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Paneer");
    expect(rows[0]).toHaveTextContent("B-9");
    expect(rows[0]).toHaveTextContent("FSSAI-1");
    expect(rows[0]).toHaveTextContent("expired 2 days ago");
    expect(rows[0]).toHaveTextContent("Use first");
    expect(rows[1]).toHaveTextContent("in 3 days");
    expect(screen.getByText(/assuming the earliest expiry is used first/)).toBeInTheDocument();
    expect(gets("/api/inventory/expiring")[0].query.get("outletId")).toBe(OUT_A);
    expect(gets("/api/inventory/expiring")[0].query.get("days")).toBe("7");

    await userEvent.selectOptions(screen.getByRole("combobox"), "30");
    await waitFor(() => expect(gets("/api/inventory/expiring").at(-1)!.query.get("days")).toBe("30"));
  });

  it("says so when nothing expires", async () => {
    state.routes = { "GET /api/inventory/expiring": () => report({ rows: [], counts: { expired: 0, today: 0, soon: 0 } }) };
    renderAs(<ExpiryScreen />, ["inventory.view"]);
    expect(await screen.findByText("Nothing expires in this period")).toBeInTheDocument();
  });
});

describe("purchase order approval note and line review", () => {
  const line = (id: string, over: Record<string, unknown> = {}) => ({ id, materialId: `m-${id}`, qty: "10", receivedQty: "0", rate: "100", taxPct: "0", lineStatus: "ACTIVE", requestedQty: null, ...over });
  const po = (over: Record<string, unknown> = {}) => ({
    id: "po1", number: "PO-0007", status: "SUBMITTED", vendorId: "v1", outletId: OUT_A, expectedDate: null, subtotal: "1500", tax: "0", total: "1500", notes: null, approvedAt: null, createdAt: "2026-10-08T10:00:00Z",
    lines: [line("l1"), line("l2", { qty: "5", rate: "100" })], receipts: [],
    approval: { plan: "SINGLE", needed: 1, done: 0, firstApprovedBy: null, approvedBy: null, autoApproved: false, youApprovedFirst: false }, ...over,
  });
  const base = (doc: unknown) => ({
    "GET /api/procurement/purchase-orders/po1": () => doc,
    "GET /api/master/materials": () => ({ items: [{ id: "m-l1", name: "Flour", sku: "F", baseUnit: { code: "kg" } }, { id: "m-l2", name: "Sugar", sku: "S", baseUnit: { code: "kg" } }], nextCursor: null }),
    "GET /api/master/vendors": () => ({ items: [{ id: "v1", name: "Fresh Farms" }], nextCursor: null }),
  });

  it("an approver reviews the lines: only what changed is sent, and a line can be taken off", async () => {
    state.routes = { ...base(po()), "POST /api/procurement/purchase-orders/po1/review": () => ({ id: "po1" }) };
    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"] as never);
    await userEvent.click(await screen.findByRole("button", { name: "Review lines" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("No changes yet.")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    expect(await within(dlg).findByText("Nothing was changed")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);

    const qty = within(dlg).getByLabelText("Quantity of Flour");
    await userEvent.clear(qty);
    await userEvent.type(qty, "6");
    await userEvent.click(within(dlg).getByRole("button", { name: "Take Sugar off" }));
    expect(within(dlg).getByText("2 changes; 1 line stays on the order.")).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("Note (optional)"), "cut back");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ lines: [{ lineId: "l1", action: "KEEP", qty: 6 }, { lineId: "l2", action: "REJECT" }], note: "cut back" });
  });

  it("will not take every line off, and a taken-off line can be put back", async () => {
    state.routes = base(po({ lines: [line("l1"), line("l2", { lineStatus: "REJECTED", requestedQty: "5" })] }));
    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"] as never);
    await userEvent.click(await screen.findByRole("button", { name: "Review lines" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByRole("button", { name: "Put Sugar back" })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Take Flour off" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Save review" }));
    expect(await within(dlg).findByText(/At least one line has to stay/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("only an approver sees the review button, and only while the order is submitted", async () => {
    state.routes = base(po());
    const first = renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.create"] as never);
    await screen.findByText("PO PO-0007");
    expect(screen.queryByRole("button", { name: "Review lines" })).toBeNull();
    first.unmount();
    state.routes = base(po({ status: "APPROVED" }));
    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"] as never);
    await screen.findByText("PO PO-0007");
    expect(screen.queryByRole("button", { name: "Review lines" })).toBeNull();
  });

  it("a rejected line is struck through with its original quantity kept in view", async () => {
    state.routes = base(po({ status: "APPROVED", lines: [line("l1", { qty: "6", requestedQty: "10" }), line("l2", { lineStatus: "REJECTED" })] }));
    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view"] as never);
    const table = await screen.findByRole("table", { name: "PO lines" });
    expect(within(table).getByText("was 10")).toBeInTheDocument();
    expect(within(table).getByText("Rejected")).toBeInTheDocument();
  });

  it("the note says what the rules asked of this order; a second approver is counted and the first approver cannot approve twice", async () => {
    state.routes = base(po({ approval: { plan: "DUAL", needed: 2, done: 0, firstApprovedBy: null, approvedBy: null, autoApproved: false, youApprovedFirst: false } }));
    const a = renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"] as never);
    expect(await screen.findByTestId("approval-note")).toHaveTextContent(/needs two different approvers\. No one has approved it yet/);
    expect(screen.getByRole("button", { name: "Approve (1 of 2)" })).toBeInTheDocument();
    a.unmount();

    state.routes = base(po({ approval: { plan: "DUAL", needed: 2, done: 1, firstApprovedBy: "Asha", approvedBy: null, autoApproved: false, youApprovedFirst: true } }));
    const b = renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view", "purchase.approve"] as never);
    expect(await screen.findByTestId("approval-note")).toHaveTextContent(/Asha gave the first approval \(you\); a second approver has to give the other/);
    expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull(); // you cannot be the second approver
    b.unmount();

    state.routes = base(po({ status: "APPROVED", approval: { plan: "AUTO", needed: 0, done: 0, firstApprovedBy: null, approvedBy: null, autoApproved: true, youApprovedFirst: false } }));
    renderAs(<PurchaseOrderDetail id="po1" />, ["purchase.view"] as never);
    expect(await screen.findByTestId("approval-note")).toHaveTextContent("Approved automatically");
  });
});

describe("importing a spreadsheet", () => {
  const checked = (over: Record<string, unknown> = {}) => ({
    kind: "materials", committed: false, counts: { create: 2, skip: 1, error: 0 }, newCategories: ["Spices"], columns: { used: ["name", "unit"], ignored: ["Weird"] }, note: "Nothing has been saved yet. Import to create the rows marked Create.",
    rows: [{ line: 2, label: "Turmeric", action: "CREATE" }, { line: 3, label: "Cumin", action: "CREATE" }, { line: 4, label: "Rice", action: "SKIP", message: "already exists (SKU RICE-1)" }], ...over,
  });
  const materialRoutes = (importRoute: (c: Call) => unknown) => ({
    "GET /api/master/materials": () => ({ items: [], nextCursor: null }),
    "GET /api/master/material-categories": () => [],
    "POST /api/master/import/materials": importRoute,
  });

  it("checks first (nothing is saved), lists what each line would do, then imports exactly that", async () => {
    state.routes = materialRoutes((c) => (c.body.commit ? checked({ committed: true, note: "Imported." }) : checked()));
    renderAs(<MaterialsScreen />, ["master.manage", "master.view"] as never, { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog", { name: "Import materials" });
    expect(within(dlg).getByRole("button", { name: "Check file" })).toBeDisabled(); // nothing pasted yet
    expect(within(dlg).getByRole("button", { name: "Import" })).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(/Or paste the rows/), { target: { value: "Name,Unit\nTurmeric,kg\nCumin,kg\nRice,kg\n" } });
    await userEvent.click(within(dlg).getByRole("button", { name: "Check file" }));
    expect(await within(dlg).findByTestId("import-summary")).toHaveTextContent("Checked: 2 to create, 1 already there, 0 with errors.");
    expect(within(dlg).getByText("Columns not used: Weird.")).toBeInTheDocument();
    expect(within(dlg).getByText(/New categories: Spices/)).toBeInTheDocument();
    const rows = within(within(dlg).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows[2]).toHaveTextContent("Skip");
    expect(rows[2]).toHaveTextContent("already exists");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ csv: "Name,Unit\nTurmeric,kg\nCumin,kg\nRice,kg\n", commit: false });

    await userEvent.click(within(dlg).getByRole("button", { name: "Import 2 rows" }));
    await waitFor(() => expect(within(dlg).getByTestId("import-summary")).toHaveTextContent("Imported: 2 to create"));
    expect(posts()[1].body).toMatchObject({ commit: true });
    expect(within(dlg).queryByRole("button", { name: "Check file" })).toBeNull(); // done: only Close is left
    expect(within(dlg).getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("a file with an error cannot be imported until it is fixed; editing the text drops the old check", async () => {
    state.routes = materialRoutes(() => checked({ counts: { create: 1, skip: 0, error: 1 }, note: "Fix the lines marked as errors, then check the file again.", rows: [{ line: 2, label: "Fine", action: "CREATE" }, { line: 3, label: "Broken", action: "ERROR", message: 'unit "nope" is not one of your units' }] }));
    renderAs(<MaterialsScreen />, ["master.manage", "master.view"] as never, { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog", { name: "Import materials" });
    fireEvent.change(within(dlg).getByLabelText(/Or paste the rows/), { target: { value: "Name,Unit\nFine,kg\nBroken,nope\n" } });
    await userEvent.click(within(dlg).getByRole("button", { name: "Check file" }));
    expect(await within(dlg).findByText(/unit "nope" is not one of your units/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Fix the lines marked as errors/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Import" })).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText(/Or paste the rows/), { target: { value: "Name,Unit\nFine,kg\n" } });
    expect(within(dlg).queryByTestId("import-summary")).toBeNull();
  });

  it("a file the server cannot read shows why; vendors and the template are offered; a login that cannot manage master data sees no button", async () => {
    state.routes = { "GET /api/master/vendors": () => ({ items: [], nextCursor: null }), "POST /api/master/import/vendors": () => fail(422, "ValidationError", "The file has a header but no rows") };
    const v = renderAs(<VendorsScreen />, ["vendor.manage", "vendor.view"] as never, { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog", { name: "Import vendors" });
    expect(within(dlg).getByRole("button", { name: "Download template" })).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText(/Or paste the rows/), { target: { value: "Name\n" } });
    await userEvent.click(within(dlg).getByRole("button", { name: "Check file" }));
    expect(await within(dlg).findByText("The file has a header but no rows")).toBeInTheDocument();
    v.unmount();

    state.routes = { "GET /api/master/materials": () => ({ items: [], nextCursor: null }), "GET /api/master/material-categories": () => [] };
    renderAs(<MaterialsScreen />, ["master.view"] as never, { orgWide: true });
    await screen.findByRole("table", { name: "Materials" });
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });
});

describe("vendor contacts", () => {
  const vendor = (contacts: unknown[] = []) => ({ id: "v1", name: "Fresh Farms", companyName: null, phone: null, email: null, gstin: null, paymentTerms: null, creditLimit: "0", address: null, notes: null, bankAccount: null, bankIfsc: null, active: true, status: "ACTIVE", category: "Produce", natureOfSupply: "GOODS", materials: [], contacts });
  const contact = (over: Record<string, unknown> = {}) => ({ id: "c1", name: "Meera", role: "Accounts", phone: "+91 98765 43210", email: "meera@example.com", isPrimary: true, ...over });

  it("lists the people to call with the main one marked, and shows the vendor's category and nature of supply", async () => {
    state.routes = { "GET /api/master/vendors/v1": () => vendor([contact(), contact({ id: "c2", name: "Rahul", role: "Delivery", isPrimary: false, phone: null })]), "GET /api/master/materials": () => ({ items: [], nextCursor: null }) };
    renderAs(<VendorDetail id="v1" />, ["vendor.view", "master.view"] as never);
    const table = await screen.findByRole("table", { name: "Vendor contacts" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Meera");
    expect(rows[0]).toHaveTextContent("Main");
    expect(rows[1]).toHaveTextContent("Rahul");
    expect(screen.getByText("Produce")).toBeInTheDocument();
    expect(screen.getByText("Goods")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add contact" })).toBeNull(); // read-only without vendor.manage
  });

  it("a vendor manager adds, edits and removes contacts", async () => {
    let contacts = [contact()];
    state.routes = {
      "GET /api/master/vendors/v1": () => vendor(contacts), "GET /api/master/materials": () => ({ items: [], nextCursor: null }),
      "POST /api/master/vendors/v1/contacts": (c) => { contacts = [...contacts, contact({ id: "c9", isPrimary: false, ...(c.body as object) })]; return contacts.at(-1); },
      "PATCH /api/master/vendor-contacts/c1": () => contact({ role: "Finance" }),
      "DELETE /api/master/vendor-contacts/c1": () => { contacts = []; return { id: "c1" }; },
    };
    renderAs(<VendorDetail id="v1" />, ["vendor.view", "vendor.manage", "master.view"] as never, { orgWide: true });
    await userEvent.click(await screen.findByRole("button", { name: "Add contact" }));
    const dlg = await screen.findByRole("dialog", { name: "New contact" });
    await userEvent.type(within(dlg).getByLabelText(/Name/), "Rahul");
    await userEvent.type(within(dlg).getByLabelText(/^Role/), "Delivery desk");
    await userEvent.type(within(dlg).getByLabelText("Phone"), "9812345678");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add contact" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ name: "Rahul", role: "Delivery desk", phone: "9812345678", email: null, isPrimary: false });
    expect(await screen.findByText("Rahul")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit Meera" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Meera" });
    const role = within(edit).getByLabelText(/^Role/);
    await userEvent.clear(role);
    await userEvent.type(role, "Finance");
    await userEvent.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts().some((p) => p.method === "PATCH")).toBe(true));
    expect(posts().find((p) => p.method === "PATCH")!.body).toMatchObject({ role: "Finance" });

    const meera = within(await screen.findByRole("table", { name: "Vendor contacts" })).getAllByRole("row").find((r) => r.textContent?.includes("Meera"))!;
    await userEvent.click(within(meera).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove Meera?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posts().some((p) => p.method === "DELETE" && p.path === "/api/master/vendor-contacts/c1")).toBe(true));
  });
});

describe("indent fulfilment", () => {
  const indent = (over: Record<string, unknown> = {}) => ({
    id: "i1", number: "IND-0003", status: "APPROVED", outletId: OUT_A, departmentId: null, notes: null, createdAt: "2026-10-08T10:00:00Z",
    lines: [{ id: "il1", materialId: "m-l1", qty: "10" }, { id: "il2", materialId: "m-l2", qty: "4" }],
    fulfilment: {
      lines: [{ materialId: "m-l1", requested: 10, issued: 6, outstanding: 4, baseUnitId: "kg" }, { materialId: "m-l2", requested: 4, issued: 4, outstanding: 0, baseUnitId: "kg" }],
      complete: false, issues: [{ id: "is1", number: "ISS-0001", status: "ISSUED", issuedAt: "2026-10-09T08:00:00Z" }],
    }, ...over,
  });
  const base = (doc: unknown) => ({
    "GET /api/procurement/indents/i1": () => doc,
    "GET /api/master/materials": () => ({ items: [{ id: "m-l1", name: "Flour", sku: "F", baseUnit: { code: "kg" } }, { id: "m-l2", name: "Sugar", sku: "S", baseUnit: { code: "kg" } }], nextCursor: null }),
    "GET /api/master/departments": () => [{ id: "d-store", name: "Store", kind: "STORE", active: true, outletId: OUT_A }, { id: "d-kit", name: "Kitchen", kind: "KITCHEN", active: true, outletId: OUT_A }],
  });

  it("shows what was asked, what has gone out and what is still needed, with links to the issues", async () => {
    state.routes = base(indent());
    renderAs(<IndentDetail id="i1" />, ["purchase.view", "indent.create"] as never);
    const table = await screen.findByRole("table", { name: "Indent fulfilment" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Flour");
    expect(rows[0]).toHaveTextContent("10 kg");
    expect(rows[0]).toHaveTextContent("4"); // still needed
    expect(rows[1]).toHaveTextContent("Done");
    expect(within(screen.getByRole("list", { name: "Issues against this indent" })).getByRole("link", { name: "ISS-0001" })).toHaveAttribute("href", "/inventory/issues/is1");
    expect(screen.queryByRole("button", { name: "Issue stock" })).toBeNull(); // needs inventory.issue
  });

  it("the store starts an issue from the indent with the outstanding quantities; the issue is tied to the indent", async () => {
    state.routes = { ...base(indent()), "POST /api/inventory/issues": () => ({ id: "is2" }) };
    renderAs(<IndentDetail id="i1" />, ["purchase.view", "inventory.issue"] as never);
    await userEvent.click(await screen.findByRole("button", { name: "Issue stock" }));
    const dlg = await screen.findByRole("dialog", { name: "Issue stock for indent IND-0003" });
    expect(within(dlg).getByLabelText("Qty")).toHaveValue(4); // only the line that is still needed
    await userEvent.selectOptions(within(dlg).getByLabelText(/^To department/), "d-kit");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create issue (draft)" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toMatchObject({ outletId: OUT_A, indentId: "i1", toDepartmentId: "d-kit", lines: [{ materialId: "m-l1", qty: 4 }] });
    expect(posts()[0].headers["Idempotency-Key"] ?? posts()[0].headers["idempotency-key"]).toBeTruthy();
  });

  it("once everything is issued there is no button; a draft indent shows no fulfilment card", async () => {
    const done = indent({ status: "CLOSED", fulfilment: { lines: [{ materialId: "m-l1", requested: 10, issued: 10, outstanding: 0, baseUnitId: "kg" }], complete: true, issues: [{ id: "is1", number: "ISS-0001", status: "ISSUED", issuedAt: "2026-10-09T08:00:00Z" }] } });
    state.routes = base(done);
    const a = renderAs(<IndentDetail id="i1" />, ["purchase.view", "inventory.issue"] as never);
    expect(await screen.findByRole("table", { name: "Indent fulfilment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issue stock" })).toBeNull();
    a.unmount();
    state.routes = base(indent({ status: "DRAFT", fulfilment: { lines: [], complete: false, issues: [] } }));
    renderAs(<IndentDetail id="i1" />, ["purchase.view", "inventory.issue"] as never);
    await screen.findByText("Indent IND-0003");
    expect(screen.queryByRole("table", { name: "Indent fulfilment" })).toBeNull();
  });
});
