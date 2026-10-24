/**
 * Guest (customer) QR ordering: scan a table's QR -> menu -> cart -> order ->
 * online payment -> live status -> digital receipt.
 *
 * Trust model — the browser is anonymous and untrusted:
 *  - Tenant context comes ONLY from the table's QR token, resolved here on the
 *    server (table -> outlet -> organization, all active). A browser never
 *    names an organization, outlet or table id.
 *  - Lines are priced by the menu (orders.placeOrder -> menu.priceMenuSelection);
 *    the guest item schema is strict, so a client price/total is rejected.
 *  - An order is reachable only with its access key: an HMAC of the order id
 *    under a server secret (stateless; no extra column). The key is returned
 *    once, when the order is placed, and travels in a request header.
 *  - Payments use the existing payment service: a PENDING payment for the
 *    server-computed outstanding balance, made SUCCESS only by gateway
 *    verification (payment.verifyPayment, with its balance/concurrency rules).
 *  - Guests pay online; there is no pay-at-the-counter choice. An order
 *    arrives OPEN and reaches the kitchen only when verified gateway payments
 *    cover its total (payment.verifyPayment -> kot.createKOTsForOrder). The
 *    kitchen gate (kitchenGate.ts) refuses every other release — POS accept,
 *    captain rounds / fire, desktop Cloud Sync — and counter payments cannot
 *    settle it, so neither a client nor a member of staff can send an unpaid
 *    guest order to the kitchen. Ordering is refused while online payment is
 *    unavailable.
 *
 * Services run with a system context scoped to the resolved outlet (the same
 * pattern as webhooks); every input that reaches them is fixed here.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { isGuestTableToken } from "@/lib/qr/tableQrUrl";
import { systemContext } from "@/server/auth/context";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { DEV_AUTH_SECRET_PLACEHOLDER } from "@/server/config/env";
import { writeAudit } from "@/server/audit/log";
import { createNotificationTx } from "@/server/services/notifications";
import { listMenu, priceMenuSelection } from "@/server/services/menu";
import { calculateOrderTotals, placeOrder } from "@/server/services/orders";
import { applyCouponTx, previewCoupon } from "@/server/services/coupons";
import { attachReferralTx } from "@/server/services/referrals";
import { setConsent } from "@/server/services/consent";
import { submitOrderFeedback, type GuestFeedbackResult } from "@/server/services/feedbackLoop";
import { lockInTx, runInTx } from "@/server/services/_workflow";
import type { Tx } from "@/server/services/_workflow";
import { formatClock, formatHours, hasHours, isOpenAt } from "@/domain/openingHours";
import { guestTracker, type GuestTracker } from "@/domain/orderProgress";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { isAwaitingOnlinePayment, isPastFulfilmentWindow, verifiedOnlineTotalTx } from "@/server/services/kitchenGate";
import { buildBill, billOrderInclude, loadBillVenue, orderRef, type Bill } from "@/server/services/bill";
import { getOrderInvoices } from "@/server/services/invoicing";
import { getCheckoutProvider, type IntegrationMode, type PaymentProvider } from "@/integrations/payment";
import { IntegrationError } from "@/integrations/http";
import { ProviderUnavailableError } from "@/integrations/policy";
import { enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { D, money, num } from "@/domain/money";
import { MAX_SPLIT_PARTS, MIN_SPLIT_PARTS, splitShare } from "@/domain/billSplit";
import { FULFILMENT_LABEL, GUEST_AWAITING_PAYMENT_LABEL, GUEST_HELD_FOR_REVIEW_LABEL } from "@/domain/orderProgress";

// ---------------- access keys ----------------

let hmacKey: Buffer | null = null;
function accessHmacKey(): Buffer {
  if (hmacKey) return hmacKey;
  const material = process.env.AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : DEV_AUTH_SECRET_PLACEHOLDER);
  if (!material) throw new Error("AUTH_SECRET is required for guest order access keys");
  hmacKey = Buffer.from(hkdfSync("sha256", material, "aharos", "guest-order-access/v1", 32));
  return hmacKey;
}

/** The capability that lets a guest read / pay one order. */
export function guestOrderKey(orderId: string): string {
  return createHmac("sha256", accessHmacKey()).update(`order:${orderId}`).digest("base64url");
}

