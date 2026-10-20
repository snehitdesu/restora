# Razorpay online payments — LEGACY ONLY

> **Retired for new checkouts on 2026-10-20** (owner decision: direct SBI UPI
> collection replaces it — `docs/sbi-upi-integration.md`,
> `docs/payment-safety.md`). Everything below the line describes how Razorpay
> payments made *before* that date are still resolved; nothing creates a new
> Razorpay payment any more.

## Legacy-only status

| | |
| --- | --- |
| New Razorpay checkout | **Disabled.** `getCheckoutProvider()` refuses `razorpay`; the adapter has no `createCheckout` / `resumeCheckout`; `PAYMENT_PROVIDER=razorpay` boots with a warning and online payment shows *unavailable*. Razorpay is never a fallback. |
| Browser checkout | **Removed:** `src/features/guest/razorpay.ts` (checkout.js loader), the Razorpay branch of the guest order page, the CSP / Permissions-Policy / COOP exceptions for `/o/*`. |
| Retained (server-side only) | `RazorpayPaymentProvider.verify` / `getPaymentStatus` (guest status check, recovery job, webhooks), `POST /api/webhooks/payment/razorpay` + `x-razorpay-signature`, `refund`, `getSettlements` (reconciliation), the `RAZORPAY_*` env validation (all three required when any key is set), the tenant binding (`IntegrationConnection` provider `razorpay`). Historical `Payment` / `Refund` / `WebhookEvent` rows are untouched. |
| Removed with the E2E conversion | `RAZORPAY_API_BASE` emulator hook, `tests/support/razorpayEmulator.ts`, `scripts/razorpay/sandbox-check.ts` (it created new Razorpay orders). |

### Three different states (only the first two are true today)

1. **New Razorpay checkout disabled — DONE (code, tests).** No code path creates
   a Razorpay order or loads checkout.js; `PAYMENT_PROVIDER=razorpay` gives
   "online payment unavailable", never a silent switch.
2. **Legacy Razorpay support retained — DONE, deliberately.** Server-side
   verify / status / signed webhook / refund / settlements stay so that any
   older Razorpay payment can still be settled, refunded and reconciled.
3. **Full Razorpay removal — NOT DONE and not yet safe.** It needs the
   read-only production counts below (unknown today) and the conditions in
   "When the residual code can be removed".

### Outstanding obligations — could not be checked here

The production database was not available to this work (read-only access was
not established), so it is **unknown** whether Razorpay payments are still
`PENDING` or may need refunds. Before removing the retained code, run on the
production database (read-only):

```sql
-- Undecided Razorpay payments (the recovery job keeps asking Razorpay for 26 h after creation).
SELECT count(*) FROM "Payment" WHERE provider = 'razorpay' AND status = 'PENDING';
-- Captured Razorpay money that may still be refunded (refund window is the merchant's policy / Razorpay's limit).
SELECT count(*), max("createdAt") FROM "Payment" WHERE provider = 'razorpay' AND status IN ('SUCCESS', 'PARTIAL');
-- Unresolved anomalies about Razorpay captures (refund at Razorpay, then resolve).
SELECT count(*) FROM "Anomaly" a JOIN "Payment" p ON p.id = a."entityId" WHERE a."entityType" = 'Payment' AND p.provider = 'razorpay' AND a.status IN ('OPEN', 'ACKNOWLEDGED');
-- Refunds recorded in RESTORA without a Razorpay refund id (not confirmed at Razorpay).
SELECT count(*) FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" WHERE p.provider = 'razorpay' AND r."providerRef" IS NULL;
-- Razorpay webhooks received but not processed (failed or never applied).
SELECT status, count(*) FROM "WebhookEvent" WHERE provider = 'razorpay' AND status IN ('RECEIVED', 'FAILED') GROUP BY status;
```

Run these only on a connection that is **read-only** (a read-only database
role or a read replica), never with the application's write credentials, and
copy out the counts only — no payment ids, references, amounts or payloads.
Status 2026-10-20: **BLOCKED** — no read-only Production connection exists for
this work (the Production database connection itself is not on record).

### When the residual code can be removed

All of: the first and third queries return 0; the newest Razorpay `SUCCESS` /
`PARTIAL` payment is older than the refund window the owner accepts (Razorpay
allows refunds of a payment for a limited period — confirm the current limit in
the Razorpay dashboard); the Razorpay dashboard's settlements reconcile with
RESTORA for the last period; and the Razorpay webhook has been disabled in the
Razorpay dashboard. Then delete `RazorpayPaymentProvider`, `razorpay` from
`GATEWAY_PROVIDERS` / `LEGACY_PROVIDERS` / the webhook resolver / the env
validation / `PAYMENT_PROVIDER_NAMES`, the `RAZORPAY_*` variables, and
`tests/integrations/razorpay.test.ts` + the legacy section of
`tests/domain/integrations-p7.test.ts`. Keep historical rows (provider
`razorpay`) — they are the audit trail; reports read them as data.

---

*The rest of this page is the original description, kept for resolving legacy payments.*

How guests paid online from the table QR, how RESTORA decides a payment is real,
and what an operator must configure. Cash, card-terminal and UPI-at-the-till
payments are counter payments (staff attest them with `payment.take`); this page
is about the gateway.

## Flow

