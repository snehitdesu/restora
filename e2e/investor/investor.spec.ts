/**
 * INVESTOR ACCEPTANCE — the whole restaurant transaction in real browsers,
 * against the production build, on the real Coders' Cafe menu:
 *
 *   DEVICE 1  owner   (desktop)  Tables → Table T07's QR; finance / analytics / audit
 *   DEVICE 2  manager (desktop)  sees the paid order; rings up a counter sale and takes cash
 *   DEVICE 3  customer (phone)   scans T07 → real menu → cart → order → pays by UPI QR
 *   KITCHEN   chef    (desktop)  KDS: accept → start → ready → served
 *
 * INV-001 UPI QR success · INV-002 counter cash (staff order) · INV-003 the
 * bank declines, then a new QR is paid. After each: exactly one order, one
 * successful payment, one KOT, one invoice; finance and analytics moved by the
 * order total; audit records exist.
 *
 * The bank = tests/support/upiBankEmulator.ts (a dynamic-UPI-QR bank, RESTORA's
 * own TEST wire format — NOT SBI) behind UPI_EMULATOR_BASE (see
 * playwright.investor.config.ts); the adapter reports mode MOCK. The test plays
 * the payer's UPI app by telling the emulator the QR was paid; the bank then
 * sends its signed callback. Everything RESTORA does — the QR for the server's
 * amount, the page polling RESTORA, the server asking the bank, the callback,
 * settlement, the kitchen release — is the real code path.
 */
import { test, expect, type Browser, type BrowserContext, type Page, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { UpiBankEmulator } from "../../tests/support/upiBankEmulator";
import { INVESTOR_PORT, EMULATOR_PORT, INVESTOR_UPI, INVESTOR_DB_URL } from "../../playwright.investor.config";

const BASE = `http://localhost:${INVESTOR_PORT}`;
const PASSWORD = "Demo@12345";
const USERS = { owner: "cafe.owner@demo.local", manager: "cafe.manager@demo.local", chef: "cafe.chef@demo.local" } as const;
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const bank = new UpiBankEmulator({ ...INVESTOR_UPI, port: EMULATOR_PORT, webhookUrl: `${BASE}/api/webhooks/payment/upi_emulator` });
const db = new PrismaClient({ datasourceUrl: `${INVESTOR_DB_URL}?connection_limit=1&socket_timeout=30` });

test.beforeAll(async () => {
  await bank.start();
});
test.afterAll(async () => {
  await bank.stop();
  await db.$disconnect();
});

/** The bank reference of the QR currently shown for an order (read-only, from the database). */
async function shownQr(orderId: string) {
  const p = await db.payment.findFirstOrThrow({ where: { orderId, status: "PENDING", providerRef: { not: null } }, orderBy: { createdAt: "desc" } });
  return { paymentId: p.id, reference: p.providerRef! };
}

// ---------------- devices ----------------

async function staff(browser: Browser, who: keyof typeof USERS): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who]);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

/** The customer's phone (no payment script: the bank's QR is drawn by RESTORA). */
async function customerPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { context, page: await context.newPage() };
}

// ---------------- server state (through the real API, as the owner) ----------------

type OrderDTO = { id: string; status: string; channel: string; total: string; items: Array<{ name: string; qty: string; modifiers: Array<{ name: string }> }>; payments?: Array<{ method: string; status: string; amount: string }>; kots?: Array<{ id: string; number: number; status: string }>; invoiceNo?: string | null };
async function get<T>(api: APIRequestContext, url: string): Promise<T> {
  const r = await api.get(url);
  expect(r.status(), url).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
const orderIdFrom = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!);
const ref = (orderId: string) => orderId.slice(-6).toUpperCase();

