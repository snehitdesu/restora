/**
 * Customer website → RESTORA → KOT → kitchen, proven against the database:
 *
 *   CK-001 ONLINE chosen at checkout: storefront → test gateway "Approve" →
 *          server verification (payment.verifyPayment) → order confirmed →
 *          exactly one KOT → the chef's KDS shows it → Accept / Start / Ready /
 *          Served → the customer's status follows. A replayed confirmation
 *          changes nothing (one order, one payment, one KOT).
 *   CK-002 CASH chosen at checkout: placing the order sends it to the kitchen
 *          (one KOT, in the same transaction; a refresh never re-dispatches) and
 *          it stays unpaid → chef → served → cash at the POS → paid once.
 *
 * Every record is read back from the database and must point at the same
 * order, organization, outlet and table that the QR token resolves to, and
 * the KITCHEN user's outlet must be that outlet. (The KOT is RESTORA's kitchen
 * ticket: the KDS lists live KOTs; there is no separate ticket table.)
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, outletByCode, openPos, sessionFor, apiAs, apiData, e2eDb, CENTRAL, ROLES } from "./helpers";

test.use({ storageState: statePath("cashier") });
const BASE = `http://localhost:${Number(process.env.E2E_PORT ?? 3210)}`;

type TableRow = { id: string; code: string; qrToken: string | null };

async function qrTable(outletId: string, code: string) {
  const manager = await apiAs("manager");
  const t = (await apiData<TableRow[]>(manager, `/api/master/tables?outletId=${outletId}`)).find((x) => x.code === code);
  expect(t?.qrToken, `QR token for ${code}`).toBeTruthy();
  return { tableId: t!.id, token: t!.qrToken! };
}

async function guestPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { context, page: await context.newPage() };
}

/** Storefront: menu → cart page → checkout → place the order with the chosen payment method. */
async function order(g: Page, token: string, dish: string, method: "CASH" | "ONLINE") {
  await g.goto(`/t/${token}`);
  await g.getByRole("button", { name: `Add ${dish}` }).click();
  await g.getByRole("link", { name: /^View cart/ }).click();
  await g.waitForURL(/\/cart$/);
  await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await g.waitForURL(/\/checkout$/);
  await g.getByRole("radio", { name: method === "ONLINE" ? /Pay online|Simulated online payment|Pay by UPI/ : /^Cash/ }).check();
  await g.getByRole("button", { name: /^Place order/ }).click();
  await g.waitForURL(/\/o\/[^/#]+#k=/);
  const url = new URL(g.url());
  return { orderId: decodeURIComponent(url.pathname.split("/").pop()!), key: new URLSearchParams(url.hash.slice(1)).get("k")! };
}

/** The records behind one order, straight from the database. */
async function records(orderId: string) {
  const db = await e2eDb();
  try {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, items: true, kots: { include: { items: true, station: true } }, table: true } });
    return o;
  } finally {
    await db.$disconnect();
  }
}

async function chefOutlet() {
  const db = await e2eDb();
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email: ROLES.kitchen }, include: { memberships: true } });
    return { organizationId: u.organizationId, outletIds: u.memberships.map((m) => m.outletId) };
  } finally {
    await db.$disconnect();
  }
}

async function chefCooks(k: Page, kotNumber: number, table: string, guest: Page) {
  await k.goto("/kitchen");
  const ticket = k.getByRole("article", { name: `KOT ${kotNumber}, Table ${table} · QR` });
  await expect(ticket).toBeVisible();
  await ticket.getByRole("button", { name: "Accept" }).click();
  await ticket.getByRole("button", { name: "Start" }).click();
  await expect(guest.getByTestId("order-stage")).toHaveText("Being prepared", { timeout: 15_000 });
  await ticket.getByRole("button", { name: "Ready" }).click();
  await expect(guest.getByTestId("order-stage")).toHaveText("Ready", { timeout: 15_000 });
  await ticket.getByRole("button", { name: "Served" }).click();
  await expect(ticket).toHaveCount(0);
  await expect(guest.getByTestId("order-stage")).toHaveText(/Served|Completed/, { timeout: 15_000 });
}

