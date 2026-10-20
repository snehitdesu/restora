# Coders' Cafe customer / investor acceptance test

> **2026-10-20:** the spec (`e2e/acceptance/acceptance.spec.ts`) was converted from
> the Razorpay emulator to the direct-bank UPI QR emulator
> (`tests/support/upiBankEmulator.ts`) when Razorpay was retired for new payments.
> The evidence recorded below is from the **2026-10-12 Razorpay-emulator run** and
> is kept as history; re-run `npm run e2e:acceptance` for current evidence. The
> Razorpay files it names cannot be run: `tests/support/razorpayEmulator.ts` and
> `tests/domain/coders-cafe-razorpay.test.ts` were removed on 2026-10-20, and
> `e2e/razorpay-sandbox.spec.ts` was never committed.

_Run of 2026-10-12 on a fresh database, on the branch merged with `main` (`a80caa9`) (`prisma/e2e-acceptance.db`, rebuilt from the committed migrations for every run), production build, SQLite. Command: `npm run build && npm run e2e:acceptance`. Result: **7 tests passed, 31 of 31 recorded steps PASS** (steps 1-30 and the final sweep). The suite is `e2e/acceptance/acceptance.spec.ts`; it is also a CI step, and CI uploads the full evidence (every observation, screenshots) as the artifact `acceptance-evidence-coders-cafe`._

## The order, by identifier

The ids below belong to the disposable database of that run; every run creates new ones (the shapes and the relations between them are what repeats).

| What | Value |
|---|---|
| Restaurant (organization) | `Coders' Cafe (cmv53vkyn00007doj5uaz1e1k)` |
| Outlet | `CC01 (cmv53vkyr00027dojvrx6niah)` |
| Table | `T07 (7e278a1dbfa766b3fe8fa9661b3041c0)` |
| RESTORA order id | `cmv53vtas000c7dqurmwbnjk3` (reference `#WBNJK3`) |
| RESTORA payment id | `cmv53vtjo000j7dqujs3srvg0` (ONLINE, provider razorpay, SUCCESS, ₹157.50) |
| Gateway order id (stored as `Payment.providerRef`) | `order_a2fnou3fgA` |
| Gateway payment id (Razorpay emulator) | `pay_uFc4psTXPg` |
| KOT id / number | `cmv53vtrz000o7dquel8t816g` / 1 |
| Invoice id / number | `cmv53vtsf000t7dquogdeoik4` / `CC/2627/00001` |
| Final kitchen status | **SERVED** (NEW → ACCEPTED → PREPARING → READY → SERVED, each time stamped) |

## Conditions of the test, stated plainly

