// @vitest-environment jsdom
/**
 * Guest QR storefront in a DOM: menu (quick add, sizes / add-ons sheet, sticky
 * cart) -> cart (server quote: current prices, unavailable items, clear) ->
 * checkout (optional name / phone, cash or online, one idempotent request, no
 * prices sent) -> order page (key from the URL fragment, header auth, live
 * tracker, test-gateway approve / decline and Razorpay -> server confirmation);
 * bill rendering; the guest browser-state helpers.
 */
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuestMenuScreen } from "@/features/guest/components/GuestMenuScreen";
import { GuestCartScreen } from "@/features/guest/components/GuestCartScreen";
import { GuestCheckoutScreen, normalizePhone, phoneValid } from "@/features/guest/components/GuestCheckoutScreen";
import { GuestOrderScreen } from "@/features/guest/components/GuestOrderScreen";
import { StorefrontOverlays } from "@/features/guest/components/Chrome";
import { StorefrontProvider, type GuestMenuData } from "@/features/guest/storefront";
import { brandFor } from "@/features/guest/brand";
import { BillView } from "@/features/billing/BillView";
import { loadCart, saveCart, submissionKey, clearSubmission, rememberOrder, rememberedOrders, orderKeyFor, orderUrl } from "@/features/guest/session";
import { cartReducer, emptyCart, type CartLine } from "@/features/pos/cart";
import type { Bill } from "@/server/services/bill";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a> }));

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let handler: (c: Call) => { status?: number; data?: unknown; error?: { code: string; message: string } };

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const c: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(c);
    const r = handler(c);
    if (r.error) return new Response(JSON.stringify({ ok: false, error: r.error }), { status: r.status ?? 422 });
    return new Response(JSON.stringify({ ok: true, data: r.data }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const menuData = (): GuestMenuData => ({
  restaurant: { name: "Spice Route", outletName: "Central", address: null, phone: null, currency: "INR", hours: null },
  table: { code: "T4" },
  ordering: { open: true, message: null },
  payment: { online: true, testMode: true },
  menu: [
    { id: "i-dosa", name: "Masala Dosa", description: "Crisp", price: 120, effectivePrice: 120, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, offered: true, soldOut: false, effectiveSoldOut: false, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [] },
    { id: "i-idli", name: "Idli", description: null, price: 60, effectivePrice: 60, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, offered: true, soldOut: true, effectiveSoldOut: true, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [] },
    {
      id: "i-biryani", name: "Biryani", description: null, price: 300, effectivePrice: 300, taxPct: 5, station: "KITCHEN", isVeg: false, active: true, offered: true, soldOut: false, effectiveSoldOut: false, categoryId: "c2", category: { id: "c2", name: "Mains", sortOrder: 2 },
      variants: [{ id: "v-large", name: "Large", priceDelta: 80, active: true }],
      modifierGroups: [{ group: { id: "g-spice", name: "Spice", minSelect: 1, maxSelect: 1, active: true, options: [{ id: "o-hot", name: "Hot", priceDelta: 0, active: true }, { id: "o-mild", name: "Mild", priceDelta: 0, active: true }] } }, { group: { id: "g-extra", name: "Extras", minSelect: 0, maxSelect: 1, active: true, options: [{ id: "o-raita", name: "Raita", priceDelta: 30, active: true }, { id: "o-egg", name: "Egg", priceDelta: 25, active: true }] } }],
    },
  ],
});

const TOKEN = "tok-123456";
function inStore(ui: ReactNode, data: GuestMenuData = menuData()) {
  return render(
    <StorefrontProvider token={TOKEN} initial={data}>
      {ui}
      <StorefrontOverlays />
    </StorefrontProvider>
  );
}

const line = (over: Partial<CartLine>): Omit<CartLine, "key"> => ({ menuItemId: "i-dosa", name: "Masala Dosa", modifierOptionIds: [], modifierLabels: [], unitPrice: 120, modifiersPerUnit: 0, taxPct: 5, qty: 1, ...over });
function seedCart(lines: Array<Omit<CartLine, "key">>, notes = "") {
  let c = emptyCart("DINE_IN");
  for (const l of lines) c = cartReducer(c, { type: "add", line: l });
  saveCart(TOKEN, { ...c, notes });
}

type QLine = { ok: true; unitPrice: string; modifiersPerUnit?: string; qty: number; name: string; menuItemId: string } | { ok: false; reason: string; menuItemId: string };
function quoteOf(lines: QLine[]) {
  let sub = 0;
  const out = lines.map((l, index) => {
    if (!l.ok) return { index, ...l };
    const total = l.qty * (Number(l.unitPrice) + Number(l.modifiersPerUnit ?? "0"));
    sub += total;
    return { index, ok: true, menuItemId: l.menuItemId, name: l.name, unitPrice: l.unitPrice, modifiers: [], modifiersPerUnit: l.modifiersPerUnit ?? "0.00", taxPct: "5", qty: l.qty, lineTotal: total.toFixed(2) };
  });
  const tax = Math.round(sub * 5) / 100;
  return { lines: out, subtotal: sub.toFixed(2), tax: tax.toFixed(2), taxes: [{ ratePct: "5", amount: tax.toFixed(2) }], total: (sub + tax).toFixed(2), allAvailable: out.every((l) => l.ok), ordering: { open: true, message: null } };
}

describe("guest storefront — menu", () => {
  it("quick-adds simple dishes, configures sizes / add-ons in the sheet, never offers sold-out items, and shows the sticky cart", async () => {
    const user = userEvent.setup();
    handler = () => ({ data: menuData() });
    inStore(<GuestMenuScreen />);

    expect(screen.getByLabelText("Table T4")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Idli" })).toBeNull(); // sold out
    expect(screen.getAllByText("Sold out").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Add Masala Dosa" }));
    await user.click(screen.getByRole("button", { name: "Increase Masala Dosa" })); // the row turns into a stepper
    expect(within(screen.getByRole("group", { name: "Quantity of Masala Dosa" })).getByText("2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add Biryani" }));
    const sheet = await screen.findByRole("dialog", { name: "Biryani" });
    await user.click(within(sheet).getByRole("button", { name: /^Add to cart/ }));
    expect(within(sheet).getByRole("alert")).toHaveTextContent("Choose at least 1"); // required group enforced like the server
    await user.click(within(sheet).getByRole("radio", { name: /^Large/ }));
    await user.click(within(sheet).getByRole("radio", { name: /^Hot/ }));
    await user.click(within(sheet).getByRole("radio", { name: /^Raita/ }));
    await user.click(within(sheet).getByRole("button", { name: "Increase Biryani" }));
    expect(within(sheet).getByRole("button", { name: /^Add to cart/ })).toHaveTextContent("₹820.00"); // 2 × (300 + 80 + 30)
    await user.click(within(sheet).getByRole("button", { name: /^Add to cart/ }));
    expect(screen.queryByRole("dialog")).toBeNull();

    const bar = screen.getByRole("link", { name: /View cart: 4 items/ });
    expect(bar).toHaveAttribute("href", `/t/${TOKEN}/cart`);
    expect(bar).toHaveTextContent("₹1,113.00"); // (240 + 820) × 1.05
    const saved = loadCart(TOKEN).lines;
    expect(saved.map((l) => [l.menuItemId, l.variantId, l.modifierOptionIds, l.qty])).toEqual([["i-dosa", undefined, [], 2], ["i-biryani", "v-large", ["o-hot", "o-raita"], 2]]);
  });

  it("explains when ordering is closed and only shows facts the restaurant entered", () => {
    handler = () => ({ data: menuData() });
    const data = { ...menuData(), ordering: { open: false, message: "We're closed right now — ordering opens at 9:00 AM. You can still browse the menu." } };
    inStore(<GuestMenuScreen />, data);
    expect(screen.getByRole("status")).toHaveTextContent("We're closed right now");
    expect(screen.getByRole("button", { name: "Add Masala Dosa" })).toBeDisabled();
    expect(screen.queryByText(/Get directions/)).toBeNull(); // no address entered
    expect(screen.queryByText(/Opening hours/)).toBeNull();
  });

  it("brands Coders' Cafe and keeps every other restaurant neutral", () => {
    expect(brandFor("Coders' Cafe")).toMatchObject({ theme: "coders", strap: "Brew · Muse · Play", codeAccents: true });
    expect(brandFor("CODERS CAFE")).toMatchObject({ theme: "coders" });
    expect(brandFor("Spice Route")).toMatchObject({ theme: "classic", about: null, codeAccents: false });
  });
});

describe("guest storefront — cart", () => {
  it("prices the cart on the server: updated prices are applied and announced, unavailable items block checkout until removed", async () => {
    const user = userEvent.setup();
    seedCart([line({ qty: 2 }), line({ menuItemId: "i-biryani", name: "Biryani", unitPrice: 300, qty: 1 })]);
    handler = (c) => {
      if (c.url.endsWith("/quote")) {
        const items = c.body.items as Array<{ menuItemId: string; qty: number }>;
        return { data: quoteOf(items.map((i) => (i.menuItemId === "i-biryani" ? { ok: false as const, menuItemId: i.menuItemId, reason: "Biryani is sold out at this outlet" } : { ok: true as const, menuItemId: i.menuItemId, name: "Masala Dosa", unitPrice: "130.00", qty: i.qty }))) };
      }
      return { data: menuData() };
    };
    inStore(<GuestCartScreen />);

    expect(await screen.findByText(/The café changed the price of Masala Dosa/)).toBeInTheDocument();
    expect(screen.getByText("Biryani is sold out at this outlet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove unavailable items to continue" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /Proceed to checkout/ })).toBeNull();
    // The cart now carries the server's price. It is saved to sessionStorage by an effect that runs after the
    // render showing the notice, so wait for it (reading it in the same tick raced on a loaded machine).
    await waitFor(() => expect(loadCart(TOKEN).lines[0].unitPrice).toBe(130));
    const quote = calls.find((c) => c.url.endsWith("/quote"))!;
    expect(quote.url).toBe(`/api/qr/t/${TOKEN}/quote`);
    expect(JSON.stringify(quote.body)).not.toMatch(/price|total|tax/i);

    await user.click(screen.getByRole("button", { name: "Remove Biryani" }));
    const go = await screen.findByRole("link", { name: /Proceed to checkout/ });
    expect(go).toHaveAttribute("href", `/t/${TOKEN}/checkout`);
    expect(screen.getByTestId("cart-total")).toHaveTextContent("₹273.00"); // 2 × 130 × 1.05, from the server

    await user.click(screen.getByRole("button", { name: "Clear cart" }));
    await user.click(screen.getByRole("button", { name: "Yes, clear cart" }));
    expect(await screen.findByText("Your cart is empty")).toBeInTheDocument();
  });

  it("edits a configured line in the sheet (size / add-ons) without duplicating it", async () => {
    const user = userEvent.setup();
    seedCart([line({ menuItemId: "i-biryani", name: "Biryani", unitPrice: 300, modifierOptionIds: ["o-hot"], modifierLabels: ["Spice: Hot"], qty: 1 })]);
    handler = (c) => (c.url.endsWith("/quote") ? { data: quoteOf((c.body.items as Array<{ menuItemId: string; qty: number; variantId?: string; modifierOptionIds?: string[] }>).map((i) => ({ ok: true as const, menuItemId: i.menuItemId, name: "Biryani", unitPrice: i.variantId ? "380.00" : "300.00", modifiersPerUnit: i.modifierOptionIds?.includes("o-egg") ? "25.00" : "0.00", qty: i.qty }))) } : { data: menuData() });
    inStore(<GuestCartScreen />);
    await user.click(await screen.findByRole("button", { name: "Edit Biryani" }));
    const sheet = await screen.findByRole("dialog", { name: "Biryani" });
    expect(within(sheet).getByRole("radio", { name: /^Hot/ })).toBeChecked();
    await user.click(within(sheet).getByRole("radio", { name: /^Large/ }));
    await user.click(within(sheet).getByRole("radio", { name: /^Egg/ }));
    await user.click(within(sheet).getByRole("button", { name: /^Update item/ }));
    await waitFor(() => expect(loadCart(TOKEN).lines).toEqual([expect.objectContaining({ name: "Biryani (Large)", variantId: "v-large", modifierOptionIds: ["o-hot", "o-egg"], qty: 1 })]));
    expect(await screen.findByTestId("cart-total")).toHaveTextContent("₹425.25"); // (380 + 25) × 1.05
  });
});

describe("guest storefront — checkout", () => {
  const okQuote = (c: Call) => quoteOf((c.body.items as Array<{ menuItemId: string; qty: number }>).map((i) => ({ ok: true as const, menuItemId: i.menuItemId, name: "Masala Dosa", unitPrice: "120.00", qty: i.qty })));

  it("places ONE order (double tap) with items only, optional name / phone and the payment choice, then opens the order page", async () => {
    const user = userEvent.setup();
    seedCart([line({ qty: 2 })], "no onion");
    const navigate = vi.fn();
    handler = (c) => (c.url.endsWith("/quote") ? { data: okQuote(c) } : c.method === "POST" ? { data: { orderId: "cmord1", ref: "ORD001", accessKey: "key-abc", replayed: false } } : { data: menuData() });
    inStore(<GuestCheckoutScreen navigate={navigate} />);
    expect(await screen.findByText("Table T4")).toBeInTheDocument();
    await screen.findByText("Prices and GST confirmed by the café just now.").catch(() => undefined);
    await waitFor(() => expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled());
    expect(screen.getByTestId("checkout-total")).toHaveTextContent("₹252.00");
    await user.type(screen.getByLabelText(/Your name/), "Ananya");
    await user.type(screen.getByLabelText(/Phone/), "+91 98765-43210");
    await user.click(screen.getByRole("radio", { name: /Pay online/ }));
    const place = screen.getByRole("button", { name: /Place order & pay ₹252\.00/ });
    await user.dblClick(place);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`${orderUrl("cmord1", "key-abc")}&new=1&pay=1`));
    const posts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/orders"));
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`/api/qr/t/${TOKEN}/orders`);
    expect(posts[0].headers["Idempotency-Key"]).toMatch(/^qr-/);
    expect(posts[0].body).toEqual({ items: [{ menuItemId: "i-dosa", qty: 2 }], notes: "no onion", customer: { name: "Ananya", phone: "9876543210" }, paymentMethod: "ONLINE" });
    expect(JSON.stringify(posts[0].body)).not.toMatch(/price|total|tax/i);
    expect(rememberedOrders()).toEqual([expect.objectContaining({ orderId: "cmord1", key: "key-abc", token: TOKEN })]);
    expect(loadCart(TOKEN).lines).toHaveLength(0);
  });

  it("shows the server's refusal, refreshes the menu and re-checks the cart; a retry reuses the same idempotency key", async () => {
    const user = userEvent.setup();
    seedCart([line({})]);
    let n = 0;
    handler = (c) => {
      if (c.url.endsWith("/quote")) return { data: okQuote(c) };
      if (c.method === "POST") return ++n === 1 ? { status: 422, error: { code: "ValidationError", message: "Item 1: Masala Dosa is sold out at this outlet. Please update your cart." } } : { data: { orderId: "o2", ref: "R2", accessKey: "k2" } };
      return { data: menuData() };
    };
    inStore(<GuestCheckoutScreen navigate={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled()); // after the server quote
    await user.click(screen.getByRole("button", { name: "Place order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("sold out");
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === `/api/qr/t/${TOKEN}`)).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/quote")).length).toBeGreaterThanOrEqual(2));
    await user.click(await screen.findByRole("button", { name: "Place order" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/orders"))).toHaveLength(2));
    const keys = calls.filter((c) => c.method === "POST" && c.url.endsWith("/orders")).map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(calls.find((c) => c.url.endsWith("/orders"))!.body.paymentMethod).toBe("CASH");
  });

  it("validates the optional phone before sending anything", async () => {
    const user = userEvent.setup();
    seedCart([line({})]);
    handler = (c) => (c.url.endsWith("/quote") ? { data: okQuote(c) } : { data: menuData() });
    inStore(<GuestCheckoutScreen navigate={() => undefined} />);
    await screen.findByText("₹126.00", { selector: "[data-testid=checkout-total]" });
    await user.type(screen.getByLabelText(/Phone/), "12ab");
    await user.tab();
    expect(screen.getByText("Enter a valid mobile number, or leave it empty.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Place order" })).toBeDisabled();
    expect(calls.some((c) => c.url.endsWith("/orders"))).toBe(false);
    expect(normalizePhone("098765 43210")).toBe("9876543210");
    expect(phoneValid("")).toBe(true);
    expect(phoneValid("+44 20 7946 0958")).toBe(true);
  });
});

const bill = (over: Partial<Bill> = {}): Bill => ({
  kind: "BILL", billNo: "ORD001", orderId: "cmord1",
  restaurant: { name: "Spice Route", outletName: "Central", address: "1 Road", phone: null, timezone: "Asia/Kolkata", currency: "INR" },
  table: "T4", channel: "QR", source: "QR", covers: 1, orderStatus: "SENT", fulfilment: "PREPARING", createdAt: "2026-10-04T08:00:00.000Z", paidAt: null,
  lines: [{ name: "Biryani", qty: "2", unitPrice: "300.00", modifiers: [{ name: "Spice: Hot", priceDelta: "0.00" }], discount: "0.00", taxPct: "5", lineTotal: "600.00", notes: null }],
  subtotal: "600.00", discount: "0.00", taxes: [{ ratePct: "5", taxable: "600.00", amount: "30.00" }], tax: "30.00", total: "630.00",
  payments: [], refunds: [], paid: "0.00", refunded: "0.00", balanceDue: "630.00", paymentStatus: "UNPAID", invoice: null, creditNotes: [], ...over,
});

describe("guest order page", () => {
  it("authenticates with the key from the URL fragment and pays through the server (decline, then approve)", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/o/cmord1#k=key-abc");
    const view = (over: object = {}) => ({ orderId: "cmord1", ref: "ORD001", status: "SENT", fulfilment: "PREPARING", fulfilmentLabel: "Being prepared", tracker: { step: 2, confirmed: true }, bill: bill(), canPay: true, payment: { online: true, testMode: true }, pendingPaymentId: null, reorder: [], split: { sharesPaid: 0, minParts: 2, maxParts: 12 }, ...over });
    let confirms = 0;
    handler = (c) => {
      if (c.url.endsWith("/payments/confirm")) {
        confirms++;
        return confirms === 1
          ? { data: { ...view(), paymentStatus: "FAILED" } }
          : { data: { ...view({ status: "PAID", canPay: false, bill: bill({ kind: "RECEIPT", paymentStatus: "PAID", paid: "630.00", balanceDue: "0.00", payments: [{ method: "ONLINE", status: "SUCCESS", amount: "630.00", at: "2026-10-04T08:10:00.000Z" }] }) }), paymentStatus: "SUCCESS" } };
      }
      if (c.url.endsWith("/payments")) return { data: { paymentId: `pay${confirms}`, amount: "630.00", provider: "mock", testMode: true } };
      return { data: view() };
    };
    render(<GuestOrderScreen orderId="cmord1" />);
    expect(await screen.findByTestId("order-stage")).toHaveTextContent("Being prepared");
    expect(calls[0]).toMatchObject({ url: "/api/qr/orders/cmord1" });
    expect(calls[0].headers["x-order-key"]).toBe("key-abc");
    expect(calls[0].url).not.toContain("key-abc");

    await user.click(screen.getByRole("button", { name: /Pay .*630\.00/ }));
    const gw = await screen.findByRole("region", { name: "Test payment gateway" });
    await user.click(within(gw).getByRole("button", { name: "Decline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("declined");
    await user.click(screen.getByRole("button", { name: /Pay .*630\.00/ }));
    await user.click(within(await screen.findByRole("region", { name: "Test payment gateway" })).getByRole("button", { name: "Approve payment" }));
    expect(await screen.findByText("Payment successful. Thank you!")).toBeInTheDocument();
    expect(screen.getByTestId("bill-payment-status")).toHaveTextContent("Paid");
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();

    const confirmsSent = calls.filter((c) => c.url.endsWith("/payments/confirm")).map((c) => c.body);
    expect(confirmsSent).toEqual([{ paymentId: "pay0", gateway: { mockOutcome: "decline" } }, { paymentId: "pay1" }]);
    const starts = calls.filter((c) => c.url.endsWith("/payments"));
    expect(starts[0].body).toBeUndefined(); // the amount is the server's, never sent
    expect(starts[0].headers["Idempotency-Key"]).not.toBe(starts[1].headers["Idempotency-Key"]); // a new attempt after a decline
  });

  describe("Razorpay Checkout", () => {
    type Opts = { key: string; order_id: string; amount: number; currency: string; handler: (r: Record<string, string>) => void; modal: { ondismiss: () => void } };
    let opened: Opts[] = [];
    let behaviour: (o: Opts, failed: (r: unknown) => void) => void;
    beforeEach(() => {
      opened = [];
      window.Razorpay = class {
        private failed: (r: unknown) => void = () => undefined;
        constructor(private o: Opts) { opened.push(o); }
        on(_e: string, cb: (r: unknown) => void) { this.failed = cb; }
        open() { setTimeout(() => behaviour(this.o, this.failed), 0); }
      } as never;
    });
    afterEach(() => { delete window.Razorpay; });

    const rzpView = (over: object = {}) => ({ orderId: "cmord9", ref: "ORD009", status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE", fulfilmentLabel: "Waiting", tracker: { step: 0, confirmed: false }, bill: bill({ total: "462.00", balanceDue: "462.00" }), canPay: true, payment: { online: true, testMode: false, mode: "SANDBOX" }, pendingPaymentId: null, reorder: [], split: { sharesPaid: 0, minParts: 2, maxParts: 12 }, ...over });
    const started = { paymentId: "payR", amount: "462.00", provider: "razorpay", mode: "SANDBOX", testMode: false, checkout: { provider: "razorpay", mode: "SANDBOX", keyId: "rzp_test_PUBLIC", orderId: "order_R1", amount: 46200, currency: "INR" } };

    it("opens Checkout with the server's key, gateway order and amount; the signed response is verified by the server", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord9#k=key-9");
      const success = { razorpay_payment_id: "pay_1", razorpay_order_id: "order_R1", razorpay_signature: "sig" };
      behaviour = (o) => o.handler(success);
      handler = (c) => {
        if (c.url.endsWith("/payments/confirm")) return { data: { ...rzpView({ status: "PAID", canPay: false, bill: bill({ kind: "RECEIPT", paymentStatus: "PAID", paid: "462.00", balanceDue: "0.00", total: "462.00" }) }), paymentStatus: "SUCCESS", pending: false } };
        if (c.url.endsWith("/payments")) return { data: started };
        return { data: rzpView() };
      };
      render(<GuestOrderScreen orderId="cmord9" />);
      expect(await screen.findByTestId("gateway-mode")).toHaveTextContent("Razorpay test mode");
      expect(screen.getByTestId("pay-at-counter")).toHaveTextContent("Pay at the counter");
      await user.click(screen.getByRole("button", { name: /Pay online .*462\.00/ }));
      expect(await screen.findByText("Payment successful. Thank you!")).toBeInTheDocument();
      expect(opened).toEqual([expect.objectContaining({ key: "rzp_test_PUBLIC", order_id: "order_R1", amount: 46200, currency: "INR" })]);
      const confirms = calls.filter((c) => c.url.endsWith("/payments/confirm")).map((c) => c.body);
      expect(confirms).toEqual([{ paymentId: "payR", gateway: success }]);
    });

    it("a closed window is a status check, not a failure; a declined attempt is reported while the window stays open", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord9#k=key-9");
      behaviour = (o, failed) => {
        failed({ error: { description: "Card declined by the bank." } });
        o.modal.ondismiss();
      };
      handler = (c) => {
        if (c.url.endsWith("/payments/confirm")) return { data: { ...rzpView({ pendingPaymentId: "payR" }), paymentStatus: "PENDING", pending: true } };
        if (c.url.endsWith("/payments")) return { data: started };
        return { data: rzpView() };
      };
      render(<GuestOrderScreen orderId="cmord9" />);
      await user.click(await screen.findByRole("button", { name: /Pay online/ }));
      // The bank's reason stays on screen after the window closes (the server still decides the state).
      expect(await screen.findByRole("alert")).toHaveTextContent("Card declined by the bank. You can try again.");
      expect(calls.filter((c) => c.url.endsWith("/payments/confirm")).map((c) => c.body)).toEqual([{ paymentId: "payR" }]);
      // Resuming asks the server first (the UPI app may have completed it), then reopens the SAME checkout.
      behaviour = (o) => o.modal.ondismiss();
      await user.click(await screen.findByRole("button", { name: /Resume payment/ }));
      await waitFor(() => expect(opened).toHaveLength(2));
      // Closed again without a decline: "not completed", not "declined".
      await waitFor(() => expect(screen.getAllByRole("status").some((el) => /^Payment not completed\. If money left your account/.test(el.textContent ?? ""))).toBe(true));
      const after = calls.filter((c) => c.method === "POST").map((c) => c.url.replace("/api/qr/orders/cmord9", ""));
      expect(after).toEqual(["/payments", "/payments/confirm", "/payments/confirm", "/payments", "/payments/confirm"]);
    });
  });

  it("live tracker follows the kitchen; checkout's \"pay online\" opens the payment once and is not replayed by a refresh", async () => {
    window.history.replaceState(null, "", "/o/cmord5#k=key-5&new=1&pay=1");
    const v = (over: object = {}) => ({ orderId: "cmord5", ref: "ORD005", status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE", fulfilmentLabel: "Waiting for the restaurant to accept", tracker: { step: 0, confirmed: false }, bill: bill(), canPay: true, payment: { online: true, testMode: true }, pendingPaymentId: null, reorder: [], split: { sharesPaid: 0, minParts: 2, maxParts: 12 }, ...over });
    handler = (c) => (c.url.endsWith("/payments") ? { data: { paymentId: "p5", amount: "630.00", provider: "mock", testMode: true } } : { data: v() });
    const { unmount } = render(<GuestOrderScreen orderId="cmord5" />);
    expect(await screen.findByRole("region", { name: "Test payment gateway" })).toBeInTheDocument(); // opened without a tap
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Complete your payment");
    expect(window.location.hash).toBe("#k=key-5"); // one-shot flags removed
    expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(1);
    unmount();

    // Kitchen accepted (KDS "Accept"): step 2 of 5 is current; nothing is communicated by colour alone.
    handler = () => ({ data: v({ status: "SENT", fulfilment: "PREPARING", fulfilmentLabel: "Being prepared", tracker: { step: 1, confirmed: true } }) });
    render(<GuestOrderScreen orderId="cmord5" />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Kitchen accepted");
    const steps = within(screen.getByRole("list", { name: "Order progress" })).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-state"))).toEqual(["done", "current", "todo", "todo", "todo"]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(steps[0]).toHaveTextContent("Done.");
    expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(1); // no second auto-start
  });

  describe("splitting the bill and ordering again", () => {
    const reorder = [
      { menuItemId: "i-biryani", name: "Biryani", variantId: "v-large", modifierOptionIds: ["o-hot"], modifierLabels: ["Spice: Hot"], unitPrice: 380, modifiersPerUnit: 0, taxPct: 5, qty: 2, notes: "no onions" },
      { menuItemId: "i-dosa", name: "Masala Dosa", modifierOptionIds: [], modifierLabels: [], unitPrice: 120, modifiersPerUnit: 0, taxPct: 5, qty: 1 },
    ];
    const v = (over: object = {}) => ({ orderId: "cmord7", ref: "ORD007", status: "OPEN", fulfilment: "AWAITING_ACCEPTANCE", fulfilmentLabel: "Waiting for the restaurant to accept", tracker: { step: 0, confirmed: false }, bill: bill({ total: "630.00", balanceDue: "630.00" }), canPay: true, payment: { online: true, testMode: true }, pendingPaymentId: null, reorder, split: { sharesPaid: 0, minParts: 2, maxParts: 12 }, ...over });

    it("shows each person's part before they pay, sends only the number of people, and shows the server's amount", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      handler = (c) => (c.url.endsWith("/payments") ? { data: { paymentId: "pS1", amount: "210.00", provider: "mock", testMode: true, share: { parts: 3, remainingParts: 3, last: false } } } : { data: v() });
      render(<GuestOrderScreen orderId="cmord7" />);
      await user.click(await screen.findByRole("button", { name: "Split the bill" }));
      expect(screen.getByTestId("split-parts")).toHaveTextContent("2");
      expect(screen.getByTestId("split-share")).toHaveTextContent("Your part: ₹315.00. One more person pays the rest");
      expect(screen.getByRole("button", { name: "Fewer people" })).toBeDisabled(); // 2 is the least
      await user.click(screen.getByRole("button", { name: "More people" }));
      expect(screen.getByTestId("split-parts")).toHaveTextContent("3");
      expect(screen.getByTestId("split-share")).toHaveTextContent("Your part: ₹210.00. 2 more people pay the rest");
      await user.click(screen.getByRole("button", { name: /Pay your part .*210\.00/ }));
      const gw = await screen.findByRole("region", { name: "Test payment gateway" });
      expect(within(gw).getByTestId("share-note")).toHaveTextContent("Your part of the bill, split 3 ways");
      expect(gw).toHaveTextContent("210.00");
      const start = calls.find((c) => c.url.endsWith("/payments"))!;
      expect(start.body).toEqual({ parts: 3 }); // never an amount
      expect(start.headers["Idempotency-Key"]).toBeTruthy();
    });

    it("the last person pays what is left; a part that is paid says what is still due", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      const half = (over: object = {}) => v({ bill: bill({ total: "630.00", balanceDue: "315.00", paid: "315.00", paymentStatus: "PARTIALLY_PAID" }), split: { sharesPaid: 1, minParts: 2, maxParts: 12 }, ...over });
      let state = half();
      handler = (c) => {
        if (c.url.endsWith("/payments/confirm")) {
          state = half({ bill: bill({ total: "630.00", balanceDue: "105.00", paid: "525.00", paymentStatus: "PARTIALLY_PAID" }), split: { sharesPaid: 2, minParts: 2, maxParts: 12 } });
          return { data: { ...state, paymentStatus: "SUCCESS" } };
        }
        if (c.url.endsWith("/payments")) return { data: { paymentId: "pS2", amount: "210.00", provider: "mock", testMode: true, share: { parts: 3, remainingParts: 2, last: false } } };
        return { data: state };
      };
      render(<GuestOrderScreen orderId="cmord7" />);
      await user.click(await screen.findByRole("button", { name: "Split the bill" }));
      await user.click(screen.getByRole("button", { name: "More people" }));
      expect(screen.getByTestId("split-share")).toHaveTextContent("Your part: ₹157.50. One more person pays the rest");
      expect(screen.getByTestId("split-share")).toHaveTextContent("One part is already paid.");
      await user.click(screen.getByRole("button", { name: /Pay your part/ }));
      await user.click(within(await screen.findByRole("region", { name: "Test payment gateway" })).getByRole("button", { name: "Approve payment" }));
      expect(await screen.findByText(/Your part is paid\. ₹105\.00 is still due on this bill\./)).toBeInTheDocument();
    });

    it("a new ask is a new payment: the same ask retried keeps its key, a different number of people does not", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      handler = (c) => {
        if (c.url.endsWith("/payments")) return { error: { code: "VALIDATION_ERROR", message: "Could not start the payment." } };
        return { data: v() };
      };
      render(<GuestOrderScreen orderId="cmord7" />);
      await user.click(await screen.findByRole("button", { name: "Split the bill" }));
      await user.click(screen.getByRole("button", { name: /Pay your part/ }));
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: /Pay your part/ }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(2));
      await user.click(screen.getByRole("button", { name: "More people" }));
      await user.click(screen.getByRole("button", { name: /Pay your part/ }));
      await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/payments"))).toHaveLength(3));
      const keys = calls.filter((c) => c.url.endsWith("/payments")).map((c) => c.headers["Idempotency-Key"]);
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it("offers no split once nothing is due, or when online payment is off", async () => {
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      handler = () => ({ data: v({ canPay: false }) });
      render(<GuestOrderScreen orderId="cmord7" />);
      expect(await screen.findByTestId("pay-at-counter")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Split the bill" })).toBeNull();
    });

    it("\"Order the same again\" fills the cart with the same dishes and opens it; the cart screen prices them", async () => {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      rememberOrder({ orderId: "cmord7", key: "key-7", token: "tok-7", ref: "ORD007", at: "2026-10-04T08:00:00.000Z" });
      saveCart("tok-7", cartReducer(emptyCart("DINE_IN"), { type: "add", line: { menuItemId: "i-dosa", name: "Masala Dosa", modifierOptionIds: [], modifierLabels: [], unitPrice: 120, modifiersPerUnit: 0, taxPct: 5, qty: 1 } }));
      handler = () => ({ data: v() });
      const assign = vi.fn();
      const original = window.location;
      Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign, hash: original.hash, pathname: original.pathname, search: original.search } });
      try {
        render(<GuestOrderScreen orderId="cmord7" />);
        await user.click(await screen.findByRole("button", { name: "Order the same again" }));
        expect(assign).toHaveBeenCalledWith("/t/tok-7/cart");
      } finally {
        Object.defineProperty(window, "location", { configurable: true, value: original });
      }
      const lines = loadCart("tok-7").lines;
      expect(lines.map((l) => [l.menuItemId, l.qty])).toEqual([["i-dosa", 2], ["i-biryani", 2]]); // merged with what was already in the cart
      expect(lines[1]).toMatchObject({ variantId: "v-large", modifierOptionIds: ["o-hot"], notes: "no onions" });
      expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing is ordered until the guest checks out
    });

    it("has no \"Order the same again\" without the menu link, or for an order with no dishes", async () => {
      window.history.replaceState(null, "", "/o/cmord7#k=key-7");
      handler = () => ({ data: v() });
      const { unmount } = render(<GuestOrderScreen orderId="cmord7" />);
      await screen.findByTestId("order-stage");
      expect(screen.queryByRole("button", { name: "Order the same again" })).toBeNull(); // opened from a bookmark: no table menu to go back to
      unmount();
      rememberOrder({ orderId: "cmord7", key: "key-7", token: "tok-7", ref: "ORD007", at: "2026-10-04T08:00:00.000Z" });
      handler = () => ({ data: v({ reorder: [] }) });
      render(<GuestOrderScreen orderId="cmord7" />);
      await screen.findByTestId("order-stage");
      expect(screen.queryByRole("button", { name: "Order the same again" })).toBeNull();
    });
  });

  it("without a key it explains instead of calling the API", async () => {
    window.history.replaceState(null, "", "/o/other");
    handler = () => ({ data: null });
    render(<GuestOrderScreen orderId="other" />);
    expect(await screen.findByText("Order link incomplete")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe("bill view", () => {
  it("renders the server's amounts, modifiers, tax lines and payment state, and never claims a tax invoice", () => {
    render(<BillView bill={bill({ discount: "10.00", payments: [{ method: "CASH", status: "SUCCESS", amount: "100.00", at: "2026-10-04T08:05:00.000Z" }], paid: "100.00", balanceDue: "520.00", paymentStatus: "PARTIALLY_PAID" })} />);
    const doc = screen.getByRole("article", { name: "Bill ORD001" });
    expect(within(doc).getByText("+ Spice: Hot")).toBeInTheDocument();
    expect(within(doc).getByLabelText("Totals")).toHaveTextContent(/Tax 5% on ₹600\.00.*₹30\.00.*Total.*₹630\.00/);
    expect(within(doc).getByLabelText("Payments")).toHaveTextContent(/Balance due.*₹520\.00/);
    expect(screen.getByTestId("bill-payment-status")).toHaveTextContent("Partially paid");
    expect(doc).toHaveTextContent("not a tax invoice");
    expect(doc).not.toHaveTextContent(/GST|Tax invoice/);
  });
});

describe("guest browser state", () => {
  it("cart and submission key survive a refresh; a changed cart gets a new key", () => {
    const cart = cartReducer(emptyCart("DINE_IN"), { type: "add", line: { menuItemId: "m", name: "M", modifierOptionIds: [], modifierLabels: [], unitPrice: 1, modifiersPerUnit: 0, taxPct: 5, qty: 2 } });
    saveCart("t1", cart);
    expect(loadCart("t1").lines).toEqual(cart.lines);
    expect(loadCart("t2").lines).toEqual([]);
    const k = submissionKey("t1", "fp-a");
    expect(submissionKey("t1", "fp-a")).toBe(k);
    expect(submissionKey("t1", "fp-b")).not.toBe(k);
    clearSubmission("t1");
    expect(submissionKey("t1", "fp-b")).not.toBe(k);
  });

  it("remembers orders and prefers the fragment key", () => {
    rememberOrder({ orderId: "o1", key: "k1", token: "t", ref: "R1", at: "x" });
    expect(orderKeyFor("o1", "")).toBe("k1");
    expect(orderKeyFor("o1", "#k=k9")).toBe("k9");
    expect(orderKeyFor("o2", "")).toBeNull();
    localStorage.setItem("aharos.guest.orders", "{corrupt");
    expect(rememberedOrders()).toEqual([]);
  });
});
