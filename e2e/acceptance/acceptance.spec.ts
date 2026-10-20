/**
 * CODERS' CAFE CUSTOMER / INVESTOR ACCEPTANCE TEST — thirty steps, fresh state.
 *
 *   CUSTOMER    1-8    scan table T07 → live menu → add item → cart → checkout → pay online → paid
 *   BACKEND     9-14   order created by the server, payment verified by the server, state, no shortcut,
 *                      exactly one KOT, restaurant / outlet / table
 *   KITCHEN     15-20  chef account: NEW → Accept → Start → Ready → Served
 *   BACK OFFICE 21-25  POS order history, Finance / Money Desk, invoice, inventory (once), analytics
 *   NEGATIVE    26-30  failed payment, duplicate webhook / payment, duplicate submission,
 *                      amount tampering, restaurant / outlet / table tampering
 *
 * Real browsers (a phone for the customer, desktops for owner / manager / chef), the production build,
 * a real SQLite database built from nothing by prepare-db.ts, and the dynamic-UPI-QR bank emulator
 * (tests/support/upiBankEmulator.ts) behind UPI_EMULATOR_BASE — RESTORA's own TEST wire format, not SBI's.
 * The test plays the payer's UPI app by telling the emulator a QR was paid (or declined); the bank then
 * sends its signed callback. Everything RESTORA does (the QR for the server's amount, the page polling
 * RESTORA, the server's own status lookup at the bank, signed callbacks, settlement) is the real code path.
 * Classification: LOCAL EMULATOR evidence — not SBI UAT, not production. Database reads in this file are
 * read-only and independent of the application's own APIs.
 *
 * Every step records what it observed (ids, statuses, amounts, HTTP codes); the run writes them to
 * e2e/.evidence-acceptance/acceptance-evidence.{json,md} (+ screenshots). A step that fails is reported
 * as FAIL with the reason: nothing here is "implemented" unless the observation proves it.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { UpiBankEmulator, type UpiCallback } from "../../tests/support/upiBankEmulator";
import { ACCEPTANCE_PORT, ACCEPTANCE_EMULATOR_PORT, ACCEPTANCE_UPI } from "../../playwright.acceptance.config";
import { ACCEPTANCE_DB_PATH, CAFE_GSTIN, DISH, INGREDIENTS, OTHER } from "./fixture";

const BASE = `http://localhost:${ACCEPTANCE_PORT}`;
const PASSWORD = "Demo@12345";
const USERS = { owner: "cafe.owner@demo.local", manager: "cafe.manager@demo.local", chef: "cafe.chef@demo.local" } as const;
const SECOND_DISH = { name: "Veg Arrabita Penne", total: 194.25 } as const; // 185 + 5% — no recipe, never paid in this suite
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rupees = (v: unknown) => Number(v);

// ------------------------------------------------------------------ evidence

type Facts = Record<string, unknown>;
type Evidence = { step: number | string; group: string; title: string; result: "PASS" | "FAIL"; at: string; facts: Facts };
const EVIDENCE_DIR = path.join(process.cwd(), "e2e", ".evidence-acceptance");
const evidence: Evidence[] = [];
/** The headline identifiers of the main order (filled while the first test runs). */
const ids: Facts = {};
/** The customer's access key for the main order: a credential, so it is kept out of the evidence. */
let mainOrderKey = "";
/**
 * Playwright starts a fresh worker (and reloads this module) after a failed test, so what the earlier tests
 * recorded is written to disk after every step and read back at the start of the next test.
 */
const STATE_FILE = path.join(EVIDENCE_DIR, "state.json");
let runKey = "";
function persist() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ runKey, evidence, ids, mainOrderKey }));
}
function restore() {
  if (!fs.existsSync(STATE_FILE)) return;
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { runKey: string; evidence: Evidence[]; ids: Facts; mainOrderKey: string };
  if (saved.runKey !== runKey) return; // another database: a previous run
  evidence.splice(0, evidence.length, ...saved.evidence);
  Object.assign(ids, saved.ids);
  mainOrderKey = saved.mainOrderKey;
}