- **Razorpay is an emulator** (`tests/support/razorpayEmulator.ts`, reached through `RAZORPAY_API_BASE`; the adapter labels that mode MOCK) and the browser's `checkout.js` is a stub that plays the customer's side of Razorpay's window. This proves RESTORA's half of the contract: the amount sent to the gateway is the server's, the checkout signature is checked with the key secret, the server asks the gateway about the payment itself, webhooks are signature- and account-checked, and nothing is applied twice. It does **not** prove Razorpay accepts these calls: that needs `rzp_test_` keys (`e2e/razorpay-sandbox.spec.ts`).
- **What the test sets up beyond the shipped Coders' Cafe dataset**, because the dataset has none of it: the outlet's GSTIN (the sample `27AAPFU0939F1ZV`, so the invoice is a registered business's CGST / SGST invoice; without a GSTIN RESTORA issues an unregistered-supply invoice with no GST split), a recipe for Loaded Veg Nachos (0.2 kg nacho chips + 0.1 kg cheese sauce a plate), opening stock of both in the kitchen department (10 kg and 5 kg), and a second, unrelated restaurant for the cross-tenant checks.
- Database reads in the spec are read-only and independent of the application's own APIs; every figure is also read back through the real authenticated API or the real screen.
- The guest write limit (60 a minute per address) applies to attackers too, so each simulated visitor in the attack tests uses its own address.

## A product defect this test found and fixed

Step 20 failed the first time it was run. Nothing in the application ever wrote `Kot.acceptedAt`, `startedAt`, `readyAt` or `servedAt`: `updateKOTStatus` changed only `status`. The dish prep-time report and the late-ticket alerts (audit MB-07, MB-08) read those columns, so on real tickets they had nothing to measure; their tests passed because they set the columns by hand. `updateKOTStatus` now stamps the time of the status reached (once; a repeated tap changes nothing). `P4` in `tests/domain/prep-times.test.ts` drives the real taps and fails without the fix; step 20 asserts all four stamps. Two earlier acceptance runs also failed on mistakes in the test itself (a quote request awaited too early; a Money Desk row read after leaving the page), fixed in the test.

## Steps 1-30

| # | Step | Result | Evidence (observed in this run) |
|---|---|---|---|
| 1 | Open the Coders' Cafe table ordering page | PASS | the link on T07's QR dialog (`http://localhost:3230/t/<T07 token>`, token from that run's disposable database, redacted) opens with HTTP 200; page title `Coders' Cafe · Table T07` |
| 2 | Use a real seeded table (T07) | PASS | table row `7e278a1dbfa766b3fe8fa9661b3041c0` code T07 of outlet CC01; the token in the link is that row's `qrToken`; the server answers `table: T07`, restaurant Coders' Cafe |
| 3 | Browse the live menu | PASS | 64 items from the server = 64 active items in the database = 64 Add buttons on the phone; Loaded Veg Nachos ₹150 on screen, in the API and in the database |
| 4 | Add an item | PASS | Loaded Veg Nachos added; sticky bar `1 item · ₹157.50 incl. GST View cart` |
| 5 | Open the cart | PASS | total ₹157.50 (₹150 + 5% GST ₹7.50); the cart's price request to the server carried only `menuItemId` and `qty` |
| 6 | Checkout | PASS | checkout shows Table T07 |
| 7 | Choose online payment | PASS | the radio is labelled "Simulated online payment" (RESTORA's wording for any non-live gateway, here the Razorpay emulator) and is checked; the server reports online payment available (key id `rzp_test_ACCEPTANCE0001`) |
| 8 | Complete the payment | PASS | Razorpay window opened for gateway order `order_a2fnou3fgA`, **15750 paise**; the page shows "Payment successful. Thank you!" |
| 9 | Server creates the RESTORA order | PASS | order `cmv53vtas000c7dqurmwbnjk3`: channel QR, source QR, 1 × Loaded Veg Nachos @ ₹150, subtotal 150, GST 7.50, total 157.50; the browser's order request was `{"items": [{"menuItemId": "6043be0a6acdb763a98426fa2b9370e6", "qty": 1}], "paymentMethod": "ONLINE"}`; audit CREATE entry |
| 10 | Payment verified server-side | PASS | payment `cmv53vtjo000j7dqujs3srvg0` SUCCESS with `verifiedAt` 2026-10-12T10:25:17.174Z; the gateway order was created by the server for 15750 paise; server's gateway calls: `GET /payments`, `GET /payments`, `POST /orders`, `GET /orders/order_a2fnou3fgA`, `GET /orders/order_a2fnou3fgA`, `GET /payments/pay_uFc4psTXPg` (the capture was looked up at the gateway, not taken from the browser); the key secret and webhook secret never appeared in anything the browser received |
| 11 | Order reaches the paid / confirmed state | PASS | OPEN → **PAID** (`paidAt` 2026-10-12T10:25:17.185Z), KOT created NEW in the same step; audit trail `UPDATE {status: PAID, kots: [1], via: prepaid}`; the customer's page: "Sent to the kitchen" |
| 12 | No client-side "paid" shortcut | PASS | 11 attempts while the real payment was PENDING: bodies claiming `status: SUCCESS` / `paid: true` → **422**; a status check or a claimed gateway reference with no proof → 200 and still PENDING; a reference to another gateway order → 422; the staff payment, verify and submit-to-kitchen endpoints as a stranger → **401**; a forged-signature and an unsigned webhook → **401**. After **every** attempt: payment PENDING, order OPEN, 0 KOTs, 0 invoices |
| 13 | Exactly one KOT | PASS | KOT `cmv53vtrz000o7dquel8t816g` number 1, 1 × Loaded Veg Nachos; 1 KOT for the order and 1 in the whole database |
| 14 | Correct restaurant, outlet, table | PASS | order, payment and KOT carry the Coders' Cafe organization id and the CC01 outlet id; the order's table is T07's id |
| 15 | Open the chef account | PASS | signed in as `cafe.chef@demo.local` (role KITCHEN), `/kitchen`; the same account gets **403** from the finance API |
| 16 | Order appears as NEW | PASS | ticket `KOT 1, Table T07 · QR` in the New column; database status NEW |
| 17 | Accept | PASS | KOT ACCEPTED, `acceptedAt` 2026-10-12T10:25:18.373Z; ticket moves to In progress |
| 18 | Start | PASS | KOT PREPARING, `startedAt` 2026-10-12T10:25:18.504Z |
| 19 | Ready | PASS | KOT READY, `readyAt` 2026-10-12T10:25:18.900Z; ticket in the Ready column |
| 20 | Served | PASS | KOT **SERVED**, `servedAt` 2026-10-12T10:25:19.216Z; ticket leaves the board; the customer's page: "Completed" |
| 21 | Order in POS / order history | PASS | POS → Open orders → Recent lists `#WBNJK3 · Table T07 · QR · PAID`; the orders API returns it once; the receipt `/pos/bill/cmv53vtas000c7dqurmwbnjk3` shows Table T07, the item and ₹157.50 |
| 22 | Payment in Finance / Money Desk | PASS | Payments screen row: `12 Oct 2026, 15:55 CC/2627/00001 Online Success order_a2fnou3fgA ₹157.50 — Refund`; Money Desk 2026-10-12: 1 order, billed ₹157.5, GST ₹7.5, **collected online ₹157.5**, 0 unsettled orders |
| 23 | Invoice / bill correct | PASS | invoice `cmv53vtsf000t7dquogdeoik4` **CC/2627/00001** (FY 2026-27), seller Coders' Cafe GSTIN 27AAPFU0939F1ZV, INTRA supply: taxable ₹150, CGST 2.5% ₹3.75, SGST 2.5% ₹3.75, IGST ₹0, tax ₹7.5, total ₹157.5; one invoice for the order; the same number on the order and on the customer's receipt |
| 24 | Inventory consumed exactly once | PASS | 2 `SALE_CONSUMPTION` ledger rows, signed negative: Nacho chips -0.2 kg @ ₹120 (₹-24), Cheese sauce -0.1 kg @ ₹300 (₹-30); on hand 10 → 9.8 kg and 5 → 4.9 kg; theoretical food cost ₹54; the order's `stockConsumed` is true; unchanged after steps 26-30 |
| 25 | Analytics reflect the sale | PASS | sales summary: 1 order, gross ₹150, GST ₹7.5, revenue ₹157.5; item sales: Loaded Veg Nachos × 1, ₹150 net; payments by method: ONLINE 1 / ₹157.50; food cost ₹54; the Analytics screen shows ₹157.50 |
| 26 | Failed payment must NOT reach the kitchen as PAID | PASS | order `cmv53w40c001b7dqurmtcq5ai` on T08: bank declines and the customer closes the window → payment FAILED, order OPEN, 0 KOTs, 0 invoices; a payment only *authorized* at the bank → confirm answers pending, payment PENDING; a webhook that *claims* capture for it → **HTTP 503** (not acknowledged, the gateway must retry; the server found no capture); a forged checkout signature → payment FAILED. The chef's board shows no T08 ticket (screen and KDS API); the books before and after are identical |
| 27 | Duplicate payment / webhook must NOT create a duplicate KOT | PASS | the captured webhook delivered again → **DUPLICATE**; 8 simultaneous deliveries → 8 × DUPLICATE; a late `payment.failed` after success → IGNORED ("ignored payment.failed for a SUCCESS payment"); "Pay online" on the settled order → 422 "This order is already paid"; 3 simultaneous re-sent confirms → SUCCESS unchanged. One stored webhook event, `verifiedAt` unchanged, still KOT `cmv53vtrz000o7dquel8t816g` only; books identical before and after |
| 28 | Duplicate submission must NOT create duplicate orders | PASS | double-tap on Place order → 1 request, 1 key, 1 order; same key + same body → the same order (`replayed`); same key + a different cart → **409**; 5 simultaneous requests with one key → 1 order; "Pay online" pressed again 3 times → the same payment and the same single gateway order. Different keys are different submissions (by design not merged), but a table may have at most 3 orders waiting: the 4th is refused (422) |
| 29 | Amount tampering must fail | PASS | `unitPrice`, `price`, `total`, `amount`, `subtotal`, `tax`, `discount`, `taxPct` on the order body, a line and the quote → **422** each, no order created; the same by rewriting the browser's request on the wire → refused, no order; payment bodies with `amount` / `total` / `parts` 0, -1, 1, 99, 1.5 → 422; the gateway order is created for the server's 19425 paise; **₹1 captured at the gateway for a ₹194.25 bill** → payment FAILED ("Amount mismatch"), order OPEN, no KOT; a webhook edited after signing → **401**; ₹1000 / ₹-5 cash by the manager → 422 ("Payment 1000 exceeds outstanding 194.25") |
| 30 | Restaurant / outlet / table tampering must fail | PASS | `tableId`, `outletId`, `organizationId`, `restaurantId`, `channel`, `source`, `status` in the order body → **422**; a QR token with one character changed → **404**; the other restaurant's table with a Coders' Cafe dish, and the reverse → 404; another order's key, no key, a made-up key, another order's payment id → **404**; the browser's request rewritten to name another table / outlet / restaurant → refused, no order; the other restaurant's **owner** reading or writing this restaurant's order, orders, payments, Money Desk, sales, stock, KDS, cash payment, KOT status, new order → **404** on every one; this restaurant's manager naming the other restaurant's outlet → 404; a signed webhook for an unknown merchant account → 503 "Unknown integration account" (not applied). Nothing changed in the main order, the kitchen or the money; 0 orders exist in the other restaurant |

## Final sweep

After all five attack families (which leave 6 unpaid, never-accepted orders on T05, T08, T09 and T10): books = `{"paidOrders": 1, "successPayments": 1, "kots": 1, "invoices": 1, "consumptionRows": 2}` (1 paid order, 1 successful payment, 1 KOT, 1 invoice, 2 consumption rows), sales summary 1 order / ₹157.5, stock 9.8 kg and 4.9 kg, the main order still PAID with its KOT SERVED, **0 high-severity anomalies**.

## Observations worth knowing (not defects of this test)

- A forged or invalid checkout signature marks the customer's *pending* payment FAILED (step 26c). It needs the order's access key (the customer's own credential), and the payment service re-asks the gateway about a FAILED payment, so a capture that really happened still settles it (the recovery rule, covered by `tests/domain/coders-cafe-razorpay.test.ts`; this acceptance run does not exercise it); but it means whoever holds the key can fail their own pending payment.
- An unknown merchant account and a capture the gateway does not yet show are answered with 503, so the gateway delivers them again; both leave RESTORA unchanged.
- Orders placed with different Idempotency-Keys are different orders. The protection against flooding is the cap of 3 waiting orders per table and the per-address write limit, not content matching.
- Not covered by this test: a real Razorpay account, the Razorpay-hosted payment window, refunds, split-bill parts (covered in `QR-004`), a second outlet inside the same restaurant (multi-outlet is not part of this acceptance).

## Re-running it

```bash
npm run build
npm run e2e:acceptance        # ~1 minute; fresh database every time
# evidence: e2e/.evidence-acceptance/acceptance-evidence.{json,md} and screens/
```
