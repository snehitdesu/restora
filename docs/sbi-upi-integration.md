# Direct SBI UPI integration — onboarding, acceptance and activation

This is the **authoritative** document for the SBI integration: what SBI
publishes (§1), the request to send SBI (§2), the acceptance matrix (§3), the
configuration names (§4), the UAT scenarios (§5), the dependency-ordered
implementation and Production activation plan (§6), and where each piece of work
stands (§7). Other documents link here instead of repeating it.

Status (2026-10-20): **BLOCKED on SBI.** RESTORA's side of a direct-bank UPI
checkout is built (provider boundary, dynamic-QR checkout screen, server-side
status polling, callback route, recovery worker, kitchen gate). The real SBI
adapter (`sbi_upi`, `src/integrations/payment/sbiUpi.ts`) is **deliberately
unavailable**: every call refuses with "awaiting SBI API specification" and its
health check is false. Guest QR ordering therefore reports *online payment
unavailable* until it is implemented against SBI's own documentation and
verified in SBI UAT.

Nothing in this repository has talked to SBI. No SBI endpoint, payload, header,
signing scheme, certificate, response code or QR string has been assumed.

## 1. What SBI publishes (checked 2026-10-20)

Pages read (all loaded): the Transaction Banking Unit page
(`sbi.bank.in/web/business/information/transaction-banking-unit`), the UPI FAQ
(`sbi.bank.in/web/customer-care/upi1`), SBIePay
(`sbi.bank.in/web/business/sme/digital-collection-products/sbiepay`), the
Digital Collection Products index, SB Collect, SBI Unipay, Merchant Acquiring
and BHIM SBI Pay.

| Capability RESTORA needs | Public SBI material |
| --- | --- |
| Transaction-specific dynamic UPI QR / UPI intent via API | **Not stated.** Only merchant QR (BHIM SBI Pay "I am a Merchant", YONO SBI Merchant BQR) is described. |
| Merchant-generated unique transaction reference | **Not stated.** |
| Authenticated payment callback / webhook | **Not stated.** Merchant app "real-time payment confirmations" and voice alerts are app/device notifications, not server callbacks. |
| Server-to-server transaction-status API | **Not stated.** |
| Final status semantics (success / pending / failed / expired) | **Not stated.** |
| Bank reference (RRN / UTR) in API responses | **Not stated.** |
| Refund API / process for merchant UPI collections | **Not stated** (only the customer-side auto-reversal of failed transactions, T+2 dispute). |
| Reconciliation | MIS reports are mentioned (Transaction Banking "customised MIS on daily & monthly basis"; merchant QR daily statement). Format not published. |
| UAT / sandbox | **Not stated.** |
| API specification, authentication, encryption | **Not published.** The Transaction Banking page mentions, in general terms, ERP integration and "API based system", host-to-host and SFTP — not tied to UPI collection. |
| Onboarding | Merchant QR: an SB/CC/CA account holder applies at the home branch. Transaction Banking: through SBI's corporate / relationship channel. SBIePay: merchant onboarding contact on its page. |

Re-checked later on 2026-10-20 (independent read of the three pages above plus
SBI's Merchant Acquiring Business page): still no developer, API, UAT, sandbox,
webhook or callback documentation on any of them. The only further lead is the
Merchant Acquiring page's link to `www.sbipayments.com` (not read: off the
`sbi.bank.in` site). SBIePay's page lists merchant-onboarding and technical-support
contacts; using them means considering SBIePay, which needs the owner's approval.

