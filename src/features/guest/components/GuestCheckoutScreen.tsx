"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { request, describeError, ApiError } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { cartFingerprint, toOrderItems } from "@/features/pos/cart";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import { clearSubmission, loadReferral, markSubmissionPending, orderUrl, pendingSubmission, rememberOrder, saveCart, saveCoupon, saveNotice, saveReferral, settleSubmission, submissionKey, type PendingSubmission } from "@/features/guest/session";
import { ORDER_ATTEMPT_TIMEOUT_MS, submitWithReconcile, type SubmitOutcome, type SubmitPhase } from "@/features/guest/orderSubmit";
import { guestSeat, useServerQuote, useStorefront } from "@/features/guest/storefront";
import { OfflineBanner, TopBar } from "@/features/guest/components/Chrome";
import { Totals } from "@/features/guest/components/GuestCartScreen";
import { CouponBox, ReferralAndOffers } from "@/features/guest/components/GuestOffers";
import { Alert, Spinner } from "@/features/guest/components/Bits";
import { SfIcon } from "@/features/guest/components/SfIcon";
import { guestOnlinePaymentCopy } from "@/features/guest/paymentCopy";

type PlacedOrder = { orderId: string; ref: string; accessKey: string; coupon?: { applied: boolean; message?: string }; referral?: { attached: boolean; message?: string } };
/** Test hook: shorter waits than a real phone on a slow network needs. */
export type OrderSubmitTiming = { attemptTimeoutMs?: number; slowAfterMs?: number; delaysMs?: number[] };

/** "98765 43210" / "+91 98765-43210" → "9876543210" (same rule as the server). */
export function normalizePhone(raw: string): string {
  const compact = raw.replace(/[\s().-]/g, "");
  const india = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(compact);
  return india ? india[1] : compact;
}
/**
 * The price guard: the total placing the order is priced at, i.e. before any coupon (the coupon is
 * applied once the order exists). A quote with a discount but without that figure sends no guard
 * rather than the discounted total, which the server would always refuse.
 */
function guardTotal(quote: { total: string; discount?: string; totalBeforeDiscount?: string }): { expectedTotal?: string } {
  if (quote.totalBeforeDiscount) return { expectedTotal: quote.totalBeforeDiscount };
  return Number(quote.discount ?? 0) > 0 ? {} : { expectedTotal: quote.total };
}

export const phoneValid = (raw: string) => !raw.trim() || /^\+?\d{10,15}$/.test(normalizePhone(raw));

/**
 * Checkout: table, order summary (server-priced), optional name / phone, online
 * payment (the only way a QR order is paid: it reaches the kitchen once the
 * payment is verified, and the server refuses a pay-at-the-counter order). Placing the order is one idempotent request (a double tap or a
 * refresh replays the same order). A slow or lost answer is never shown as a
 * failure: the same request is replayed to learn what happened (orderSubmit.ts),
 * and if that stays unknown the guest gets "Check order status", not an error.
 * Online payment then opens on the order page, where the payment gateway is
 * allowed to run.
 */
