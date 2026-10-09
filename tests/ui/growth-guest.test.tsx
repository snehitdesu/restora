// @vitest-environment jsdom
/**
 * Group 6 on the guest side, in a DOM: the coupon box (cart and checkout), the referral code and the explicit offers
 * opt-in at checkout, the rating on the order page, and the three link pages (feedback, unsubscribe, invite). The
 * server decides every price and answer; the pages send only what the guest typed and show what the server said.
 */
import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuestCartScreen } from "@/features/guest/components/GuestCartScreen";
import { GuestCheckoutScreen } from "@/features/guest/components/GuestCheckoutScreen";
import { RateTheMeal } from "@/features/guest/components/GuestOffers";
import { FeedbackLinkScreen, ReferralLandingScreen, UnsubscribeScreen } from "@/features/guest/components/GuestLinks";
import { StorefrontProvider, type GuestMenuData } from "@/features/guest/storefront";
import { loadCoupon, loadReferral, saveCart, takeNotice, wasRated } from "@/features/guest/session";
import { cartReducer, emptyCart, type CartLine } from "@/features/pos/cart";

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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const TOKEN = "tok-123456";
const menuData = (): GuestMenuData => ({
  restaurant: { name: "Spice Route", outletName: "Central", address: null, phone: null, currency: "INR", hours: null },
  table: { code: "T4" }, ordering: { open: true, message: null }, payment: { online: false, testMode: false },
  menu: [{ id: "i-dosa", name: "Masala Dosa", description: "Crisp", price: 120, effectivePrice: 120, taxPct: 5, station: "KITCHEN", isVeg: true, active: true, offered: true, soldOut: false, effectiveSoldOut: false, categoryId: "c1", category: { id: "c1", name: "Tiffin", sortOrder: 1 }, variants: [], modifierGroups: [] }],
});
const inStore = (ui: ReactNode) => render(<StorefrontProvider token={TOKEN} initial={menuData()}>{ui}</StorefrontProvider>);
const line = (over: Partial<CartLine> = {}): Omit<CartLine, "key"> => ({ menuItemId: "i-dosa", name: "Masala Dosa", modifierOptionIds: [], modifierLabels: [], unitPrice: 120, modifiersPerUnit: 0, taxPct: 5, qty: 2, ...over });
function seedCart(lines: Array<Omit<CartLine, "key">>) {
  let c = emptyCart("DINE_IN");
  for (const l of lines) c = cartReducer(c, { type: "add", line: l });
  saveCart(TOKEN, c);
}

/** The server's quote for 2 × ₹120, with the coupon answer a code would get. */
function quote(c: Call) {
  const code = c.body.couponCode as string | undefined;
  const sub = 240;
  const good = code === "WELCOME10";
  const discount = good ? 24 : 0;
  const tax = Math.round((sub - discount) * 5) / 100;
  return {
    lines: [{ index: 0, ok: true, menuItemId: "i-dosa", name: "Masala Dosa", unitPrice: "120.00", modifiers: [], modifiersPerUnit: "0.00", taxPct: "5", qty: 2, lineTotal: "240.00" }],
    subtotal: sub.toFixed(2), tax: tax.toFixed(2), taxes: [{ ratePct: "5", amount: tax.toFixed(2) }], total: (sub - discount + tax).toFixed(2), allAvailable: true, ordering: { open: true, message: null }, discount: discount.toFixed(2),
    ...(code ? { coupon: good ? { ok: true, code, name: "Welcome", discount: "24.00" } : { ok: false, message: "This code can't be used here." } } : {}),
  };
}