async function step(n: number | string, group: string, title: string, fn: () => Promise<Facts | void>) {
  await test.step(`${n}. ${title}`, async () => {
    const at = new Date().toISOString();
    try {
      evidence.push({ step: n, group, title, result: "PASS", at, facts: (await fn()) ?? {} });
      persist();
    } catch (e) {
      evidence.push({ step: n, group, title, result: "FAIL", at, facts: { error: String((e as Error).message).slice(0, 1200) } });
      persist();
      throw e;
    }
  });
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(path.join(EVIDENCE_DIR, "screens"), { recursive: true });
  const file = `${String(fs.readdirSync(path.join(EVIDENCE_DIR, "screens")).length + 1).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "screens", file), fullPage: false });
  return `screens/${file}`;
}

// ------------------------------------------------------------------ infrastructure

const emu = new UpiBankEmulator({ ...ACCEPTANCE_UPI, port: ACCEPTANCE_EMULATOR_PORT, webhookUrl: `${BASE}/api/webhooks/payment/upi_emulator` });
/** A bank callback delivered to RESTORA: HTTP status + RESTORA's answer. */
async function deliver(cb: UpiCallback | string, signature?: string) {
  const r = await emu.deliver(cb, signature);
  return { status: r.status, body: (await r.json().catch(() => null)) as unknown };
}
const db = new PrismaClient({ datasourceUrl: `file:${ACCEPTANCE_DB_PATH.replace(/\\/g, "/")}?connection_limit=1&socket_timeout=30` });
let anon: APIRequestContext; // a stranger: no cookies
/** Each simulated visitor is a different customer on a different connection (guest writes are limited to 60 a minute per address). */
async function asVisitor(ip: string) {
  await anon?.dispose();
  anon = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE, "x-forwarded-for": ip } });
}

test.beforeAll(async () => {
  await emu.start();
  await asVisitor("203.0.113.10");
  runKey = (await db.organization.findFirstOrThrow({ where: { name: "Coders' Cafe" }, select: { id: true } })).id; // new for every fresh database
  restore();
});
test.afterAll(async () => {
  await emu.stop();
  await anon.dispose();
  await db.$disconnect();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, "acceptance-evidence.json"), JSON.stringify({ generatedAt: new Date().toISOString(), ids, steps: evidence }, null, 2));
  fs.writeFileSync(path.join(EVIDENCE_DIR, "acceptance-evidence.md"), renderMarkdown());
});

function renderMarkdown(): string {
  const fact = (v: unknown) => "`" + JSON.stringify(v).replace(/\|/g, "\\|") + "`";
  const lines = ["# Coders' Cafe acceptance evidence", "", `_Generated ${new Date().toISOString()} by e2e/acceptance/acceptance.spec.ts_`, "", "## Identifiers of the main order", "", "| What | Value |", "|---|---|"];
  for (const [k, v] of Object.entries(ids)) lines.push(`| ${k} | ${fact(v)} |`);
  lines.push("", "## Steps", "");
  for (const e of [...evidence].sort((a, b) => String(a.step).localeCompare(String(b.step), undefined, { numeric: true }))) {
    lines.push(`### ${e.step}. ${e.title} — ${e.result}`, `_${e.group}_`, "");
    for (const [k, v] of Object.entries(e.facts)) lines.push(`- **${k}**: ${fact(v)}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ devices

async function staff(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

type Traffic = { path: string; headers: Record<string, string>; body: string | null };

/** The customer's phone. No payment script is loaded: the bank's UPI QR is drawn by RESTORA. */
async function customerPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const traffic: Traffic[] = [];
  const responses: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/qr/")) traffic.push({ path: new URL(r.url()).pathname, headers: r.headers(), body: r.postData() });
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/qr/")) void r.text().then((t) => responses.push(t)).catch(() => undefined);
  });
  return { context, page, traffic, responses };
}

/** The bank reference of the QR currently shown for an order (read-only, from the database). */
async function shownQr(orderId: string) {
  const p = await until("the bank's QR for the order", () => db.payment.findFirst({ where: { orderId, status: "PENDING", providerRef: { not: null } }, orderBy: { createdAt: "desc" } }));
  return { paymentId: p.id, reference: p.providerRef! };
}

// ------------------------------------------------------------------ small helpers

type Reply = { status: number; json: { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string } } | null };
async function call(api: APIRequestContext, method: "GET" | "POST", url: string, opts: { data?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const r = method === "GET" ? await api.get(url, { headers: opts.headers }) : await api.post(url, { data: opts.data ?? {}, headers: { origin: BASE, ...opts.headers } });
  return { status: r.status(), json: (await r.json().catch(() => null)) as Reply["json"] };
}
async function data<T>(api: APIRequestContext, url: string): Promise<T> {
  const r = await call(api, "GET", url);
  expect(r.status, url).toBe(200);
  return r.json!.data as unknown as T;
}
const message = (r: Reply) => r.json?.error?.message ?? r.json?.error?.code ?? "";
const guestHeaders = (key: string, idem?: string) => ({ "x-order-key": key, ...(idem ? { "idempotency-key": idem } : {}) });

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 25_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const parseOrderUrl = (page: Page) => {
  const u = new URL(page.url());
  return { orderId: decodeURIComponent(u.pathname.split("/").pop()!), key: new URLSearchParams(u.hash.slice(1)).get("k")! };
};
const ref = (orderId: string) => orderId.slice(-6).toUpperCase();

/** The books at a glance — compared before and after every attack. */
async function books() {
  return {
    paidOrders: await db.order.count({ where: { status: "PAID" } }),
    successPayments: await db.payment.count({ where: { status: "SUCCESS" } }),
    kots: await db.kot.count(),
    invoices: await db.taxInvoice.count({ where: { kind: "INVOICE" } }),
    consumptionRows: await db.inventoryLedger.count({ where: { txnType: "SALE_CONSUMPTION" } }),
  };
}

async function orderState(orderId: string) {
  const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, kots: true } });
  return { status: o.status, payments: o.payments.map((p) => p.status), successPayments: o.payments.filter((p) => p.status === "SUCCESS").length, kots: o.kots.length, invoiceNo: o.invoiceNo };
}

const cafeOrgId = async () => (await db.organization.findFirstOrThrow({ where: { name: "Coders' Cafe" }, select: { id: true } })).id;

async function shopFront(tableCode: string) {
  const t = await db.restaurantTable.findFirstOrThrow({ where: { code: tableCode, organizationId: await cafeOrgId() } });
  return { table: t, link: `${BASE}/t/${t.qrToken}` };
}

/** The customer's journey from the QR page to the placed order (cart priced by the server). */
async function orderFromTable(guest: Page, link: string, tableCode: string, cart: Array<{ item: string; times?: number }>, expectedTotal: number, pay: "ONLINE" = "ONLINE") {
  await guest.goto(link);
  await expect(guest.getByLabel(`Table ${tableCode}`).first()).toBeVisible();
  for (const line of cart) {
    await guest.getByRole("button", { name: `Add ${line.item}` }).click();
    for (let i = 1; i < (line.times ?? 1); i++) await guest.getByRole("button", { name: `Increase ${line.item}` }).click();
  }
  await guest.getByRole("link", { name: /^View cart/ }).click();
  await expect(guest.getByTestId("cart-total")).toHaveText(inr(expectedTotal));
  await guest.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await expect(guest.getByText(`Table ${tableCode}`).first()).toBeVisible();
  // Online payment is the only way a QR order is paid (no pay-at-the-counter option exists).
  if (pay === "ONLINE") await expect(guest.getByRole("radio", { name: /Simulated online payment|Pay online|Pay by UPI/ })).toBeChecked();
  expect(await guest.getByRole("radio", { name: /^Cash/ }).count()).toBe(0);
}
async function placeOrder(guest: Page) {
  await guest.getByRole("button", { name: /^Place order/ }).click();
  await guest.waitForURL(/\/o\/[^/#]+#k=/);
  return parseOrderUrl(guest);
}

let nextKey = 0;
const idem = (label: string) => `acc-${label}-${Date.now().toString(36)}-${++nextKey}`;

/** What the customer's browser sends to place an order, for the API-level attacks. */
const cartBody = (menuItemId: string, qty = 1, extra: Record<string, unknown> = {}) => ({ items: [{ menuItemId, qty }], paymentMethod: "ONLINE", ...extra });
async function menuItemId(name: string) {
  return (await db.menuItem.findFirstOrThrow({ where: { name, organizationId: await cafeOrgId() } })).id;
}

/** A bank QR payment for an order the customer holds (what the phone does after "Pay online"). */
async function startPayment(orderId: string, key: string, body: Record<string, unknown> = {}, idemKey = idem("pay")) {
  const r = await call(anon, "POST", `/api/qr/orders/${orderId}/payments`, { data: body, headers: guestHeaders(key, idemKey) });
  return { reply: r, paymentId: r.json?.data?.paymentId as string | undefined, reference: (r.json?.data?.checkout as { reference?: string } | undefined)?.reference };
}

// =====================================================================================================
//   A. THE ORDER, STEPS 1-25
// =====================================================================================================

test("ACC-A  steps 1-25: T07 → live menu → cart → pay online → verified → one KOT → kitchen → POS, finance, invoice, stock, analytics", async ({ browser }) => {
  test.setTimeout(900_000);
  await asVisitor("203.0.113.10");
  const owner = await staff(browser, USERS.owner);
  const manager = await staff(browser, USERS.manager);
  const chef = await staff(browser, USERS.chef);
  const api = owner.page.request;

  const cafe = await db.organization.findFirstOrThrow({ where: { name: "Coders' Cafe" } });
  const outlet = await db.outlet.findFirstOrThrow({ where: { organizationId: cafe.id, code: "CC01" } });
  const t07 = await db.restaurantTable.findFirstOrThrow({ where: { outletId: outlet.id, code: "T07" } });
  const dish = await db.menuItem.findFirstOrThrow({ where: { organizationId: cafe.id, name: DISH.name } });
  const kitchenDept = await db.department.findFirstOrThrow({ where: { outletId: outlet.id, kind: "KITCHEN" } });
  Object.assign(ids, { restaurant: `${cafe.name} (${cafe.id})`, outlet: `${outlet.code} (${outlet.id})`, table: `${t07.code} (${t07.id})` });

  // Nothing exists yet: the state is fresh (this is the proof, not an assumption).
  const fresh = { orders: await db.order.count(), payments: await db.payment.count(), kots: await db.kot.count(), invoices: await db.taxInvoice.count(), saleConsumption: await db.inventoryLedger.count({ where: { txnType: "SALE_CONSUMPTION" } }) };
  expect(fresh).toEqual({ orders: 0, payments: 0, kots: 0, invoices: 0, saleConsumption: 0 });
  const stockBefore = await data<Array<{ name: string; quantity: number; avgCost: number }>>(api, `/api/inventory/stock?outletId=${outlet.id}`);
  for (const ing of INGREDIENTS) expect(stockBefore.find((s) => s.name === ing.name)?.quantity, `opening stock of ${ing.name}`).toBeCloseTo(ing.openingQty, 3);

  // ---- the customer's phone. While the bank's QR is on screen (payment PENDING) every shortcut to "paid" is tried first.
  const shortcuts: Array<{ attack: string; httpStatus: number; response: string; paymentAfter: string; orderAfter: string; kotsAfter: number; invoicesAfter: number }> = [];
  const guest = await customerPhone(browser);
  async function tryEveryShortcut(orderId: string, key: string, payId: string, reference: string) {
    const attack = async (what: string, run: () => Promise<Reply>) => {
      const r = await run();
      const p = await db.payment.findUniqueOrThrow({ where: { id: payId } });
      const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
      shortcuts.push({ attack: what, httpStatus: r.status, response: message(r) || JSON.stringify(r.json?.data ?? {}).slice(0, 120), paymentAfter: p.status, orderAfter: o.status, kotsAfter: await db.kot.count({ where: { orderId } }), invoicesAfter: await db.taxInvoice.count({ where: { orderId } }) });
    };
    const confirm = (body: unknown) => call(anon, "POST", `/api/qr/orders/${orderId}/payments/confirm`, { data: body, headers: guestHeaders(key) });
    await attack("confirm { paymentId, status: 'SUCCESS' }", () => confirm({ paymentId: payId, status: "SUCCESS" }));
    await attack("confirm { paymentId, paid: true, amount: 157.5 }", () => confirm({ paymentId: payId, paid: true, amount: DISH.total }));
    await attack("confirm { paymentId } (no proof: 'did it go through?')", () => confirm({ paymentId: payId }));
    await attack("confirm { paymentId, gateway: { status: SUCCESS, rrn } } ('I paid' + a made-up bank reference)", () => confirm({ paymentId: payId, gateway: { status: "SUCCESS", rrn: "123456789012" } }));
    await attack("confirm { paymentId, providerRef: <the real QR's reference> } (a claim without a payment)", () => confirm({ paymentId: payId, providerRef: reference }));
    await attack("confirm { paymentId, providerRef: <someone else's reference> }", () => confirm({ paymentId: payId, providerRef: "RSTForgedByTheGuest01" }));
    await attack("start payment { status: 'SUCCESS' }", () => call(anon, "POST", `/api/qr/orders/${orderId}/payments`, { data: { status: "SUCCESS" }, headers: guestHeaders(key, idem("shortcut")) }));
    await attack("staff API as a stranger: POST /api/payments CASH for the full amount", () => call(anon, "POST", "/api/payments", { data: { orderId, method: "CASH", amount: DISH.total } }));
    await attack("staff API as a stranger: POST /api/payments/:id/verify", () => call(anon, "POST", `/api/payments/${payId}/verify`, { data: {} }));
    await attack("staff API as a stranger: POST /api/orders/:id/submit (send to kitchen unpaid)", () => call(anon, "POST", `/api/orders/${orderId}/submit`, { data: {} }));
    const forged = JSON.stringify({ eventId: "forged-success-0001", merchantId: ACCEPTANCE_UPI.merchantId, reference, status: "SUCCESS", amountPaise: Math.round(DISH.total * 100), currency: "INR", rrn: "999999999999" });
    await attack("bank callback: SUCCESS with a forged signature", async () => {
      const r = await deliver(forged, "0".repeat(64));
      return { status: r.status, json: r.body as Reply["json"] };
    });
    await attack("bank callback: SUCCESS with no signature at all", async () => {
      const r = await fetch(emu.cfg.webhookUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: forged });
      return { status: r.status, json: (await r.json().catch(() => null)) as Reply["json"] };
    });
  }
  const g = guest.page;

  // ---------------------------------------------------------------- CUSTOMER
  let link = "";
  await step(1, "CUSTOMER", "Open the Coders' Cafe customer / table ordering page (the link printed on the table's QR)", async () => {
    await owner.page.goto("/tables");
    await owner.page.getByRole("button", { name: "QR for T07" }).click();
    const dlg = owner.page.getByRole("dialog", { name: /QR — table T07/ });
    await expect(dlg.getByRole("img", { name: "QR code for table T07" })).toBeVisible();
    link = (await dlg.getByLabel("Guest ordering link").textContent())!.trim();
    expect(link).toBe(`${BASE}/t/${t07.qrToken}`);
    await dlg.getByRole("button", { name: "Close" }).first().click();
    const nav = await g.goto(link);
    expect(nav!.status()).toBe(200);
    await expect(g.getByText("Coders' Cafe").first()).toBeVisible();
    return { qrLink: link, httpStatus: nav!.status(), pageTitle: await g.title(), restaurantShown: "Coders' Cafe", screenshot: await shot(g, "customer-landing-T07") };
  });

  await step(2, "CUSTOMER", "Use a real seeded table (T07): the QR token resolves to Coders' Cafe / outlet CC01 / table T07", async () => {
    await expect(g.getByLabel("Table T07").first()).toBeVisible();
    const menu = await call(anon, "GET", `/api/qr/t/${t07.qrToken}`);
    expect(menu.status).toBe(200);
    expect(menu.json!.data).toMatchObject({ table: { code: "T07" }, restaurant: { name: "Coders' Cafe" } });
    return { tableRow: { id: t07.id, code: t07.code, outletId: t07.outletId, organizationId: t07.organizationId, qrTokenMatchesLink: link.endsWith(t07.qrToken!) }, serverSays: menu.json!.data!.table, seededUsersOfTheCafe: Object.values(USERS) };
  });

  await step(3, "CUSTOMER", "Browse the live menu (the real Coders' Cafe menu at the outlet's prices)", async () => {
    await expect(g.getByRole("button", { name: `Add ${DISH.name}` })).toBeVisible();
    const row = g.getByRole("listitem").filter({ hasText: DISH.name }).first();
    await expect(row).toContainText(`₹${DISH.price}`);
    const uiItems = await g.getByRole("button", { name: /^Add / }).count();
    const menu = (await call(anon, "GET", `/api/qr/t/${t07.qrToken}`)).json!.data as { menu: Array<{ name: string; price: number; soldOut: boolean; category: { name?: string } | string | null }> };
    const apiItem = menu.menu.find((m) => m.name === DISH.name)!;
    expect(apiItem.price).toBe(DISH.price);
    expect(apiItem.soldOut).toBe(false);
    const dbItems = await db.menuItem.count({ where: { organizationId: cafe.id, active: true } });
    expect(menu.menu.length).toBe(dbItems);
    expect(uiItems).toBeGreaterThanOrEqual(1);
    return { itemsInServerMenu: menu.menu.length, activeItemsInDatabase: dbItems, addButtonsOnThePhone: uiItems, spotCheck: { name: DISH.name, uiPrice: `₹${DISH.price}`, apiPrice: apiItem.price, dbPrice: rupees(dish.price) }, screenshot: await shot(g, "customer-live-menu") };
  });

  await step(4, "CUSTOMER", `Add an item (${DISH.name})`, async () => {
    await g.getByRole("button", { name: `Add ${DISH.name}` }).click();
    const bar = g.getByRole("link", { name: /^View cart/ });
    await expect(bar).toBeVisible();
    return { addedItem: DISH.name, stickyCartBar: (await bar.innerText()).replace(/\s+/g, " ") };
  });

  await step(5, "CUSTOMER", "Open the cart (priced by the server; the browser sends no price)", async () => {
    await g.getByRole("link", { name: /^View cart/ }).click();
    await expect(g.getByTestId("cart-total")).toHaveText(inr(DISH.total));
    await expect(g.getByText(DISH.name).first()).toBeVisible();
    // The cart asks the server for its own price a moment after it opens (the figures above are the server's once this settles).
    await expect(g.locator('dl[aria-label="Order total"]')).toHaveAttribute("aria-busy", "false");
    const quotes = await until("the cart's price request to the server", async () => {
      const q = guest.traffic.filter((t) => t.path.endsWith("/quote"));
      return q.length ? q : null;
    });
    const body = JSON.parse(quotes[0].body!) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(body.items[0]).sort()).toEqual(["menuItemId", "qty"]);
    return { cartTotalShown: inr(DISH.total), arithmetic: `₹${DISH.price} + 5% GST ₹${DISH.tax} = ₹${DISH.total}`, quoteRequestBody: body, screenshot: await shot(g, "customer-cart") };
  });

  await step(6, "CUSTOMER", "Checkout", async () => {
    await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
    await expect(g.getByText("Table T07").first()).toBeVisible();
    return { checkoutShows: "Table T07", screenshot: await shot(g, "customer-checkout") };
  });

  await step(7, "CUSTOMER", "Online payment (the bank's UPI QR — here the local bank emulator) is the only payment option", async () => {
    const online = g.getByRole("radio", { name: /Simulated online payment|Pay online|Pay by UPI/ });
    await expect(online).toBeChecked();
    expect(await g.getByRole("radio", { name: /^Cash/ }).count()).toBe(0);
    const options = (await call(anon, "GET", `/api/qr/t/${t07.qrToken}`)).json!.data!.payment as Record<string, unknown>;
    expect(options.online).toBe(true);
    return { paymentOptionsFromServer: options, bank: `upi_emulator adapter → local bank emulator (UPI_EMULATOR_BASE), merchant ${ACCEPTANCE_UPI.merchantId}` };
  });

  let orderId = "";
  let orderKey = "";
  await step(8, "CUSTOMER", "Complete the payment: the bank's QR is shown; after every shortcut fails, the payer pays it; the page learns it from RESTORA", async () => {
    await g.getByRole("button", { name: /^Place order/ }).click();
    await g.waitForURL(/\/o\/[^/#]+#k=/);
    ({ orderId, key: orderKey } = parseOrderUrl(g));
    mainOrderKey = orderKey;
    await expect(g.getByTestId("upi-qr")).toBeVisible();
    await expect(g.getByTestId("upi-amount")).toHaveText(inr(DISH.total));
    const qr = await shownQr(orderId);
    expect(emu.txn(qr.reference)).toMatchObject({ amountPaise: Math.round(DISH.total * 100), currency: "INR", status: "PENDING" });
    const qrScreenshot = await shot(g, "customer-upi-qr");
    await tryEveryShortcut(orderId, orderKey, qr.paymentId, qr.reference);
    await expect(g.getByText("Payment successful. Thank you!")).toHaveCount(0);
    // Now the payer really pays in their UPI app; the bank confirms and sends its signed callback.
    const cb = await emu.pay(qr.reference);
    ids.bankCallback = cb;
    await expect(g.getByText("Payment successful. Thank you!")).toBeVisible({ timeout: 30_000 });
    const pay = await db.payment.findFirstOrThrow({ where: { orderId, status: "SUCCESS" } });
    Object.assign(ids, { orderId, orderRef: `#${ref(orderId)}`, restoraPaymentId: pay.id, bankReference: pay.providerRef, bankRrn: cb.rrn });
    return { orderId, qrShownFor: inr(DISH.total), bankReference: qr.reference, bankRrn: cb.rrn, pageShows: "Payment successful. Thank you!", screenshots: [qrScreenshot, await shot(g, "customer-paid")] };
  });

  // ---------------------------------------------------------------- BACKEND
  await step(9, "BACKEND", "The server creates the RESTORA order", async () => {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, payments: true } });
    expect(o).toMatchObject({ channel: "QR", source: "QR" });
    expect(o.items.map((i) => [i.name, rupees(i.qty), rupees(i.unitPrice), rupees(i.lineTotal)])).toEqual([[DISH.name, 1, DISH.price, DISH.price]]);
    expect([rupees(o.subtotal), rupees(o.tax), rupees(o.total)]).toEqual([DISH.price, DISH.tax, DISH.total]);
    const viaApi = await data<{ id: string; total: string; status: string }>(api, `/api/orders/${orderId}`);
    expect(viaApi.id).toBe(orderId);
    expect(rupees(viaApi.total)).toBe(DISH.total);
    const sent = guest.traffic.find((t) => t.path.endsWith("/orders"))!;
    const sentBody = JSON.parse(sent.body!) as { items: Array<Record<string, unknown>> };
    expect(Object.keys(sentBody.items[0]).sort()).toEqual(["menuItemId", "qty"]);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityType: "Order", entityId: orderId, action: "CREATE", after: { contains: "guest-qr" } } });
    return { orderId, ref: `#${ref(orderId)}`, channel: o.channel, source: o.source, lines: o.items.map((i) => `${rupees(i.qty)} × ${i.name} @ ₹${rupees(i.unitPrice)}`), subtotal: rupees(o.subtotal), gst: rupees(o.tax), total: rupees(o.total), orderRequestTheBrowserSent: sentBody, createAuditEntry: { id: audit.id, action: audit.action, after: audit.after } };
  });

  await step(10, "BACKEND", "The payment is actually verified server-side (the server's own status lookup at the bank: merchant, reference, amount, INR, final status)", async () => {
    const p = await db.payment.findFirstOrThrow({ where: { orderId, status: "SUCCESS" } });
    expect(p).toMatchObject({ method: "ONLINE", provider: "upi_emulator", status: "SUCCESS" });
    expect(p.verifiedAt).not.toBeNull();
    expect(rupees(p.amount)).toBe(DISH.total);
    expect(p.providerRef).toBe(`RST${p.id}`.slice(0, 35)); // RESTORA's own reference, never the client's
    const txn = emu.txn(p.providerRef!);
    expect(txn).toMatchObject({ amountPaise: Math.round(DISH.total * 100), merchantId: ACCEPTANCE_UPI.merchantId, status: "SUCCESS" }); // the QR was created for the SERVER's amount
    const creates = emu.calls.filter((c) => c.method === "POST" && c.path === "/v1/qr");
    const lookups = emu.calls.filter((c) => c.method === "GET" && c.path === `/v1/qr/${encodeURIComponent(p.providerRef!)}/status`);
    expect(creates).toHaveLength(1);
    expect(lookups.length, "the server asked the bank about the payment itself").toBeGreaterThanOrEqual(1);
    const browserSawSecret = [...guest.responses, await g.content()].some((t) => t.includes(ACCEPTANCE_UPI.apiKey) || t.includes(ACCEPTANCE_UPI.webhookSecret));
    expect(browserSawSecret).toBe(false);
    const audit = await db.auditLog.findMany({ where: { entityType: "Payment", entityId: p.id }, orderBy: { createdAt: "asc" } });
    return { restoraPaymentId: p.id, status: p.status, method: p.method, provider: p.provider, amount: rupees(p.amount), bankReference: p.providerRef, bankRrn: ids.bankRrn, verifiedAt: p.verifiedAt, qrCreatedForPaise: txn.amountPaise, bankCallsMadeByTheServer: emu.calls.map((c) => `${c.method} ${c.path}`), bankCredentialsNeverReachedTheBrowser: !browserSawSecret, paymentAudit: audit.map((a) => ({ action: a.action, after: a.after })) };
  });

  await step(11, "BACKEND", "The order moves to the correct paid / confirmed state", async () => {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { kots: true } });
    expect(o.status).toBe("PAID");
    expect(o.paidAt).not.toBeNull();
    expect(o.kots.map((k) => k.status)).toEqual(["NEW"]);
    const trail = await db.auditLog.findMany({ where: { entityType: "Order", entityId: orderId }, orderBy: { createdAt: "asc" } });
    const toPaid = trail.find((a) => a.after?.includes('"status":"PAID"'));
    expect(toPaid, "an audit entry records OPEN → PAID").toBeTruthy();
    const stage = (await g.getByTestId("order-stage").innerText()).trim();
    return { orderStatus: o.status, paidAt: o.paidAt, kotStatusRightAfterPayment: o.kots[0].status, guestPageStage: stage, auditTrail: trail.map((a) => `${a.action} ${a.after ?? ""}`) };
  });

  await step(12, "BACKEND", "No client-side 'paid' shortcut can bypass verification (12 attacks made while the real payment was PENDING)", async () => {
    expect(shortcuts.length).toBeGreaterThanOrEqual(12);
    for (const s of shortcuts) {
      expect(s.paymentAfter, `${s.attack}: payment`).toBe("PENDING");
      expect(s.orderAfter, `${s.attack}: order`).toBe("OPEN");
      expect(s.kotsAfter, `${s.attack}: KOTs`).toBe(0);
      expect(s.invoicesAfter, `${s.attack}: invoices`).toBe(0);
    }
    const byAttack = (needle: string) => shortcuts.filter((s) => s.attack.includes(needle));
    for (const s of [...byAttack("status: 'SUCCESS'"), ...byAttack("paid: true")]) expect(s.httpStatus, s.attack).toBe(422); // strict schemas
    for (const s of byAttack("stranger")) expect(s.httpStatus, s.attack).toBe(401);
    for (const s of byAttack("webhook")) expect(s.httpStatus, s.attack).toBe(401);
    expect(byAttack("no proof")[0].httpStatus).toBe(200); // an honest status check: still PENDING
    expect(byAttack("made-up bank reference")[0].httpStatus).toBe(200); // the browser's payload is ignored: still PENDING
    expect(byAttack("someone else's")[0].httpStatus).toBe(422);
    return { attempts: shortcuts, conclusion: "after every attempt the payment was still PENDING, the order OPEN, with no KOT and no invoice; only the bank's own confirmation (status lookup) settled it" };
  });

  await step(13, "BACKEND", "Exactly one KOT is generated", async () => {
    const kots = await db.kot.findMany({ where: { orderId }, include: { items: true } });
    expect(kots).toHaveLength(1);
    const k = kots[0];
    expect(k.items.map((i) => [i.name, rupees(i.qty)])).toEqual([[DISH.name, 1]]);
    const viaKds = await data<Array<{ id: string; number: number; status: string }>>(owner.page.request, `/api/kitchen/kots?outletId=${outlet.id}`);
    expect(viaKds.filter((x) => x.id === k.id)).toHaveLength(1);
    expect(viaKds.filter((x) => (x as unknown as { orderId?: string }).orderId === orderId || x.id === k.id)).toHaveLength(1);
    Object.assign(ids, { kotId: k.id, kotNumber: k.number });
    return { kotId: k.id, kotNumber: k.number, kotsForThisOrder: kots.length, statusAtCreation: k.status, items: k.items.map((i) => `${rupees(i.qty)} × ${i.name}`), kotsInTheWholeDatabase: await db.kot.count() };
  });

  await step(14, "BACKEND", "The order is associated with the correct restaurant, outlet and table", async () => {
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const p = await db.payment.findFirstOrThrow({ where: { orderId } });
    const k = await db.kot.findFirstOrThrow({ where: { orderId } });
    for (const row of [o, p, k]) {
      expect(row.organizationId).toBe(cafe.id);
      expect(row.outletId).toBe(outlet.id);
    }
    expect(o.tableId).toBe(t07.id);
    return { restaurant: { expected: cafe.id, order: o.organizationId, payment: p.organizationId, kot: k.organizationId }, outlet: { expected: outlet.id, order: o.outletId, payment: p.outletId, kot: k.outletId }, table: { expected: `T07 ${t07.id}`, order: o.tableId } };
  });

  // ---------------------------------------------------------------- KITCHEN
  const ticket = chef.page.getByRole("article", { name: /Table T07 · QR$/ });
  const column = (name: RegExp) => chef.page.getByRole("region", { name });
  const kotStatus = async () => (await db.kot.findUniqueOrThrow({ where: { id: ids.kotId as string } }));
  await step(15, "KITCHEN", "Open the chef / kitchen account", async () => {
    await chef.page.goto("/kitchen");
    await expect(chef.page.getByRole("region", { name: /^New/ })).toBeVisible();
    const money = await call(chef.page.request, "GET", `/api/finance/payments?outletId=${outlet.id}`);
    expect(money.status, "a kitchen login has no money access").toBe(403);
    return { signedInAs: USERS.chef, role: "KITCHEN", kdsUrl: chef.page.url(), financeApiForTheChef: money.status, screenshot: await shot(chef.page, "kitchen-opened") };
  });
  await step(16, "KITCHEN", "The new order appears as NEW", async () => {
    await expect(column(/^New/).getByRole("article", { name: /Table T07 · QR$/ })).toBeVisible();
    await expect(ticket).toContainText(DISH.name);
    expect((await kotStatus()).status).toBe("NEW");
    return { column: "New", ticketTitle: await ticket.getAttribute("aria-label"), ticketText: (await ticket.innerText()).replace(/\s+/g, " ").slice(0, 160), kotStatusInDatabase: "NEW", screenshot: await shot(chef.page, "kitchen-new") };
  });
  await step(17, "KITCHEN", "Accept it", async () => {
    await ticket.getByRole("button", { name: "Accept" }).click();
    const k = await until("KOT ACCEPTED", async () => ((await kotStatus()).status === "ACCEPTED" ? await kotStatus() : null));
    await expect(column(/^In progress/).getByRole("article", { name: /Table T07 · QR$/ })).toBeVisible();
    return { kotStatus: k.status, acceptedAt: k.acceptedAt, column: "In progress" };
  });
  await step(18, "KITCHEN", "Start it", async () => {
    await ticket.getByRole("button", { name: "Start" }).click();
    const k = await until("KOT PREPARING", async () => ((await kotStatus()).status === "PREPARING" ? await kotStatus() : null));
    return { kotStatus: k.status, startedAt: k.startedAt, column: "In progress", screenshot: await shot(chef.page, "kitchen-preparing") };
  });
  await step(19, "KITCHEN", "Mark it Ready", async () => {
    await ticket.getByRole("button", { name: "Ready" }).click();
    const k = await until("KOT READY", async () => ((await kotStatus()).status === "READY" ? await kotStatus() : null));
    await expect(column(/^Ready/).getByRole("article", { name: /Table T07 · QR$/ })).toBeVisible();
    return { kotStatus: k.status, readyAt: k.readyAt, column: "Ready", guestPageNow: (await g.getByTestId("order-stage").innerText()).trim() };
  });
  await step(20, "KITCHEN", "Mark it Served", async () => {
    await ticket.getByRole("button", { name: "Served" }).click();
    const k = await until("KOT SERVED", async () => ((await kotStatus()).status === "SERVED" ? await kotStatus() : null));
    await expect(ticket).toHaveCount(0);
    await expect(g.getByTestId("order-stage")).toHaveText("Completed", { timeout: 20_000 });
    expect([k.acceptedAt, k.startedAt, k.readyAt, k.servedAt].every(Boolean)).toBe(true);
    ids.finalKitchenStatus = k.status;
    return { finalKitchenStatus: k.status, timestamps: { accepted: k.acceptedAt, started: k.startedAt, ready: k.readyAt, served: k.servedAt }, guestPageNow: "Completed", screenshot: await shot(g, "customer-completed") };
  });

  // ---------------------------------------------------------------- BACK OFFICE
  await step(21, "BACK OFFICE", "The order appears in POS / order history", async () => {
    const m = manager.page;
    await m.goto("/pos");
    await m.getByRole("button", { name: /^Open orders/ }).click();
    const dlg = m.getByRole("dialog", { name: "Open orders" });
    await dlg.getByRole("tab", { name: "Recent" }).click();
    const row = dlg.getByRole("listitem").filter({ hasText: `#${ref(orderId)}` });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Table T07");
    await expect(row).toContainText("PAID");
    const shotRecent = await shot(m, "pos-order-history");
    await m.keyboard.press("Escape");
    await m.goto(`/pos/bill/${orderId}`);
    const bill = m.getByRole("article", { name: /^Receipt / });
    await expect(bill).toContainText("Table T07");
    await expect(bill).toContainText(DISH.name);
    await expect(bill).toContainText(inr(DISH.total));
    const list = await data<{ items: Array<{ id: string; status: string; total: string }> }>(manager.page.request, `/api/orders?outletId=${outlet.id}&take=50`);
    expect(list.items.filter((o) => o.id === orderId)).toHaveLength(1);
    return { posRecentTab: `#${ref(orderId)} · Table T07 · QR · PAID`, ordersApiRowsForThisOrder: 1, receiptScreenshot: await shot(m, "pos-receipt"), historyScreenshot: shotRecent };
  });

  await step(22, "BACK OFFICE", "The payment appears in Finance / Money Desk", async () => {
    const payRow = await data<{ items: Array<{ id: string; orderId: string; status: string; amount: number; method: string; providerRef: string | null }> }>(api, `/api/finance/payments?outletId=${outlet.id}&orderId=${orderId}`);
    expect(payRow.items.filter((p) => p.status === "SUCCESS").map((p) => [p.method, p.amount, p.providerRef])).toEqual([["ONLINE", DISH.total, ids.bankReference]]);
    await owner.page.goto("/finance/payments");
    const uiRow = owner.page.getByRole("row").filter({ hasText: String(ids.bankReference) });
    await expect(uiRow).toHaveCount(1);
    await expect(uiRow).toContainText(inr(DISH.total));
    const paymentsScreenRow = (await uiRow.innerText()).replace(/\s+/g, " ");
    const shotPayments = await shot(owner.page, "finance-payments");
    // The Money Desk's business day is the outlet's; try today then yesterday (an early-morning run).
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - 86_400_000));
    type Desk = { businessDate: string; pos: { orders: number; billed: number; tax: number }; collections: Array<{ method: string; expected: number }>; channels: Array<{ key: string; orders: number; billed: number }>; unsettledOrders: number };
    let desk: Desk | null = null;
    for (const d of [today, yesterday]) {
      const candidate = await data<Desk>(api, `/api/finance/money-desk?outletId=${outlet.id}&businessDate=${d}`);
      if (candidate.pos.orders > 0) { desk = candidate; break; }
    }
    expect(desk, "the Money Desk shows the day with this order").not.toBeNull();
    expect(desk!.pos).toMatchObject({ orders: 1, billed: DISH.total, tax: DISH.tax });
    expect(desk!.collections.find((c) => c.method === "ONLINE")?.expected).toBe(DISH.total);
    expect(desk!.unsettledOrders).toBe(0);
    await owner.page.goto("/finance/money-desk");
    await expect(owner.page.getByText(inr(DISH.total)).first()).toBeVisible();
    return { paymentsApiRow: payRow.items.find((p) => p.status === "SUCCESS"), paymentsScreenRow, moneyDeskDay: desk!.businessDate, moneyDesk: { posOrders: desk!.pos.orders, posBilled: desk!.pos.billed, posGst: desk!.pos.tax, collectedOnline: desk!.collections.find((c) => c.method === "ONLINE"), channels: desk!.channels, unsettledOrders: desk!.unsettledOrders }, screenshots: [shotPayments, await shot(owner.page, "finance-money-desk")] };
  });

  await step(23, "BACK OFFICE", "The invoice / bill is generated correctly", async () => {
    const invoices = await db.taxInvoice.findMany({ where: { orderId }, include: { lines: true } });
    expect(invoices).toHaveLength(1);
    const inv = invoices[0];
    const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(inv.kind).toBe("INVOICE");
    expect(inv.number).toMatch(/^CC\/\d{4}\/\d{5}$/);
    expect(o.invoiceNo).toBe(inv.number);
    expect(inv).toMatchObject({ sellerName: "Coders' Cafe", sellerGstin: CAFE_GSTIN, sellerStateCode: "27", supplyType: "INTRA" });
    expect([rupees(inv.taxableValue), rupees(inv.cgst), rupees(inv.sgst), rupees(inv.igst), rupees(inv.totalTax), rupees(inv.total)]).toEqual([DISH.price, DISH.cgst, DISH.sgst, 0, DISH.tax, DISH.total]);
    expect(rupees(inv.taxableValue) + rupees(inv.totalTax)).toBe(rupees(inv.total));
    expect(inv.lines.map((l) => [rupees(l.ratePct), rupees(l.taxableValue), rupees(l.cgst), rupees(l.sgst)])).toEqual([[5, DISH.price, DISH.cgst, DISH.sgst]]);
    expect(await db.taxInvoice.count()).toBe(1);
    const receipt = await g.getByRole("article", { name: /^Receipt / }).innerText();
    expect(receipt).toContain(inv.number);
    expect(receipt).toContain(inr(DISH.total));
    expect(receipt).toContain(DISH.name);
    Object.assign(ids, { invoiceId: inv.id, invoiceNo: inv.number });
    return { invoiceId: inv.id, invoiceNo: inv.number, fiscalYear: inv.fiscalYear, seller: { name: inv.sellerName, gstin: inv.sellerGstin, state: inv.sellerStateCode }, supplyType: inv.supplyType, taxableValue: rupees(inv.taxableValue), cgst2_5: rupees(inv.cgst), sgst2_5: rupees(inv.sgst), igst: rupees(inv.igst), totalTax: rupees(inv.totalTax), total: rupees(inv.total), line: inv.lines.map((l) => `${rupees(l.ratePct)}% on ₹${rupees(l.taxableValue)}`), invoicesForThisOrder: 1, invoiceNumberOnOrder: o.invoiceNo, receiptShownToTheCustomer: "contains the invoice number, the item and ₹157.50", screenshot: await shot(g, "customer-receipt") };
  });

  await step(24, "BACK OFFICE", "Inventory is consumed exactly once", async () => {
    const rows = await db.inventoryLedger.findMany({ where: { sourceType: "ORDER", sourceId: orderId }, orderBy: { sourceRef: "asc" } });
    expect(rows).toHaveLength(INGREDIENTS.length);
    const byMaterial = new Map((await db.material.findMany({ where: { organizationId: cafe.id } })).map((m) => [m.id, m.name]));
    for (const ing of INGREDIENTS) {
      const r = rows.find((x) => byMaterial.get(x.materialId) === ing.name)!;
      expect(r.txnType).toBe("SALE_CONSUMPTION");
      expect(rupees(r.qty)).toBeCloseTo(-ing.perPlate, 6);
      expect(rupees(r.rate)).toBe(ing.rate);
      expect(r.departmentId).toBe(kitchenDept.id);
      expect(r.sourceRef).toBe(`order:${orderId}:mat:${r.materialId}:dept:${kitchenDept.id}`);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).stockConsumed).toBe(true);
    const stock = await data<Array<{ name: string; quantity: number }>>(api, `/api/inventory/stock?outletId=${outlet.id}`);
    for (const ing of INGREDIENTS) expect(stock.find((s) => s.name === ing.name)!.quantity).toBeCloseTo(ing.openingQty - ing.perPlate, 3);
    const foodCost = INGREDIENTS.reduce((a, i) => a + i.perPlate * i.rate, 0);
    return { ledgerRows: rows.map((r) => ({ id: r.id, material: byMaterial.get(r.materialId), type: r.txnType, qty: rupees(r.qty), ratePerKg: rupees(r.rate), amount: rupees(r.amount), sourceRef: r.sourceRef })), onHandAfter: INGREDIENTS.map((i) => ({ material: i.name, opening: i.openingQty, consumed: i.perPlate, onHand: stock.find((s) => s.name === i.name)!.quantity })), theoreticalFoodCost: foodCost, orderStockConsumedFlag: true, note: "re-checked unchanged after the duplicate-webhook tests and at the end (test ACC-Z)" };
  });

  await step(25, "BACK OFFICE", "Analytics / sales reflect the transaction", async () => {
    const summary = await data<{ orders: number; grossSales: number; taxes: number; revenue: number; netSales: number }>(api, `/api/analytics/sales-summary?outletId=${outlet.id}`);
    expect(summary).toMatchObject({ orders: 1, grossSales: DISH.price, taxes: DISH.tax, revenue: DISH.total });
    const items = await data<Array<{ name: string; qty: number; netRevenue: number }>>(api, `/api/analytics/items?outletId=${outlet.id}`);
    expect(items.find((i) => i.name === DISH.name)).toMatchObject({ qty: 1, netRevenue: DISH.price });
    const payments = await data<Array<{ method: string; count: number; collected: number }>>(api, `/api/analytics/payments?outletId=${outlet.id}`);
    expect(payments.find((p) => p.method === "ONLINE")).toMatchObject({ count: 1, collected: DISH.total });
    const cost = await data<number>(api, `/api/analytics/food-cost?outletId=${outlet.id}`);
    expect(cost).toBeCloseTo(INGREDIENTS.reduce((a, i) => a + i.perPlate * i.rate, 0), 2);
    await owner.page.goto("/analytics");
    await expect(owner.page.getByText(inr(DISH.total)).first()).toBeVisible();
    return { salesSummary: summary, itemSales: items.find((i) => i.name === DISH.name), paymentsByMethod: payments, foodCost: cost, screenshot: await shot(owner.page, "analytics") };
  });

  for (const d of [owner, manager, chef, guest]) await d.context.close();
});