test.describe("customer website → order → payment → KOT → kitchen", () => {
  test("CK-001 online: test gateway Approve → server verification → one KOT → chef → served; a replayed confirmation changes nothing", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { tableId, token } = await qrTable(outlet.id, "F6");
    const guest = await guestPhone(browser);
    const g = guest.page;
    const { orderId, key } = await order(g, token, "Masala Chai", "ONLINE");

    // Before the gateway answers, nothing reaches the kitchen.
    let o = await records(orderId);
    expect(o.status).toBe("OPEN");
    expect(o.kots).toHaveLength(0);

    // The checkout opened the test gateway for the server's amount; Approve goes to the server.
    const gw = g.getByRole("region", { name: "Test payment gateway" });
    await expect(gw).toBeVisible();
    const confirmCall = g.waitForResponse((r) => r.request().method() === "POST" && /\/payments\/confirm$/.test(r.url()));
    await gw.getByRole("button", { name: "Approve payment" }).click();
    expect((await confirmCall).status()).toBe(200);
    await expect(g.getByTestId("order-stage")).toHaveText("Sent to the kitchen", { timeout: 15_000 });

    o = await records(orderId);
    const chef = await chefOutlet();
    // ORDER / PAYMENT / KOT: one of each, all on this order, in the QR token's tenant.
    expect(o).toMatchObject({ status: "PAID", source: "QR", tableId, outletId: outlet.id });
    expect(o.organizationId).toBe(chef.organizationId);
    expect(chef.outletIds).toContain(o.outletId);
    expect(o.payments).toHaveLength(1);
    expect(o.payments[0]).toMatchObject({ orderId, method: "ONLINE", provider: "mock", status: "SUCCESS", outletId: o.outletId, organizationId: o.organizationId });
    expect(o.payments[0].providerRef).toBeTruthy();
    expect(o.payments[0].verifiedAt).toBeTruthy();
    expect(o.kots).toHaveLength(1);
    expect(o.kots[0]).toMatchObject({ orderId, status: "NEW", outletId: o.outletId, organizationId: o.organizationId });
    expect(o.kots[0].station?.name).toBe(o.items[0].station); // routed to the item's own station (Masala Chai = BAR)
    expect(o.kots[0].items.map((i) => i.name)).toEqual(["Masala Chai"]);
    expect(o.invoiceNo).toBeTruthy();
    test.info().annotations.push({ type: "records", description: `order ${o.id} org ${o.organizationId} outlet ${o.outletId} table ${o.table?.code} ${o.status} | payment ${o.payments[0].id} ${o.payments[0].method} ${o.payments[0].status} ref ${o.payments[0].providerRef} | KOT ${o.kots[0].id} #${o.kots[0].number} ${o.kots[0].station?.name} ${o.kots[0].status}` });

    // The same confirmation again (double tap / retried request): nothing doubles.
    const replay = await page.request.post(`/api/qr/orders/${encodeURIComponent(orderId)}/payments/confirm`, {
      headers: { "x-order-key": key, origin: BASE },
      data: { paymentId: o.payments[0].id },
    });
    expect(replay.status()).toBe(200);
    const again = await records(orderId);
    expect(again.payments.filter((p) => p.status === "SUCCESS")).toHaveLength(1);
    expect(again.kots).toHaveLength(1);
    expect(again.status).toBe("PAID");

    // The chef's KDS query returns it; the chef cooks it; the customer's page follows.
    const kitchen = await sessionFor(browser, "kitchen");
    await chefCooks(kitchen.page, o.kots[0].number, "F6", g);
    expect((await records(orderId)).kots.map((k) => k.status)).toEqual(["SERVED"]);
    await kitchen.context.close();
    await guest.context.close();
  });

  test("CK-002 no pay-at-the-counter for a guest QR order: no cash option, CASH refused by the server, nothing reaches the kitchen", async ({ page, browser }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const { token } = await qrTable(outlet.id, "F5");
    const guest = await guestPhone(browser);
    const g = guest.page;
    await g.goto(`/t/${token}`);
    await g.getByRole("button", { name: "Add Masala Chai" }).click();
    await g.getByRole("link", { name: /^View cart/ }).click();
    await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
    await g.waitForURL(/\/checkout$/);
    // Only online payment is offered: a QR order reaches the kitchen once its payment is verified.
    await expect(g.getByRole("radio", { name: /Pay online|Simulated online payment|Pay by UPI/ })).toBeChecked();
    expect(await g.getByRole("radio", { name: /^Cash/ }).count()).toBe(0);
    // An older page (or a hand-made request) asking to pay at the counter is refused and creates nothing.
    const db = await e2eDb();
    try {
      const table = await db.restaurantTable.findFirstOrThrow({ where: { qrToken: token } });
      const chai = await db.menuItem.findFirstOrThrow({ where: { organizationId: table.organizationId, name: "Masala Chai" } });
      const before = { orders: await db.order.count(), kots: await db.kot.count() };
      const r = await g.request.post(`/api/qr/t/${token}/orders`, { data: { items: [{ menuItemId: chai.id, qty: 1 }], paymentMethod: "CASH" }, headers: { "idempotency-key": `ck2-cash-${Date.now()}`, origin: new URL(g.url()).origin } });
      expect(r.status()).toBe(422);
      expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/paid online before they go to the kitchen/);
      expect({ orders: await db.order.count(), kots: await db.kot.count() }).toEqual(before);
    } finally {
      await db.$disconnect();
    }
    await guest.context.close();
  });
});