describe("the coupon box", () => {
  it("sends the code with the quote, shows the saving and the discounted total, and remembers it for this table; Remove drops it", async () => {
    const user = userEvent.setup();
    seedCart([line()]);
    handler = (c) => (c.url.endsWith("/quote") ? { data: quote(c) } : { data: menuData() });
    inStore(<GuestCartScreen />);
    await screen.findByText("Prices and GST confirmed by the café just now."); // the server's quote has arrived
    await user.type(screen.getByLabelText(/Have a coupon code/), "welcome10");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByTestId("coupon-applied")).toHaveTextContent("WELCOME10");
    expect(screen.getByText(/You save/)).toHaveTextContent("₹24.00");
    await waitFor(() => expect(screen.getByTestId("cart-total")).toHaveTextContent("₹226.80"));
    expect(screen.getByTestId("cart-discount")).toHaveTextContent("− ₹24.00");
    const quoted = calls.filter((c) => c.url.endsWith("/quote")).at(-1)!;
    expect(quoted.body).toMatchObject({ couponCode: "WELCOME10" });
    expect(quoted.body).not.toHaveProperty("phone"); // no phone typed yet
    expect(loadCoupon(TOKEN)).toBe("WELCOME10");

    await user.click(screen.getByRole("button", { name: "Remove coupon WELCOME10" }));
    await waitFor(() => expect(screen.getByTestId("cart-total")).toHaveTextContent("₹252.00"));
    expect(loadCoupon(TOKEN)).toBeNull();
    expect(screen.queryByTestId("cart-discount")).toBeNull();
  });

  it("a code the server refuses is explained in the guest's words and can be removed; the cart still checks out", async () => {
    const user = userEvent.setup();
    seedCart([line()]);
    handler = (c) => (c.url.endsWith("/quote") ? { data: quote(c) } : { data: menuData() });
    inStore(<GuestCartScreen />);
    await screen.findByText("Prices and GST confirmed by the café just now.");
    await user.type(screen.getByLabelText(/Have a coupon code/), "nosuch");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/This code can't be used here/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Proceed to checkout/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText(/This code can't be used here/)).toBeNull());
  });
});

describe("checkout: referral and offers", () => {
  const placed = (extra: Record<string, unknown> = {}) => ({ orderId: "ord9", ref: "ORD009", accessKey: "key-9", replayed: false, ...extra });

  it("sends the accepted coupon, the friend's code and an explicit yes only when a phone number is given; the invite code on this phone is filled in", async () => {
    const user = userEvent.setup();
    localStorage.setItem("aharos.guest.referral", JSON.stringify("RF7K2M9Q"));
    sessionStorage.setItem(`aharos.guest.coupon.${TOKEN}`, JSON.stringify("WELCOME10"));
    seedCart([line()]);
    const navigate = vi.fn();
    handler = (c) => (c.url.endsWith("/quote") ? { data: quote(c) } : c.method === "POST" ? { data: placed({ coupon: { applied: true }, referral: { attached: true } }) } : { data: menuData() });
    inStore(<GuestCheckoutScreen navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled());
    const friend = screen.getByLabelText(/Friend's referral code/);
    expect(friend).toHaveValue("RF7K2M9Q");
    expect(friend).toBeDisabled(); // needs a phone number first
    const offers = screen.getByRole("checkbox", { name: /Send me offers/ });
    expect(offers).toBeDisabled();
    expect(offers).not.toBeChecked(); // never pre-ticked

    await user.type(screen.getByLabelText(/Phone/), "98765 43210");
    await waitFor(() => expect(friend).toBeEnabled());
    await user.click(offers);
    // A first-order / per-guest coupon is checked against the guest's own record, so the phone re-prices the cart.
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/quote")).at(-1)!.body).toMatchObject({ couponCode: "WELCOME10", phone: "9876543210" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"))!;
    expect(post.body).toMatchObject({ customer: { phone: "9876543210" }, couponCode: "WELCOME10", referralCode: "RF7K2M9Q", marketingOptIn: true });
    expect(JSON.stringify(post.body)).not.toMatch(/discount|price|total/i); // the server prices the coupon
    // Used: nothing is kept for the next order.
    expect(loadReferral()).toBeNull();
    expect(loadCoupon(TOKEN)).toBeNull();
    expect(takeNotice("ord9")).toBeNull();
  });

  it("without a phone number neither the referral code nor the opt-in is sent; a refused code is explained on the order page", async () => {
    const user = userEvent.setup();
    localStorage.setItem("aharos.guest.referral", JSON.stringify("RF7K2M9Q"));
    sessionStorage.setItem(`aharos.guest.coupon.${TOKEN}`, JSON.stringify("WELCOME10"));
    seedCart([line()]);
    const navigate = vi.fn();
    handler = (c) => (c.url.endsWith("/quote") ? { data: quote(c) } : c.method === "POST" ? { data: placed({ coupon: { applied: false, message: "This code has been fully used." } }) } : { data: menuData() });
    inStore(<GuestCheckoutScreen navigate={navigate} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Place order" }));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/orders"))!;
    expect(post.body).not.toHaveProperty("referralCode");
    expect(post.body).not.toHaveProperty("marketingOptIn");
    expect(takeNotice("ord9")).toBe("Coupon not applied: This code has been fully used.");
    expect(takeNotice("ord9")).toBeNull(); // shown once
    expect(loadReferral()).toBe("RF7K2M9Q"); // not used: kept for the next order
  });
});

