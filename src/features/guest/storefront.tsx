"use client";

/**
 * Guest storefront state for one scanned table: the menu (from the server),
 * this device's cart, the item sheet, toasts. Lives in the /t/[token] layout so
 * the menu → cart → checkout pages share it without refetching.
 *
 * The server stays authoritative: the cart only stores what the guest picked
 * (item / size / add-ons / quantity). Prices shown before the server's quote
 * are estimates from the outlet menu; the cart and checkout pages re-price the
 * cart on the server (POST /api/qr/t/:token/quote) and the order is priced
 * again when it is placed.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { request } from "@/lib/api/client";
import { cartItemCount, cartReducer, emptyCart, lineKey, type CartAction, type CartLine, type CartState } from "@/features/pos/cart";
import { estimateTotals } from "@/features/pos/estimate";
import type { MenuItemDTO } from "@/features/pos/types";
import { loadCart, loadCoupon, saveCart, saveCoupon } from "@/features/guest/session";
import { brandFor, type Brand } from "@/features/guest/brand";

export type GuestMenuData = {
  restaurant: {
    name: string;
    outletName: string;
    address: string | null;
    phone?: string | null;
    currency: string;
    hours?: { open: string | null; close: string | null; label: string | null } | null;
  };
  /** null: the restaurant's common QR — the guest sits anywhere; staff assign the table. */
  table: { code: string } | null;
  ordering?: { open: boolean; message: string | null };
  menu: MenuItemDTO[];
  payment: { online: boolean; testMode: boolean; mode?: string | null };
};

/** The server accepts at most this many of one line (guestOrdering.ts). */
export const GUEST_MAX_QTY = 50;
/** …and at most this many lines per order. */
export const GUEST_MAX_LINES = 30;

type StoreAction =
  | CartAction
  | { type: "load"; state: CartState }
  /** Replace one line (edit size / add-ons / note / qty); merges into an identical line if one exists. */
  | { type: "replace"; key: string; line: Omit<CartLine, "key"> }
  /** Server re-pricing of existing lines (prices changed at the restaurant). */
  | { type: "reprice"; prices: Array<{ key: string; unitPrice: number; modifiersPerUnit: number; taxPct: number }> };

function storeReducer(state: CartState, action: StoreAction): CartState {
  switch (action.type) {
    case "load":
      return action.state;
    case "replace": {
      const idx = state.lines.findIndex((l) => l.key === action.key);
      if (idx < 0) return state;
      const key = lineKey(action.line);
      const next: CartLine = { ...action.line, key, qty: Math.max(1, Math.min(GUEST_MAX_QTY, action.line.qty)) };
      const twin = state.lines.findIndex((l, i) => i !== idx && l.key === key);
      let lines: CartLine[];
      if (twin >= 0) {
        lines = state.lines.filter((_, i) => i !== idx).map((l) => (l.key === key ? { ...l, qty: Math.min(GUEST_MAX_QTY, l.qty + next.qty) } : l));
      } else {
        lines = state.lines.map((l, i) => (i === idx ? next : l));
      }
      return { ...state, lines, selectedKey: key };
    }
    case "reprice": {
      const byKey = new Map(action.prices.map((p) => [p.key, p]));
      return { ...state, lines: state.lines.map((l) => (byKey.has(l.key) ? { ...l, ...byKey.get(l.key)!, key: l.key } : l)) };
    }
    default:
      return cartReducer(state, action);
  }
}

type SheetState = { item: MenuItemDTO; editing?: CartLine } | null;

type StorefrontValue = {
  token: string;
  data: GuestMenuData;
  brand: Brand;
  base: string;
  cart: CartState;
  /** True once the saved cart was restored on this device (avoid flashing an empty cart). */
  cartReady: boolean;
  /** A coupon code the guest entered (the server prices it; it is only sent with the quote and the order). */
  couponCode: string | null;
  setCouponCode: (code: string | null) => void;
  dispatch: (a: StoreAction) => void;
  count: number;
  estimate: ReturnType<typeof estimateTotals>;
  sheet: SheetState;
  openItem: (item: MenuItemDTO) => void;
  editLine: (line: CartLine) => void;
  closeSheet: () => void;
  /** One tap on a simple item: add it (sold-out items are never added). */
  quickAdd: (item: MenuItemDTO) => void;
  refreshMenu: () => Promise<void>;
  toast: string | null;
  showToast: (msg: string) => void;
  online: boolean;
  /** The server's last quote, shared by the cart and checkout pages (use useServerQuote). */
  quoteState: QuoteState;
  runQuote: () => Promise<void>;
  /** The phone typed at checkout, for a coupon's per-guest rules (only sent with a coupon code). */
  setQuotePhone: (phone: string | undefined) => void;
  dismissRepriced: () => void;
};

type QuoteState = { quote: (Quote & { sig: string; at: number }) | null; loading: boolean; error: string | null; repriced: string[] };

const Ctx = createContext<StorefrontValue | null>(null);