// =====================================================================================================
//   B. THE NEGATIVE TESTS, STEPS 26-30
// =====================================================================================================

test("ACC-B  step 26: a failed payment must NOT reach the kitchen as PAID", async ({ browser }) => {
  test.setTimeout(300_000);
  await asVisitor("203.0.113.26");
  expect(ids.orderId, "ACC-A must have produced the main order").toBeTruthy();
  const chef = await staff(browser, USERS.chef);
  const { table, link } = await shopFront("T08");
  const before = await books();
  let bankPayment = "";
  const guest = await customerPhone(browser);

  await step(26, "NEGATIVE", "Failed payment must NOT reach the kitchen as PAID", async () => {
    const checks: Array<{ check: string; observed: unknown }> = [];
    // (a) the payer's bank declines the QR payment (the bank's callback says FAILED)
    await orderFromTable(guest.page, link, "T08", [{ item: SECOND_DISH.name }], SECOND_DISH.total, "ONLINE");
    const { orderId, key } = await placeOrder(guest.page);
    await expect(guest.page.getByTestId("upi-qr")).toBeVisible();
    const first = await shownQr(orderId);
    bankPayment = first.reference;
    await emu.pay(first.reference, "FAILED");
    await expect(guest.page.getByRole("alert").filter({ hasText: /declined.*You can try again/ })).toBeVisible({ timeout: 30_000 });
    let s = await orderState(orderId);
    checks.push({ check: "(a) declined by the payer's bank", observed: s });
    expect(s).toMatchObject({ status: "OPEN", successPayments: 0, kots: 0, invoiceNo: null });
    expect(s.payments).toEqual(["FAILED"]);
    const failedAudit = await db.auditLog.findFirst({ where: { entityType: "Payment", action: "PAYMENT", after: { contains: '"FAILED"' } } });
    checks.push({ check: "the failure is audited", observed: failedAudit ? JSON.parse(failedAudit.after!) : null });
    expect(failedAudit).not.toBeNull();

    // (b) a second QR, still unpaid at the bank: the guest's check stays PENDING, and a correctly signed callback that CLAIMS success
    //     is not believed (RESTORA asks the bank, which says PENDING)
    const second = await startPayment(orderId, key);
    expect(second.reply.status).toBe(200);
    expect(second.reference).not.toBe(first.reference);
    const confirm = await call(anon, "POST", `/api/qr/orders/${orderId}/payments/confirm`, { data: { paymentId: second.paymentId }, headers: guestHeaders(key) });
    checks.push({ check: "(b) unpaid at the bank: the guest's status check", observed: { http: confirm.status, paymentStatus: confirm.json?.data?.paymentStatus, pending: confirm.json?.data?.pending } });
    expect(confirm.status).toBe(200);
    expect(confirm.json!.data).toMatchObject({ paymentStatus: "PENDING", pending: true });
    const hook = await deliver(emu.callbackFor({ ...emu.txn(second.reference!), status: "SUCCESS", rrn: "000000000001" }, `claim-${second.reference}`));
    checks.push({ check: "(b) a signed callback that CLAIMS success the bank's status API does not confirm (a 5xx tells the bank to deliver it again later)", observed: { http: hook.status, body: hook.body } });
    expect(hook.status, "a success the bank does not confirm is never acknowledged as processed").toBeGreaterThanOrEqual(500);
    s = await orderState(orderId);
    expect(s).toMatchObject({ status: "OPEN", successPayments: 0, kots: 0, invoiceNo: null });
    expect(s.payments.sort()).toEqual(["FAILED", "PENDING"]);
    checks.push({ check: "(b) state", observed: s });

    // (c) a forged "proof" from the browser (a made-up bank reference and status)
    const forged = await call(anon, "POST", `/api/qr/orders/${orderId}/payments/confirm`, { data: { paymentId: second.paymentId, gateway: { status: "SUCCESS", rrn: "424242424242", reference: second.reference! } }, headers: guestHeaders(key) });
    checks.push({ check: "(c) forged payment proof sent by the browser", observed: { http: forged.status, paymentStatus: forged.json?.data?.paymentStatus } });
    s = await orderState(orderId);
    expect(s).toMatchObject({ status: "OPEN", successPayments: 0, kots: 0 });
    expect(s.payments.every((p) => p !== "SUCCESS")).toBe(true);

    // The kitchen: nothing for T08 — on the screen, and in the KDS API
    await chef.page.goto("/kitchen");
    await expect(chef.page.getByRole("region", { name: /^New/ })).toBeVisible();
    await expect(chef.page.getByRole("article", { name: /Table T08/ })).toHaveCount(0);
    const outletId = table.outletId;
    const kds = await data<Array<{ id: string; orderId?: string; table?: { code: string } | null }>>(chef.page.request, `/api/kitchen/kots?outletId=${outletId}`);
    expect(JSON.stringify(kds)).not.toContain(orderId);
    checks.push({ check: "kitchen screen and KDS API", observed: { t08TicketsOnScreen: 0, ticketsInKdsApiForThisOrder: 0 } });
    expect(await db.auditLog.count({ where: { entityType: "Order", entityId: orderId, after: { contains: '"status":"PAID"' } } })).toBe(0);
    const after = await books();
    expect(after).toEqual(before);
    return { orderId, bankPaymentId: bankPayment, orderStatus: s.status, paymentStatuses: s.payments, kotsCreated: 0, booksBeforeAndAfter: { before, after }, checks, screenshot: await shot(chef.page, "kitchen-no-ticket-for-failed-payment") };
  });
  for (const d of [chef, guest]) await d.context.close();
});

