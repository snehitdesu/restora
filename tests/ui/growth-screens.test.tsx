// @vitest-environment jsdom
/**
 * Group 6 back-office screens in a DOM, against recorded API responses: coupons, campaigns, loyalty and referrals,
 * growth settings, the feedback inbox and trends, a guest's consent / tier / referral card, and the POS coupon entry.
 * The server prices and enforces everything; these tests pin what the screens ask for, show and refuse to offer.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CouponsScreen } from "@/features/backoffice/growthCoupons";
import { CampaignsScreen, CampaignDetailScreen } from "@/features/backoffice/growthCampaigns";
import { LoyaltyScreen } from "@/features/backoffice/growthLoyalty";
import { GrowthSettingsScreen } from "@/features/backoffice/growthSettings";
import { FeedbackScreen } from "@/features/backoffice/growthFeedback";
import { CustomerGrowth } from "@/features/backoffice/growthCustomer";
import { DiscountDialog } from "@/features/pos/components/DiscountDialog";
import type { OrderDTO } from "@/features/pos/types";
import { state, installFetch, teardown, renderAs, posts, fail, setValue } from "./harness";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/customers/coupons" }));
beforeEach(() => { installFetch(); push.mockClear(); });
afterEach(teardown);

const MANAGER = ["growth.view", "growth.manage", "customer.view", "customer.manage"] as const;
const at = "2026-10-05T06:30:00.000Z";

const coupon = (over: Record<string, unknown> = {}) => ({
  id: "cp1", code: "WELCOME10", name: "Welcome", description: null, kind: "PERCENT", value: 10, maxDiscount: 50, minOrderValue: 100, validFrom: null, validTo: null, usageLimit: 100,
  perCustomerLimit: 1, firstOrderOnly: true, minTier: null, channels: [], outletIds: [], stackable: false, active: true, createdAt: at, redeemed: 12, discountGiven: 480, ...over,
});
const tiers = [
  { id: "t1", code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100, perks: null, sortOrder: 0, active: true },
  { id: "t2", code: "GOLD", name: "Gold", minSpend: 5000, earnMultiplierPct: 150, perks: "Free dessert", sortOrder: 0, active: true },
];

describe("coupons", () => {
  it("lists codes with their offer, rules and cost; only growth.manage can create or edit; a used code is locked", async () => {
    state.routes = {
      "GET /api/growth/coupons": () => [coupon(), coupon({ id: "cp2", code: "FLAT50", name: "Flat", kind: "FIXED", value: 50, maxDiscount: null, minOrderValue: null, firstOrderOnly: false, perCustomerLimit: null, usageLimit: null, redeemed: 0, discountGiven: 0, active: false })],
      "GET /api/growth/tiers": () => tiers,
    };
    renderAs(<CouponsScreen />, [...MANAGER]);
    const table = await screen.findByRole("table", { name: "Coupons" });
    const row = within(table).getByText("WELCOME10").closest("tr")!;
    expect(row).toHaveTextContent("10% off, up to ₹50.00");
    expect(row).toHaveTextContent("first order");
    expect(row).toHaveTextContent("12 / 100");
    expect(row).toHaveTextContent("₹480.00");
    expect(within(table).getByText("FLAT50").closest("tr")).toHaveTextContent("₹50.00 off");
    expect(within(table).getByText("FLAT50").closest("tr")).toHaveTextContent("Inactive");

    await userEvent.click(within(row).getByRole("button", { name: "Edit WELCOME10" }));
    const dlg = await screen.findByRole("dialog", { name: "Edit WELCOME10" });
    expect(within(dlg).getByLabelText(/^Code/)).toBeDisabled(); // already used
    expect(within(dlg).getByText(/Already used: deactivate it/)).toBeInTheDocument();
  });

  it("creates a coupon: uppercase code, validity as whole days, channels, and shows the server's field error", async () => {
    let created = false;
    state.routes = {
      "GET /api/growth/coupons": () => (created ? [coupon()] : []),
      "GET /api/growth/tiers": () => tiers,
      "POST /api/growth/coupons": (c) => {
        if (c.body.code === "TAKEN10") return fail(409, "ConflictError", "A coupon with this code already exists");
        created = true;
        return coupon();
      },
    };
    renderAs(<CouponsScreen />, [...MANAGER]);
    expect(await screen.findByText("No coupons yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /New coupon/ }));
    const dlg = await screen.findByRole("dialog", { name: "New coupon" });
    await userEvent.type(within(dlg).getByLabelText(/^Code/), "taken10");
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "Taken");
    await userEvent.type(within(dlg).getByLabelText(/^Percent/), "10");
    await userEvent.click(within(dlg).getByRole("button", { name: "Create coupon" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("A coupon with this code already exists");

    const code = within(dlg).getByLabelText(/^Code/);
    await userEvent.clear(code);
    await userEvent.type(code, "welcome10");
    expect(code).toHaveValue("WELCOME10");
    await userEvent.type(within(dlg).getByLabelText(/^Cap/), "50");
    await userEvent.type(within(dlg).getByLabelText(/^Minimum order/), "100");
    setValue(within(dlg).getByLabelText(/^Valid from/), "2026-10-10");
    setValue(within(dlg).getByLabelText(/^Valid until/), "2026-10-31");
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "Takeaway" }));
    await userEvent.click(within(dlg).getByRole("checkbox", { name: "First order only" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Create coupon" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New coupon" })).toBeNull());
    const sent = posts().filter((p) => p.path === "/api/growth/coupons").at(-1)!;
    expect(sent.body).toMatchObject({ code: "WELCOME10", name: "Taken", kind: "PERCENT", value: 10, maxDiscount: 50, minOrderValue: 100, channels: ["TAKEAWAY"], firstOrderOnly: true, stackable: false, active: true });
    expect(new Date(sent.body.validFrom).getTime()).toBeLessThan(new Date(sent.body.validTo).getTime());
    expect(await screen.findByText("WELCOME10")).toBeInTheDocument();
  });

  it("a viewer without growth.manage sees the list but no way to change it", async () => {
    state.routes = { "GET /api/growth/coupons": () => [coupon()], "GET /api/growth/tiers": () => tiers };
    renderAs(<CouponsScreen />, ["growth.view"]);
    await screen.findByText("WELCOME10");
    expect(screen.queryByRole("button", { name: /New coupon/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit WELCOME10/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Uses" })).toBeInTheDocument();
  });
});

describe("campaigns", () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    id: "cm1", name: "Weekend special", channel: "WHATSAPP", kind: "MANUAL", audience: { minOrders: 2 }, body: "Hi {name}, come by {restaurant}", couponId: null, status: "DRAFT",
    scheduledAt: null, startedAt: null, completedAt: null, recipientCount: 0, createdAt: at, ...over,
  });

  it("drafting asks the server how many guests match and saves the audience rules; the row opens the campaign", async () => {
    state.routes = {
      "GET /api/growth/campaigns": () => [campaign({ id: "cm9", name: "Old one", status: "SENT", recipientCount: 40, completedAt: at })],
      "GET /api/growth/tiers": () => tiers,
      "GET /api/growth/coupons": () => [coupon()],
      "POST /api/growth/campaigns/preview": (c) => ({ matching: c.body.audience.minOrders ? 7 : 31, optedInOnChannel: 40, sample: ["Asha", "Bala"] }),
      "POST /api/growth/campaigns": () => campaign(),
    };
    renderAs(<CampaignsScreen />, [...MANAGER]);
    const table = await screen.findByRole("table", { name: "Campaigns" });
    await userEvent.click(within(table).getByText("Old one"));
    expect(push).toHaveBeenCalledWith("/customers/campaigns/cm9");

    await userEvent.click(screen.getByRole("button", { name: /New campaign/ }));
    const dlg = await screen.findByRole("dialog", { name: "New campaign" });
    expect(await within(dlg).findByText(/31/)).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText("At least this many orders"), "2");
    await waitFor(() => expect(within(dlg).getByRole("status")).toHaveTextContent("7 guests match"));
    expect(within(dlg).getByRole("status")).toHaveTextContent("40 agreed to WhatsApp offers");
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "Weekend special");
    await userEvent.type(within(dlg).getByLabelText(/^Message/), "Hi {{name}, come by {{restaurant}");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/customers/campaigns/cm1"));
    const sent = posts().find((p) => p.path === "/api/growth/campaigns" && p.method === "POST")!;
    expect(sent.body).toEqual({ name: "Weekend special", channel: "WHATSAPP", audience: { minOrders: 2 }, body: "Hi {name}, come by {restaurant}", couponId: null });
  });

  it("a draft is reviewed and sent from its page; the server's refusal is shown; a running campaign can be cancelled", async () => {
    let status = "DRAFT";
    state.routes = {
      "GET /api/growth/campaigns/cm1": () => ({ campaign: campaign({ status, recipientCount: status === "SENDING" ? 3 : 0 }), recipients: status === "SENDING" ? { SENT: 1, QUEUED: 1, SKIPPED: 1 } : {}, skippedBecause: status === "SENDING" ? [{ reason: "Weekly message limit reached for this guest", count: 1 }] : [], deliveries: status === "SENDING" ? { SENT: 1 } : {} }),
      "GET /api/growth/coupons": () => [],
      "POST /api/growth/campaigns/cm1/schedule": () => {
        if (status === "DRAFT" && !state.calls.some((c) => c.path.endsWith("/schedule") && c.method === "POST" && c !== state.calls.at(-1))) return fail(422, "ValidationError", "Connect a WHATSAPP provider first (Integrations)");
        status = "SENDING";
        return campaign({ status });
      },
      "POST /api/growth/campaigns/cm1/cancel": () => { status = "CANCELLED"; return campaign({ status }); },
    };
    renderAs(<CampaignDetailScreen id="cm1" />, [...MANAGER]);
    expect(await screen.findByRole("heading", { name: "Weekend special" })).toBeInTheDocument();
    expect(screen.getByText("Counted when sending starts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Send…/ }));
    const dlg = await screen.findByRole("dialog", { name: "Send campaign" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Send now" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("Connect a WHATSAPP provider first");
    await userEvent.click(within(dlg).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(screen.getByText("Sending")).toBeInTheDocument());
    expect(screen.getByText("Weekly message limit reached for this guest")).toBeInTheDocument();
    expect(posts().filter((p) => p.path.endsWith("/schedule")).at(-1)!.body).toEqual({});

    await userEvent.click(screen.getByRole("button", { name: "Cancel campaign" }));
    const confirm = await screen.findByRole("dialog", { name: "Cancel this campaign?" });
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel campaign" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/growth/campaigns/cm1/cancel")).toBe(true));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });

  it("a viewer cannot send or cancel", async () => {
    state.routes = { "GET /api/growth/campaigns/cm1": () => ({ campaign: campaign(), recipients: {}, skippedBecause: [], deliveries: {} }), "GET /api/growth/coupons": () => [] };
    renderAs(<CampaignDetailScreen id="cm1" />, ["growth.view"]);
    await screen.findByRole("heading", { name: "Weekend special" });
    expect(screen.queryByRole("button", { name: /Send…/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel campaign" })).toBeNull();
  });
});

describe("loyalty and referrals", () => {
  it("tiers: empty state explains the default, adding a tier posts it; referrals show the summary and the rules", async () => {
    let list: typeof tiers = [];
    state.routes = {
      "GET /api/growth/tiers": () => list,
      "POST /api/growth/tiers": (c) => { list = [{ ...tiers[0], ...c.body, id: "t9" }]; return list[0]; },
      "GET /api/growth/referrals": () => [{ id: "r1", referrer: { id: "c1", name: "Asha" }, referred: { id: "c2", name: "Bala" }, status: "REWARDED", rejectReason: null, referrerPoints: 100, refereePoints: 50, createdAt: at, rewardedAt: at }, { id: "r2", referrer: { id: "c1", name: "Asha" }, referred: { id: "c3", name: "Chitra" }, status: "REJECTED", rejectReason: "The qualifying order was refunded", referrerPoints: null, refereePoints: null, createdAt: at, rewardedAt: null }],
      "GET /api/growth/referrals/summary": () => ({ pending: 2, rewarded: 1, rejected: 1, pointsGiven: 150 }),
      "GET /api/growth/settings": () => ({ referralEnabled: true, referrerPoints: 100, refereePoints: 50, referralMinOrderValue: 200, referralMonthlyCap: 20 }),
      "PATCH /api/growth/settings": () => ({}),
    };
    renderAs(<LoyaltyScreen />, [...MANAGER]);
    expect(await screen.findByText("No tiers yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add the first tier" }));
    const dlg = await screen.findByRole("dialog", { name: "New tier" });
    await userEvent.type(within(dlg).getByLabelText(/^Code/), "base");
    await userEvent.type(within(dlg).getByLabelText(/^Name/), "Base");
    await userEvent.type(within(dlg).getByLabelText(/^Spend in the last 365 days/), "0");
    await userEvent.click(within(dlg).getByRole("button", { name: "Add tier" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New tier" })).toBeNull());
    expect(posts().find((p) => p.path === "/api/growth/tiers")!.body).toMatchObject({ code: "BASE", name: "Base", minSpend: 0, earnMultiplierPct: 100 });
    expect((await screen.findByRole("table", { name: "Loyalty tiers" })).textContent).toContain("Everyone");

    await userEvent.click(screen.getByRole("tab", { name: "Referrals" }));
    const refs = await screen.findByRole("table", { name: "Referrals" });
    expect(within(refs).getByText("Bala").closest("tr")).toHaveTextContent("100 + 50");
    expect(within(refs).getByText("Chitra").closest("tr")).toHaveTextContent("The qualifying order was refunded");
    expect(await screen.findByText("150")).toBeInTheDocument(); // points given
    expect(screen.getByText(/gets/)).toHaveTextContent("The guest who refers gets 100 points, the friend gets 50");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    const rules = await screen.findByRole("dialog", { name: "Referral rewards" });
    await userEvent.clear(within(rules).getByLabelText("Points for the friend"));
    await userEvent.type(within(rules).getByLabelText("Points for the friend"), "75");
    await userEvent.click(within(rules).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts().some((p) => p.method === "PATCH")).toBe(true));
    expect(posts().find((p) => p.method === "PATCH")!.body).toEqual({ referralEnabled: true, referrerPoints: 100, refereePoints: 75, referralMinOrderValue: 200, referralMonthlyCap: 20 });
  });

  it("without growth.view the Referrals tab is not offered and no referral data is requested", async () => {
    state.routes = { "GET /api/growth/tiers": () => tiers };
    renderAs(<LoyaltyScreen />, ["customer.view"]);
    await screen.findByRole("table", { name: "Loyalty tiers" });
    expect(screen.queryByRole("tab", { name: "Referrals" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add tier/ })).toBeNull();
    expect(state.calls.some((c) => c.path.includes("referrals"))).toBe(false);
  });
});

describe("growth settings", () => {
  const settings = {
    referralEnabled: false, birthdayCouponId: null, anniversaryCouponId: null, winbackCouponId: null, winbackAfterDays: 45, winbackCooldownDays: 90, feedbackEnabled: false, feedbackDelayMinutes: 120,
    googleReviewUrl: null, lowRatingMax: 3, quietHoursStart: 21, quietHoursEnd: 9, marketingWeeklyCap: 2, bookingMessagesEnabled: false, bookingReminderHours: 2, digestEnabled: false, digestHour: 9, digestPhone: null,
  };

  it("saves exactly what was changed, shows server field errors, and previews the morning summary", async () => {
    state.routes = {
      "GET /api/growth/settings": () => settings,
      "GET /api/growth/coupons": () => [coupon()],
      "PATCH /api/growth/settings": (c) => (String(c.body.googleReviewUrl ?? "").startsWith("http://")
        ? fail(422, "ValidationError", "Invalid", { fieldErrors: { googleReviewUrl: ["An https link to Google, Zomato, Swiggy, TripAdvisor or Justdial"] } })
        : { ...settings, ...c.body }),
      "GET /api/growth/digest": () => ({ date: "2026-10-07", restaurant: "Cafe", text: "Cafe summary for 2026-10-07\nCafe A: 12 orders, Rs.4,200.00", outlets: [{ outletId: "o1", name: "Cafe A", orders: 12, revenue: 4200 }] }),
    };
    renderAs(<GrowthSettingsScreen />, [...MANAGER]);
    await screen.findByRole("heading", { name: "Growth settings" });
    await userEvent.selectOptions(screen.getByLabelText(/^Birthday offer/), "cp1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Ask guests how it was" }));
    const url = screen.getByLabelText(/Public review page/);
    await userEvent.type(url, "http://g.page/r/abc");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("An https link to Google, Zomato, Swiggy, TripAdvisor or Justdial")).toBeInTheDocument();
    await userEvent.clear(url);
    await userEvent.type(url, "https://g.page/r/abc");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Saved\. The worker uses these/)).toBeInTheDocument();
    const sent = posts().filter((p) => p.method === "PATCH").at(-1)!.body;
    expect(sent).toMatchObject({ birthdayCouponId: "cp1", feedbackEnabled: true, googleReviewUrl: "https://g.page/r/abc", marketingWeeklyCap: 2, quietHoursStart: 21, quietHoursEnd: 9 });
    expect(sent).not.toHaveProperty("referralEnabled"); // referral rules live on the Loyalty screen

    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(await screen.findByText(/Cafe A: 12 orders/)).toBeInTheDocument();
  });

  it("is read-only for a viewer", async () => {
    state.routes = { "GET /api/growth/settings": () => settings, "GET /api/growth/coupons": () => [] };
    renderAs(<GrowthSettingsScreen />, ["growth.view"]);
    await screen.findByRole("heading", { name: "Growth settings" });
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.getByLabelText(/^Birthday offer/)).toBeDisabled();
    expect(screen.getByText(/needs the Growth manager permission/)).toBeInTheDocument();
  });
});

describe("feedback", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "f1", outletId: "out-a", customerId: "c1", customerName: "Asha", orderId: "order-abcdef", rating: 2, comment: "Cold food", createdAt: at, source: "GUEST", status: "NEW", routedTo: "PRIVATE", resolution: null, handledAt: null, ...over,
  });

  it("the inbox flags unhappy guests, lets a manager follow up (a resolution is required) and hides the action from others", async () => {
    let status = "NEW";
    state.routes = {
      "GET /api/growth/feedback": () => ({ items: [row({ status }), row({ id: "f2", rating: 5, comment: "Great", status: "RESOLVED", routedTo: "GOOGLE", source: "GUEST" })], nextCursor: null }),
      "GET /api/growth/feedback/attention": () => ({ new: status === "NEW" ? 1 : 0, acknowledged: 0 }),
      "POST /api/growth/feedback/f1/handle": (c) => {
        if (c.body.status === "RESOLVED" && !c.body.resolution) return fail(422, "ValidationError", "Say what was done", { fieldErrors: { resolution: ["Required"] } });
        status = c.body.status;
        return {};
      },
    };
    renderAs(<FeedbackScreen />, [...MANAGER]);
    const table = await screen.findByRole("table", { name: "Feedback" });
    expect(await screen.findByRole("status")).toHaveTextContent("1 unhappy answer is waiting for someone");
    expect(within(table).getByText("Cold food").closest("tr")).toHaveTextContent("New");
    expect(within(table).getByText("Great").closest("tr")).toHaveTextContent("sent to review page");
    expect(within(table).getAllByRole("button", { name: "Follow up" })).toHaveLength(1); // not on the resolved one

    await userEvent.click(within(table).getByRole("button", { name: "Follow up" }));
    const dlg = await screen.findByRole("dialog", { name: "Follow up" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Status"), "RESOLVED");
    expect(within(dlg).getByLabelText(/What was done/)).toBeRequired();
    await userEvent.type(within(dlg).getByLabelText(/What was done/), "Called the guest, refunded the dish");
    await userEvent.click(within(dlg).getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/growth/feedback/f1/handle")).toBe(true));
    expect(posts().find((p) => p.path === "/api/growth/feedback/f1/handle")!.body).toEqual({ status: "RESOLVED", resolution: "Called the guest, refunded the dish" });
  });

  it("a cashier sees the inbox but neither trends nor the follow-up button", async () => {
    state.routes = { "GET /api/growth/feedback": () => ({ items: [row()], nextCursor: null }) };
    renderAs(<FeedbackScreen />, ["customer.view", "customer.manage"]);
    await screen.findByText("Cold food");
    expect(screen.queryByRole("button", { name: "Follow up" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Trends" })).toBeNull();
    expect(state.calls.some((c) => c.path.endsWith("/attention"))).toBe(false);
    expect(screen.getByRole("button", { name: /Record feedback/ })).toBeInTheDocument();
  });

  it("trends rank dishes on unhappy orders (too few answers are not ranked) and break results down by time of day and server", async () => {
    state.routes = {
      "GET /api/growth/feedback": () => ({ items: [], nextCursor: null }),
      "GET /api/growth/feedback/attention": () => ({ new: 0, acknowledged: 0 }),
      "GET /api/growth/feedback/trends": (c) => {
        expect(c.query.get("outletId")).toBe("out-a");
        return {
          lowRatingMax: 3, minOrdersForRanking: 3,
          overall: { answers: 14, average: 4.1, low: 3, distribution: [{ rating: 1, count: 1 }, { rating: 2, count: 1 }, { rating: 3, count: 1 }, { rating: 4, count: 4 }, { rating: 5, count: 7 }] },
          byDay: [], byDayPart: [{ key: "DINNER", label: "Dinner", answers: 9, average: 3.8, low: 3 }],
          byStaff: [{ userId: "u1", name: "Ravi", answers: 6, average: 3.5, low: 2 }],
          byDish: [{ name: "Masala Dosa", answers: 6, average: 3.2, low: 3, lowShare: 50, ranked: true }, { name: "Filter Coffee", answers: 2, average: 2, low: 1, lowShare: 50, ranked: false }],
        };
      },
    };
    renderAs(<FeedbackScreen />, [...MANAGER]);
    await userEvent.click(await screen.findByRole("tab", { name: "Trends" }));
    const dishes = await screen.findByRole("table", { name: "Feedback by dish" });
    expect(within(dishes).getByText("Masala Dosa").closest("tr")).toHaveTextContent("50%");
    expect(within(dishes).getByText("Filter Coffee").closest("tr")).toHaveTextContent("too few");
    expect(within(await screen.findByRole("table", { name: "Feedback by day part" })).getByText("Dinner")).toBeInTheDocument();
    expect(within(await screen.findByRole("table", { name: "Feedback by staff member" })).getByText("Ravi")).toBeInTheDocument();
    expect(screen.getByText("Unhappy (≤ 3 stars)")).toBeInTheDocument();
  });
});

describe("a guest's offers and referrals card", () => {
  const consent = (m: boolean, t: boolean) => ["SMS", "WHATSAPP", "EMAIL"].map((channel) => ({ channel, marketing: channel === "WHATSAPP" ? m : false, transactional: channel === "SMS" ? t : true, source: channel === "WHATSAPP" && m ? "GUEST_QR" : null, updatedAt: channel === "WHATSAPP" && m ? at : null }));

  it("shows what the guest agreed to and changes one preference at a time", async () => {
    let m = true;
    state.routes = {
      "GET /api/growth/customers/c1/consent": () => consent(m, true),
      "POST /api/growth/customers/c1/consent": (c) => { m = c.body.channels[0].marketing ?? m; return {}; },
      "GET /api/growth/customers/c1/loyalty": () => ({ tier: { code: "GOLD", name: "Gold", perks: "Free dessert", earnMultiplierPct: 150 }, spend: 6200, next: null, configured: true }),
      "GET /api/growth/customers/c1/referrals": () => ({ code: null, brought: [], cameWith: null }),
    };
    renderAs(<CustomerGrowth customerId="c1" hasPhone hasEmail={false} />, [...MANAGER]);
    const table = await screen.findByRole("table", { name: "Message preferences" });
    const wa = within(table).getByText("WhatsApp").closest("tr")!;
    expect(within(wa).getByRole("checkbox", { name: "Agreed" })).toBeChecked();
    expect(within(wa).getByText(/by the guest when ordering/)).toBeInTheDocument();
    expect(within(table).getByText("E-mail").closest("tr")).toHaveTextContent("no e-mail address");
    await userEvent.click(within(wa).getByRole("checkbox", { name: "Agreed" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/growth/customers/c1/consent")).toBe(true));
    expect(posts()[0].body).toEqual({ channels: [{ channel: "WHATSAPP", marketing: false }] });
    await waitFor(() => expect(within(wa).getByRole("checkbox", { name: "Not agreed" })).not.toBeChecked());
    expect(await screen.findByText(/earns 150% points/)).toBeInTheDocument();
    expect(screen.getByText(/Top tier reached/)).toBeInTheDocument();
  });

  it("creates a referral code and records a friend's code; the card is read-only without customer.manage", async () => {
    let code: string | null = null;
    state.routes = {
      "GET /api/growth/customers/c1/consent": () => consent(false, true),
      "GET /api/growth/customers/c1/loyalty": () => ({ tier: null, spend: 0, next: null, configured: false }),
      "GET /api/growth/customers/c1/referrals": () => ({ code, brought: code ? [{ id: "r1", referredCustomerId: "c9", status: "PENDING", rewardedAt: null }] : [], cameWith: null }),
      "POST /api/growth/customers/c1/referral-code": () => { code = "RF7K2M9Q"; return { code }; },
      "POST /api/growth/customers/c1/referral": () => ({ status: "ATTACHED" }),
    };
    const first = renderAs(<CustomerGrowth customerId="c1" hasPhone hasEmail />, [...MANAGER]);
    await userEvent.click(await screen.findByRole("button", { name: "Create a referral code" }));
    expect(await screen.findByText("RF7K2M9Q")).toBeInTheDocument();
    expect(screen.getByText(/waiting for the friend's first paid order/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/Friend's code/), "rf1a2b3c");
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(posts().some((p) => p.path === "/api/growth/customers/c1/referral")).toBe(true));
    expect(posts().find((p) => p.path === "/api/growth/customers/c1/referral")!.body).toEqual({ code: "RF1A2B3C" });
    first.unmount();

    code = null;
    renderAs(<CustomerGrowth customerId="c1" hasPhone hasEmail />, ["customer.view"]);
    await screen.findByRole("table", { name: "Message preferences" });
    expect(screen.queryByRole("button", { name: "Create a referral code" })).toBeNull();
    for (const box of screen.getAllByRole("checkbox")) expect(box).toBeDisabled();
  });
});

describe("POS coupon entry", () => {
  const order = { id: "ord1", discount: "0.00" } as unknown as OrderDTO;

  it("applies a code the server prices, shows the applied coupon, removes it, and keeps the manual amount separate", async () => {
    let applied: { code: string; name: string; amount: number; stackable: boolean } | null = null;
    state.routes = {
      "GET /api/growth/orders/ord1/coupon": () => ({ coupon: applied }),
      "POST /api/growth/orders/ord1/coupon": (c) => {
        if (c.body.code === "EXPIRED5") return fail(422, "ValidationError", "This coupon has expired");
        applied = { code: c.body.code, name: "Welcome", amount: 30, stackable: false };
        return { discount: 30 };
      },
      "POST /api/growth/orders/ord1/coupon/remove": () => { applied = null; return { removed: true }; },
      "POST /api/orders/ord1/discount": () => ({}),
    };
    const changed = vi.fn(async () => undefined);
    const closed = vi.fn();
    renderAs(<DiscountDialog order={order} onClose={closed} onChanged={changed} />, ["order.discount"]);
    const dlg = await screen.findByRole("dialog", { name: "Order discount" });
    const input = within(dlg).getByLabelText("Coupon code");
    await userEvent.type(input, "expired5");
    await userEvent.click(within(dlg).getByRole("button", { name: "Use code" }));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("This coupon has expired");
    expect(changed).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, "welcome10");
    expect(input).toHaveValue("WELCOME10");
    await userEvent.click(within(dlg).getByRole("button", { name: "Use code" }));
    expect(await within(dlg).findByText("WELCOME10")).toBeInTheDocument();
    expect(within(dlg).getByText(/−₹30\.00/)).toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(within(dlg).getByText(/including the coupon above/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(dlg).getByLabelText("Coupon code")).toBeInTheDocument());
    expect(changed).toHaveBeenCalledTimes(2);

    setValue(within(dlg).getByLabelText("Discount amount (₹)"), "20");
    await userEvent.click(within(dlg).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(posts().find((p) => p.path === "/api/orders/ord1/discount")!.body).toEqual({ amount: 20 });
  });

  it("without coupon support for this login the manual amount still works", async () => {
    state.routes = { "GET /api/growth/orders/ord1/coupon": () => fail(403, "ForbiddenError", "no"), "POST /api/orders/ord1/discount": () => ({}) };
    const closed = vi.fn();
    renderAs(<DiscountDialog order={order} onClose={closed} onChanged={async () => undefined} />, ["order.discount"]);
    const dlg = await screen.findByRole("dialog", { name: "Order discount" });
    setValue(within(dlg).getByLabelText("Discount amount (₹)"), "15");
    await userEvent.click(within(dlg).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(closed).toHaveBeenCalled());
  });
});