function keyMatches(orderId: string, key: string | null | undefined): boolean {
  if (!key || key.length > 128) return false;
  const expected = Buffer.from(guestOrderKey(orderId));
  const given = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// ---------------- table resolution ----------------

// The token rule lives with the scanner's URL parser (pure, client-safe); re-exported for existing callers.
export { GUEST_TABLE_TOKEN_RE, isGuestTableToken } from "@/lib/qr/tableQrUrl";

// One message for every failure: no oracle for which tables/outlets exist.
const BAD_QR = "This table QR code is not valid. Please ask the staff for help.";

export type GuestTable = {
  ctx: AccessContext;
  /**
   * The table whose QR was scanned; null for the restaurant's common QR
   * (Outlet.guestQrToken): the guest sits anywhere and staff assign the table
   * later (orderOps.setOrderTable). Never filled in from anything else.
   */
  table: { id: string; code: string } | null;
  outlet: { id: string; organizationId: string; name: string; address: string | null; phone: string | null; currency: string; timezone: string; openTime: string | null; closeTime: string | null };
  restaurantName: string;
};

/**
 * The one table-token lookup. `inactive`: the table exists but its outlet or
 * organization is switched off. Guests never see the difference (resolveTable
 * throws the same error for both); the staff QR scanner reports it.
 */
export type TableTokenLookup =
  | { status: "not_found" }
  | { status: "inactive"; table: { id: string; code: string } | null; scope: { organizationId: string; outletId: string }; outletName: string; restaurantName: string }
  | { status: "ok"; guest: GuestTable };

const OUTLET_FOR_GUESTS = { id: true, organizationId: true, name: true, address: true, phone: true, currency: true, timezone: true, openTime: true, closeTime: true, active: true, organization: { select: { name: true, legalName: true, active: true } } } as const;

/**
 * A guest token is either a table's QR (RestaurantTable.qrToken) or the
 * restaurant's common QR (Outlet.guestQrToken). Both are random, both are
 * resolved only here, and the outlet / organization always come from the
 * database row the token belongs to — never from the request.
 */
export async function lookupTableToken(token: string, db: PrismaClient = prisma): Promise<TableTokenLookup> {
  if (!isGuestTableToken(token)) return { status: "not_found" };
  const table = await db.restaurantTable.findUnique({ where: { qrToken: token }, select: { id: true, code: true, organizationId: true, outletId: true } });
  const outlet = table
    ? await db.outlet.findUnique({ where: { id: table.outletId }, select: OUTLET_FOR_GUESTS })
    : await db.outlet.findUnique({ where: { guestQrToken: token }, select: OUTLET_FOR_GUESTS });
  if (!outlet || (table && outlet.organizationId !== table.organizationId)) return { status: "not_found" };
  const restaurantName = outlet.organization.legalName || outlet.organization.name;
  const atTable = table ? { id: table.id, code: table.code } : null;
  if (!outlet.active || !outlet.organization.active) return { status: "inactive", table: atTable, scope: { organizationId: outlet.organizationId, outletId: outlet.id }, outletName: outlet.name, restaurantName };
  const { active: _a, organization: _org, ...o } = outlet;
  void _a;
  void _org;
  return { status: "ok", guest: { ctx: systemContext(outlet.organizationId, [outlet.id]), table: atTable, outlet: o, restaurantName } };
}

export async function resolveTable(token: string, db: PrismaClient = prisma): Promise<GuestTable> {
  const found = await lookupTableToken(token, db);
  if (found.status !== "ok") throw new NotFoundError(BAD_QR);
  return found.guest;
}

// ---------------- payment availability ----------------

/**
 * online: a checkout provider (getCheckoutProvider: SBI UPI, or the emulator /
 * mock outside production — never Razorpay, which is legacy-only) is configured
 * and reachable. testMode: the in-process development gateway (MOCK — no
 * gateway at all). mode: MOCK = emulator / simulator, SANDBOX = the bank's test
 * environment (no real money), LIVE = real money.
 */
export type GuestPaymentOptions = { online: boolean; testMode: boolean; mode: IntegrationMode | null };

const OFFLINE: GuestPaymentOptions = { online: false, testMode: false, mode: null };
/** A real gateway's health check is a network call: every menu load and order poll would otherwise make one. */
const HEALTH_TTL_MS = 30_000;
let health: { key: string; at: number; ok: boolean } | null = null;

/**
 * Online payment is offered only when a gateway is configured and usable.
 * Menu loads and order polls use a recent health result; starting a payment
 * (`fresh`) always asks the gateway, so a payment is never begun while it is down.
 */
export async function guestPaymentOptions(opts: { fresh?: boolean } = {}): Promise<GuestPaymentOptions> {
  let gw: PaymentProvider;
  try {
    gw = getCheckoutProvider();
  } catch {
    return OFFLINE;
  }
  const key = `${gw.name}:${gw.mode}`;
  let ok: boolean;
  if (!opts.fresh && gw.name !== "mock" && health?.key === key && Date.now() - health.at < HEALTH_TTL_MS) ok = health.ok;
  else {
    ok = await gw.healthCheck().catch(() => false);
    if (gw.name !== "mock") health = { key, at: Date.now(), ok };
  }
  return ok ? { online: true, testMode: gw.name === "mock", mode: gw.mode } : OFFLINE;
}

// ---------------- menu ----------------

/** The guest menu: what the table's outlet offers, at its prices — no admin fields. */
export async function guestMenu(token: string, db: PrismaClient = prisma) {
  return guestMenuFor(await resolveTable(token, db), db);
}

/** The guest menu for a table already resolved from its token (the storefront layout resolves it once per request). */
export async function guestMenuFor(t: GuestTable, db: PrismaClient = prisma) {
  // With an outletId, listMenu returns the outlet's effective price / sold-out per item.
  type Effective = { effectivePrice: number; effectiveSoldOut: boolean };
  const items = (await listMenu(db, t.ctx, { outletId: t.outlet.id, activeOnly: true })) as Array<Awaited<ReturnType<typeof listMenu>>[number] & Effective>;
  const menu = items.map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    isVeg: i.isVeg,
    categoryId: i.categoryId,
    category: i.category,
    price: i.effectivePrice,
    effectivePrice: i.effectivePrice,
    taxPct: num(i.taxPct),
    station: i.station,
    active: true,
    offered: true,
    soldOut: i.effectiveSoldOut,
    effectiveSoldOut: i.effectiveSoldOut,
    variants: i.variants.map((v) => ({ id: v.id, name: v.name, priceDelta: num(v.priceDelta), active: v.active })),
    modifierGroups: i.modifierGroups
      .filter((l) => l.group.active)
      .map((l) => ({ group: { id: l.group.id, name: l.group.name, minSelect: l.group.minSelect, maxSelect: l.group.maxSelect, active: true, options: l.group.options.map((o) => ({ id: o.id, name: o.name, priceDelta: num(o.priceDelta), active: o.active })) } })),
  }));
  return {
    restaurant: {
      name: t.restaurantName,
      outletName: t.outlet.name,
      address: t.outlet.address,
      phone: t.outlet.phone,
      currency: t.outlet.currency,
      // Only what the restaurant has entered in RESTORA (Admin → Outlets); null = not configured.
      hours: hasHours(t.outlet) ? { open: t.outlet.openTime, close: t.outlet.closeTime, label: formatHours(t.outlet) } : null,
    },
    // null = the common QR: no table is chosen by the guest (staff assign one).
    table: t.table ? { code: t.table.code } : null,
    ordering: orderingStatus(t),
    menu,
    payment: await guestPaymentOptions(),
  };
}

// ---------------- ordering availability ----------------