test("ACC-C  step 27: a duplicate payment / webhook must NOT create a duplicate KOT", async () => {
  test.setTimeout(300_000);
  await asVisitor("203.0.113.27");
  const orderId = ids.orderId as string;
  expect(orderId, "ACC-A must have produced the main order").toBeTruthy();
  expect(mainOrderKey, "ACC-A must have kept the customer's access key").toBeTruthy();
  await step(27, "NEGATIVE", "Duplicate payment / webhook must NOT create a duplicate KOT", async () => {
    const checks: Array<{ check: string; observed: unknown }> = [];
    const before = await books();
    const payment = await db.payment.findFirstOrThrow({ where: { orderId } });
    const kotBefore = await db.kot.findFirstOrThrow({ where: { orderId } });
    const cb = ids.bankCallback as UpiCallback;

    const one = await deliver(cb);
    checks.push({ check: "the same SUCCESS callback delivered again", observed: one });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ status: "DUPLICATE" });

    const burst = await Promise.all(Array.from({ length: 8 }, () => deliver(cb)));
    checks.push({ check: "8 simultaneous deliveries of the same event", observed: burst.map((b) => `${b.status} ${(b.body as { status?: string })?.status}`) });
    expect(burst.every((b) => b.status === 200)).toBe(true);

    // a late failure notice (signed) after the payment succeeded must not undo it
    const late: UpiCallback = { ...cb, eventId: `${cb.reference}:LATE-FAILED`, status: "FAILED", rrn: null };
    const lateHook = await deliver(late);
    checks.push({ check: "a late FAILED callback after the payment succeeded", observed: lateHook });

    // customer pays again: a second payment on a settled order is refused; a re-sent confirm changes nothing
    const orderKey = mainOrderKey;
    const again = await startPayment(orderId, orderKey);
    checks.push({ check: "customer taps 'Pay online' again on the settled order", observed: { http: again.reply.status, message: message(again.reply) } });
    expect(again.reply.status).toBe(422);
    const replays = await Promise.all(Array.from({ length: 3 }, () => call(anon, "POST", `/api/qr/orders/${orderId}/payments/confirm`, { data: { paymentId: payment.id }, headers: guestHeaders(orderKey) })));
    checks.push({ check: "3 simultaneous re-sent confirms", observed: replays.map((r) => `${r.status} ${r.json?.data?.paymentStatus}`) });
    expect(replays.every((r) => r.status === 200)).toBe(true);
    // Webhook events are recorded once per (provider, event id); the id is namespaced by the merchant account.
    const events = await db.webhookEvent.findMany({ where: { eventId: { endsWith: cb.eventId } } });
    expect(events).toHaveLength(1);
    checks.push({ check: "the one stored callback event for the success", observed: { eventId: events[0].eventId, status: events[0].status, note: events[0].error } });
    const lateFailure = await db.webhookEvent.findMany({ where: { eventId: { endsWith: late.eventId } } });
    expect(lateFailure).toHaveLength(1);
    checks.push({ check: "the late FAILED notice was recorded and ignored", observed: { status: lateFailure[0].status, note: lateFailure[0].error } });
    const after = await books();
    const paymentAfter = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after).toEqual(before);
    expect(paymentAfter.status).toBe("SUCCESS");
    expect(paymentAfter.verifiedAt?.getTime()).toBe(payment.verifiedAt?.getTime());
    const kots = await db.kot.findMany({ where: { orderId } });
    expect(kots.map((k) => k.id)).toEqual([kotBefore.id]);
    expect(kots[0].status).toBe("SERVED");
    return { orderId, kotId: kotBefore.id, kotsForTheOrder: kots.length, webhookEventRows: events.length, paymentStatus: paymentAfter.status, verifiedAtUnchanged: true, booksBeforeAndAfter: { before, after }, checks };
  });
});