export function GuestCheckoutScreen({ navigate = (url: string) => window.location.assign(url), timing }: { navigate?: (url: string) => void; timing?: OrderSubmitTiming }) {
  const { token, cart, cartReady, data, base, estimate, dispatch, refreshMenu, couponCode, setCouponCode } = useStorefront();
  const online = data.payment.online;
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [referral, setReferral] = useState("");
  const [optIn, setOptIn] = useState(false);
  // A friend's invite link (/r/CODE) leaves the code on this device until it is used.
  useEffect(() => setReferral(loadReferral() ?? ""), []);
  const { quote, loading, unavailable, recheck } = useServerQuote({ phone: phoneValid(phone) && phone.trim() ? normalizePhone(phone) : undefined });
  const [touched, setTouched] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SubmitPhase | null>(null);
  // An order request went out but its outcome is unknown (slow / lost answer), possibly from before a refresh.
  const [unconfirmed, setUnconfirmed] = useState(false);
  useEffect(() => setUnconfirmed(pendingSubmission(token) !== null), [token]);
  const guard = useRef(createSubmitGuard());
  const phoneId = useId();
  const phoneOk = phoneValid(phone);
  const closed = (quote?.ordering ?? data.ordering)?.open === false;
  const total = quote ? quote.total : estimate.total;
  const onlineCopy = guestOnlinePaymentCopy(data.payment);

  async function place() {
    setTouched(true);
    if (!cart.lines.length || !phoneOk || placing || unconfirmed) return;
    setError(null);
    setPlacing(true);
    const customer = name.trim() || phone.trim() ? { ...(name.trim() ? { name: name.trim().slice(0, 60) } : {}), ...(phone.trim() ? { phone: normalizePhone(phone) } : {}) } : undefined;
    const withPhone = Boolean(phone.trim());
    // Only a code the server just accepted rides with the order; the server prices it again when the order is placed.
    const coupon = quote?.coupon?.ok ? quote.coupon.code : undefined;
    const referralCode = withPhone && referral.length >= 4 ? referral : undefined;
    const marketingOptIn = withPhone && optIn ? true : undefined;
    const fp = cartFingerprint(cart, JSON.stringify([customer ?? null, "ONLINE", coupon ?? null, referralCode ?? null, marketingOptIn ?? null]));
    // The key survives a refresh (sessionStorage): resubmitting the same order replays it.
    // The total the guest was shown, before any coupon (the coupon is applied once the order exists):
    // the server prices the order itself and refuses (409, nothing created) if its price differs.
    // JSON round trip: exactly what is sent, and what a later "Check order status" replays.
    const body = JSON.parse(JSON.stringify({
      items: toOrderItems(cart).map((i) => ({ ...i, notes: i.notes || undefined })), notes: cart.notes.trim() || undefined, ...(customer ? { customer } : {}), paymentMethod: "ONLINE",
      ...(quote ? guardTotal(quote) : {}),
      ...(coupon ? { couponCode: coupon } : {}), ...(referralCode ? { referralCode } : {}), ...(marketingOptIn ? { marketingOptIn } : {}),
    })) as Record<string, unknown>;
    await submit({ fingerprint: fp, key: submissionKey(token, fp), body });
  }

  /** "Check order status": the same request again (same key, same body) — returns the order if it was placed. */
  async function checkAgain() {
    const p = pendingSubmission(token);
    if (!p || placing) return;
    setError(null);
    setPlacing(true);
    await submit(p);
  }

  async function submit(pending: PendingSubmission) {
    // Remembered before sending: a refresh while the answer is outstanding can still recover the order.
    markSubmissionPending(token, pending);
    setUnconfirmed(false);
    const result = await guard.current.run(pending.fingerprint, async () => {
      const outcome = await submitWithReconcile(
        () => request<PlacedOrder>(`/api/qr/t/${encodeURIComponent(token)}/orders`, { method: "POST", idempotencyKey: pending.key, body: pending.body, timeoutMs: timing?.attemptTimeoutMs ?? ORDER_ATTEMPT_TIMEOUT_MS }),
        { onPhase: setPhase, delaysMs: timing?.delaysMs, slowAfterMs: timing?.slowAfterMs }
      );
      if (outcome.status !== "ok") throw outcome;
      return outcome.value;
    });
    setPhase(null);
    if (result.status === "busy") return;
    if (result.status === "error") {
      setPlacing(false);
      const outcome = result.error as SubmitOutcome<PlacedOrder>;
      if (outcome.status === "unknown") {
        // Not a failure: the order may be in the kitchen already. Keep the request and offer a safe check.
        setUnconfirmed(true);
        return;
      }
      settleSubmission(token);
      const e = outcome.status === "failed" ? outcome.error : outcome;
      if (e instanceof ApiError && e.code === "PriceChanged") {
        const now = (e.details as { total?: unknown } | undefined)?.total;
        setError(typeof now === "string" ? `${e.message} New total: ${formatMoney(now)}.` : e.message);
        void refreshMenu();
        void recheck();
        return;
      }
      setError(describeError(e));
      if (e instanceof ApiError && e.kind === "validation") {
        void refreshMenu(); // e.g. an item just sold out
        void recheck();
      }
      return;
    }
    const placed = result.value;
    rememberOrder({ orderId: placed.orderId, key: placed.accessKey, token, ref: placed.ref, at: new Date().toISOString() });
    clearSubmission(token);
    // The order never fails because of a code; if one was not used, the order page says why.
    const notices = [placed.coupon && !placed.coupon.applied ? `Coupon not applied: ${placed.coupon.message ?? "this code can't be used here."}` : null, placed.referral && !placed.referral.attached ? `Referral not used: ${placed.referral.message ?? "this code can't be used."}` : null].filter(Boolean);
    if (notices.length) saveNotice(placed.orderId, notices.join(" "));
    if (pending.body.referralCode) saveReferral(null);
    saveCoupon(token, null);
    setCouponCode(null);
    saveCart(token, { ...cart, lines: [], notes: "" });
    dispatch({ type: "clear" });
    // A full page load: the order page is where the payment gateway's script is allowed (CSP).
    navigate(`${orderUrl(placed.orderId, placed.accessKey)}&new=1&pay=1`);
  }

  if (cartReady && cart.lines.length === 0 && !placing && !unconfirmed) {
    return (
      <div>
        <TopBar />
        <main className="sf-wrap">
          <div className="sf-card sf-empty" style={{ marginTop: 24 }}>
            <SfIcon name="cart" />
            <h1 style={{ fontFamily: "var(--sf-display)", fontSize: 24, margin: "10px 0 4px" }}>Nothing to check out</h1>
            <p>Your cart is empty.</p>
            <Link href={`${base}#menu`} className="sf-btn sf-btn-primary" style={{ marginTop: 14 }}>
              Browse the menu
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const disabled = placing || !cartReady || loading || !quote || unavailable.length > 0 || closed || !phoneOk || !online;

  return (
    <div>
      <TopBar />
      <OfflineBanner />
      <main className="sf-wrap" style={{ paddingBottom: 24 }}>
        <div className="sf-page-head">
          <Link prefetch href={`${base}/cart`} className="sf-back" aria-label="Back to your cart">
            <SfIcon name="back" />
          </Link>
          <div>
            <h1 className="sf-page-title">Checkout</h1>
            <p className="sf-page-sub">No sign-up needed.</p>
          </div>
        </div>

        <section className="sf-card sf-table-card" aria-label="Your table">
          {data.table && <span className="sf-tno" aria-hidden="true">{data.table.code}</span>}
          <div>
            <p className="sf-card-title">Ordering from</p>
            <p style={{ fontWeight: 700, fontSize: 18 }}>{guestSeat(data.table)}</p>
            <p className="sf-page-sub">{data.restaurant.name}</p>
            {!data.table && <p className="sf-page-sub" data-testid="sit-anywhere-hint">No need to pick a table: the staff bring your order to you. You can say where you are sitting in the note, if you like.</p>}
          </div>
        </section>

        <section className="sf-card" aria-labelledby="co-order">
          <h2 id="co-order" className="sf-card-title">Your order</h2>
          <ul className="sf-lines">
            {cart.lines.map((l) => (
              <li key={l.key} className="sf-line">
                <div className="sf-line-top">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p className="sf-line-name">
                      {l.qty} × {l.name}
                    </p>
                    {l.modifierLabels.length > 0 && <p className="sf-line-meta">{l.modifierLabels.map((m) => m.replace(/^[^:]+:\s*/, "+ ")).join(" · ")}</p>}
                  </div>
                  <span className="sf-line-amt">{formatMoney(l.qty * (l.unitPrice + l.modifiersPerUnit))}</span>
                </div>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 12 }}>
            <Totals quote={quote} estimate={estimate} loading={loading} />
          </div>
          {unavailable.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Alert tone="bad" role="alert">
                Some items aren&apos;t available any more. <Link prefetch href={`${base}/cart`} className="sf-link">Review your cart</Link>
              </Alert>
            </div>
          )}
        </section>

        <CouponBox quote={quote} loading={loading} />

        <section className="sf-card" aria-labelledby="co-you">
          <h2 id="co-you" className="sf-card-title">About you</h2>
          <label className="sf-field" style={{ marginTop: 8 }}>
            <span className="sf-label">
              Your name <small>Optional — so we can call you</small>
            </span>
            <input className="sf-input" name="name" autoComplete="given-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ananya" />
          </label>
          <label className="sf-field">
            <span className="sf-label">
              Phone <small>Optional</small>
            </span>
            <input
              className="sf-input"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="10-digit mobile number"
              aria-invalid={touched && !phoneOk}
              aria-describedby={phoneId}
            />
            <p id={phoneId} className={touched && !phoneOk ? "sf-field-error" : "sf-hint"}>
              {touched && !phoneOk ? "Enter a valid mobile number, or leave it empty." : "Only used by the café for this order and your visits."}
            </p>
          </label>
          <ReferralAndOffers phoneGiven={Boolean(phone.trim()) && phoneOk} referral={referral} onReferral={setReferral} optIn={optIn} onOptIn={setOptIn} />
        </section>

        <section className="sf-card" aria-labelledby="co-pay">
          <h2 id="co-pay" className="sf-card-title">Payment method</h2>
          {online ? (
            <div className="sf-pay-opts" role="radiogroup" aria-labelledby="co-pay" style={{ marginTop: 8 }}>
              <label className="sf-pay-opt" data-checked="true">
                <input className="sf-hit" type="radio" name="payment" value="ONLINE" checked readOnly />
                <span className="sf-pay-ico"><SfIcon name="card" /></span>
                <span>
                  <b>{onlineCopy.title}</b>
                  <small>{onlineCopy.detail}</small>
                </span>
                <span className="sf-option-mark" data-kind="radio"><SfIcon name="check" strokeWidth={3} /></span>
              </label>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <Alert tone="warn" role="status">Online payment isn&apos;t available right now, so orders can&apos;t be placed from the table. Please order with the staff.</Alert>
            </div>
          )}
          <p className="sf-note">
            {data.payment.mode === "LIVE"
              ? "Your order goes to the kitchen as soon as the payment is confirmed by the bank."
              : `${onlineCopy.detail} The café sends the order to the kitchen only after that payment is accepted.`}
          </p>
        </section>

        {closed && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="warn" role="status">{(quote?.ordering ?? data.ordering)?.message}</Alert>
          </div>
        )}
        {error && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="bad" role="alert">{error}</Alert>
          </div>
        )}
        <div role="status" aria-live="polite">
          {placing && (phase === "slow" || phase === "confirming") && (
            <div style={{ marginTop: 14 }}>
              <Alert tone="info">
                {phase === "slow"
                  ? "Still placing your order — the connection to the café is slow. Please keep this page open."
                  : "Confirming your order with the café… Please keep this page open; your order won't be placed twice."}
              </Alert>
            </div>
          )}
          {unconfirmed && !placing && (
            <div style={{ marginTop: 14 }} data-testid="order-unconfirmed">
              <Alert tone="warn">
                We couldn&apos;t confirm your order yet. It may already have been placed, so please don&apos;t order it again — check its status in a moment, or ask a member of staff.
              </Alert>
            </div>
          )}
        </div>

        <div className="sf-sticky-cta">
          <div className="sf-total-line">
            <span>Total</span>
            <b data-testid="checkout-total">{formatMoney(total)}</b>
          </div>
          {unconfirmed && !placing ? (
            <button type="button" className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block" onClick={() => void checkAgain()}>
              Check order status
            </button>
          ) : (
            <button type="button" className="sf-btn sf-btn-primary sf-btn-lg sf-btn-block" onClick={() => void place()} disabled={disabled} aria-disabled={disabled}>
              {placing ? (
                <>
                  <Spinner /> {phase === "confirming" ? "Confirming your order…" : "Placing your order…"}
                </>
              ) : (
                `Place order & pay ${formatMoney(total)}`
              )}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