export type OrderingStatus = { open: boolean; message: string | null };

/** Orders are accepted inside the outlet's opening hours; an outlet without hours is always open. */
export function orderingStatus(t: Pick<GuestTable, "outlet">, now: Date = new Date()): OrderingStatus {
  if (isOpenAt(t.outlet, now)) return { open: true, message: null };
  const opens = formatClock(t.outlet.openTime);
  return { open: false, message: `We're closed right now${opens ? ` — ordering opens at ${opens}` : ""}. You can still browse the menu.` };
}

// ---------------- server pricing of a cart ----------------

const NOT_ON_MENU = "This item is no longer on the menu";

type GuestLineInput = { menuItemId: string; variantId?: string; modifierOptionIds?: string[]; qty: number };
export type GuestPricedLine =
  | { index: number; ok: true; menuItemId: string; name: string; unitPrice: string; modifiers: Array<{ name: string; priceDelta: string }>; modifiersPerUnit: string; taxPct: string; qty: number; lineTotal: string }
  | { index: number; ok: false; menuItemId: string; reason: string; notFound?: true };

/**
 * Price every line exactly as order placement will (menu.priceMenuSelection:
 * outlet price override, variant, modifier rules, sold-out / not offered) —
 * read-only. A line that cannot be ordered carries the reason instead of a price.
 * Lines are independent reads, so they are priced concurrently: a cart costs
 * about one line's round trips instead of one per line (each line is 4 queries).
 */
async function priceGuestLines(db: PrismaClient, t: GuestTable, items: GuestLineInput[]): Promise<GuestPricedLine[]> {
  return Promise.all(
    items.map(async (it, index): Promise<GuestPricedLine> => {
      try {
        // Reads only (menu item, variants, groups, outlet override): no transaction needed.
        const p = await priceMenuSelection(db as unknown as Tx, t.ctx, { menuItemId: it.menuItemId, variantId: it.variantId, modifierOptionIds: it.modifierOptionIds?.length ? it.modifierOptionIds : undefined, outletId: t.outlet.id });
        const modsPerUnit = p.modifiers.reduce((a, m) => a.plus(m.priceDelta), D(0));
        const line = calculateOrderTotals([{ qty: it.qty, unitPrice: p.unitPrice, modifiersPerUnit: modsPerUnit, taxPct: p.taxPct }]);
        return {
          index,
          ok: true,
          menuItemId: p.menuItemId,
          name: p.name,
          unitPrice: money(p.unitPrice).toFixed(2),
          modifiers: p.modifiers.map((m) => ({ name: m.name, priceDelta: money(m.priceDelta).toFixed(2) })),
          modifiersPerUnit: money(modsPerUnit).toFixed(2),
          taxPct: D(p.taxPct).toString(),
          qty: it.qty,
          lineTotal: line.subtotal.toFixed(2),
        };
      } catch (e) {
        if (e instanceof NotFoundError) return { index, ok: false, menuItemId: it.menuItemId, reason: NOT_ON_MENU, notFound: true };
        if (e instanceof ValidationError) return { index, ok: false, menuItemId: it.menuItemId, reason: e.message };
        throw e;
      }
    })
  );
}

const quoteSchema = z.object({
  items: z.array(z.lazy(() => guestItem)).min(1, "Your cart is empty").max(30),
  /** Optional: price the cart with this coupon code (nothing is created or counted). */
  couponCode: z.string().trim().min(1).max(40).optional(),
  /** Optional: lets a first-order / per-guest coupon be checked against the guest's own record (looked up, never created). */
  phone: z.string().trim().max(20).optional(),
}).strict();

export type GuestQuote = {
  lines: GuestPricedLine[];
  /** Totals of the lines that can be ordered, by the same function that prices orders and invoices. */
  subtotal: string;
  tax: string;
  taxes: Array<{ ratePct: string; amount: string }>;
  total: string;
  allAvailable: boolean;
  ordering: OrderingStatus;
  /** Present when a code was sent: what it is worth now, or a message a guest may see. `discount` is already out of `subtotal`'s tax base and `total`. */
  coupon?: { ok: true; code: string; name: string; discount: string } | { ok: false; message: string };
  discount: string;
  /**
   * `total` without the coupon: what placing the order is priced at (the coupon is
   * applied after the order exists), so it is the value checkout sends as
   * `expectedTotal`. Equal to `total` when no coupon applies.
   */
  totalBeforeDiscount: string;
};

/**
 * The cart as the server would price it right now. Nothing is created; the
 * order total is still computed again when the order is placed.
 */
export async function quoteGuestCart(token: string, input: unknown, db: PrismaClient = prisma): Promise<GuestQuote> {
  const data = quoteSchema.parse(input);
  const t = await resolveTable(token, db);
  const lines = await priceGuestLines(db, t, data.items);
  const okLines = lines.filter((l): l is Extract<GuestPricedLine, { ok: true }> => l.ok);
  const lineItems = okLines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct }));
  const base = calculateOrderTotals(lineItems);
  let totals = base;
  let coupon: GuestQuote["coupon"];
  if (data.couponCode && okLines.length) {
    const phone = data.phone ? normalizeGuestPhone(data.phone) : null;
    const known = phone ? await db.customer.findFirst({ where: { organizationId: t.ctx.organizationId, phone }, select: { id: true } }) : null;
    coupon = await previewCoupon(db, { organizationId: t.ctx.organizationId, outletId: t.outlet.id, channel: "QR", code: data.couponCode, subtotal: totals.subtotal, customerId: known?.id ?? null });
    if (coupon.ok) totals = calculateOrderTotals(lineItems, coupon.discount);
  }
  return {
    // `notFound` is internal (placement keeps answering 404 for a dish that is not this restaurant's).
    lines: lines.map((l) => (l.ok ? l : { index: l.index, ok: false as const, menuItemId: l.menuItemId, reason: l.reason })),
    subtotal: totals.subtotal.toFixed(2),
    tax: totals.tax.toFixed(2),
    taxes: totals.byRate.map((r) => ({ ratePct: r.ratePct.toString(), amount: r.tax.toFixed(2) })),
    total: totals.total.toFixed(2),
    allAvailable: okLines.length === lines.length,
    ordering: orderingStatus(t),
    discount: totals.discount.toFixed(2),
    totalBeforeDiscount: base.total.toFixed(2),
    ...(coupon ? { coupon } : {}),
  };
}