test("ACC-D  step 28: a duplicate customer submission must NOT create duplicate orders", async ({ browser }) => {
  test.setTimeout(300_000);
  await asVisitor("203.0.113.28");
  const { table, link } = await shopFront("T09");
  const penne = await menuItemId(SECOND_DISH.name);
  const guest = await customerPhone(browser);
  await step(28, "NEGATIVE", "Duplicate customer submission must NOT create duplicate orders", async () => {
    const checks: Array<{ check: string; observed: unknown }> = [];
    const countOrders = () => db.order.count({ where: { tableId: table.id } });
    expect(await countOrders()).toBe(0);

    // (a) the customer double-taps "Place order" in the browser
    await orderFromTable(guest.page, link, "T09", [{ item: SECOND_DISH.name }], SECOND_DISH.total, "ONLINE");
    await guest.page.getByRole("button", { name: /^Place order/ }).dblclick();
    await guest.page.waitForURL(/\/o\/[^/#]+#k=/);
    await guest.page.waitForTimeout(1500);
    const posts = guest.traffic.filter((t) => t.path.endsWith("/orders"));
    const keys = new Set(posts.map((p) => p.headers["idempotency-key"]));
    expect(keys.size).toBe(1);
    expect(await countOrders()).toBe(1);
    checks.push({ check: "(a) double-tap on Place order", observed: { requestsFromTheBrowser: posts.length, distinctIdempotencyKeys: keys.size, ordersCreated: 1 } });
    const { orderId, key } = parseOrderUrl(guest.page);
    const idemKey = posts[0].headers["idempotency-key"];
    const body = JSON.parse(posts[0].body!) as Record<string, unknown>;

    // (b) the identical request again (lost response, retry)
    const replay = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: body, headers: { "idempotency-key": idemKey } });
    checks.push({ check: "(b) same Idempotency-Key, same body", observed: { http: replay.status, replayed: replay.json?.data?.replayed, sameOrder: replay.json?.data?.orderId === orderId } });
    expect(replay.json!.data).toMatchObject({ orderId, replayed: true });
    expect(await countOrders()).toBe(1);

    // (c) the same key with a DIFFERENT cart is refused, not merged
    const different = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: cartBody(penne, 3), headers: { "idempotency-key": idemKey } });
    checks.push({ check: "(c) same Idempotency-Key, different cart", observed: { http: different.status, message: message(different) } });
    expect(different.status).toBe(409);
    expect(await countOrders()).toBe(1);

    // (d) five simultaneous submissions of one fresh key (two phones / a flaky network)
    const burstKey = idem("burst");
    const burst = await Promise.all(Array.from({ length: 5 }, () => call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: cartBody(penne, 2), headers: { "idempotency-key": burstKey } })));
    const burstIds = new Set(burst.map((r) => r.json?.data?.orderId));
    checks.push({ check: "(d) 5 simultaneous requests, one key", observed: { statuses: burst.map((r) => r.status), distinctOrders: burstIds.size } });
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(burstIds.size).toBe(1);
    expect(await countOrders()).toBe(2);

    // (e) "Pay online" pressed again and again: the browser already opened one payment when the order was placed; more taps resume it
    const gatewayOrdersFor = async () => {
      const refs = new Set((await db.payment.findMany({ where: { orderId }, select: { providerRef: true } })).map((p) => p.providerRef));
      return [...emu.txns.values()].filter((t) => refs.has(t.reference)).length;
    };
    await until("the browser's own QR", async () => (await gatewayOrdersFor()) === 1);
    expect(await gatewayOrdersFor()).toBe(1);
    const p1 = await startPayment(orderId, key, {}, idem("tap1"));
    const p2 = await startPayment(orderId, key, {}, idem("tap2"));
    const p3 = await startPayment(orderId, key, {}, idem("tap1")); // a retry of the first tap's own key
    const rows = await db.payment.findMany({ where: { orderId } });
    checks.push({ check: "(e) Pay online pressed again (3 more taps after the browser's own)", observed: { samePaymentEveryTime: new Set([p1.paymentId, p2.paymentId, p3.paymentId, rows[0]?.id]).size === 1, sameBankQr: new Set([p1.reference, p2.reference, p3.reference, rows[0]?.providerRef]).size === 1, bankQrsForThisOrder: await gatewayOrdersFor(), paymentRows: rows.length } });
    expect(new Set([p1.paymentId, p2.paymentId, p3.paymentId, rows[0].id]).size).toBe(1);
    expect(new Set([p1.reference, p2.reference, p3.reference, rows[0].providerRef]).size).toBe(1);
    expect(await gatewayOrdersFor()).toBe(1);
    expect(rows).toHaveLength(1);

    // (f) different keys are different submissions — by design not merged, but a table cannot flood the kitchen
    const third = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("third") } });
    const fourth = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("fourth") } });
    checks.push({ check: "(f) distinct keys: 3rd then 4th unaccepted order from one table", observed: { thirdHttp: third.status, fourthHttp: fourth.status, fourthMessage: message(fourth) } });
    expect(third.status).toBe(200);
    expect(fourth.status).toBe(422);
    expect(await countOrders()).toBe(3);
    expect((await books()).kots).toBe(1);
    return { table: "T09", orderIdOfTheDoubleTap: orderId, ordersOnTheTableAfterEverything: 3, intentionalOrders: "1 (double-tap) + 1 (burst) + 1 (third key)", duplicatesCreated: 0, checks };
  });
  await guest.context.close();
});

