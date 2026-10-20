"use client";

import { useEffect, useRef, useState } from "react";
import { qrSvgPath } from "@/lib/qrSvg";
import { formatMoney } from "@/lib/format";
import { Spinner } from "@/features/guest/components/Bits";

/** A bank's transaction-specific UPI QR, as the server returned it (public data only). */
export type UpiQrCheckout = {
  paymentId: string;
  amount: string;
  mode?: string;
  qr: string;
  intentUri?: string;
  expiresAt: string;
  share?: { parts: number; remainingParts: number; last: boolean };
};

/** Server checkout data → a UPI QR checkout, or null when it is something else (e.g. the simulated gateway). */
export function upiQrCheckout(started: { paymentId: string; amount: string; mode?: string; checkout?: Record<string, string | number>; share?: UpiQrCheckout["share"] }): UpiQrCheckout | null {
  const c = started.checkout;
  if (!c || c.kind !== "upi_qr" || typeof c.qr !== "string" || !c.qr || typeof c.expiresAt !== "string") return null;
  return { paymentId: started.paymentId, amount: started.amount, mode: started.mode, qr: c.qr, intentUri: typeof c.intentUri === "string" && c.intentUri ? c.intentUri : undefined, expiresAt: c.expiresAt, share: started.share };
}

const POLL_MS = 4000;
const isPhone = () => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function remaining(expiresAt: string, now: number) {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

/**
 * The QR the guest scans with any UPI app — on this phone or another one. The
 * page never decides that the payment went through: while the QR is shown it
 * asks RESTORA's server every few seconds (`onCheck`), the server asks the
 * bank, and only the server's verified answer ends this panel (the parent
 * unmounts it). When the QR expires the server is asked once more; the guest
 * can then ask for a new QR.
 */
export function UpiQrPayment({ checkout, onCheck, onRenew, busy }: { checkout: UpiQrCheckout; onCheck: () => Promise<unknown>; onRenew: () => void; busy: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  // The latest callback, without restarting the polling timer whenever the parent re-renders.
  const checkRef = useRef(onCheck);
  checkRef.current = onCheck;
  const left = remaining(checkout.expiresAt, now);
  const expired = left === 0;
  const test = checkout.mode === "MOCK";
  const sandbox = checkout.mode === "SANDBOX";

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Ask the server (which asks the bank) while the QR is valid, and once more right after it expires.
  useEffect(() => {
    let finalCheckDone = false;
    const check = async () => {
      if (inFlight.current) return;
      const over = remaining(checkout.expiresAt, Date.now()) === 0;
      if (over && finalCheckDone) return;
      if (over) finalCheckDone = true;
      inFlight.current = true;
      setChecking(true);
      try {
        await checkRef.current();
      } catch {
        /* a lost answer changes nothing: the next check asks again */
      } finally {
        inFlight.current = false;
        setChecking(false);
      }
    };
    const t = window.setInterval(() => void check(), POLL_MS);
    return () => window.clearInterval(t);
  }, [checkout.paymentId, checkout.expiresAt]);

  const { size, d } = qrSvgPath(checkout.qr);
  const mm = String(Math.floor(left / 60));
  const ss = String(left % 60).padStart(2, "0");

  return (
    <div role="region" aria-label="Pay by UPI" data-testid="upi-qr" style={{ border: "2px solid var(--sf-accent)", borderRadius: 14, padding: 14, textAlign: "center" }}>
      <p style={{ margin: 0, fontWeight: 700 }}>{test ? "Test UPI QR (emulator)" : sandbox ? "Bank test QR" : "Scan to pay by UPI"}</p>
      {checkout.share && <p className="sf-hint" data-testid="share-note" style={{ margin: "4px 0 0" }}>{checkout.share.last ? "Your part: everything that is left on the bill" : `Your part of the bill, split ${checkout.share.parts} ways`}</p>}
      <p style={{ margin: "4px 0 8px", fontSize: 26, fontWeight: 800 }} className="sf-num" data-testid="upi-amount">{formatMoney(checkout.amount)}</p>
      {expired ? (
        <div data-testid="upi-expired">
          <p className="sf-alert sf-alert-info" style={{ margin: "0 0 10px" }}>
            This QR has expired. If money left your account, this page will still show it once the bank confirms. Otherwise, get a new QR.
          </p>
          <button type="button" className="sf-btn sf-btn-primary sf-btn-block" disabled={busy || checking} onClick={onRenew}>
            {busy || checking ? <Spinner /> : null} Get a new QR
          </button>
        </div>
      ) : (
        <>
          <svg role="img" aria-label={`UPI QR code for ${formatMoney(checkout.amount)}`} viewBox={`0 0 ${size} ${size}`} width={232} height={232} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 8, maxWidth: "100%" }}>
            <rect width={size} height={size} fill="#fff" />
            <path d={d} fill="#000" />
          </svg>
          <p className="sf-hint" style={{ margin: "8px 0 0" }}>
            Scan with any UPI app — from this phone or another one. Keep this page open: it updates by itself once the bank confirms the payment.
          </p>
          {checkout.intentUri && isPhone() && !test && (
            <a className="sf-btn sf-btn-block" style={{ marginTop: 10 }} href={checkout.intentUri} data-testid="upi-intent">
              Open a UPI app on this phone
            </a>
          )}
          <p className="sf-stage-caption" style={{ marginTop: 10 }} role="status" aria-live="polite" data-testid="upi-waiting">
            <Spinner /> Waiting for the bank to confirm · QR valid for {mm}:{ss}
          </p>
        </>
      )}
      {test && <p className="sf-hint" style={{ margin: "8px 0 0" }}>Emulator test QR — no real money; no UPI app can pay it.</p>}
      {sandbox && <p className="sf-hint" style={{ margin: "8px 0 0" }}>Bank test environment — no real money is collected.</p>}
    </div>
  );
}
