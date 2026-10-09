"use client";

/**
 * Public pages reached from a link in a message: the feedback link (/f/<token>), the one-click unsubscribe link
 * (/u/<token>) and a friend's invite (/r/<code>). The token in the link is the only credential; opening a link
 * never changes anything by itself (scanners and previews fetch links), the guest confirms with a button.
 */
import { useEffect, useState, type ReactNode } from "react";
import { request, describeError } from "@/lib/api/client";
import { saveReferral } from "@/features/guest/session";
import { Alert, Spinner } from "@/features/guest/components/Bits";
import { RatingForm } from "@/features/guest/components/GuestOffers";
import { SfIcon, type SfIconName } from "@/features/guest/components/SfIcon";

function Notice({ icon, title, children }: { icon: SfIconName; title: string; children?: ReactNode }) {
  return (
    <div className="sf" data-theme="classic">
      <main className="sf-notice">
        <div className="sf-notice-card">
          <div className="sf-notice-ico"><SfIcon name={icon} /></div>
          <h1>{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export function FeedbackLinkScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<{ restaurant: string; answered: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<{ restaurant: string; answered: boolean }>(`/api/qr/feedback/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(describeError(e)));
  }, [token]);
  if (error) return <Notice icon="alert" title="This link doesn't work"><p>{error}</p></Notice>;
  if (!info) return <Notice icon="receipt" title="One moment…"><p role="status"><Spinner /> Loading</p></Notice>;
  if (info.answered) return <Notice icon="check" title="Thank you"><p>We already have your answer for this visit to {info.restaurant}.</p></Notice>;
  return (
    <div className="sf" data-theme="classic">
      <main className="sf-wrap" style={{ paddingTop: 28, paddingBottom: 32 }}>
        <h1 className="sf-page-title" style={{ marginBottom: 12 }}>How was your visit to {info.restaurant}?</h1>
        <RatingForm url={`/api/qr/feedback/${encodeURIComponent(token)}`} heading="Your rating" />
      </main>
    </div>
  );
}

export function UnsubscribeScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<{ restaurant: string; channel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"ask" | "busy" | "done">("ask");
  useEffect(() => {
    request<{ restaurant: string; channel: string }>(`/api/qr/unsubscribe/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(describeError(e)));
  }, [token]);
  const channel = info?.channel === "WHATSAPP" ? "WhatsApp" : info?.channel === "EMAIL" ? "e-mail" : "SMS";
  async function confirm() {
    setState("busy");
    setError(null);
    try {
      await request(`/api/qr/unsubscribe/${encodeURIComponent(token)}`, { method: "POST", body: {} });
      setState("done");
    } catch (e) {
      setError(describeError(e));
      setState("ask");
    }
  }
  if (error && !info) return <Notice icon="alert" title="This link doesn't work"><p>{error}</p></Notice>;
  if (!info) return <Notice icon="receipt" title="One moment…"><p role="status"><Spinner /> Loading</p></Notice>;
  if (state === "done") return <Notice icon="check" title="You're unsubscribed"><p>{info.restaurant} will no longer send you offers by {channel}. Messages about your own orders and bookings are not affected.</p></Notice>;
  return (
    <Notice icon="bell" title={`Stop offers from ${info.restaurant}?`}>
      <p>You will no longer receive offers and promotions by {channel}. Messages about your own orders and bookings continue.</p>
      {error && <div style={{ marginTop: 10 }}><Alert tone="bad" role="alert">{error}</Alert></div>}
      <button type="button" className="sf-btn sf-btn-primary sf-btn-lg" style={{ marginTop: 16 }} onClick={() => void confirm()} disabled={state === "busy"}>
        {state === "busy" ? <Spinner /> : null} Unsubscribe from {channel} offers
      </button>
    </Notice>
  );
}

/** A friend's invite: keep the code on this device so the checkout fills it in when the guest scans a table's QR code. */
export function ReferralLandingScreen({ code }: { code: string }) {
  const valid = /^[A-Za-z0-9]{4,20}$/.test(code);
  useEffect(() => {
    if (valid) saveReferral(code);
  }, [code, valid]);
  if (!valid) return <Notice icon="alert" title="This invite link doesn't work"><p>Ask your friend to share their code again.</p></Notice>;
  return (
    <Notice icon="smile" title="A friend invited you">
      <p>Scan the QR code on your table at the restaurant, order, and enter this code at checkout. You and your friend both earn points after your first paid order.</p>
      <p className="sf-num" style={{ fontSize: 28, fontWeight: 800, letterSpacing: "0.08em", marginTop: 14 }} data-testid="invite-code">{code.toUpperCase()}</p>
      <p className="sf-hint">We&apos;ve saved it on this phone, so checkout fills it in for you.</p>
    </Notice>
  );
}