// ---------------- placing an order ----------------

const guestItem = z
  .object({
    menuItemId: z.string().min(1).max(64),
    variantId: z.string().min(1).max(64).optional(),
    modifierOptionIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    qty: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(50, "At most 50 of one item"),
    notes: z.string().trim().max(200).optional(),
  })
  .strict(); // a client price, tax or total is refused, not ignored

/** Indian mobile numbers as typed ("98765 43210", "+91-98765-43210") → "9876543210"; other countries keep their digits (+ prefix). */
export function normalizeGuestPhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, "");
  const india = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(compact);
  return india ? india[1] : compact;
}

const guestCustomer = z
  .object({
    /** Shown to the staff with the order (and kept on the CRM record when a phone is given). */
    name: z.string().trim().max(60, "Name is too long").optional(),
    /** Optional. With a phone the order is linked to the restaurant's customer record (find-or-create; an existing record is never overwritten). */
    phone: z
      .string()
      .trim()
      .max(20)
      .transform(normalizeGuestPhone)
      .refine((p) => /^\+?\d{10,15}$/.test(p), "Enter a valid mobile number")
      .optional(),
  })
  .strict();

const guestOrderSchema = z
  .object({
    items: z.array(guestItem).min(1, "Your cart is empty").max(30),
    notes: z.string().trim().max(300).optional(),
    customer: guestCustomer.optional(),
    /**
     * How the guest will pay: online only. CASH (pay at the counter) is refused with a message rather than
     * accepted and ignored, so an older page that still offers it cannot place an order the guest thinks is
     * on its way to the kitchen.
     */
    paymentMethod: z.enum(["CASH", "ONLINE"]).optional(),
    /**
     * The total the guest was shown at checkout. Never used as a price: the order
     * is always priced here. When this request's own pricing differs (a price,
     * tax rate or add-on changed since the quote), nothing is created and the
     * guest is told the new total (GuestPriceChangedError).
     */
    expectedTotal: z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, "Invalid total").optional(),
    /** A coupon code: priced and applied by the server after the order exists; an invalid one never blocks the order. */
    couponCode: z.string().trim().min(1).max(40).optional(),
    /** A friend's referral code (counts only for a new guest who gave a phone number). */
    referralCode: z.string().trim().min(4).max(20).optional(),
    /** "Send me offers": an explicit yes to SMS and WhatsApp marketing for the phone number given. */
    marketingOptIn: z.boolean().optional(),
  })
  .strict();

/** 409: the cart costs something other than the guest was shown. Nothing was created; `details.total` is the current total. */
export class GuestPriceChangedError extends Error {
  status = 409;
  details: { total: string };
  constructor(total: string) {
    super("Prices changed since you opened checkout. Check the new total, then place your order again.");
    this.name = "PriceChanged";
    this.details = { total };
  }
}
export const ORDER_TOO_OLD_TO_PAY = "This order is too old to be sent to the kitchen now. Please order again, or ask the staff.";
export const PAY_ONLINE_ONLY = "QR orders are paid online before they go to the kitchen. Please choose online payment.";
export const ONLINE_PAYMENT_UNAVAILABLE = "Online payment isn't available right now, so orders can't be placed from the table. Please order with the staff.";
const idemKey = z.string().trim().min(8).max(64).regex(/^[\w.:-]+$/, "Invalid idempotency key");

/** Guest orders a table may have waiting for their online payment at once (a QR is a public link). */
export const MAX_WAITING_GUEST_ORDERS = 3;
/**
 * Unsettled guest orders a table may have at once (a public QR link must not
 * be able to pile up orders; paying, or staff cancelling, frees one). Orders
 * reach the kitchen only once paid online, so today this mostly bounds orders
 * placed before that rule (pay-at-the-counter orders sent straight to the kitchen).
 *
 * This is an abuse guard, not a documented restaurant rule: 6 was chosen during
 * development (a table of six each ordering separately). The owner can change it
 * with GUEST_MAX_UNPAID_ORDERS_PER_TABLE (1–50); production validation refuses
 * anything else, and an invalid value here falls back to the default.
 */
export const MAX_UNPAID_GUEST_ORDERS = 6;
const TABLE_WAITING_FULL = "Several orders from this table are waiting for payment. Please pay for one of them, or ask the staff.";
const tableUnpaidFull = (cap: number) => `This table already has ${cap} unpaid orders. Please pay for them, or ask the staff, before ordering more.`;

/** Serializes a table's two limit counts in the order's transaction (held until it ends), like lockCommonQrCap. */
export function lockTableQrCaps(tx: Tx, tableId: string): Promise<void> {
  return lockInTx(tx, `table-qr-cap:${tableId}`);
}

/** What a table's two limits count: its guest QR orders waiting for payment, and those not settled yet. */
export async function tableQrLoad(tx: Tx, organizationId: string, tableId: string): Promise<{ waiting: number; unsettled: number }> {
  const atTable = { organizationId, tableId, source: "QR" };
  const waiting = await tx.order.count({ where: { ...atTable, status: "OPEN" } });
  const unsettled = await tx.order.count({ where: { ...atTable, status: { in: UNSETTLED_STATUSES } } });
  return { waiting, unsettled };
}

/**
 * Common QR (no table): orders waiting for their online payment, restaurant-wide,
 * placed in the last COMMON_QR_WAITING_WINDOW_MS. An abuse guard for a code that
 * every table shares: it bounds the unpaid orders staff see piling up; abandoned
 * ones stop counting once older than the window (they can no longer go to the
 * kitchen anyway, kitchenGate.ts).
 */