```
guest order (server-priced) ─► POST /api/qr/orders/:id/payments
    └─ Payment PENDING for the server's outstanding balance
    └─ Razorpay order (POST /v1/orders) for exactly that amount in paise
         ─► browser: Razorpay Checkout (checkout.js, guest order page only)
              ├─ success → handler(razorpay_payment_id, razorpay_order_id, razorpay_signature)
              │     ─► POST …/payments/confirm ─► verifyPayment:
              │          signature = HMAC-SHA256(key_secret, order_id|payment_id)
              │          GET /v1/payments/:id → belongs to OUR Razorpay order, amount, status captured
              ├─ declined attempt → shown in the window; the guest may retry in the same window
              └─ window closed → confirm without a response = status check (GET /v1/orders/:id)
    Razorpay webhooks ─► POST /api/webhooks/payment/razorpay (X-Razorpay-Signature over the raw body)
          tenant = IntegrationConnection(PAYMENT, razorpay, account_id) ─► same verifyPayment
SUCCESS ─► order PAID ─► (prepaid QR order) KOT ─► tax invoice ─► stock consumption ─► loyalty
```

The browser's word is never enough: every SUCCESS comes from `verifyPayment`,
which asks Razorpay.

## States

| Gateway says | Payment | Notes |
|---|---|---|
| order `created` / `attempted`, payment `created` / `authorized` | stays **PENDING** | Undecided: never failed, no alert. The guest's status check, signed webhooks and the recovery job re-ask Razorpay (there is no **Resume payment** any more: checkout was retired). |
| captured, amount and order match | **SUCCESS** → order PAID | Exactly once: invoice number, KOT, stock, loyalty are idempotent. |
| `payment.failed` webhook / failed payment | **FAILED** | Cashier alert. A later capture (retry inside the same window, late UPI) **recovers** it to SUCCESS after Razorpay confirms the capture. |
| captured, but the order was meanwhile paid another way / cancelled | **FAILED** + HIGH `RECONCILIATION_MISMATCH` anomaly "Refund the guest at the gateway" | Money is never applied twice; the webhook is acknowledged (no endless redelivery). |
| signature invalid / amount or currency mismatch / payment of another order | refused | Nothing changes. A client-supplied reference cannot redirect verification to another Razorpay order. |
| capture event Razorpay's API does not show yet | webhook answered 503 | Razorpay redelivers. |

## Configuration

| Variable | Value |
|---|---|
| `PAYMENT_PROVIDER` | not `razorpay` any more: new checkouts use `sbi_upi` (unavailable until SBI is live). `razorpay` still boots, with a warning, and online payment shows *unavailable* |
| `RAZORPAY_KEY_ID` | `rzp_test_…` (test mode, no real money) or `rzp_live_…` |
| `RAZORPAY_KEY_SECRET` | the key secret (server only; never sent to the browser) |
| `RAZORPAY_WEBHOOK_SECRET` | the secret you set on the webhook in the Razorpay dashboard |
| `PUBLIC_BASE_URL` | the public https address (webhook URL, printed table QR codes) |

Production startup refuses a partial Razorpay configuration: once
`RAZORPAY_KEY_ID` or `RAZORPAY_KEY_SECRET` is set, all three `RAZORPAY_*` values
must be present and the key id must be a Razorpay key. Test keys under
`NODE_ENV=production` are logged as a warning at every boot (staging only).
`RAZORPAY_API_BASE` (the old test-emulator hook) is no longer read: the adapter
always talks to `api.razorpay.com`.

### Razorpay dashboard

1. **Settings → API keys**: generate test (later live) keys.
2. **Settings → Webhooks → Add**: URL `https://<PUBLIC_BASE_URL>/api/webhooks/payment/razorpay`,
   secret = `RAZORPAY_WEBHOOK_SECRET`, events **payment.captured**, **payment.failed**,
   **refund.processed**.
3. **Payment capture**: automatic capture on (RESTORA treats `authorized` as pending
   until captured).
4. Note your **account id** (`acc_…`, Settings → Account): in RESTORA open
   **Settings → Integrations** and connect *Payment · razorpay* with that account id
   for the outlet. Webhooks are bound to the restaurant ONLY through this id; an
   unbound account's webhooks are refused (503, retried) and nothing changes.

### Content-Security-Policy

Razorpay's hosts (`checkout.razorpay.com`, `api.razorpay.com`,
`lumberjack.razorpay.com`, `cdn.razorpay.com`) are allowed **only on the guest order
pages** (`/o/*`), which also use `Cross-Origin-Opener-Policy: same-origin-allow-popups`
for bank / UPI popups. Every other page keeps the strict same-origin policy
(`src/server/config/securityHeaders.mjs`, `tests/config/security-headers.test.ts`).

## Modes

| Mode | When | Shown to the guest |
|---|---|---|
| MOCK | `PAYMENT_PROVIDER=mock` (development), or Razorpay pointed at the test emulator | "Test payment gateway" / "Simulated payment gateway" |
| SANDBOX | `rzp_test_` key | "Razorpay test mode: no real money is charged" |
| LIVE | `rzp_live_` key | nothing extra |

Mock providers are refused in production unless `ALLOW_MOCK_PROVIDERS=true`
(non-public test deployments only).

## Verification

| What | How | Status |
|---|---|---|
| Adapter contract for the retained legacy paths (signatures, status, refunds, settlements, no secret leakage) | `tests/integrations/razorpay.test.ts` (recorded Razorpay response shapes) | automated |
| `PAYMENT_PROVIDER=razorpay` creates nothing; legacy webhook / verify still settle an older payment | `tests/domain/integrations-p7.test.ts` | automated |
| Browser and acceptance runs | `npm run e2e:investor`, `npm run e2e:acceptance`: now exercise the direct-bank UPI emulator, **not** Razorpay | automated (UPI only) |
| Against Razorpay's real test mode | No longer applicable: `scripts/razorpay/sandbox-check.ts` and `tests/domain/coders-cafe-razorpay.test.ts` were removed because they create new Razorpay orders | n/a |

The legacy paths that still matter in Production (webhook redelivery, refund of an
older payment, settlement reconciliation) can only be proven against real data
through the read-only audit in "Outstanding obligations" above.