test("ACC-E  step 29: tampering with the amount must fail", async ({ browser }) => {
  test.setTimeout(300_000);
  await asVisitor("203.0.113.29");
  const { table, link } = await shopFront("T10");
  const penne = await menuItemId(SECOND_DISH.name);
  const manager = await staff(browser, USERS.manager);
  const guest = await customerPhone(browser);
  await step(29, "NEGATIVE", "Tampering with the amount must fail", async () => {
    const checks: Array<{ check: string; observed: unknown }> = [];
    const before = await books();
    const countOrders = () => db.order.count({ where: { tableId: table.id } });

    // (a) price / total / tax / discount fields on the order and on the quote: refused outright
    const fields = { unitPrice: 1, price: 1, total: 1, amount: 1, subtotal: 1, tax: 0, discount: 100, taxPct: 0 };
    const refused: Record<string, number> = {};
    for (const [field, value] of Object.entries(fields)) {
      const top = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: { ...cartBody(penne), [field]: value }, headers: { "idempotency-key": idem("amt") } });
      const line = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: { items: [{ menuItemId: penne, qty: 1, [field]: value }] }, headers: { "idempotency-key": idem("amt") } });
      const quote = await call(anon, "POST", `/api/qr/t/${table.qrToken}/quote`, { data: { items: [{ menuItemId: penne, qty: 1, [field]: value }] } });
      refused[field] = top.status;
      expect([top.status, line.status, quote.status], field).toEqual([422, 422, 422]);
    }
    expect(await countOrders()).toBe(0);
    checks.push({ check: "(a) extra price fields on order body / line / quote", observed: { httpStatusPerField: refused, ordersCreated: 0 } });

    // (b) the same attack from the real browser: the request is altered on the wire
    await orderFromTable(guest.page, link, "T10", [{ item: SECOND_DISH.name }], SECOND_DISH.total, "ONLINE");
    await guest.page.route("**/api/qr/t/*/orders", async (route) => {
      const sent = JSON.parse(route.request().postData()!) as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
      sent.items[0].unitPrice = 1;
      sent.total = 1;
      await route.continue({ postData: JSON.stringify(sent) });
    });
    await guest.page.getByRole("button", { name: /^Place order/ }).click();
    await expect(guest.page.getByRole("alert").first()).toBeVisible();
    expect(guest.page.url()).not.toMatch(/\/o\//);
    expect(await countOrders()).toBe(0);
    checks.push({ check: "(b) browser request rewritten to unitPrice 1 / total 1", observed: { screenShows: (await guest.page.getByRole("alert").first().innerText()).replace(/\s+/g, " "), ordersCreated: 0 } });
    await guest.page.unroute("**/api/qr/t/*/orders");

    // (c) an honest order; the amount of the bank's QR is the SERVER's
    const placed = await call(anon, "POST", `/api/qr/t/${table.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("honest") } });
    expect(placed.status).toBe(200);
    const orderId = placed.json!.data!.orderId as string;
    const key = placed.json!.data!.accessKey as string;
    const dbOrder = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(rupees(dbOrder.total)).toBe(SECOND_DISH.total);
    for (const bad of [{ amount: 1 }, { total: 1 }, { parts: 0 }, { parts: -1 }, { parts: 1 }, { parts: 99 }, { parts: 1.5 }]) {
      const r = await startPayment(orderId, key, bad);
      expect(r.reply.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await db.payment.count({ where: { orderId } })).toBe(0);
    checks.push({ check: "(c) start-payment bodies { amount }, { total }, { parts: 0 | -1 | 1 | 99 | 1.5 }", observed: "all 422, no payment row created" });
    const pay = await startPayment(orderId, key);
    expect(pay.reply.status).toBe(200);
    const txn = emu.txn(pay.reference!);
    expect(txn.amountPaise).toBe(Math.round(SECOND_DISH.total * 100));
    expect(rupees((await db.payment.findUniqueOrThrow({ where: { id: pay.paymentId! } })).amount)).toBe(SECOND_DISH.total);
    checks.push({ check: "(c) bank QR amount vs the bill", observed: { billRupees: SECOND_DISH.total, qrPaise: txn.amountPaise, paymentRowRupees: SECOND_DISH.total } });

    // (d) the bank reports a success of ONE RUPEE for the ₹194.25 bill (status API and callback both say ₹1)
    await emu.pay(pay.reference!, "SUCCESS", { callback: false });
    emu.faults.set(pay.reference!, { override: { amountPaise: 100 } });
    const confirm = await call(anon, "POST", `/api/qr/orders/${orderId}/payments/confirm`, { data: { paymentId: pay.paymentId }, headers: guestHeaders(key) });
    const cheap: UpiCallback = { ...emu.callbackFor(emu.txn(pay.reference!)), amountPaise: 100 };
    const hook = await deliver(cheap);
    const s = await orderState(orderId);
    const mismatch = await db.anomaly.findFirst({ where: { entityId: pay.paymentId!, type: "RECONCILIATION_MISMATCH" } });
    checks.push({ check: "(d) the bank reports ₹1 paid for a ₹194.25 bill", observed: { confirmHttp: confirm.status, confirmPaymentStatus: confirm.json?.data?.paymentStatus, callbackHttp: hook.status, state: s, staffAlerted: mismatch ? { type: mismatch.type, severity: mismatch.severity } : null } });
    expect(s).toMatchObject({ status: "OPEN", successPayments: 0, kots: 0, invoiceNo: null });
    expect(s.payments).toEqual(["PENDING"]); // never paid; money may have moved, so a person checks (HIGH anomaly)
    expect(mismatch?.severity).toBe("HIGH");

    // (e) a callback edited in transit (amount rewritten, original signature kept)
    const rawBody = JSON.stringify(cheap);
    const edited = rawBody.replace(`"amountPaise":100`, `"amountPaise":19425`);
    expect(edited).not.toBe(rawBody);
    const tampered = await deliver(edited, emu.sign(rawBody));
    checks.push({ check: "(e) callback body amount edited after signing", observed: { http: tampered.status } });
    expect(tampered.status).toBe(401);

    // (f) staff side: cash for far more than the bill is refused; nothing settles
    const over = await call(manager.page.request, "POST", "/api/payments", { data: { orderId, method: "CASH", amount: 1000 } });
    const negative = await call(manager.page.request, "POST", "/api/payments", { data: { orderId, method: "CASH", amount: -5 } });
    checks.push({ check: "(f) manager records cash ₹1000 / ₹-5 on a ₹194.25 bill", observed: { overHttp: over.status, overMessage: message(over), negativeHttp: negative.status } });
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    expect(negative.status).toBeGreaterThanOrEqual(400);
    expect(negative.status).toBeLessThan(500);
    const final = await orderState(orderId);
    expect(final).toMatchObject({ status: "OPEN", successPayments: 0, kots: 0 });
    expect(await books()).toEqual(before);
    return { orderId, billRupees: SECOND_DISH.total, finalOrderState: final, booksUnchanged: true, checks };
  });
  for (const d of [manager, guest]) await d.context.close();
});

test("ACC-F  step 30: tampering with restaurant / outlet / table identifiers must fail", async ({ browser }) => {
  test.setTimeout(300_000);
  await asVisitor("203.0.113.30");
  const cafe = await db.organization.findFirstOrThrow({ where: { name: "Coders' Cafe" } });
  const other = await db.organization.findFirstOrThrow({ where: { name: OTHER.orgName } });
  const otherOutlet = await db.outlet.findFirstOrThrow({ where: { organizationId: other.id } });
  const otherTable = await db.restaurantTable.findFirstOrThrow({ where: { organizationId: other.id } });
  const otherDish = await db.menuItem.findFirstOrThrow({ where: { organizationId: other.id } });
  const cafeOutlet = await db.outlet.findFirstOrThrow({ where: { organizationId: cafe.id } });
  const { table: t05, link: link05 } = await shopFront("T05");
  const { table: t06 } = await shopFront("T06");
  const t09 = (await shopFront("T09")).table;
  const penne = await menuItemId(SECOND_DISH.name);
  const mainOrderId = ids.orderId as string;
  const mainKot = ids.kotId as string;
  expect(mainOrderId).toBeTruthy();
  const foreign = await staff(browser, OTHER.ownerEmail);
  const manager = await staff(browser, USERS.manager);
  const guest = await customerPhone(browser);

  await step(30, "NEGATIVE", "Tampering with restaurant / outlet / table identifiers must fail", async () => {
    const checks: Array<{ check: string; observed: unknown }> = [];
    const before = await books();
    const ordersBefore = await db.order.count();
    const fx = (r: Reply) => ({ http: r.status, message: message(r) });

    // (a) identifiers that are not the table's: client-supplied tenant / table fields are refused
    const extra: Record<string, unknown> = { tableId: t06.id, outletId: otherOutlet.id, organizationId: other.id, restaurantId: other.id, channel: "DELIVERY", source: "POS", status: "PAID" };
    for (const [field, value] of Object.entries(extra)) {
      const r = await call(anon, "POST", `/api/qr/t/${t05.qrToken}/orders`, { data: { ...cartBody(penne), [field]: value }, headers: { "idempotency-key": idem("ident") } });
      expect(r.status, field).toBe(422);
    }
    checks.push({ check: "(a) tableId / outletId / organizationId / restaurantId / channel / source / status in the body", observed: "all 422" });

    // (b) a different QR token
    const flipped = t05.qrToken!.slice(0, -1) + (t05.qrToken!.endsWith("A") ? "B" : "A");
    const badMenu = await call(anon, "GET", `/api/qr/t/${flipped}`);
    const badOrder = await call(anon, "POST", `/api/qr/t/${flipped}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("ident") } });
    checks.push({ check: "(b) QR token with one character changed", observed: { menu: fx(badMenu), order: fx(badOrder) } });
    expect(badMenu.status).toBe(404);
    expect(badOrder.status).toBe(404);

    // (c) another restaurant's table with this restaurant's dish, and the other way round
    const foreignTableCafeDish = await call(anon, "POST", `/api/qr/t/${otherTable.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("ident") } });
    const cafeTableForeignDish = await call(anon, "POST", `/api/qr/t/${t05.qrToken}/orders`, { data: cartBody(otherDish.id), headers: { "idempotency-key": idem("ident") } });
    checks.push({ check: "(c) other restaurant's table + Coders' Cafe dish / Coders' Cafe table + other restaurant's dish", observed: { a: fx(foreignTableCafeDish), b: fx(cafeTableForeignDish) } });
    expect(foreignTableCafeDish.status).toBe(404);
    expect(cafeTableForeignDish.status).toBe(404);
    expect(await db.order.count({ where: { organizationId: other.id } })).toBe(0);

    // (d) order keys: another order's key, no key, a made-up key; another order's payment id
    const own = await call(anon, "POST", `/api/qr/t/${t09.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("ident") } });
    expect(own.status).toBe(422); // T09 already holds three waiting orders (step 28): the cap, not an error in the check
    const mine = await call(anon, "POST", `/api/qr/t/${t05.qrToken}/orders`, { data: cartBody(penne), headers: { "idempotency-key": idem("ident") } });
    expect(mine.status).toBe(200);
    const myId = mine.json!.data!.orderId as string;
    const myKey = mine.json!.data!.accessKey as string;
    const swapped = await call(anon, "GET", `/api/qr/orders/${mainOrderId}`, { headers: { "x-order-key": myKey } });
    const none = await call(anon, "GET", `/api/qr/orders/${mainOrderId}`);
    const madeUp = await call(anon, "GET", `/api/qr/orders/${mainOrderId}`, { headers: { "x-order-key": "A".repeat(43) } });
    const mainPaymentId = ids.restoraPaymentId as string;
    const foreignPayment = await call(anon, "POST", `/api/qr/orders/${myId}/payments/confirm`, { data: { paymentId: mainPaymentId }, headers: guestHeaders(myKey) });
    checks.push({ check: "(d) another order's key / no key / made-up key / another order's payment id", observed: { swappedKey: fx(swapped), noKey: fx(none), madeUpKey: fx(madeUp), foreignPaymentId: fx(foreignPayment) } });
    for (const r of [swapped, none, madeUp, foreignPayment]) expect(r.status).toBe(404);

    // (e) the same attack through the real browser: the order request is rewritten on the wire to name another table / restaurant
    await orderFromTable(guest.page, link05, "T05", [{ item: SECOND_DISH.name }], SECOND_DISH.total, "ONLINE");
    const countBeforeUi = await db.order.count();
    await guest.page.route("**/api/qr/t/*/orders", async (route) => {
      const sent = JSON.parse(route.request().postData()!) as Record<string, unknown>;
      sent.tableId = t06.id;
      sent.outletId = otherOutlet.id;
      sent.organizationId = other.id;
      await route.continue({ postData: JSON.stringify(sent) });
    });
    await guest.page.getByRole("button", { name: /^Place order/ }).click();
    await expect(guest.page.getByRole("alert").first()).toBeVisible();
    expect(guest.page.url()).not.toMatch(/\/o\//);
    expect(await db.order.count()).toBe(countBeforeUi);
    await guest.page.unroute("**/api/qr/t/*/orders");
    checks.push({ check: "(e) browser request rewritten to another tableId / outletId / organizationId", observed: { screenShows: (await guest.page.getByRole("alert").first().innerText()).replace(/\s+/g, " "), ordersCreated: 0 } });

    // (f) another restaurant's staff against this restaurant's data
    const fapi = foreign.page.request;
    const foreignReads = {
      order: fx(await call(fapi, "GET", `/api/orders/${mainOrderId}`)),
      orderList: fx(await call(fapi, "GET", `/api/orders?outletId=${cafeOutlet.id}`)),
      payments: fx(await call(fapi, "GET", `/api/finance/payments?outletId=${cafeOutlet.id}`)),
      moneyDesk: fx(await call(fapi, "GET", `/api/finance/money-desk?outletId=${cafeOutlet.id}&businessDate=${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date())}`)),
      sales: fx(await call(fapi, "GET", `/api/analytics/sales-summary?outletId=${cafeOutlet.id}`)),
      stock: fx(await call(fapi, "GET", `/api/inventory/stock?outletId=${cafeOutlet.id}`)),
      kds: fx(await call(fapi, "GET", `/api/kitchen/kots?outletId=${cafeOutlet.id}`)),
    };
    const foreignWrites = {
      payCash: fx(await call(fapi, "POST", "/api/payments", { data: { orderId: mainOrderId, method: "CASH", amount: 10 } })),
      kotStatus: fx(await call(fapi, "POST", `/api/kitchen/kots/${mainKot}/status`, { data: { status: "CANCELLED" } })),
      newOrderInCafeOutlet: fx(await call(fapi, "POST", "/api/orders", { data: { outletId: cafeOutlet.id, channel: "DINE_IN", items: [{ menuItemId: penne, qty: 1 }] } })),
    };
    checks.push({ check: "(f) another restaurant's OWNER reads / writes Coders' Cafe data", observed: { reads: foreignReads, writes: foreignWrites } });
    for (const r of [...Object.values(foreignReads), ...Object.values(foreignWrites)]) expect([403, 404], JSON.stringify(r)).toContain(r.http);

    // (g) Coders' Cafe's own manager against the other restaurant's outlet
    const mgr = manager.page.request;
    const crossOutlet = { orders: fx(await call(mgr, "GET", `/api/orders?outletId=${otherOutlet.id}`)), newOrder: fx(await call(mgr, "POST", "/api/orders", { data: { outletId: otherOutlet.id, channel: "DINE_IN", items: [{ menuItemId: otherDish.id, qty: 1 }] } })) };
    checks.push({ check: "(g) Coders' Cafe manager names the other restaurant's outlet", observed: crossOutlet });
    for (const r of Object.values(crossOutlet)) expect([403, 404], JSON.stringify(r)).toContain(r.http);

    // (h) a callback for a merchant RESTORA does not know (signed correctly, wrong tenant)
    const theirs = await startPayment(myId, myKey);
    const stranger = await deliver({ ...emu.callbackFor({ ...emu.txn(theirs.reference!), status: "SUCCESS" }), merchantId: "EMU-SOMEONE-ELSE-0001" });
    checks.push({ check: "(h) a SUCCESS callback for a merchant that is not Coders' Cafe's", observed: stranger });
    expect(stranger.status).toBeGreaterThanOrEqual(400);

    // nothing changed in the main order, the kitchen, the money
    expect(await orderState(mainOrderId)).toMatchObject({ status: "PAID", successPayments: 1, kots: 1 });
    expect((await db.kot.findUniqueOrThrow({ where: { id: mainKot } })).status).toBe("SERVED");
    expect(await books()).toEqual(before);
    expect(await db.order.count({ where: { organizationId: other.id } })).toBe(0);
    expect(await db.order.count()).toBe(ordersBefore + 1); // only the honest T05 order of check (d)
    return { restaurantId: cafe.id, foreignRestaurantId: other.id, outletId: cafeOutlet.id, foreignOutletId: otherOutlet.id, tablesUsed: { honest: "T05", rewritten: "T06" }, booksUnchanged: true, ordersInTheOtherRestaurant: 0, checks };
  });
  for (const d of [foreign, manager, guest]) await d.context.close();
});

