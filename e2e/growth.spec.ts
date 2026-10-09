/**
 * Group 6 (growth) through the real app, in real browsers, against the production build:
 *   GROWTH-001 manager sets up tiers, a coupon, the rules and the referral program on the real screens
 *   GROWTH-002 a guest on a phone: table QR -> coupon in the cart (server-priced) -> checkout with an explicit offers
 *              opt-in -> pay online (test gateway) -> rate the meal; the manager sees the use, the consent and the rating
 *   GROWTH-003 the cashier puts the same code on a running order at the POS and takes it off again
 *   GROWTH-004 the manager sends a campaign; the worker delivers it to the guest who agreed (MOCK provider)
 *   GROWTH-005 one-click unsubscribe from the link in the message: opening it changes nothing, the button turns off
 *              that channel only
 *   GROWTH-006 a friend's invite link -> the code is filled in at checkout -> first paid order rewards both guests;
 *              an unhappy rating stays private and the manager follows it up
 * Every business fact is checked against the server (API), not only the screen.
 */
import { createHmac, hkdfSync } from "node:crypto";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { statePath, outletByCode, apiAs, apiData, apiCall, openPos, addSimpleItem, setOrderType, posCart, toast, CENTRAL, PASSWORD } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ storageState: statePath("manager") });

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const CODE = `E2E${RUN}`;
const PHONE_A = `98${String(Date.now()).slice(-8)}`;
const PHONE_B = `97${String(Date.now() + 7).slice(-8)}`;
const REVIEW_URL = "https://g.page/r/e2e-growth/review";
// playwright.config.ts gives the disposable deployment this AUTH_SECRET; consent.ts derives the unsubscribe key from it.
const E2E_AUTH_SECRET = "e2e-test-auth-secret-not-a-real-production-value-0123456789";
function unsubscribeToken(customerId: string, channel: string) {
  const key = Buffer.from(hkdfSync("sha256", E2E_AUTH_SECRET, "restora-unsubscribe", "marketing-optout-v1", 32));
  return `${customerId}.${channel}.${createHmac("sha256", key).update(`${customerId}.${channel}`).digest("base64url").slice(0, 22)}`;
}

type TableRow = { id: string; code: string; qrToken: string | null };
type Consent = Array<{ channel: string; marketing: boolean; transactional: boolean; source: string | null }>;
const shared: { guestA?: string; guestB?: string; couponId?: string; referralCode?: string; campaignId?: string } = {};

/**
 * This spec's own table (the other specs share the seeded ones and count the orders on them): created through the real
 * API with its own QR code, so a growth order never shows up on someone else's table.
 */