export const MAX_WAITING_COMMON_QR_ORDERS = 30;
export const COMMON_QR_WAITING_WINDOW_MS = 15 * 60_000;
const COMMON_QR_BUSY = "Many orders are waiting for payment right now. Please try again in a few minutes, or ask the staff.";

/** Serializes the cap's in-transaction count per outlet (held until the order's transaction ends). */
export function lockCommonQrCap(tx: Tx, outletId: string): Promise<void> {
  return lockInTx(tx, `common-qr-cap:${outletId}`);
}

/** Unpaid common-QR orders of an outlet placed within the window (the cap's count). */
function commonWaitingWhere(organizationId: string, outletId: string) {
  return { organizationId, outletId, source: "QR", tableId: null, status: "OPEN", createdAt: { gte: new Date(Date.now() - COMMON_QR_WAITING_WINDOW_MS) } };
}

export function maxUnpaidGuestOrders(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GUEST_MAX_UNPAID_ORDERS_PER_TABLE);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : MAX_UNPAID_GUEST_ORDERS;
}
const UNSETTLED_STATUSES = ["OPEN", "SENT", "PREPARING", "READY", "SERVED", "BILLED"];

export type ClientMeta = { ip?: string; userAgent?: string };

export async function placeGuestOrder(token: string, input: unknown, idempotencyKey: unknown, meta: ClientMeta = {}, db: PrismaClient = prisma) {
  const key = idemKey.parse(idempotencyKey);
  const data = guestOrderSchema.parse(input);
  const t = await resolveTable(token, db);
  const table = t.table;
  // Orders per table QR (as before); per device on the common QR, which every table shares,
  // so one phone cannot use up the restaurant's allowance (the router also limits writes per IP).
  await enforceRateLimit(RATE_POLICIES.guestOrderPerTable, table ? token : `${token}:${meta.ip ?? "unknown"}`);
  // No order reaches the kitchen before its online payment is verified (kitchenGate.ts): paying at the counter is not offered.
  if (data.paymentMethod === "CASH") throw new ValidationError(PAY_ONLINE_ONLY);
  // Namespaced per table (or per outlet for the common QR): a key can only ever replay an order placed through the same code.
  const scopedKey = table ? `qr:${table.id}:${key}` : `qr:outlet:${t.outlet.id}:${key}`;
  const placedUnderKey = () => db.order.findUnique({ where: { organizationId_idempotencyKey: { organizationId: t.ctx.organizationId, idempotencyKey: scopedKey } }, select: { id: true } });
  // A new order is checked first; a replay of a placed one skips straight to placeOrder's replay.
  const checkNewOrder = async () => {
    // Independent reads: the limits and every line's price, at once.
    const atTable = table ? { organizationId: t.ctx.organizationId, tableId: table.id, source: "QR" } : null;
    const [waiting, unpaid, commonWaiting, lines] = await Promise.all([
      atTable ? db.order.count({ where: { ...atTable, status: "OPEN" } }) : 0,
      atTable ? db.order.count({ where: { ...atTable, status: { in: UNSETTLED_STATUSES } } }) : 0,
      atTable ? 0 : db.order.count({ where: commonWaitingWhere(t.ctx.organizationId, t.outlet.id) }),
      priceGuestLines(db, t, data.items),
    ]);
    // The order can only ever be paid online: without a usable gateway it would wait forever. A recent
    // "down" answer is asked again before refusing (the gateway may be back); a recent "up" one is trusted.
    if (!(await guestPaymentOptions()).online && !(await guestPaymentOptions({ fresh: true })).online) throw new ValidationError(ONLINE_PAYMENT_UNAVAILABLE);
    if (waiting >= MAX_WAITING_GUEST_ORDERS) throw new ValidationError(TABLE_WAITING_FULL);
    const unpaidCap = maxUnpaidGuestOrders();
    if (unpaid >= unpaidCap) throw new ValidationError(tableUnpaidFull(unpaidCap));
    if (commonWaiting >= MAX_WAITING_COMMON_QR_ORDERS) throw new ValidationError(COMMON_QR_BUSY);
    const ordering = orderingStatus(t);
    if (!ordering.open) throw new ValidationError(ordering.message!);
    // Every line is checked (and priced) before anything is created, so a sold-out
    // item never leaves a half-made order or a stray customer record behind.
    const bad = lines.find((l) => !l.ok);
    if (bad && !bad.ok) {
      // Unknown / another restaurant's dish: the same 404 as before (no oracle); unavailable: 422 with the reason.
      if (bad.notFound) throw new NotFoundError("Menu item not found");
      throw new ValidationError(`Item ${bad.index + 1}: ${bad.reason}. Please update your cart.`);
    }
    if (data.expectedTotal !== undefined) {
      const okLines = lines.filter((l): l is Extract<GuestPricedLine, { ok: true }> => l.ok);
      const total = calculateOrderTotals(okLines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct }))).total;
      if (!money(total).eq(D(data.expectedTotal))) throw new GuestPriceChangedError(money(total).toFixed(2));
    }
  };
  // A new order skips placeOrder's own key lookup (one round trip less); a replay goes straight to it.
  let knownNew = false;
  if (!(await placedUnderKey())) {
    try {
      await checkNewOrder();
      knownNew = true;
    } catch (e) {
      // A replay's original can commit between the lookup above and these checks (and then count as one
      // more waiting order): the refusal is only true while the key still has no order.
      if (!(await placedUnderKey())) throw e;
    }
  }
  const guestName = data.customer?.name || undefined;
  // A phone links the order to the restaurant's CRM (find-or-create; a known customer's
  // name is never changed). The guest's response never reveals whether the number was known.
  // The record is found or created in the order's own transaction (placeOrder), so a refused
  // order leaves none behind.
  const customer = data.customer?.phone ? { name: guestName ?? "Guest", phone: data.customer.phone } : undefined;
  const order = await placeOrder(t.ctx, {
    outletId: t.outlet.id,
    channel: "QR",
    source: "QR",
    // Common QR: no table until staff assign one (never inferred, never defaulted).
    tableId: table?.id,
    covers: 1,
    notes: data.notes || undefined,
    idempotencyKey: scopedKey,
    items: data.items.map((i) => ({ menuItemId: i.menuItemId, variantId: i.variantId, modifierOptionIds: i.modifierOptionIds?.length ? i.modifierOptionIds : undefined, qty: i.qty, notes: i.notes || undefined })),
    // OPEN until the online payment is verified; payment.verifyPayment sends it to the kitchen.
    submit: false,
  }, db, {
    knownNew,
    customer,
    // Inside the order's transaction (queued with every other SQLite write):
    // the audit row and the staff alert exist exactly when the order does. A
    // separate transaction afterwards could time out under load and answer 500
    // for an order that had already been placed and sent to the kitchen.
    afterCreate: async (tx, placed) => {
      // The common-QR cap again, inside the order's transaction and counting this order. New orders run
      // READ COMMITTED (orders.ts NEW_ORDER_TX), so concurrent submissions that all passed the early check
      // would each count only what had committed: the outlet's cap lock makes them count one at a time
      // (the winners commit, the rest roll back with nothing left behind).
      if (!table) {
        await lockCommonQrCap(tx, t.outlet.id);
        if ((await tx.order.count({ where: commonWaitingWhere(t.ctx.organizationId, t.outlet.id) })) > MAX_WAITING_COMMON_QR_ORDERS) throw new ValidationError(COMMON_QR_BUSY);
      } else {
        // The same for a table's two limits (checkNewOrder ran before the transaction): the table's lock
        // makes concurrent submissions through one table QR count one at a time, each counting itself.
        await lockTableQrCaps(tx, table.id);
        const atTable = { organizationId: t.ctx.organizationId, tableId: table.id, source: "QR" };
        if ((await tx.order.count({ where: { ...atTable, status: "OPEN" } })) > MAX_WAITING_GUEST_ORDERS) throw new ValidationError(TABLE_WAITING_FULL);
        const unpaidCap = maxUnpaidGuestOrders();
        if ((await tx.order.count({ where: { ...atTable, status: { in: UNSETTLED_STATUSES } } })) > unpaidCap) throw new ValidationError(tableUnpaidFull(unpaidCap));
      }
      await writeAudit(tx, t.ctx, { action: "CREATE", entityType: "Order", entityId: placed.id, outletId: t.outlet.id, after: { via: table ? "guest-qr" : "guest-qr-common", table: table?.code ?? null, total: money(placed.total).toString(), ...(guestName ? { guestName } : {}), ...(data.paymentMethod ? { paymentMethod: data.paymentMethod } : {}) }, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 200) });
      // Staff (POS / captain alert centre) learn about the order in-app.
      await createNotificationTx(tx, t.ctx, { outletId: t.outlet.id, type: "NEW_ORDER", title: table ? `New QR order · table ${table.code}` : "New QR order · no table yet", body: [`${orderRef(placed.id)} · ₹${money(placed.total).toFixed(2)} — waiting for the guest's online payment`, guestName].filter(Boolean).join(" · ") });
    },
  });
  // Coupon, referral and consent ride on the order but never fail it: each reports its own outcome.
  let coupon: { applied: boolean; code?: string; discount?: string; message?: string } | undefined;
  let referral: { attached: boolean; message?: string } | undefined;
  const customerId = order.customerId ?? undefined;
  if (!order.replayed) {
    if (data.couponCode) {
      try {
        const r = await runInTx(db, (tx) => applyCouponTx(tx, t.ctx, order.id, data.couponCode!));
        coupon = { applied: true, code: r.coupon.code, discount: r.discount.toFixed(2) };
      } catch (e) {
        coupon = { applied: false, message: e instanceof ValidationError ? e.message : "This code can't be used here." };
      }
    }
    if (customerId && data.referralCode) {
      const r = await runInTx(db, (tx) => attachReferralTx(tx, t.ctx, customerId, data.referralCode!));
      referral = { attached: r.status === "ATTACHED", ...(r.status === "ATTACHED" ? {} : { message: r.reason }) };
    }
    if (customerId && data.marketingOptIn) await setConsent(t.ctx, customerId, [{ channel: "SMS", marketing: true }, { channel: "WHATSAPP", marketing: true }], "GUEST_QR", db);
  }
  return { orderId: order.id, ref: orderRef(order.id), accessKey: guestOrderKey(order.id), replayed: Boolean(order.replayed), ...(coupon ? { coupon } : {}), ...(referral ? { referral } : {}) };
}