describe("rating the meal", () => {
  it("stars first, a comment prompt that fits the rating, one send; a happy guest is offered the review page; the order page does not ask again", async () => {
    const user = userEvent.setup();
    handler = () => ({ data: { thanks: true, routedTo: "GOOGLE", reviewUrl: "https://g.page/r/abc/review", alreadyAnswered: false } });
    render(<RateTheMeal orderId="ord1" orderKey="key-1" />);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "5 stars" }));
    expect(screen.getByLabelText(/Anything you'd like to add/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "2 stars" }));
    expect(screen.getByLabelText(/What went wrong/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "5 stars" }));
    await user.type(screen.getByLabelText(/Anything you'd like to add/), "Lovely dosa");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Thank you!")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/qr/orders/ord1/feedback");
    expect(post.headers["x-order-key"]).toBe("key-1");
    expect(post.body).toEqual({ rating: 5, comment: "Lovely dosa" });
    expect(screen.getByRole("link", { name: "Share it on the review page" })).toHaveAttribute("href", "https://g.page/r/abc/review");
    expect(screen.getByRole("link", { name: "Share it on the review page" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(wasRated("ord1")).toBe(true);
    cleanup();
    render(<RateTheMeal orderId="ord1" orderKey="key-1" />);
    expect(screen.queryByText("How was it?")).toBeNull();
  });

  it("an unhappy guest is never sent to a public page and is told the team will follow up; errors are shown", async () => {
    const user = userEvent.setup();
    let fail = true;
    handler = () => (fail ? { status: 422, error: { code: "ValidationError", message: "You can leave feedback once your order has been served" } } : { data: { thanks: true, routedTo: "PRIVATE", reviewUrl: null, alreadyAnswered: false } });
    render(<RateTheMeal orderId="ord2" orderKey="key-2" />);
    await user.click(screen.getByRole("radio", { name: "1 star" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("once your order has been served");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText(/The team has your message/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("link pages", () => {
  it("feedback link: shows the restaurant, takes one answer, and says thanks if it was already answered", async () => {
    const user = userEvent.setup();
    handler = (c) => (c.method === "GET" ? { data: { restaurant: "Spice Route", answered: false } } : { data: { thanks: true, routedTo: "PRIVATE", reviewUrl: null, alreadyAnswered: false } });
    render(<FeedbackLinkScreen token="tok-feedback-0000000001" />);
    expect(await screen.findByRole("heading", { name: /How was your visit to Spice Route\?/ })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "3 stars" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Thank you!")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/qr/feedback/tok-feedback-0000000001");
    cleanup();
    handler = () => ({ data: { restaurant: "Spice Route", answered: true } });
    render(<FeedbackLinkScreen token="tok-feedback-0000000001" />);
    expect(await screen.findByText(/already have your answer/)).toBeInTheDocument();
    cleanup();
    handler = () => ({ status: 404, error: { code: "NotFoundError", message: "This feedback link is not valid" } });
    render(<FeedbackLinkScreen token="forged-forged-forged-0001" />);
    expect(await screen.findByText("This link doesn't work")).toBeInTheDocument();
  });

  it("unsubscribe link: opening it changes nothing; the button does, and only for the channel in the link", async () => {
    const user = userEvent.setup();
    handler = (c) => (c.method === "GET" ? { data: { restaurant: "Spice Route", channel: "WHATSAPP" } } : { data: { done: true, restaurant: "Spice Route" } });
    render(<UnsubscribeScreen token="cust1.WHATSAPP.sig" />);
    expect(await screen.findByRole("heading", { name: "Stop offers from Spice Route?" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Unsubscribe from WhatsApp offers" }));
    expect(await screen.findByRole("heading", { name: "You're unsubscribed" })).toBeInTheDocument();
    expect(screen.getByText(/orders and bookings are not affected/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toEqual([expect.objectContaining({ url: "/api/qr/unsubscribe/cust1.WHATSAPP.sig" })]);
    cleanup();
    handler = () => ({ status: 404, error: { code: "NotFoundError", message: "This link is not valid" } });
    render(<UnsubscribeScreen token="forged" />);
    expect(await screen.findByText("This link doesn't work")).toBeInTheDocument();
  });

  it("invite link: keeps a well-formed code on this phone and rejects anything else", () => {
    render(<ReferralLandingScreen code="rf7k2m9q" />);
    expect(screen.getByTestId("invite-code")).toHaveTextContent("RF7K2M9Q");
    expect(loadReferral()).toBe("RF7K2M9Q");
    cleanup();
    localStorage.clear();
    render(<ReferralLandingScreen code="<script>" />);
    expect(screen.getByText("This invite link doesn't work")).toBeInTheDocument();
    expect(loadReferral()).toBeNull();
    expect(within(document.body).queryByTestId("invite-code")).toBeNull();
  });
});