async function exactlyOnce(api: APIRequestContext, outletId: string, orderId: string, total: number, method: string) {
  const o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
  expect(o.status).toBe("PAID");
  expect(Number(o.total)).toBe(total);
  expect(o.payments!.filter((p) => p.status === "SUCCESS").map((p) => [p.method, Number(p.amount)])).toEqual([[method, total]]);
  expect(o.kots).toHaveLength(1);
  const fin = await get<{ items: Array<{ orderId: string; status: string; amount: number; method: string }> }>(api, `/api/finance/payments?outletId=${outletId}&orderId=${orderId}`);
  expect(fin.items.filter((p) => p.status === "SUCCESS").map((p) => [p.method, p.amount])).toEqual([[method, total]]);
  const audit = await get<{ items: Array<{ action: string }> }>(api, `/api/audit?entityType=Order&entityId=${orderId}`);
  expect(audit.items.length).toBeGreaterThanOrEqual(1);
  return o;
}

// ---------------- the scenario ----------------

async function scanTable07(owner: Page) {
  await owner.goto("/tables");
  await owner.getByRole("button", { name: "QR for T07" }).click();
  const dlg = owner.getByRole("dialog", { name: /QR — table T07/ });
  await expect(dlg.getByRole("img", { name: "QR code for table T07" })).toBeVisible();
  const link = (await dlg.getByLabel("Guest ordering link").textContent())!.trim();
  expect(link).toMatch(new RegExp(`^${BASE}/t/[A-Za-z0-9_-]+$`)); // PUBLIC_BASE_URL, not the viewer's origin
  await dlg.getByRole("button", { name: "Close" }).first().click();
  return link;
}

