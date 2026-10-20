# Direct SBI UPI integration — readiness checklist

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
paste them into a terminal transcript.

> Subject: API-based dynamic UPI QR collection for our restaurant — technical
> documentation and UAT request
>
> We hold a current account with SBI (account / CIF: ______, branch: ______). Our
> restaurant uses its own ordering software (RESTORA). For each table order we
> want to collect the exact bill amount by UPI directly into this account, and
> our server must be able to confirm each payment before the kitchen starts
> cooking. Please tell us which SBI product provides this and share:
>
> 1. **Product and eligibility:** the SBI product name for API-based UPI
>    collection by a merchant (dynamic QR and/or UPI intent), account and
>    merchant-category eligibility for a restaurant, onboarding forms, fees per
>    transaction, settlement timing, and whether a separate merchant ID,
>    terminal ID, sub-merchant ID or VPA is issued.
> 2. **API specification (UAT and production):** endpoints, request and response
>    formats, and error codes for (a) creating a transaction-specific dynamic QR
>    or UPI intent for a fixed amount with our unique transaction reference,
>    (b) its validity / expiry, and (c) cancelling it, if supported.
> 3. **Security:** authentication of our API calls (API keys, client certificate
>    / mutual TLS, IP whitelisting), message encryption and signing algorithms
>    and key exchange, and certificate rotation.
> 4. **Callback / notification:** whether SBI sends a server-to-server payment
>    notification, its payload, how it is signed or encrypted, retry schedule,
>    replay protection, source IP ranges, and how the callback URL is
>    registered.
> 5. **Transaction-status inquiry API:** request format, the complete list of
>    status values and which are final (success, failure, expired, pending /
>    deemed), recommended polling frequency and limits, and how long after
>    creation a transaction can still change state.
> 6. **References:** which fields carry our transaction reference, the bank
>    reference number (RRN / UTR), payer VPA (if shared), amount and currency in
>    the callback and status responses.
> 7. **Refunds:** whether refunds of UPI collections can be initiated by API (and
>    its specification) or only through a branch / portal process, partial
>    refund support, and timelines.
> 8. **Reconciliation:** the MIS / settlement report format, how it is delivered
>    (portal, SFTP, e-mail, API) and its schedule.
> 9. **UAT:** access to the UAT environment, UAT credentials and certificates
>    (issued through SBI's secure channel), test VPAs / test apps, and the test
>    scenarios SBI requires before production sign-off.
> 10. **Production activation:** go-live checklist, security review, and a
>     technical support contact and escalation matrix.
> 11. **Fit of your existing products:** whether *E-Pay* (UPI channels) or
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

Refund API and MIS format are needed before production, but not to start the
adapter.

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

## 4. Configuration names (no values in source control)

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PROVIDER=sbi_upi` | Selects SBI for new guest checkouts (currently: online payment unavailable). |
| `SBI_UPI_ENVIRONMENT` | `uat` or `production` (mode SANDBOX / LIVE). |
| `SBI_UPI_MERCHANT_ID`, `SBI_UPI_TERMINAL_ID`, `SBI_UPI_VPA` | Identifiers SBI issues (names provisional until SBI's spec confirms which exist). |
| `SBI_UPI_API_BASE` | SBI's UAT / production endpoint, from SBI's documentation. |
| Credentials, keys, certificates | Names to be fixed from SBI's spec. Stored only as Vercel **Sensitive** environment variables (or the host's secret store), never in the repository, desktop bundle or client code. |

## 5. UAT test scenarios (to run with SBI's UAT access)

Mark each result as *SBI UAT*, never as local emulator evidence.

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

## 6. Production activation checklist

- [ ] Owner has SBI's written product confirmation, fees and onboarding complete.
- [ ] SBI API specification and security documents received through an official channel.
- [ ] `sbiUpi.ts` implemented from that specification, with contract tests from SBI's documented examples.
- [ ] Callback URL registered with SBI (production domain only, HTTPS).
- [ ] CSP / security headers updated for whatever SBI's spec requires (none needed today: the QR is rendered by RESTORA).
- [ ] All section 5 scenarios passed in SBI UAT and recorded.
- [ ] Credentials set as Sensitive variables in Production only; never printed.
- [ ] External scheduler for payment recovery configured and proven (docs/payment-safety.md §3).
- [ ] One-outlet pilot with staff briefed on the held-for-review and refund procedures.