export function useStorefront(): StorefrontValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStorefront must be used inside <StorefrontProvider>");
  return v;
}

export function StorefrontProvider({ token, initial, children }: { token: string; initial: GuestMenuData; children: ReactNode }) {
  const [data, setData] = useState(initial);
  const [cart, dispatch] = useReducer(storeReducer, undefined, () => emptyCart("DINE_IN"));
  const [cartReady, setCartReady] = useState(false);
  const [couponCode, setCouponState] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const toastTimer = useRef<number | null>(null);
  const brand = useMemo(() => brandFor(data.restaurant.name), [data.restaurant.name]);
  const base = `/t/${encodeURIComponent(token)}`;

  // Restore this device's cart after hydration (sessionStorage is not available on the server).
  useEffect(() => {
    dispatch({ type: "load", state: loadCart(token) });
    setCouponState(loadCoupon(token));
    setCartReady(true);
  }, [token]);
  const setCouponCode = useCallback((code: string | null) => {
    setCouponState(code);
    saveCoupon(token, code);
  }, [token]);
  useEffect(() => {
    if (cartReady) saveCart(token, cart);
  }, [token, cart, cartReady]);

  const refreshMenu = useCallback(async () => {
    try {
      setData(await request<GuestMenuData>(`/api/qr/t/${encodeURIComponent(token)}`));
    } catch {
      /* keep the current menu; the cart is re-checked by the server before ordering */
    }
  }, [token]);

  // Sold-out flags change during service: refresh when the guest comes back to the tab, and every minute while visible.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshMenu();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshMenu();
    }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [refreshMenu]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  // Handlers below are stable across cart changes (they read the latest cart / menu
  // from refs), so the memoized menu rows do not re-render when another line changes.
  const cartLines = useRef(cart.lines);
  cartLines.current = cart.lines;
  const menu = useRef(data.menu);
  menu.current = data.menu;

  const quickAdd = useCallback(
    (item: MenuItemDTO) => {
      if (item.effectiveSoldOut) return;
      const lines = cartLines.current;
      if (lines.length >= GUEST_MAX_LINES && !lines.some((l) => l.menuItemId === item.id && !l.variantId && !l.modifierOptionIds.length && !l.notes)) {
        showToast(`An order can have up to ${GUEST_MAX_LINES} different items`);
        return;
      }
      dispatch({ type: "add", line: { menuItemId: item.id, name: item.name, modifierOptionIds: [], modifierLabels: [], unitPrice: item.effectivePrice, modifiersPerUnit: 0, taxPct: Number(item.taxPct), qty: 1 } });
      showToast(`Added ${item.name}`);
    },
    [showToast]
  );
  const openItem = useCallback((item: MenuItemDTO) => setSheet({ item }), []);
  const editLine = useCallback((line: CartLine) => {
    const item = menu.current.find((i) => i.id === line.menuItemId);
    if (item) setSheet({ item, editing: line });
  }, []);
  const closeSheet = useCallback(() => setSheet(null), []);

  // The server quote lives here, not in each page, so cart → checkout → cart does not
  // re-price an unchanged cart (the order is priced again by the server when placed).
  // It covers the coupon too: the code (and, with a code, the phone its per-guest rules
  // need) is part of the request and of the signature an answer is reused for.
  const [quoteState, setQuoteState] = useState<QuoteState>({ quote: null, loading: false, error: null, repriced: [] });
  const quoteSeq = useRef(0);
  const offer = useRef<{ couponCode: string | null; phone?: string }>({ couponCode });
  offer.current = { ...offer.current, couponCode };
  const setQuotePhone = useCallback((phone: string | undefined) => {
    offer.current = { ...offer.current, phone };
  }, []);
  const runQuote = useCallback(async () => {
    const lines = cartLines.current;
    const { couponCode: code, phone: ph } = offer.current;
    const sig = quoteSignature(lines, code, ph);
    const mine = ++quoteSeq.current;
    if (!lines.length) {
      setQuoteState((s) => ({ ...s, quote: null, loading: false }));
      return;
    }
    setQuoteState((s) => ({ ...s, loading: true }));
    try {
      const q = await request<Quote>(`/api/qr/t/${encodeURIComponent(token)}/quote`, { method: "POST", body: { items: itemsOf(lines), ...(code ? { couponCode: code, ...(ph ? { phone: ph } : {}) } : {}) } });
      if (mine !== quoteSeq.current) return;
      const changes: Array<{ key: string; unitPrice: number; modifiersPerUnit: number; taxPct: number }> = [];
      const names: string[] = [];
      q.lines.forEach((ql) => {
        const l = lines[ql.index];
        if (!l || !ql.ok) return;
        const unit = Number(ql.unitPrice);
        const mods = Number(ql.modifiersPerUnit);
        const tax = Number(ql.taxPct);
        if (Math.abs(unit - l.unitPrice) > 0.004 || Math.abs(mods - l.modifiersPerUnit) > 0.004 || Math.abs(tax - l.taxPct) > 0.0001) {
          changes.push({ key: l.key, unitPrice: unit, modifiersPerUnit: mods, taxPct: tax });
          names.push(l.name);
        }
      });
      if (changes.length) dispatch({ type: "reprice", prices: changes });
      // Re-pricing does not change the signature (items / sizes / add-ons / quantities / coupon only).
      setQuoteState((s) => ({ quote: { ...q, sig, at: Date.now() }, loading: false, error: null, repriced: names.length ? names : s.repriced }));
    } catch (e) {
      if (mine !== quoteSeq.current) return;
      setQuoteState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "Could not check your cart" }));
    }
  }, [token]);
  const dismissRepriced = useCallback(() => setQuoteState((s) => ({ ...s, repriced: [] })), []);

  const value: StorefrontValue = {
    token,
    data,
    brand,
    base,
    cart,
    cartReady,
    couponCode,
    setCouponCode,
    dispatch,
    count: cartItemCount(cart),
    estimate: estimateTotals(cart.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, modifiersPerUnit: l.modifiersPerUnit, taxPct: l.taxPct }))),
    sheet,
    openItem,
    editLine,
    closeSheet,
    quickAdd,
    refreshMenu,
    toast,
    showToast,
    online,
    quoteState,
    runQuote,
    setQuotePhone,
    dismissRepriced,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------- server quote ----------------

