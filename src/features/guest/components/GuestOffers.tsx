"use client";

/**
 * Guest-side growth pieces: the coupon box (cart and checkout), the checkout's referral / offers opt-in, and the
 * post-meal rating on the order page. The server prices coupons, checks referral codes and keeps one answer per order;
 * these components only collect the input and show what the server said.
 */
import { useId, useState } from "react";
import { request, describeError } from "@/lib/api/client";
import { formatMoney } from "@/lib/format";
import { markRated, wasRated } from "@/features/guest/session";
import { useStorefront, type Quote } from "@/features/guest/storefront";
import { Alert, Spinner } from "@/features/guest/components/Bits";

/** "Have a code?": the code is sent with the cart quote; the answer (worth, or why not) comes back from the server. */
export function CouponBox({ quote, loading }: { quote: Quote | null; loading: boolean }) {
  const { couponCode, setCouponCode } = useStorefront();
  const [draft, setDraft] = useState("");
  const id = useId();
  const result = quote?.coupon;
  if (couponCode && result?.ok) {
    return (
      <section className="sf-card" aria-label="Coupon">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <p style={{ margin: 0 }}>
            <b className="sf-num" data-testid="coupon-applied">{result.code}</b> <span className="sf-hint">{result.name}</span>
            <br />
            <span style={{ color: "var(--sf-ok)", fontWeight: 600 }}>You save {formatMoney(result.discount)}</span>
          </p>
          <button type="button" className="sf-btn sf-btn-sm sf-btn-ghost" onClick={() => setCouponCode(null)} aria-label={`Remove coupon ${result.code}`}>Remove</button>
        </div>
      </section>
    );
  }
  return (
    <section className="sf-card" aria-label="Coupon">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const code = draft.trim().toUpperCase();
          if (code) { setCouponCode(code); setDraft(""); }
        }}
      >
        <label className="sf-field" htmlFor={id} style={{ marginTop: 0 }}>
          <span className="sf-label">Have a coupon code? <small>Optional</small></span>
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id={id} className="sf-input" name="coupon" autoComplete="off" autoCapitalize="characters" maxLength={20} value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="e.g. WELCOME10" style={{ flex: 1, textTransform: "uppercase" }} />
          <button type="submit" className="sf-btn" disabled={!draft.trim() || loading}>Apply</button>
        </div>
      </form>
      {couponCode && result && !result.ok && (
        <div style={{ marginTop: 10 }}>
          <Alert tone="warn" role="status">
            <b>{couponCode}</b>: {result.message}{" "}
            <button type="button" className="sf-link" onClick={() => setCouponCode(null)}>Remove</button>
          </Alert>
        </div>
      )}
    </section>
  );
}

/** Checkout: a friend's code and an explicit, unticked yes to offers. Both need a phone number (that is who they belong to). */
export function ReferralAndOffers({ phoneGiven, referral, onReferral, optIn, onOptIn }: { phoneGiven: boolean; referral: string; onReferral: (v: string) => void; optIn: boolean; onOptIn: (v: boolean) => void }) {
  const refId = useId();
  return (
    <>
      <label className="sf-field" htmlFor={refId}>
        <span className="sf-label">Friend&apos;s referral code <small>Optional</small></span>
        <input id={refId} className="sf-input" name="referral" autoComplete="off" autoCapitalize="characters" maxLength={20} value={referral} onChange={(e) => onReferral(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="e.g. RF7K2M9Q" disabled={!phoneGiven} style={{ textTransform: "uppercase" }} />
        <p className="sf-hint">{phoneGiven ? "Your friend and you both earn points after your first paid order." : "Add your phone number above to use a referral code."}</p>
      </label>
      <label className="sf-check" style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 10 }}>
        <input type="checkbox" name="offers" checked={optIn} onChange={(e) => onOptIn(e.target.checked)} disabled={!phoneGiven} style={{ marginTop: 3 }} />
        <span>
          <b>Send me offers</b> on WhatsApp and SMS
          <small className="sf-hint" style={{ display: "block" }}>{phoneGiven ? "Optional. A few a month at most; every message has a one-tap unsubscribe. Your order updates are separate." : "Needs your phone number."}</small>
        </span>
      </label>
    </>
  );
}

export type RateResult = { thanks: true; routedTo: "GOOGLE" | "PRIVATE" | null; reviewUrl: string | null; alreadyAnswered: boolean };

/**
 * One rating, from the order page (the order's key) or from the link we sent (its token): stars and an optional
 * comment. Happy guests are offered the café's public review page; unhappy ones are told the team will follow up.
 */
export function RatingForm({ url, headers, onSent, heading = "How was it?" }: { url: string; headers?: Record<string, string>; onSent?: (r: RateResult) => void; heading?: string }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RateResult | null>(null);
  const legend = useId();
  if (result) {
    const low = result.routedTo === "PRIVATE";
    return (
      <section className="sf-card" aria-label="Thank you" role="status">
        <h2 className="sf-card-title">Thank you!</h2>
        <p style={{ marginTop: 6 }}>{result.alreadyAnswered ? "We already have your answer for this visit." : low ? "We're sorry it wasn't right. The team has your message and will follow up." : "We're glad you enjoyed it."}</p>
        {result.reviewUrl && (
          <p style={{ marginTop: 10 }}>
            <a className="sf-btn sf-btn-accent" href={result.reviewUrl} target="_blank" rel="noopener noreferrer">Share it on the review page</a>
          </p>
        )}
      </section>
    );
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await request<RateResult>(url, { method: "POST", headers, body: { rating, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
      setResult(r);
      onSent?.(r);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="sf-card" aria-labelledby={legend}>
      <form onSubmit={submit}>
        <h2 id={legend} className="sf-card-title">{heading}</h2>
        <div role="radiogroup" aria-labelledby={legend} className="sf-stars" style={{ display: "flex", gap: 6, marginTop: 8 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} ${n === 1 ? "star" : "stars"}`} onClick={() => setRating(n)}
              style={{ fontSize: 32, lineHeight: 1, background: "none", border: 0, padding: 4, cursor: "pointer", color: n <= rating ? "var(--sf-accent)" : "var(--sf-line)" }}>★</button>
          ))}
        </div>
        {rating > 0 && (
          <label className="sf-field">
            <span className="sf-label">{rating <= 3 ? "What went wrong?" : "Anything you'd like to add?"} <small>Optional</small></span>
            <textarea className="sf-textarea" name="comment" rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        )}
        {error && <div style={{ marginTop: 10 }}><Alert tone="bad" role="alert">{error}</Alert></div>}
        <button type="submit" className="sf-btn sf-btn-primary" style={{ marginTop: 12 }} disabled={!rating || busy}>{busy ? <Spinner /> : null} Send</button>
      </form>
    </section>
  );
}

/** After payment, on the order page. Hidden once this device has rated the order (the server keeps one answer per order anyway). */
export function RateTheMeal({ orderId, orderKey }: { orderId: string; orderKey: string }) {
  const [rated] = useState(() => wasRated(orderId));
  if (rated) return null;
  return <RatingForm url={`/api/qr/orders/${encodeURIComponent(orderId)}/feedback`} headers={{ "x-order-key": orderKey }} onSent={() => markRated(orderId)} />;
}