// =====================================================================================================
//   Z. AFTER EVERY ATTACK, THE BOOKS ARE STILL THE ONE ORDER
// =====================================================================================================

test("ACC-Z  final sweep: after every attack the books still hold exactly the one paid order", async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await staff(browser, USERS.owner);
  const api = owner.page.request;
  const outlet = await db.outlet.findFirstOrThrow({ where: { organization: { name: "Coders' Cafe" } } });
  await step("Z", "FINAL", "After 30 steps and every attack: one paid order, one payment, one KOT, one invoice, one consumption, sales = ₹157.50", async () => {
    expect(await books()).toEqual({ paidOrders: 1, successPayments: 1, kots: 1, invoices: 1, consumptionRows: INGREDIENTS.length });
    const summary = await data<{ orders: number; revenue: number }>(api, `/api/analytics/sales-summary?outletId=${outlet.id}`);
    expect(summary).toMatchObject({ orders: 1, revenue: DISH.total });
    const stock = await data<Array<{ name: string; quantity: number }>>(api, `/api/inventory/stock?outletId=${outlet.id}`);
    for (const ing of INGREDIENTS) expect(stock.find((s) => s.name === ing.name)!.quantity).toBeCloseTo(ing.openingQty - ing.perPlate, 3);
    const order = await db.order.findUniqueOrThrow({ where: { id: ids.orderId as string } });
    expect(order.status).toBe("PAID");
    expect((await db.kot.findUniqueOrThrow({ where: { id: ids.kotId as string } })).status).toBe("SERVED");
    const unpaid = await db.order.findMany({ where: { status: { not: "PAID" } }, select: { id: true, status: true, table: { select: { code: true } } } });
    expect(unpaid.every((o) => o.status === "OPEN")).toBe(true);
    const anomalies = await db.anomaly.count({ where: { severity: { in: ["HIGH", "CRITICAL"] } } });
    return { books: await books(), salesSummary: summary, onHand: INGREDIENTS.map((i) => ({ material: i.name, onHand: stock.find((s) => s.name === i.name)!.quantity })), unpaidOrdersLeftByTheAttacks: unpaid.map((o) => `${o.table?.code} ${o.status}`), highSeverityAnomalies: anomalies, finalIdentifiers: ids };
  });
  await owner.context.close();
});
