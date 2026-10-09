/**
 * Floor and counter operations through the real production build:
 *  - FLOOR-001 captain (phone): move an order to another table, merge another table's order into it, split a bill
 *  - FLOOR-002 cashier (desktop): hold a named bill at the counter, find it in the Held tab, resume and send it
 *  - FLOOR-003 manager (desktop): "table ready" message to a waiting party (mock provider; the outbox holds a masked number)
 *  - FLOOR-004 kitchen (desktop): a seated booking's note is printed on the kitchen ticket
 * Every table this spec uses is its own (created through the API), so no other spec's orders are touched.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { statePath, outletByCode, apiData, apiCall, apiAs, openPos, setOrderType, addSimpleItem, posCart, ticketFor, PASSWORD, CENTRAL } from "./helpers";

const RUN = Date.now().toString(36).toUpperCase();
type Table = { id: string; code: string };

async function ownTable(code: string): Promise<Table> {
  const manager = await apiAs("manager");
  const outlet = await outletByCode(manager, CENTRAL);
  const made = await apiCall<Table>(manager, "POST", "/api/master/tables", { outletId: outlet.id, code, capacity: 6 });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await manager.dispose();
  return made.body!.data;
}
async function menuId(req: APIRequestContext, outletId: string, name: string) {
  const menu = await apiData<Array<{ id: string; name: string }>>(req, `/api/menu?outletId=${outletId}&activeOnly=true`);
  const m = menu.find((x) => x.name === name);
  expect(m, `menu item ${name}`).toBeTruthy();
  return m!.id;
}
const dishes = ["Masala Chai", "Paneer Tikka", "Cola"];
/** An order at a table, sent to the kitchen, placed through the real API as the captain. */
async function orderAt(table: Table, names: string[], key: string) {
  const captain = await apiAs("captain");
  const outlet = await outletByCode(captain, CENTRAL);
  const items = [];
  for (const n of names) items.push({ menuItemId: await menuId(captain, outlet.id, n), qty: 1 });
  const placed = await apiCall<{ id: string }>(captain, "POST", "/api/orders", { outletId: outlet.id, channel: "DINE_IN", tableId: table.id, covers: 2, items, submit: true }, { "idempotency-key": key });
  expect(placed.status, JSON.stringify(placed.body)).toBe(200);
  await captain.dispose();
  return placed.body!.data.id;
}
const orderOf = async (req: APIRequestContext, id: string) => apiData<{ id: string; status: string; tableId: string; total: string; items: Array<{ name: string }> }>(req, `/api/orders/${id}`);

test.describe("captain floor operations (phone)", () => {
  test.use({ storageState: statePath("captain"), viewport: { width: 393, height: 851 }, hasTouch: true, isMobile: true });

  test("FLOOR-001 move to another table, merge another order in, split the bill", async ({ page }) => {
    const [t1, t2, t3] = [await ownTable(`FA${RUN}`), await ownTable(`FB${RUN}`), await ownTable(`FC${RUN}`)];
    const o1 = await orderAt(t1, dishes, `floor-o1-${RUN}`);
    const o3 = await orderAt(t3, ["Cola"], `floor-o3-${RUN}`);

    // Move: the order and its tickets leave the first table, which is free again.
    await page.goto("/captain");
    await page.getByTestId(`table-${t1.code}`).tap();
    await page.getByRole("button", { name: /Move/ }).tap();
    await page.getByRole("dialog", { name: "Move to another table" }).getByRole("button", { name: `Move to table ${t2.code}` }).tap();
    await expect(page.getByRole("button", { name: `Table ${t2.code}` }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Table actions" })).toBeVisible();
    expect((await orderOf(page.request, o1)).tableId).toBe(t2.id);
    await page.getByRole("button", { name: /All tables/ }).tap();
    await expect(page.getByTestId(`table-${t1.code}`)).toContainText("Free");

    // Merge: the other table's order joins this bill; its table is free.
    await page.getByTestId(`table-${t2.code}`).tap();
    await page.getByRole("button", { name: /Merge/ }).tap();
    const merge = page.getByRole("dialog", { name: "Merge another order into this one" });
    await merge.getByRole("button", { name: new RegExp(`^Merge table ${t3.code} order`) }).tap();
    await expect(merge.getByRole("status")).toContainText(/into order/);
    await merge.getByRole("button", { name: "Merge" }).tap();
    await expect(merge).toBeHidden();
    await expect.poll(async () => (await orderOf(page.request, o1)).items.length).toBe(4);
    expect((await orderOf(page.request, o3)).status).toBe("CANCELLED");
    const mergedTotal = Number((await orderOf(page.request, o1)).total);

    // Split: one dish goes to a new bill at the same table; the bills add up to what the table owed.
    await page.getByRole("button", { name: /Split/ }).tap();
    const split = page.getByRole("dialog", { name: "Split the bill" });
    await expect(split.getByRole("button", { name: /^Split/ })).toBeDisabled();
    await split.getByRole("button", { name: "More Paneer Tikka on the new bill" }).tap();
    const request = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/orders\/[^/]+\/split$/.test(new URL(r.url()).pathname));
    await split.getByRole("button", { name: /^Split · 1 item/ }).tap();
    const res = await request;
    expect(res.status()).toBe(200);
    expect(res.request().headers()["idempotency-key"]).toMatch(/^split-/);
    const body = (await res.json()) as { data: { order: { id: string; total: string }; original: { total: string } } };
    await expect(page.getByRole("group", { name: "Bills at this table" })).toBeVisible();
    expect(Math.abs(Number(body.data.order.total) + Number(body.data.original.total) - mergedTotal)).toBeLessThanOrEqual(0.02);
    expect(await apiData<{ items: Array<{ id: string }> }>(page.request, `/api/orders?outletId=${(await outletByCode(page.request, CENTRAL)).id}&tableId=${t2.id}&active=true`).then((r) => r.items.length)).toBe(2);
  });
});

test.describe("counter hold list (desktop)", () => {
  test.use({ storageState: statePath("cashier") });

  test("FLOOR-002 a named bill is held, found in the Held tab, resumed and sent; it then leaves the list", async ({ page }) => {
    const name = `Ravi ${RUN}`;
    await openPos(page);
    await setOrderType(page, "Takeaway");
    await addSimpleItem(page, "Cola");
    await page.getByLabel("Bill name (optional)").fill(name);
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await page.getByRole("button", { name: "Save" }).click();
    const res = await created;
    expect(res.request().postDataJSON()).toMatchObject({ submit: false, hold: true, holdLabel: name });
    const id = ((await res.json()) as { data: { id: string } }).data.id;
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: /Open orders/ }).click();
    const dlg = page.getByRole("dialog", { name: "Open orders" });
    await dlg.getByRole("tab", { name: "Held" }).click();
    const row = dlg.getByRole("button", { name: new RegExp(`#${id.slice(-6).toUpperCase()}.*Held · ${name}`) });
    await expect(row).toBeVisible();
    await row.click();
    await expect(dlg).toBeHidden();
    await expect(posCart(page)).toBeVisible();
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    await expect.poll(async () => (await orderOf(page.request, id)).status).toBe("SENT");

    await page.getByRole("button", { name: /Open orders/ }).click();
    const again = page.getByRole("dialog", { name: "Open orders" });
    await again.getByRole("tab", { name: "Held" }).click();
    await expect(again.getByRole("button", { name: new RegExp(`Held · ${name}`) })).toHaveCount(0);
  });
});