async function ownTable(outletId: string, code: string) {
  const manager = await apiAs("manager");
  let t = (await apiData<TableRow[]>(manager, `/api/master/tables?outletId=${outletId}`)).find((x) => x.code === code);
  if (!t) {
    const made = await apiCall<TableRow>(manager, "POST", "/api/master/tables", { outletId, code, capacity: 4 });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    t = made.body!.data;
  }
  if (!t.qrToken) {
    const rotated = await apiCall<TableRow>(manager, "POST", `/api/master/tables/${t.id}/qr`, {});
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    t = rotated.body!.data;
  }
  await manager.dispose();
  return t.qrToken!;
}
const customerByPhone = async (phone: string) => {
  const manager = await apiAs("manager");
  const [c] = await apiData<Array<{ id: string; name: string }>>(manager, `/api/customers?phone=${phone}`);
  await manager.dispose();
  return c;
};
async function guestPhone(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); // no session cookie
  return { context, page: await context.newPage() };
}
/** Storefront: add two dishes, open the cart, wait for the server's quote. */
async function fillCart(g: Page, token: string) {
  await g.goto(`/t/${token}`);
  await g.getByRole("button", { name: "Add Masala Chai" }).click();
  await g.getByRole("button", { name: "Add Paneer Tikka" }).click();
  await g.getByRole("link", { name: /^View cart/ }).click();
  await g.waitForURL(/\/cart$/);
  await expect(g.getByText("Prices and GST confirmed by the café just now.")).toBeVisible();
}
/** Checkout as a guest with a phone number, paying online with the test gateway; returns once the order page shows it paid. */
async function checkoutAndPay(g: Page, opts: { name: string; phone: string; offers?: boolean }) {
  await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
  await g.waitForURL(/\/checkout$/);
  await g.getByLabel(/Your name/).fill(opts.name);
  await g.getByLabel(/^Phone/).fill(opts.phone);
  if (opts.offers) await g.getByRole("checkbox", { name: /Send me offers/ }).check();
  await g.getByRole("radio", { name: /Pay online/ }).check();
  await expect(g.getByRole("button", { name: /^Place order & pay/ })).toBeEnabled();
  await g.getByRole("button", { name: /^Place order & pay/ }).click();
  await g.waitForURL(/\/o\/[^/#]+#k=/);
  const gw = g.getByRole("region", { name: "Test payment gateway" });
  await expect(gw).toBeVisible();
  await gw.getByRole("button", { name: "Approve payment" }).click();
  await expect(g.getByText("Paid ✓")).toBeVisible();
  return decodeURIComponent(new URL(g.url()).pathname.split("/").pop()!);
}

test.describe("growth (Group 6)", () => {
  test("GROWTH-001 the manager sets up tiers, a coupon, the rules and the referral program", async ({ page }) => {
    // Messaging is the owner's to connect (integration.manage); the MOCK provider records instead of sending.
    const owner = await apiAs("owner");
    expect((await apiCall(owner, "POST", "/api/auth/reauth", { password: PASSWORD, scope: "settings.manage" })).status).toBe(200); // step-up, as the screen does
    const conn = await apiCall(owner, "POST", "/api/integrations", { kind: "MESSAGING", provider: "mock", mode: "SANDBOX", status: "CONNECTED", config: { channel: "SMS", templates: {} } });
    expect(conn.status, JSON.stringify(conn.body)).toBe(200);
    await owner.dispose();

    await page.goto("/customers/loyalty");
    await page.getByRole("button", { name: "Add the first tier" }).click();
    let dlg = page.getByRole("dialog", { name: "New tier" });
    await dlg.getByLabel(/^Code/).fill("BASE");
    await dlg.getByLabel(/^Name/).fill("Base");
    await dlg.getByLabel(/^Spend in the last 365 days/).fill("0");
    await dlg.getByRole("button", { name: "Add tier" }).click();
    const tiers = page.getByRole("table", { name: "Loyalty tiers" });
    await expect(tiers.getByRole("row").filter({ hasText: "Base" })).toContainText("Everyone");
    await page.getByRole("button", { name: /Add tier/ }).first().click();
    dlg = page.getByRole("dialog", { name: "New tier" });
    await dlg.getByLabel(/^Code/).fill("GOLD");
    await dlg.getByLabel(/^Name/).fill("Gold");
    await dlg.getByLabel(/^Spend in the last 365 days/).fill("5000");
    await dlg.getByLabel(/^Points earned/).fill("150");
    await dlg.getByRole("button", { name: "Add tier" }).click();
    await expect(tiers.getByRole("row").filter({ hasText: "Gold" })).toContainText("150%");

    // The referral program: on, with the default rewards.
    await page.getByRole("tab", { name: "Referrals" }).click();
    await page.getByRole("button", { name: "Change" }).click();
    dlg = page.getByRole("dialog", { name: "Referral rewards" });
    await dlg.getByRole("checkbox", { name: "Referral program is on" }).check();
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/The guest who refers gets 100 points, the friend gets 50/)).toBeVisible();

    await page.goto("/customers/coupons");
    await page.getByRole("button", { name: /New coupon/ }).click();
    dlg = page.getByRole("dialog", { name: "New coupon" });
    await dlg.getByLabel(/^Code/).fill(CODE);
    await dlg.getByLabel(/^Name/).fill("E2E welcome");
    await dlg.getByLabel(/^Percent/).fill("10");
    await dlg.getByLabel(/^Cap/).fill("30");
    await dlg.getByLabel(/^Minimum order/).fill("100");
    await dlg.getByRole("button", { name: "Create coupon" }).click();
    const row = page.getByRole("table", { name: "Coupons" }).getByRole("row").filter({ hasText: CODE });
    await expect(row).toContainText("10% off, up to ₹30.00");
    await expect(row).toContainText("Active");

    await page.goto("/customers/growth-settings");
    await page.getByLabel(/^Quiet hours start/).selectOption({ label: "00:00" });
    await page.getByLabel(/^Quiet hours end/).selectOption({ label: "00:00" }); // no quiet hours: the worker may send at any time of the E2E run
    await page.getByRole("checkbox", { name: "Ask guests how it was" }).check();
    await page.getByLabel(/^Public review page/).fill("http://g.page/r/not-https");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText(/An https link to Google/)).toBeVisible(); // refused by the server, shown on the field
    await page.getByLabel(/^Public review page/).fill(REVIEW_URL);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText(/Saved\. The worker uses these/)).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(/^Public review page/)).toHaveValue(REVIEW_URL);
    await expect(page.getByRole("checkbox", { name: "Ask guests how it was" })).toBeChecked();

    const manager = await apiAs("manager");
    const coupons = await apiData<Array<{ id: string; code: string }>>(manager, `/api/growth/coupons?search=${CODE}`);
    shared.couponId = coupons.find((c) => c.code === CODE)!.id;
    expect(shared.couponId).toBeTruthy();
    await manager.dispose();
  });

  test("GROWTH-002 a guest uses the code, opts in to offers, pays and rates the meal", async ({ browser, page }) => {
    const outlet = await outletByCode(page.request, CENTRAL);
    const token = await ownTable(outlet.id, "GRA");
    const { context, page: g } = await guestPhone(browser);
    await fillCart(g, token);
    const before = Number((await g.getByTestId("cart-total").innerText()).replace(/[^\d.]/g, ""));

    // A wrong code is explained in plain words and never blocks the order.
    await g.getByLabel(/Have a coupon code/).fill("NOSUCHCODE");
    await g.getByRole("button", { name: "Apply" }).click();
    await expect(g.getByText(/This code can't be used here/)).toBeVisible();
    await g.locator(".sf-alert").filter({ hasText: "NOSUCHCODE" }).getByRole("button", { name: "Remove" }).click();

    await g.getByLabel(/Have a coupon code/).fill(CODE.toLowerCase());
    await g.getByRole("button", { name: "Apply" }).click();
    await expect(g.getByTestId("coupon-applied")).toHaveText(CODE);
    await expect(g.getByTestId("cart-discount")).toBeVisible();
    const after = Number((await g.getByTestId("cart-total").innerText()).replace(/[^\d.]/g, ""));
    expect(after).toBeLessThan(before);
    expect(before - after).toBeGreaterThan(0);

    const orderId = await checkoutAndPay(g, { name: "Growth Guest", phone: PHONE_A, offers: true });
    const manager = await apiAs("manager");
    const o = await apiData<{ total: string; discount: string; status: string }>(manager, `/api/orders/${orderId}`);
    expect(Number(o.discount)).toBeGreaterThan(0);
    expect(Number(o.total)).toBeCloseTo(after, 1); // what the guest saw in the cart is what the server charged

    // The use is counted once, against this order.
    const uses = await apiData<Array<{ orderId: string; status: string; amount: number }>>(manager, `/api/growth/coupons/${shared.couponId}/redemptions`);
    expect(uses.filter((u) => u.orderId === orderId && u.status === "APPLIED")).toHaveLength(1);

    // The explicit yes was recorded for the phone given, on SMS and WhatsApp only.
    const guest = await customerByPhone(PHONE_A);
    shared.guestA = guest.id;
    const consent = await apiData<Consent>(manager, `/api/growth/customers/${guest.id}/consent`);
    expect(consent.filter((c) => c.marketing).map((c) => c.channel).sort()).toEqual(["SMS", "WHATSAPP"]);
    expect(consent.find((c) => c.channel === "SMS")!.source).toBe("GUEST_QR");
    expect(consent.find((c) => c.channel === "EMAIL")!.marketing).toBe(false);

    // Rating on the order page: a happy guest is offered the café's public review page.
    await expect(g.getByText("How was it?")).toBeVisible();
    await g.getByRole("radio", { name: "5 stars" }).click();
    await g.getByLabel(/Anything you'd like to add/).fill("Lovely chai");
    await g.getByRole("button", { name: "Send" }).click();
    await expect(g.getByText("Thank you!")).toBeVisible();
    await expect(g.getByRole("link", { name: "Share it on the review page" })).toHaveAttribute("href", REVIEW_URL);
    await g.reload();
    await expect(g.getByText("Paid ✓")).toBeVisible();
    await expect(g.getByText("How was it?")).toHaveCount(0); // asked once
    const inbox = await apiData<{ items: Array<{ rating: number; source: string; comment: string | null; status: string; routedTo: string | null }> }>(manager, `/api/growth/feedback?outletId=${outlet.id}&source=GUEST`);
    expect(inbox.items.find((f) => f.comment === "Lovely chai")).toMatchObject({ rating: 5, source: "GUEST", routedTo: "GOOGLE", status: "RESOLVED" });
    await manager.dispose();
    await context.close();

    // The manager sees the guest's card: consent by source, tier, code.
    await page.goto(`/customers/${shared.guestA}`);
    await page.getByRole("tab", { name: "Offers & referrals" }).click();
    const prefs = page.getByRole("table", { name: "Message preferences" });
    await expect(prefs.getByRole("row").filter({ hasText: "WhatsApp" })).toContainText("by the guest when ordering");
    await expect(prefs.getByRole("row").filter({ hasText: "E-mail" })).toContainText("no e-mail address");
  });

  test("GROWTH-003 the cashier puts the code on a running order at the POS and removes it", async ({ browser }) => {
    const cashier = await browser.newContext({ storageState: statePath("cashier"), viewport: { width: 1440, height: 900 } });
    const page = await cashier.newPage();
    await openPos(page);
    await setOrderType(page, "Takeaway");
    await addSimpleItem(page, "Cold Coffee");
    await addSimpleItem(page, "Cold Coffee");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders");
    await page.getByRole("button", { name: "Send to kitchen" }).click();
    const orderId = ((await (await created).json()) as { data: { id: string } }).data.id;

    await page.getByRole("button", { name: "Discount" }).click();
    const disc = page.getByRole("dialog", { name: "Order discount" });
    await disc.getByLabel("Coupon code").fill("nosuchcode");
    await disc.getByRole("button", { name: "Use code" }).click();
    await expect(disc.getByRole("alert")).toBeVisible(); // the server's reason, in the dialog
    await disc.getByLabel("Coupon code").fill(CODE);
    await disc.getByRole("button", { name: "Use code" }).click();
    await expect(toast(page, "Coupon applied")).toBeVisible();
    await expect(disc.getByText(CODE)).toBeVisible();
    await expect(posCart(page).getByText("Discount")).toBeVisible();

    const manager = await apiAs("manager");
    const applied = await apiData<{ coupon: { code: string; amount: number } | null }>(manager, `/api/growth/orders/${orderId}/coupon`);
    expect(applied.coupon?.code).toBe(CODE);
    expect(applied.coupon!.amount).toBeGreaterThan(0);

    await disc.getByRole("button", { name: "Remove" }).click();
    await expect(toast(page, "Coupon removed")).toBeVisible();
    await expect(disc.getByLabel("Coupon code")).toBeVisible();
    expect((await apiData<{ coupon: unknown }>(manager, `/api/growth/orders/${orderId}/coupon`)).coupon).toBeNull();
    await manager.dispose();
    await cashier.close();
  });

  test("GROWTH-004 a campaign reaches the guest who agreed, through the worker", async ({ page }) => {
    await page.goto("/customers/campaigns");
    await page.getByRole("button", { name: /New campaign/ }).click();
    const dlg = page.getByRole("dialog", { name: "New campaign" });
    await dlg.getByLabel(/^Name/).fill(`E2E weekend ${RUN}`);
    await expect(dlg.getByRole("status")).toContainText(/guests? match/);
    await dlg.getByLabel(/^Message/).fill("Hi {name}, a weekend special at {restaurant}!");
    await dlg.getByRole("button", { name: "Save as draft" }).click();
    await page.waitForURL(/\/customers\/campaigns\/[^/]+$/);
    shared.campaignId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByRole("heading", { name: `E2E weekend ${RUN}` })).toBeVisible();

    await page.getByRole("button", { name: /Send…/ }).click();
    await page.getByRole("dialog", { name: "Send campaign" }).getByRole("button", { name: "Send now" }).click();
    await expect(page.getByText(/^(Scheduled|Sending|Sent)$/).first()).toBeVisible();

    // The maintenance worker runs every 30 s: it builds the list, writes to each guest through the consent gate, and finishes.
    const manager = await apiAs("manager");
    await expect.poll(async () => (await apiData<{ campaign: { status: string } }>(manager, `/api/growth/campaigns/${shared.campaignId}`)).campaign.status, { timeout: 90_000, intervals: [2_000] }).toBe("SENT");
    const detail = await apiData<{ campaign: { recipientCount: number }; recipients: Record<string, number> }>(manager, `/api/growth/campaigns/${shared.campaignId}`);
    expect(detail.recipients.SENT).toBeGreaterThanOrEqual(1);
    await manager.dispose();

    const owner = await apiAs("owner");
    const deliveries = await apiData<Array<{ sourceType: string; sourceId: string; status: string; mode: string; target: string }>>(owner, "/api/integrations/deliveries?kind=MESSAGE&take=200");
    const mine = deliveries.find((d) => d.sourceType === "Marketing" && d.sourceId === shared.guestA);
    expect(mine, "marketing delivery to the opted-in guest").toMatchObject({ mode: "MOCK", status: "SENT" });
    expect(mine!.target).toContain("*"); // masked in the outbox
    // Nobody who did not agree was written to.
    const nonConsented = await customerByPhone("9999900001");
    expect(deliveries.some((d) => d.sourceType === "Marketing" && d.sourceId === nonConsented.id)).toBe(false);
    await owner.dispose();
    await page.reload();
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();
  });

  test("GROWTH-005 the unsubscribe link: opening it changes nothing, the button switches off that channel only", async ({ browser }) => {
    const token = unsubscribeToken(shared.guestA!, "WHATSAPP");
    const { context, page: g } = await guestPhone(browser);
    await g.goto(`/u/${token}`);
    await expect(g.getByRole("heading", { name: /^Stop offers from/ })).toBeVisible();
    const manager = await apiAs("manager");
    const marketing = async () => Object.fromEntries((await apiData<Consent>(manager, `/api/growth/customers/${shared.guestA}/consent`)).map((c) => [c.channel, c.marketing]));
    expect(await marketing()).toMatchObject({ WHATSAPP: true, SMS: true });
    await g.getByRole("button", { name: "Unsubscribe from WhatsApp offers" }).click();
    await expect(g.getByRole("heading", { name: "You're unsubscribed" })).toBeVisible();
    expect(await marketing()).toMatchObject({ WHATSAPP: false, SMS: true });

    // A forged link is refused; the real guest's other channel is untouched.
    await g.goto(`/u/${shared.guestA}.SMS.${"A".repeat(22)}`);
    await expect(g.getByText("This link doesn't work")).toBeVisible();
    expect(await marketing()).toMatchObject({ WHATSAPP: false, SMS: true });
    await manager.dispose();
    await context.close();
  });

  test("GROWTH-006 an invite link, a friend's first paid order rewards both, and an unhappy rating is followed up", async ({ browser, page }) => {
    // The referrer's code from the profile; the invite page keeps it on the friend's phone.
    await page.goto(`/customers/${shared.guestA}`);
    await page.getByRole("tab", { name: "Offers & referrals" }).click();
    await page.getByRole("button", { name: "Create a referral code" }).click();
    const codeEl = page.getByText(/^RF[0-9A-Z]{6}$/);
    await expect(codeEl).toBeVisible();
    shared.referralCode = (await codeEl.innerText()).trim();

    const outlet = await outletByCode(page.request, CENTRAL);
    const token = await ownTable(outlet.id, "GRB");
    const { context, page: g } = await guestPhone(browser);
    await g.goto(`/r/${shared.referralCode.toLowerCase()}`);
    await expect(g.getByTestId("invite-code")).toHaveText(shared.referralCode);
    await fillCart(g, token);
    await g.getByRole("link", { name: /^Proceed to checkout/ }).click();
    await g.waitForURL(/\/checkout$/);
    const friend = g.getByLabel(/Friend's referral code/);
    await expect(friend).toHaveValue(shared.referralCode);
    await expect(friend).toBeDisabled(); // a code belongs to a phone number
    await g.getByLabel(/Your name/).fill("Growth Friend");
    await g.getByLabel(/^Phone/).fill(PHONE_B);
    await expect(friend).toBeEnabled();
    await expect(g.getByRole("checkbox", { name: /Send me offers/ })).not.toBeChecked(); // never pre-ticked
    await g.getByRole("radio", { name: /Pay online/ }).check();
    await g.getByRole("button", { name: /^Place order & pay/ }).click();
    await g.waitForURL(/\/o\/[^/#]+#k=/);
    const gw = g.getByRole("region", { name: "Test payment gateway" });
    await gw.getByRole("button", { name: "Approve payment" }).click();
    await expect(g.getByText("Paid ✓")).toBeVisible();
    const orderId = decodeURIComponent(new URL(g.url()).pathname.split("/").pop()!);

    const manager = await apiAs("manager");
    shared.guestB = (await customerByPhone(PHONE_B)).id;
    const refs = await apiData<Array<{ referrer: { id: string }; referred: { id: string }; status: string; referrerPoints: number | null; refereePoints: number | null }>>(manager, "/api/growth/referrals");
    const ref = refs.find((r) => r.referred.id === shared.guestB);
    expect(ref, "referral recorded for the friend").toMatchObject({ referrer: { id: shared.guestA }, status: "REWARDED", referrerPoints: 100, refereePoints: 50 });
    const friendLoyalty = await apiData<{ balance: number }>(manager, `/api/loyalty/customers/${shared.guestB}`);
    expect(friendLoyalty.balance).toBeGreaterThanOrEqual(50);

    // An unhappy rating stays private: no review link, and the manager is alerted to follow up.
    await g.getByRole("radio", { name: "2 stars" }).click();
    await g.getByLabel(/What went wrong/).fill("Chai was cold");
    await g.getByRole("button", { name: "Send" }).click();
    await expect(g.getByText(/The team has your message/)).toBeVisible();
    await expect(g.getByRole("link", { name: "Share it on the review page" })).toHaveCount(0);
    await context.close();

    await page.goto("/customers/feedback");
    await expect(page.getByRole("status").filter({ hasText: /unhappy answer/ })).toBeVisible();
    const fb = page.getByRole("table", { name: "Feedback" }).getByRole("row").filter({ hasText: "Chai was cold" });
    await expect(fb).toContainText("New");
    await fb.getByRole("button", { name: "Follow up" }).click();
    const dlg = page.getByRole("dialog", { name: "Follow up" });
    await dlg.getByLabel("Status").selectOption("RESOLVED");
    await dlg.getByLabel(/What was done/).fill("Called the guest and replaced the chai");
    await dlg.getByRole("button", { name: "Mark resolved" }).click();
    await expect(fb).toContainText("Resolved");
    await expect(fb).toContainText("Called the guest and replaced the chai");
    expect(orderId).toBeTruthy();
    await manager.dispose();
  });
});