export type QuoteLine =
  | { index: number; ok: true; menuItemId: string; name: string; unitPrice: string; modifiers: Array<{ name: string; priceDelta: string }>; modifiersPerUnit: string; taxPct: string; qty: number; lineTotal: string }
  | { index: number; ok: false; menuItemId: string; reason: string };
export type QuoteCoupon = { ok: true; code: string; name: string; discount: string } | { ok: false; message: string };
export type Quote = {
  lines: QuoteLine[]; subtotal: string; tax: string; taxes: Array<{ ratePct: string; amount: string }>; total: string; allAvailable: boolean; ordering: { open: boolean; message: string | null };
  /** Present when a code was sent: what it is worth, or why not (in words a guest may see). */
  coupon?: QuoteCoupon;
  /** Total discount already taken off `total` ("0.00" without a coupon). */
  discount?: string;
  /** `total` without the coupon: what the order is priced at when placed (checkout's expectedTotal). */
  totalBeforeDiscount?: string;
};

const itemsOf = (lines: CartLine[]) => lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, modifierOptionIds: l.modifierOptionIds.length ? l.modifierOptionIds : undefined, qty: l.qty }));
const quoteSignature = (lines: CartLine[], couponCode: string | null, phone: string | undefined) => JSON.stringify([itemsOf(lines), couponCode, phone ?? null]);

/** How long the cart and checkout pages reuse the server's answer for an unchanged cart. */
export const QUOTE_REUSE_MS = 30_000;

/**
 * The cart priced by the server. Re-fetched whenever the lines change
 * (debounced), and when a page opens without a recent answer for exactly this
 * cart. When the restaurant changed a price, the cart line takes the server's
 * price and `repriced` lists what changed so the page can say so.
 */
export function useServerQuote(opts: { phone?: string } = {}) {
  const { cart, cartReady, couponCode, quoteState, runQuote, setQuotePhone, dismissRepriced } = useStorefront();
  const { quote, loading, error, repriced } = quoteState;
  // The phone only matters to a coupon (first-order / per-guest rules): without one, typing it must not re-price the cart.
  const phone = couponCode ? opts.phone || undefined : undefined;
  setQuotePhone(phone);
  const signature = quoteSignature(cart.lines, couponCode, phone);
  const opened = useRef(false);

  useEffect(() => {
    if (!cartReady) return;
    const first = !opened.current;
    opened.current = true;
    // Coming from the cart (or back): the provider already holds the answer for this exact cart and coupon.
    if (quote && quote.sig === signature && Date.now() - quote.at < QUOTE_REUSE_MS) return;
    const id = window.setTimeout(() => void runQuote(), first ? 0 : 250);
    return () => window.clearTimeout(id);
    // signature captures every priced field of the lines; the cached quote is read when they change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, cartReady, runQuote]);

  /** The server's answer for exactly the current cart (null while the cart changed and is being re-checked). */
  const current = quote && quote.sig === signature ? quote : null;
  /** Quote line for cart line `index` (null while unknown). */
  const forLine = (index: number): QuoteLine | null => current?.lines.find((l) => l.index === index) ?? null;
  const unavailable = current ? current.lines.filter((l): l is Extract<QuoteLine, { ok: false }> => !l.ok) : [];
  return { quote: current, loading: loading || (cart.lines.length > 0 && !current && !error), error, repriced, dismissRepriced, forLine, unavailable, recheck: runQuote };
}

/** Where the guest is ordering from: their table (table QR) or "Sit anywhere" (the restaurant's common QR). */
export function guestSeat(table: { code: string } | null): string {
  return table ? `Table ${table.code}` : "Sit anywhere";
}