Third read (final closeout, 2026-10-20, the three official pages only; all loaded,
body text read through a summarizer, so treat these points as leads, not quotes):
the Transaction Banking Unit page describes **"E-Pay"** collection "using UPI
channels" and **E-Collection** into Virtual Account Numbers that also accepts UPI,
plus an "API based system" and ERP integration, a dedicated client-support team
and an escalation matrix. It still names no API document, callback, status or
refund API, or UAT. The UPI page is consumer-only (in-app statuses Pending /
Success / Failed / Reject / Expired; failed debits auto-reversed). SBIePay lists
merchant-onboarding and technical-support contacts (on its page; not copied here
because using them means considering SBIePay, which needs the owner's approval).
Conclusion unchanged: no public specification exists to build an adapter from.

Fourth read (resume closeout, 2026-10-20, same three pages, all HTTP 200): no
change. UPI page FAQ 11 sends merchants to their nearest branch for an SBI UPI QR
and the BHIM SBI Pay "Business" tab; "Intent Collect" appears only as a consumer
FAQ topic. No dynamic-QR, intent, status, callback, refund, RRN/UTR report or UAT
documentation is published or linked.

### Products and why none is assumed to be the answer

- **BHIM SBI Pay merchant QR / YONO SBI Merchant (BQR), soundbox, SMS:** static
  merchant QR plus notifications to the merchant. A static QR has no per-order
  amount or reference, and a notification is not a server-to-server proof. They
  **must not** be used as RESTORA's verification. A customer's screenshot or "I
  paid" button is not proof either.
- **SBIePay:** SBI's payment *aggregator / gateway* (cards, net banking, UPI). It
  may well offer exactly the APIs needed, but it is an intermediary gateway, not
  the direct-bank integration the owner asked for. **Not to be substituted
  without the owner's explicit approval.**
- **Transaction Banking Unit (Cash Management / corporate collections, Virtual
  Account Numbers, "customised API-based solutions"):** the most likely home of a
  direct UPI collection API for a merchant. Its API is not public; it has to be
  requested.
- **SB Collect, SBI Unipay (BBPS):** fee / bill collection portals for
  institutions and billers. Not a per-order restaurant checkout.

## 2. What to ask SBI for (ready to send)

Send through the owner's SBI branch / relationship manager to the Transaction
Banking Unit (and, only if the owner approves considering it, the SBIePay
merchant onboarding desk). Never send credentials by e-mail or chat, and never
paste them into a terminal transcript. Every point below is a **question**:
none of these capabilities is assumed to exist until SBI confirms it in writing.

> Subject: API-based dynamic UPI QR collection for our restaurant — technical
> documentation and UAT request
>
> We hold a current account with SBI (account / CIF: ______, branch: ______). Our
> restaurant (______, GSTIN: ______) uses its own ordering software (RESTORA).
> For each table order we want to collect the exact bill amount by UPI directly
> into this account, and our server must be able to confirm each payment before
> the kitchen starts cooking. Please tell us which SBI product provides this and
> share:
>
> 1. **Product and eligibility:** the SBI product name for API-based UPI
>    collection by a merchant (dynamic QR and/or UPI intent), and whether a
>    restaurant current account at our branch is eligible (merchant category,
>    KYC, turnover or other conditions).
> 2. **Merchant onboarding:** the forms and documents required, who must sign
>    them, the expected timeline, which identifiers are issued (merchant ID,
>    terminal ID, sub-merchant ID, VPA), and the settlement account and timing.
> 3. **Dynamic QR / UPI intent:** endpoints, request and response formats and
>    error codes for (a) creating a transaction-specific dynamic QR or UPI
>    intent for a fixed amount carrying our unique transaction reference, (b)
>    the format of what is returned (QR string, intent URI, or parameters we
>    must assemble ourselves), (c) its validity / expiry and whether we can set
>    it, and (d) cancelling it, if supported.
> 4. **Amount locking:** confirmation that the payer's UPI app cannot change the
>    amount; what happens if a different amount is paid against our reference;
>    minimum and maximum amounts; INR only.
> 5. **API authentication and security:** how our API calls are authenticated
>    (API keys, OAuth, client certificate / mutual TLS, IP whitelisting, static
>    source IPs required from us), message encryption and signing algorithms,
>    key exchange, and certificate validity and rotation.
> 6. **Transaction-status inquiry:** an API to query a transaction by our
>    reference: request format, the complete list of status values and which
>    are final (success, failure, expired, pending / deemed), recommended polling
>    frequency and rate limits, and how long after creation a transaction can
>    still change state.
> 7. **Callback / notification:** whether SBI sends a server-to-server payment
>    notification, whether delivery is guaranteed or best effort, its payload,
>    how it is signed or encrypted, the response we must return, retry schedule,
>    replay protection, source IP ranges, and how the callback URL is registered
>    for UAT and for production.
> 8. **Idempotency and duplicates:** what happens if we send the same create
>    request (same reference) twice, whether one reference can ever be paid
>    twice, the uniqueness rules, maximum length and allowed characters of our
>    reference, and how duplicate notifications are identified.
> 9. **Timeouts and uncertain outcomes:** recommended timeouts for each API, how
>    to resolve a create or status call that timed out, what a pending / deemed
>    status means and when it becomes final, and planned maintenance or
>    downtime notices.
> 10. **Late payments:** whether a payer can still complete a payment after the
>     QR or intent has expired, and if so whether it is credited, rejected or
>     auto-reversed, and how we are told.
> 11. **References:** which fields carry our transaction reference, the bank
>     reference number (RRN / UTR), payer VPA (if shared), amount and currency in
>     the callback and status responses.
> 12. **Refunds:** whether refunds of UPI collections can be initiated by API (and
>     its specification, including refund status inquiry) or only through a
>     branch / portal process; partial refunds; refunds after settlement; and
>     timelines.
> 13. **Reconciliation:** the MIS / settlement report format (per-transaction
>     fields, including our reference and the RRN / UTR, fees and settlement
>     batch), how it is delivered (portal, SFTP, e-mail, API) and its schedule.
> 14. **Fees and charges:** per-transaction charges for UPI collection under this
>     product, any set-up, annual or API charges, GST on charges, and how charges
>     appear in settlement.
> 15. **UAT:** access to the UAT environment, UAT credentials and certificates
>     (issued through SBI's secure channel), test VPAs / test apps, and the test
>     scenarios SBI requires before production sign-off.
> 16. **Certification and production sign-off:** any security review, audit or
>     certification our software or hosting must pass and who performs it, the
>     documents required, and SBI's go-live checklist.
> 17. **Support:** the technical contact for integration, production support
>     hours, the escalation matrix, and how SBI notifies merchants of incidents.
> 18. **Fit of your existing products:** whether *E-Pay* (UPI channels) or
>     *E-Collection* with a Virtual Account Number can issue a per-order dynamic
>     QR or intent and give us a server-side status / callback per transaction, or
>     whether a different product is required.
>
> Please send credentials and certificates only through SBI's official secure
> channel, not by e-mail. We are happy to meet your integration team and to
> complete the UAT test cases you prescribe before going live.
>
> Regards,
> ______ (owner name), ______ (restaurant legal name)
> Phone: ______  E-mail: ______

*Not sent by RESTORA. The owner sends it, from their own address, after filling
in the blanks.*

### Minimum SBI must provide before the `sbi_upi` adapter can be written

1. The product name and written confirmation that it gives a per-transaction
   dynamic QR / intent for a fixed amount with our own reference.
2. The API specification for create, status inquiry and (if any) callback,
   including every status value and which ones are final.
3. The authentication / encryption / signing scheme and the UAT credentials and
   certificates (through SBI's secure channel).
4. The merchant identifiers that appear in responses (merchant ID / terminal /
   VPA) and where the RRN / UTR is returned.
5. UAT access and the callback URL registration process.

Refund API, MIS format, fees and certification requirements are needed before
production, but not to start the adapter.

## 3. How SBI's answers map onto RESTORA

The adapter goes in `src/integrations/payment/sbiUpi.ts` and implements the
existing `PaymentProvider` interface (`src/integrations/payment/types.ts`).

| SBI capability | RESTORA method | Rule RESTORA already enforces |
| --- | --- | --- |
| Dynamic QR / intent creation | `createCheckout` → `{ providerRef, checkout: { kind: "upi_qr", qr, intentUri?, expiresAt } }` | Amount is the server's `Payment.amount`; reference is unique per payment; the public checkout data is stored on the payment so a refresh shows the same QR. |
| Status inquiry | `getPaymentStatus`, `verify` | Only a final success, for our reference, merchant, exact amount and INR, verifies; pending / unknown / timeout leaves the payment PENDING. |
| Callback | `verifyWebhook`, `accountRef`, `parseWebhookEvent` behind `POST /api/webhooks/payment/sbi_upi` | Signature checked per tenant binding; the event only triggers `verifyPayment`, which asks SBI's status API itself; duplicates are idempotent. |
| Refund | `refund` | Stable idempotency key; refund id unique per tenant. |
| MIS / settlement report | `getSettlements` | Gateway reconciliation (`services/reconciliation.ts`). |
| Health | `healthCheck` | Guest ordering is refused while it is false. |

**Do not enable `sbi_upi` until** the adapter verifies the merchant identity,
our transaction reference, the exact amount, INR and SBI's *final* success
status, has contract tests against SBI's documented responses, and has passed
SBI UAT (section 5).

### 3.1 Acceptance matrix

"Already in RESTORA" means implemented and tested against the local bank
emulator only; nothing in this table has been tested against SBI. Every row
needs its evidence before Production activation (§6, stage 7).

| # | Area | SBI must provide | RESTORA must implement | How it is tested | Evidence required before activation |
| --- | --- | --- | --- | --- | --- |
| 1 | Product, eligibility, onboarding | Written product confirmation; merchant approval; merchant / terminal / VPA identifiers; settlement account and timing | Nothing in code. Bind the merchant id in Settings → Integrations → Payment · sbi_upi | Document check by the owner | SBI's written confirmation; onboarding complete; identifiers configured (never committed) |
| 2 | Dynamic QR / intent | Create API, returned format, expiry rules | `createCheckout` from SBI's spec. Already in RESTORA: server amount, `RST<paymentId>` reference, stored checkout data | Contract tests from SBI's documented examples; UAT 1 | Contract tests green; UAT 1 recorded |
| 3 | Amount locking | Confirmation that the amount is fixed; behaviour on a different amount | Already in RESTORA: `decideUpiTxn` treats any amount other than the exact paise as a mismatch (never paid, HIGH anomaly) | Contract test with a mismatched amount; UAT 1, 12 | UAT record; SBI's written statement |
| 4 | Authentication and security | Scheme, algorithms, UAT and production credentials and certificates through a secure channel | Server-side credential loading only; credentials never in `checkout` data | Unit test that checkout data carries no secret; UAT handshake | Credentials stored as Sensitive variables; handshake recorded in UAT |
| 5 | Status inquiry | API, every status value, which are final, rate limits | `getPaymentStatus` / `verify` mapping SBI statuses through `decideUpiTxn` | Contract test per documented status; UAT 2, 3, 4, 6 | Every documented status covered by a test; UAT records |
| 6 | Callbacks | Payload, signing, retries, source IPs, registration process | `verifyWebhook`, `accountRef`, `parseWebhookEvent`. Already in RESTORA: callback only triggers `verifyPayment`; unbound merchants refused | Contract tests: valid, bad signature, replay, unbound merchant; UAT 5, 11, 13 | UAT records; callback URL registered |
| 7 | Idempotency and duplicates | Duplicate-create semantics; reference rules | Map our reference to SBI's rules. Already in RESTORA: one bank transaction per payment (stored checkout reused on refresh), idempotent apply | UAT 10, 11 | UAT records |
| 8 | Timeouts and uncertain outcomes | Recommended timeouts; pending / deemed semantics | Timeouts from SBI's guidance. Already in RESTORA: a timeout writes nothing (payment stays PENDING); recovery job re-asks | UAT 6; recovery scheduler proven on the UAT deployment | UAT 6 record; scheduler `200` log |
| 9 | Late payments | Behaviour after QR expiry | Already in RESTORA: fulfilment-window hold for staff (10 minutes is a **proposed default, not approved** — owner decision, `docs/payment-safety.md` §4) | UAT 7, 14 | Owner's written approval of the window; UAT records |
| 10 | Refunds | Refund API or documented manual process; refund status | `refund` from SBI's spec, or a documented manual procedure recorded in RESTORA | UAT 8 | UAT 8 record; staff procedure written |
| 11 | Reconciliation | MIS format and delivery | `getSettlements` or an import of SBI's report, depending on delivery | UAT 9 | One UAT day's MIS matched against RESTORA's payments |
| 12 | Fees | Fee schedule | Nothing in code | — | Owner's written acceptance of the charges |
| 13 | UAT and certification | UAT access, required test cases, security review / sign-off | Pass SBI's cases and §5 | §5 plus SBI's own cases | SBI's written UAT sign-off |
| 14 | Support | Contacts, hours, escalation matrix | Record them in the owner's operating notes (not in this repository) | — | Contacts on record before the pilot |
| 15 | Health | Health endpoint or availability guidance, if any | `healthCheck` reflecting real SBI availability | Contract test; UAT with SBI unreachable | Unreachable SBI shows "online payment unavailable" in UAT |
| 16 | Callback freshness (added 2026-10-22) | Whether callbacks carry a signed timestamp / nonce, and the allowed clock skew | If SBI signs a timestamp: refuse callbacks outside SBI's window **before** acting (in addition to the signature check and idempotent apply); never trust an unsigned timestamp. If SBI signs none: rely on the signature + status re-query (row 6), and record that SBI offers no freshness field | Contract tests: stale, future-dated, replayed-within-window; UAT 16 | SBI's written statement of the field and window; UAT 16 record |

## 4. Configuration names (no values in source control)

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PROVIDER=sbi_upi` | Selects SBI for new guest checkouts (currently: online payment unavailable). |
| `SBI_UPI_ENVIRONMENT` | `uat` or `production` (mode SANDBOX / LIVE). |
| `SBI_UPI_MERCHANT_ID`, `SBI_UPI_TERMINAL_ID`, `SBI_UPI_VPA` | Identifiers SBI issues (names provisional until SBI's spec confirms which exist). |
| `SBI_UPI_API_BASE` | SBI's UAT / production endpoint, from SBI's documentation. |
| Credentials, keys, certificates | Names to be fixed from SBI's spec. Stored only as Vercel **Sensitive** environment variables (or the host's secret store), never in the repository, desktop bundle or client code. |

`mock` and `upi_emulator` are test doubles for automated tests and a disposable
local demo only. They move no money, prove nothing about SBI, and are refused in
Production (`docs/payment-safety.md` §6).

## 5. UAT test scenarios (to run with SBI's UAT access)

Mark each result as *SBI UAT*, never as local emulator evidence. Scenarios 10–15
depend on what SBI's specification allows; record "not applicable per SBI spec"
rather than skipping silently.

1. QR created for the exact server amount; amount cannot be changed by the payer.
2. Successful payment → callback (if any) and status API agree; one payment,
   one invoice, one set of KOTs.
3. Payer abandons → stays pending, then expires; order never reaches the kitchen.
4. Payer's bank declines → definitive failure; guest can start a new QR.
5. Callback with a bad signature / replayed callback → refused / idempotent.
6. Status API timeout → payment stays pending; recovery settles it later.
7. Payment after the fulfilment window → money recorded, order held for staff.
8. Refund (API or SBI's documented process) and its reconciliation entry.
9. MIS report matches RESTORA's payments for the test day.
10. Page refreshed / checkout requested twice → the same QR, one SBI transaction.
11. The same successful callback delivered twice → applied once.
12. A different amount paid against our reference (if SBI's test tools allow it)
    → not paid, `RECONCILIATION_MISMATCH` anomaly.
13. Callback for a merchant not bound to the outlet → refused, nothing changes.
14. Payment attempted after the QR's own expiry → SBI's documented outcome;
    RESTORA records it as SBI reports it and never sends a late order to the
    kitchen automatically.
15. SBI unreachable → health check false, guest sees "online payment
    unavailable", staff ordering continues.
16. A correctly signed callback replayed after SBI's freshness window (if SBI
    signs a timestamp) → refused before any state change; within the window →
    applied once (scenario 11).

## 6. Implementation and Production activation plan (dependency order)

Each stage starts only when the stages it depends on are complete. Nothing in
stages 1–8 has been started; stage 0 decisions are open.

| Stage | Work | Depends on | Who |
| --- | --- | --- | --- |
| 0 | Owner decisions: approve sending §2; decide whether SBIePay may be considered; approve or change the 10-minute late-payment window; confirm the Vercel plan and the recovery scheduler choice (`docs/payment-safety.md` §3) | — | Owner |
| 1 | Send §2; SBI confirms the product; onboarding forms, KYC and fees agreed | 0 | Owner + SBI |
| 2 | SBI specification, security documents, UAT access and UAT credentials received through SBI's secure channel | 1 | SBI |
| 3 | Implement `sbiUpi.ts` from the specification (statuses through `decideUpiTxn`), contract tests from SBI's documented examples, `healthCheck`, then set `SBI_UPI_IMPLEMENTED`; code review; full local test suites | 2 | RESTORA developer (local only) |
| 4 | UAT deployment (non-Production, with its own database, never Production's): `SBI_UPI_ENVIRONMENT=uat`, UAT credentials as Sensitive variables, UAT callback URL registered, recovery scheduler running; run every §5 scenario and SBI's own cases; record results | 3 | Developer + owner + SBI |
| 5 | SBI UAT sign-off and any certification / security review | 4 | SBI (owner coordinates) |
| 6 | Production prerequisites, independent of SBI and startable any time after stage 0, all required before stage 7: Production `DATABASE_URL` confirmed and not shared with Preview; backup proven to restore; the nine pending migrations applied (`docs/payment-safety.md` §7); recovery scheduler configured and proven; table QR token audit, approved rotation and new cards (`docs/qr-token-rotation.md`); legacy Razorpay read-only audit (`docs/payments-razorpay.md`; keep `RAZORPAY_*` until it is clear); staff briefed on held orders and refunds | 0 | Owner, with controlled Production access |
| 7 | Production activation, in a closed window: production credentials as Sensitive variables (never printed); production callback URL (HTTPS, production domain only) registered with SBI; merchant id bound in Settings → Integrations; CSP / security headers updated only if SBI's spec requires it (none needed today: the QR is rendered by RESTORA); `PAYMENT_PROVIDER=sbi_upi`, `SBI_UPI_ENVIRONMENT=production`; deploy; `/api/health` ready; one small real payment by the owner, verified, then refunded and reconciled | 5, 6 | Owner + developer |
| 8 | One-outlet pilot for a week (`docs/payment-safety.md` §7): daily MIS reconciliation, anomaly review, scheduler `200`s; then normal operation | 7 | Owner + staff |

Activation checklist (stage 7 is complete only when every box is ticked, each
with its evidence from §3.1):

- [ ] Owner has SBI's written product confirmation, fees and onboarding complete.
- [ ] SBI API specification and security documents received through an official channel.
- [ ] `sbiUpi.ts` implemented from that specification, with contract tests from SBI's documented examples.
- [ ] All section 5 scenarios passed in SBI UAT and recorded; SBI's UAT sign-off received.
- [ ] Callback URL registered with SBI (production domain only, HTTPS).
- [ ] CSP / security headers updated for whatever SBI's spec requires (none needed today: the QR is rendered by RESTORA).
- [ ] Credentials set as Sensitive variables in Production only; never printed.
- [ ] External scheduler for payment recovery configured and proven (`docs/payment-safety.md` §3).
- [ ] Late-payment window approved by the owner in writing.
- [ ] Production migrations applied and Production table QR tokens rotated (stage 6).
- [ ] One-outlet pilot with staff briefed on the held-for-review and refund procedures.

## 7. Where each piece of work stands (2026-10-20)

**Implemented and verified locally** (unit / integration tests and browser E2E
against the local UPI bank emulator; never against SBI): the payment provider
boundary; the dynamic-QR checkout screen; server-side confirmation polling; the
callback route with per-tenant merchant binding; pending-payment recovery
(in-process worker, `GET /api/cron/payments`); the server-side kitchen gate; the
late-payment hold; mismatch anomalies; refusal of `mock` / `upi_emulator` in
Production; and the `sbi_upi` stub, which refuses every call. Online guest
payment is **not operational**: with `PAYMENT_PROVIDER=sbi_upi` guests are told
online payment is unavailable and QR ordering is refused.

**Depends on SBI** (specification, onboarding, credentials, UAT): the `sbi_upi`
adapter itself and every "SBI must provide" cell in §3.1; refunds and
reconciliation against SBI; UAT and certification.

**Requires owner approval:** sending §2; considering SBIePay; the late-payment
window (10 minutes is a proposed default only); accepting SBI's fees; the Vercel
plan and recovery scheduler; the Production migration window; the QR token
rotation window; the release.

**Requires controlled Production access, backups or hardware:** Production's
`DATABASE_URL`; a backup proven to restore; applying migrations; configuring
the recovery scheduler; the QR token audit, rotation and new printed cards; the
legacy Razorpay read-only audit; Production credentials; and the physical bill
printer check (`docs/physical-printer-test.md`). These are separate operational
tasks, tracked in `docs/owner-go-live-checklist.md`.