/** The order page's feedback form: the order's access key is the credential (same check as every guest order action). */
export async function submitGuestOrderFeedback(orderId: string, key: string | null | undefined, input: unknown, db: PrismaClient = prisma): Promise<GuestFeedbackResult> {
  if (typeof orderId !== "string" || orderId.length > 64 || !keyMatches(orderId, key)) throw new NotFoundError("Order not found");
  return submitOrderFeedback(orderId, input, db);
}

// ---------------- the guest's view of an order ----------------

async function loadGuestOrder(orderId: string, key: string | null | undefined, db: PrismaClient) {
  if (typeof orderId !== "string" || orderId.length > 64 || !keyMatches(orderId, key)) throw new NotFoundError("Order not found");
  const order = await db.order.findUnique({ where: { id: orderId }, include: billOrderInclude });
  if (!order || order.source !== "QR") throw new NotFoundError("Order not found");
  return order;
}

export type GuestOrderView = {
  orderId: string;
  ref: string;
  status: string;
  fulfilment: Bill["fulfilment"];
  fulfilmentLabel: string;
  /** Customer tracker (received → kitchen accepted → preparing → ready → served), from the KOTs. */
  tracker: GuestTracker;
  bill: Bill;
  canPay: boolean;
  payment: GuestPaymentOptions;
  pendingPaymentId: string | null;
  /**
   * Paid online in full, but the payment was verified after the fulfilment window, so the order was not sent
   * to the kitchen automatically: staff will send it or refund it (kitchenGate.ts).
   */
  heldForReview: boolean;
  /** Waiting for its online payment, but past the fulfilment window: no new payment is taken for it. */
  expired: boolean;
  /** The same dishes as a cart, for "order the same again": current price and availability are checked when the cart is priced. */
  reorder: GuestReorderLine[];
  /** Splitting the bill from the phones: how many online parts guests have already paid. */
  split: { sharesPaid: number; minParts: number; maxParts: number };
};