test.describe("waitlist message (desktop)", () => {
  test.use({ storageState: statePath("manager") });

  test("FLOOR-003 'Table ready' tells a waiting party; the outbox keeps only a masked number", async ({ page }) => {
    const owner = await apiAs("owner");
    expect((await apiCall(owner, "POST", "/api/auth/reauth", { password: PASSWORD, scope: "settings.manage" })).status).toBe(200);
    const conn = await apiCall(owner, "POST", "/api/integrations", { kind: "MESSAGING", provider: "mock", mode: "SANDBOX", status: "CONNECTED", config: { channel: "SMS", templates: {} } });
    expect(conn.status, JSON.stringify(conn.body)).toBe(200);

    const guest = `Waitlist ${RUN}`;
    const mobile = `98${String(Date.now()).slice(-8)}`;
    await page.goto("/reservations");
    await page.getByRole("tab", { name: "Waitlist" }).click();
    await page.getByRole("button", { name: /Add party/ }).click();
    const add = page.getByRole("dialog", { name: "Add to waitlist" });
    await add.getByLabel("Name").fill(guest);
    await add.getByLabel("Phone").fill(mobile);
    await add.getByRole("button", { name: "Add" }).click();
    const row = page.getByRole("table", { name: "Waitlist" }).getByRole("row").filter({ hasText: guest });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: `Tell ${guest} the table is ready` }).click();
    await expect(page.getByText(new RegExp(`${guest} was told by`))).toBeVisible();
    await expect(row.getByText(/Told .* ago/)).toBeVisible();
    await expect(row.getByRole("button", { name: `Tell ${guest} the table is ready` })).toHaveText("Tell again");

    const deliveries = await apiData<Array<{ sourceType: string; target: string; status: string; mode: string }>>(owner, "/api/integrations/deliveries?kind=MESSAGE&take=200");
    const masked = `+91${"*".repeat(6)}${mobile.slice(-4)}`; // first three and last four characters only
    const mine = deliveries.filter((d) => d.target === masked);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ sourceType: "Customer", mode: "MOCK" }) // the mock provider is labelled as such, never as live;
    expect(deliveries.some((d) => d.target.includes(mobile))).toBe(false); // the full number is never in the outbox
    await owner.dispose();
  });
});

test.describe("booking note on the kitchen ticket (desktop)", () => {
  test.use({ storageState: statePath("kitchen") });

  test("FLOOR-004 a seated booking's note is printed on the kitchen ticket", async ({ page }) => {
    const table = await ownTable(`FD${RUN}`);
    const manager = await apiAs("manager");
    const outlet = await outletByCode(manager, CENTRAL);
    const note = `Anniversary - cake at 9pm ${RUN}`;
    const booked = await apiCall<{ id: string }>(manager, "POST", "/api/reservations", { outletId: outlet.id, tableId: table.id, partySize: 2, reservedAt: new Date(Date.now() + 5 * 60_000).toISOString(), notes: note });
    expect(booked.status, JSON.stringify(booked.body)).toBe(200);
    expect((await apiCall(manager, "POST", `/api/reservations/${booked.body!.data.id}/seat`, {})).status).toBe(200);
    await manager.dispose();
    await orderAt(table, ["Masala Chai"], `floor-note-${RUN}`);

    await page.goto("/kitchen");
    const ticket = ticketFor(page, table.code);
    await expect(ticket).toBeVisible();
    await expect(ticket).toContainText(`Booking note: ${note}`);
  });
});