async function orderFromTable(guest: Page, link: string, cart: Array<{ item: string; size?: string; addOn?: string; times?: number }>, expectedTotal: number) {
  await guest.goto(link);
  await expect(guest.getByLabel("Table T07").first()).toBeVisible();
  await expect(guest.getByText("Coders' Cafe").first()).toBeVisible();
  for (const line of cart) {
    const times = line.times ?? 1;
    if (line.size || line.addOn) {
      // Sizes / add-ons: the item sheet with the item's real RESTORA variants and modifier group.
      for (let i = 0; i < times; i++) {
        await guest.getByRole("button", { name: `Add ${line.item}` }).click();
        const dlg = guest.getByRole("dialog", { name: line.item });
        if (line.size) await dlg.getByRole("radio", { name: new RegExp(`^${line.size}`) }).check();
        if (line.addOn) await dlg.getByRole("checkbox", { name: new RegExp(`^${line.addOn}`) }).check();
        await dlg.getByRole("button", { name: /^Add/ }).click();
      }
    } else {
      await guest.getByRole("button", { name: `Add ${line.item}` }).click();
      for (let i = 1; i < times; i++) await guest.getByRole("button", { name: `Increase ${line.item}` }).click();
    }
  }
  // Sticky cart → cart (priced by the server) → checkout → place the order.
  await guest.getByRole("link", { name: /^View cart/ }).click();
  await expect(guest.getByTestId("cart-total")).toHaveText(inr(expectedTotal));
  await guest.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await expect(guest.getByText("Table T07").first()).toBeVisible();
  // Online payment is the only way a QR order is paid; against the emulator the adapter reports MOCK ("simulated").
  await expect(guest.getByRole("radio", { name: /Pay online|Simulated online payment|Pay by UPI/ })).toBeChecked();
  expect(await guest.getByRole("radio", { name: /^Cash/ }).count()).toBe(0);
  await guest.getByRole("button", { name: /^Place order/ }).click();
  await guest.waitForURL(/\/o\/[^/#]+#k=/);
  // The order page asks for the bank's QR by itself ("Place order & pay").
  await expect(guest.getByTestId("upi-qr")).toBeVisible();
  await expect(guest.getByTestId("upi-amount")).toHaveText(inr(expectedTotal));
  return orderIdFrom(guest);
}

async function kitchenCompletes(chef: Page, orderId: string, expectLines: string[], channel: RegExp = /Table T07 · QR$/) {
  await chef.goto("/kitchen");
  const ticket = chef.getByRole("article", { name: channel });
  await expect(ticket).toBeVisible();
  for (const l of expectLines) await expect(ticket).toContainText(l);
  await ticket.getByRole("button", { name: "Accept" }).click();
  await ticket.getByRole("button", { name: "Start" }).click();
  await ticket.getByRole("button", { name: "Ready" }).click();
  await ticket.getByRole("button", { name: "Served" }).click();
  await expect(ticket).toHaveCount(0);
  void orderId;
}

test.describe("investor acceptance — Coders' Cafe, Table 07", () => {
  test("INV-001 UPI QR: scan T07, real menu, pay by the bank's QR, kitchen, bill, finance, analytics — nothing doubled", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const manager = await staff(browser, "manager");
    const chef = await staff(browser, "chef");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;
    const before = await get<{ orders: number; revenue: number }>(api, `/api/analytics/sales-summary?outletId=${outletId}`);

    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;
    // Real items and board prices on the customer's phone.
    await g.goto(link);
    await expect(g.getByRole("button", { name: "Add Classic Margherita Pizza" })).toBeVisible();
    await expect(g.getByRole("listitem").filter({ hasText: "Classic Margherita Pizza" }).first()).toContainText("₹99");
    await expect(g.getByRole("listitem").filter({ hasText: "Guntur Chiken 65" }).first()).toContainText("₹240");

    // ---- checkout: the bank's QR on the order page for the SERVER's amount. (160 + 60) + 2 × 110 = 440 + 5% = 462
    const orderId = await orderFromTable(g, link, [
      { item: "Classic Margherita Pizza", size: "Medium", addOn: "Make It a Cheese Melt" },
      { item: "Classic Fries", size: "Large", times: 2 },
    ], 462);
    const qr = await shownQr(orderId);
    expect(bank.txn(qr.reference)).toMatchObject({ amountPaise: 46200, currency: "INR", status: "PENDING" });
    // Not paid yet: nothing in the kitchen, the page is waiting for the bank.
    let o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
    expect(o).toMatchObject({ channel: "QR", total: "462", status: "OPEN" });
    expect(o.kots).toHaveLength(0);
    await expect(g.getByTestId("upi-waiting")).toContainText("Waiting for the bank to confirm");

    // ---- the payer's UPI app pays; the bank sends its signed callback; the page learns it from RESTORA.
    const cb = await bank.pay(qr.reference);
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible({ timeout: 30_000 });
    o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
    expect(o.items.map((i) => [i.name, Number(i.qty)])).toEqual([["Classic Margherita Pizza (Medium)", 1], ["Classic Fries (Large)", 2]]);
    // A redelivered callback is a duplicate.
    expect(await (await bank.deliver(cb)).json()).toMatchObject({ status: "DUPLICATE" });

    // ---- manager sees the same order; the kitchen gets it as one KOT (prepaid → sent automatically)
    await manager.page.goto(`/pos/bill/${orderId}`);
    const staffCopy = manager.page.getByRole("article", { name: /^Receipt / });
    await expect(staffCopy).toContainText("Table T07");
    await expect(staffCopy).toContainText(inr(462));
    await expect(staffCopy).toContainText("Paid");
    await kitchenCompletes(chef.page, orderId, ["Classic Margherita Pizza (Medium)", "Pizza Add-ons: Make It a Cheese Melt", "2 × Classic Fries (Large)"]);
    await expect(g.getByTestId("order-stage")).toHaveText("Completed", { timeout: 20_000 });

    // ---- the bill is the order; payment, finance, analytics, audit all agree, once
    o = await exactlyOnce(api, outletId, orderId, 462, "ONLINE");
    const receipt = await g.getByRole("article", { name: /^Receipt / }).innerText();
    expect(receipt).toContain("Classic Margherita Pizza (Medium)");
    expect(receipt).toContain(inr(462));
    expect(receipt).toMatch(/Invoice CC\/\d{4}\/\d{5}/);
    const after = await get<{ orders: number; revenue: number }>(api, `/api/analytics/sales-summary?outletId=${outletId}`);
    expect(after.orders - before.orders).toBe(1);
    expect(after.revenue - before.revenue).toBeCloseTo(462, 2);
    const paymentAudit = await get<{ items: Array<{ action: string; after: unknown }> }>(api, `/api/audit?entityType=Payment&action=PAYMENT`);
    expect(paymentAudit.items.length).toBeGreaterThanOrEqual(1);

    for (const d of [owner, manager, chef, guest]) await d.context.close();
  });

  test("INV-002 counter cash: the guest's QR cannot pay at the counter; the manager rings the order up at the POS, the kitchen cooks, cash is taken once", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const manager = await staff(browser, "manager");
    const chef = await staff(browser, "chef");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;

    // The guest's checkout has no cash option (a QR order is paid online before it reaches the kitchen).
    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;
    await g.goto(link);
    await g.getByRole("button", { name: "Add Loaded Veg Nachos" }).click();
    await g.getByRole("link", { name: /^View cart/ }).click();
    await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
    await expect(g.getByText("Table T07").first()).toBeVisible();
    expect(await g.getByRole("radio", { name: /^Cash/ }).count()).toBe(0);
    await guest.context.close();

    // The manager takes the same table's order at the counter POS instead: a staff order, cash at the till.
    // 150 + 185 = 335 + 5% = 351.75
    const m = manager.page;
    await m.goto("/pos");
    await expect(m.getByRole("button", { name: /^Loaded Veg Nachos,/ })).toBeVisible();
    await m.getByRole("button", { name: /Choose table|^Table / }).first().click();
    const tables = m.getByRole("dialog", { name: "Choose table" });
    await tables.getByRole("button", { name: /^Table T07,/ }).click();
    await expect(tables).toBeHidden();
    await m.getByRole("button", { name: /^Loaded Veg Nachos,/ }).click();
    await m.getByRole("button", { name: /^Veg Arrabita Penne,/ }).click();
    const created = m.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await m.getByRole("button", { name: "Send to kitchen" }).click();
    const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;

    // A staff order goes to the kitchen at once; the chef cooks it.
    await kitchenCompletes(chef.page, orderId, ["Loaded Veg Nachos", "Veg Arrabita Penne"], /^KOT \d+, Table T07$/); // a staff dine-in ticket: no "· QR"

    await m.getByRole("button", { name: "Pay", exact: true }).click();
    const dlg = m.getByRole("dialog", { name: "Take payment" });
    await expect(dlg.getByRole("radio", { name: "Cash" })).toHaveAttribute("aria-checked", "true");
    await dlg.getByLabel("Cash received").fill("400");
    await expect(dlg.getByText(`Change to return: ${inr(48.25)}`)).toBeVisible();
    await dlg.getByRole("button", { name: `Charge ${inr(351.75)}` }).click();
    await expect(dlg.getByText("Paid in full")).toBeVisible();
    await dlg.getByRole("button", { name: "Done" }).click();

    await exactlyOnce(api, outletId, orderId, 351.75, "CASH");
    // A second charge attempt on the settled order is refused by the server.
    const again = await m.request.post("/api/payments", { data: { orderId, method: "CASH", amount: 351.75 }, headers: { origin: BASE } });
    expect(again.status()).toBe(422);
    for (const d of [owner, manager, chef]) await d.context.close();
  });

  test("INV-003 the bank declines: nothing paid or cooked; a new QR is paid once", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const api = owner.page.request;
    const outletId = (await get<Array<{ id: string; code: string }>>(api, "/api/master/outlets")).find((o) => o.code === "CC01")!.id;
    const link = await scanTable07(owner.page);
    const guest = await customerPhone(browser);
    const g = guest.page;

    // 210 + 5% = 220.50; the payer's bank declines the QR payment.
    const orderId = await orderFromTable(g, link, [{ item: "Butter Garlic Wings (6 Pc)" }], 220.5);
    const first = await shownQr(orderId);
    await bank.pay(first.reference, "FAILED");
    await expect(g.getByRole("alert").filter({ hasText: /declined.*You can try again|The payment was declined/ })).toBeVisible({ timeout: 30_000 });
    let o = await get<OrderDTO>(api, `/api/orders/${orderId}`);
    expect(o.status).toBe("OPEN");
    expect(o.kots).toHaveLength(0);
    expect(o.payments!.filter((p) => p.status === "SUCCESS")).toHaveLength(0);

    // The guest tries again: a NEW QR (a new bank transaction), paid this time.
    await g.getByRole("button", { name: /^(Pay online|Resume payment)/ }).click();
    await expect(g.getByTestId("upi-qr")).toBeVisible();
    const second = await shownQr(orderId);
    expect(second.reference).not.toBe(first.reference);
    await bank.pay(second.reference);
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible({ timeout: 30_000 });
    o = await exactlyOnce(api, outletId, orderId, 220.5, "ONLINE");
    expect(o.payments!.map((p) => p.status).sort()).toEqual(["FAILED", "SUCCESS"]);
    for (const d of [owner, guest]) await d.context.close();
  });

  test("INV-004 recipes: every drafted dish is linked to its menu item, clearly marked as estimated, and cannot be approved as it is", async ({ browser }) => {
    const owner = await staff(browser, "owner");
    const o = owner.page;
    const organizationId = (await db.organization.findFirstOrThrow({ where: { name: "Coders' Cafe" } })).id;
    const drafts = await db.recipe.count({ where: { organizationId } });
    expect(drafts).toBe(61); // prisma/coders-cafe/recipes.ts: every board item except three combos whose contents are unreadable
    expect(await db.recipeVersion.count({ where: { organizationId, NOT: { status: "DRAFT", estimated: true } } })).toBe(0);

    await o.goto("/recipes");
    await o.getByPlaceholder("Search recipe name…").fill("Margherita");
    const row = o.getByRole("row", { name: /Classic Margherita Pizza/ });
    await expect(row).toContainText("Estimated");
    await expect(row).toContainText("Draft");
    await row.click();
    await expect(o).toHaveURL(/\/recipes\/[^/]+$/);
    await expect(o.getByRole("heading", { level: 1, name: "Classic Margherita Pizza" })).toBeVisible();
    await expect(o.getByRole("link", { name: "Classic Margherita Pizza" })).toBeVisible(); // linked to the menu item
    await expect(o.getByText(`(${inr(99)})`)).toBeVisible(); // the board's price, unchanged
    await expect(o.getByTestId("recipe-estimated")).toContainText("never used for stock consumption, purchasing or food cost");
    const lines = o.getByRole("table", { name: "Recipe lines" });
    await expect(lines).toContainText("Thin crust pizza base (regular)");
    await expect(lines).toContainText("Mozzarella cheese");
    await expect(o.getByText(/ESTIMATED DRAFT/).first()).toBeVisible();
    await expect(o.getByText(/Indicative cost at .* \(estimated quantities\)/)).toBeVisible();
    // No ingredient costs were ever entered: the card says so instead of showing a ₹0.00 "cost".
    await expect(o.getByText("Cost unavailable", { exact: true })).toBeVisible();
    await expect(o.getByTestId("recipe-cost-unpriced")).toContainText("Cost unavailable: ingredient costs not entered");
    await expect(o.getByRole("table", { name: "Cost breakdown" }).getByText("₹0.00")).toHaveCount(0);

    // Approving as it is: refused by the server, explained in the dialog, nothing changes.
    await o.getByRole("button", { name: "Approve", exact: true }).click();
    const dlg = o.getByRole("dialog", { name: "Approve version 1?" });
    await dlg.getByRole("button", { name: "Confirm" }).click();
    await expect(dlg.getByText(/estimated quantities that the kitchen has not confirmed/)).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    const v = await db.recipeVersion.findFirstOrThrow({ where: { organizationId, recipe: { name: "Classic Margherita Pizza" } } });
    expect(v).toMatchObject({ status: "DRAFT", estimated: true, approvedAt: null });
    await owner.context.close();
  });
});