export type GuestReorderLine = {
  menuItemId: string;
  name: string;
  variantId?: string;
  modifierOptionIds: string[];
  modifierLabels: string[];
  unitPrice: number;
  modifiersPerUnit: number;
  taxPct: number;
  qty: number;
  notes?: string;
};

async function viewOf(order: Awaited<ReturnType<typeof loadGuestOrder>>, db: PrismaClient): Promise<GuestOrderView> {
  const bill = buildBill(order, await loadBillVenue(db, order.organizationId, order.outletId), await getOrderInvoices(db, order.id));
  const payment = await guestPaymentOptions();
  const pending = order.payments.filter((p) => p.status === "PENDING" && p.method === "ONLINE" && !p.actorId).at(-1);
  // Not yet in the kitchen: a guest order waits for its online payment, not for the restaurant (kitchenGate.ts).
  const waitingForPayment = isAwaitingOnlinePayment(order);
  const heldForReview = waitingForPayment && D(order.total).gt(0) && (await verifiedOnlineTotalTx(db, order.id)).gte(D(order.total));
  const expired = waitingForPayment && !heldForReview && pending === undefined && isPastFulfilmentWindow(order);
  const awaitingPayment = !heldForReview && bill.fulfilment === "AWAITING_ACCEPTANCE" && (pending !== undefined || waitingForPayment);
  const reorder: GuestReorderLine[] = order.items
    .filter((i) => i.menuItemId)
    .map((i) => ({
      menuItemId: i.menuItemId!,
      name: i.name,
      ...(i.variantId ? { variantId: i.variantId } : {}),
      modifierOptionIds: i.modifiers.map((m) => m.optionId).filter((x): x is string => Boolean(x)),
      modifierLabels: i.modifiers.map((m) => m.name),
      unitPrice: num(i.unitPrice),
      modifiersPerUnit: num(i.modifiers.reduce((a, m) => a.plus(D(m.priceDelta)), D(0))),
      taxPct: num(i.taxPct),
      qty: Math.min(50, Math.max(1, Math.round(num(i.qty)))),
      ...(i.notes ? { notes: i.notes } : {}),
    }));
  return {
    orderId: order.id,
    ref: orderRef(order.id),
    status: order.status,
    fulfilment: bill.fulfilment,
    fulfilmentLabel: heldForReview ? GUEST_HELD_FOR_REVIEW_LABEL : awaitingPayment ? GUEST_AWAITING_PAYMENT_LABEL : FULFILMENT_LABEL[bill.fulfilment],
    tracker: guestTracker(order),
    bill,
    canPay: payment.online && !expired && !["PAID", "CANCELLED", "REFUNDED"].includes(order.status) && D(bill.balanceDue).gt(0),
    payment,
    pendingPaymentId: pending?.id ?? null,
    heldForReview,
    expired,
    reorder,
    split: { sharesPaid: guestSharesPaid(order.payments), minParts: MIN_SPLIT_PARTS, maxParts: MAX_SPLIT_PARTS },
  };
}

/** Online payments by guests that went through (staff payments and cash are not "parts" of a phone split). */
const guestSharesPaid = (payments: Array<{ status: string; method: string; actorId: string | null }>) => payments.filter((p) => (p.status === "SUCCESS" || p.status === "PARTIAL") && p.method === "ONLINE" && !p.actorId).length;

export async function getGuestOrder(orderId: string, key: string | null | undefined, db: PrismaClient = prisma): Promise<GuestOrderView> {
  return viewOf(await loadGuestOrder(orderId, key, db), db);
}

// ---------------- paying ----------------

/**
 * Start an online payment for the outstanding balance (computed here). A
 * refresh during checkout resumes the guest's open PENDING payment for the same
 * amount instead of creating another; a new attempt after a decline is a new
 * payment. Retries with the same Idempotency-Key return the same payment.
 */
const startPaymentSchema = z.object({ parts: z.number().int().min(MIN_SPLIT_PARTS, `The bill can be split between ${MIN_SPLIT_PARTS} and ${MAX_SPLIT_PARTS} people`).max(MAX_SPLIT_PARTS, `The bill can be split between ${MIN_SPLIT_PARTS} and ${MAX_SPLIT_PARTS} people`).optional() }).strict();

/**
 * With `parts` the guest pays an equal part of what is still due instead of all of it: the server works out the amount from
 * the balance and the parts already paid (src/domain/billSplit.ts), the last person pays what is left, and every guest's
 * payment is their own (never shared with another guest's open payment).
 */
export async function startGuestPayment(orderId: string, key: string | null | undefined, idempotencyKey: unknown, input: unknown = {}, db: PrismaClient = prisma) {
  const idem = idemKey.parse(idempotencyKey);
  const { parts } = startPaymentSchema.parse(input ?? {});
  const order = await loadGuestOrder(orderId, key, db);
  if (["PAID", "CANCELLED", "REFUNDED"].includes(order.status)) throw new ValidationError(`This order is already ${order.status.toLowerCase()}`);
  const options = await guestPaymentOptions({ fresh: true });
  if (!options.online) throw new ValidationError(isAwaitingOnlinePayment(order) ? ONLINE_PAYMENT_UNAVAILABLE : "Online payment is not available here. Please pay at the counter.");
  const gateway = getCheckoutProvider();
  const collected = order.payments.filter((p) => p.status === "SUCCESS" || p.status === "PARTIAL").reduce((a, p) => a.plus(D(p.amount)), D(0));
  const outstanding = money(D(order.total).minus(collected));
  if (outstanding.lte(0)) throw new ValidationError("Nothing is due on this order");
  const share = parts ? splitShare(outstanding, parts, guestSharesPaid(order.payments)) : null;
  const amount = share ? D(share.amount) : outstanding;

  const ctx = systemContext(order.organizationId, [order.outletId]);
  // A refresh resumes the guest's own open payment. Whole-bill payments share one open payment for the same amount; a part
  // belongs to the phone that asked for it (its Idempotency-Key), so two guests never end up on the same checkout.
  const resumable = share ? undefined : order.payments.find((p) => p.status === "PENDING" && p.method === "ONLINE" && p.provider === gateway.name && !p.actorId && D(p.amount).eq(outstanding));
  // An order the kitchen would no longer receive automatically is not charged again (a new QR / payment);
  // an open checkout can still finish (it is then held for staff, never lost).
  if (!resumable && isAwaitingOnlinePayment(order) && isPastFulfilmentWindow(order)) throw new ValidationError(ORDER_TOO_OLD_TO_PAY);
  const payment = resumable ?? (await createPayment(ctx, order.id, { method: "ONLINE", amount: num(amount), provider: gateway.name, idempotencyKey: `qrpay:${order.id.slice(-12)}:${idem}` }, db));
  // Gateway-side checkout for the SERVER's amount (the Payment row), created outside any DB
  // transaction. A failure leaves the payment PENDING without a reference; the next attempt
  // resumes it. A payment that already has its checkout keeps it (no second gateway order).
  let checkout: Record<string, string | number> | undefined;
  if (gateway.createCheckout) {
    let providerRef = payment.providerRef;
    if (!providerRef) {
      const session = await gateway.createCheckout({ paymentId: payment.id, orderId: order.id, amount: num(payment.amount), currency: "INR" });
      // Compare-and-set, queued like every other write (runInTx): a bare write outside the queue lost
      // SQLite's write lock under a burst of guests starting payments at once (socket timeout).
      // The checkout's public data (a bank QR and its expiry) is kept so a refresh shows the same QR.
      const claimed = await runInTx(db, (tx) => tx.payment.updateMany({ where: { id: payment.id, status: "PENDING", providerRef: null }, data: { providerRef: session.providerRef, checkoutData: JSON.stringify(session.checkout), checkoutExpiresAt: session.expiresAt ?? null } }));
      if (claimed.count === 1) providerRef = session.providerRef;
      else {
        // Another start stored its checkout first (resumed below), or the payment was decided meanwhile —
        // declined or paid without a reference — and has no checkout left to open: the guest starts again.
        const now = await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true, providerRef: true } });
        if (now.status !== "PENDING" || !now.providerRef) throw new ConflictError("This payment changed while it was being started. Please try again.");
        providerRef = now.providerRef;
      }
      checkout = providerRef === session.providerRef ? session.checkout : undefined;
    }
    // Resuming (refresh mid-payment): reopen the same gateway checkout, never a second gateway order.
    if (!checkout && providerRef) checkout = storedCheckout(await db.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { checkoutData: true } })) ?? gateway.resumeCheckout?.({ providerRef, amount: num(payment.amount), currency: "INR" });
    checkout ??= { provider: gateway.name, mode: gateway.mode, orderId: providerRef ?? "", amount: Math.round(num(payment.amount) * 100), currency: "INR" };
  }
  return { paymentId: payment.id, amount: money(payment.amount).toFixed(2), provider: gateway.name, mode: gateway.mode, testMode: options.testMode, checkout, ...(share ? { share: { parts, remainingParts: share.remainingParts, last: share.last } } : {}) };
}

const confirmSchema = z
  .object({
    paymentId: z.string().min(1).max(64),
    /** The gateway's payment reference from its checkout (verified with the gateway, not trusted). */
    providerRef: z.string().trim().min(1).max(100).optional(),
    /** The gateway checkout's response, handed to the provider adapter for server-side verification. */
    gateway: z.record(z.string().max(512)).refine((r) => Object.keys(r).length <= 10, "Too many fields").optional(),
  })
  .strict();

/**
 * Confirm a payment with the gateway. Outcome is decided by the provider +
 * payment service, never by this request. Without a checkout response this is
 * a status check ("I closed the window — did it go through?"): an undecided
 * payment stays PENDING (`pending`), it is not failed.
 */
/** The checkout data stored when the payment's checkout was created (public data only), or undefined. */
function storedCheckout(p: { checkoutData: string | null }): Record<string, string | number> | undefined {
  if (!p.checkoutData) return undefined;
  try {
    const v = JSON.parse(p.checkoutData) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string | number>) : undefined;
  } catch {
    return undefined;
  }
}

export async function confirmGuestPayment(orderId: string, key: string | null | undefined, input: unknown, db: PrismaClient = prisma): Promise<GuestOrderView & { paymentStatus: string; pending: boolean }> {
  const data = confirmSchema.parse(input);
  const order = await loadGuestOrder(orderId, key, db);
  const payment = order.payments.find((p) => p.id === data.paymentId);
  if (!payment || payment.method !== "ONLINE" || payment.actorId) throw new NotFoundError("Payment not found");
  const ctx = systemContext(order.organizationId, [order.outletId]);
  let res: { payment: { status: string }; pending?: boolean };
  try {
    res = await verifyPayment(ctx, payment.id, { providerRef: data.providerRef, payload: data.gateway }, db);
  } catch (e) {
    // The gateway could not be reached or timed out: nothing was decided and nothing changed. The guest is told the
    // payment is still being confirmed (never paid, never failed); the pending-payment recheck settles it later.
    if (!(e instanceof IntegrationError && e.retryable) && !(e instanceof ProviderUnavailableError)) throw e;
    res = { payment: { status: payment.status }, pending: true };
  }
  return { ...(await getGuestOrder(orderId, key, db)), paymentStatus: res.payment.status, pending: Boolean(res.pending) };
}
