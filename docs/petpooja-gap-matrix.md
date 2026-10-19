# RESTORA vs Petpooja: workflow gap matrix (2026-10-19)

Status: **draft for the owner's review.** No feature work starts from this list
until the owner approves the rows to build. Multi-outlet / multi-restaurant work
stays deferred (PA-08, AD-04, AD-05).

## What each claim is based on

| Tag | Source | What it can establish |
|---|---|---|
| **[D]** | A Petpooja demonstration step actually observed | How Petpooja performs a workflow. **No [D] evidence exists yet.** The reference video (https://youtu.be/y12pNLvkMt8, "Petpooja Restaurant Management Software", channel "Software") was not watched: the fetched page carried no description, chapters or transcript. Nothing below claims what the video shows. |
| **[O]** | Petpooja's public website (petpooja.com, /Poss), fetched 2026-10-19 | Only that Petpooja **markets** a module of that name: Billing, Inventory, Online ordering, Reporting, Menu, CRM, Purchase Manager, Offline POS, Marketing Manager; add-ons Captain Ordering App, Kitchen Display System, Scan & Order, Self-Service Kiosk, Wireless Calling Device, Loyalty Program, Customer Feedback, SMS Service, Restaurant Website, Token Management, Order Reconciliation, Analytics & Insights. Marketing copy, not product documentation. |
| **[S]** | RESTORA source and tests in this repository | What RESTORA does. File and test references are given per row; `docs/master-feature-audit.md` holds the per-feature evidence these rows summarize. |

"Unknown" (column 4) lists the Petpooja behaviour that would have to be observed
in a demonstration before the row can be called a gap or parity. Send the
observations (timestamp + what the screen does) and the row will be updated.

Severity: **S1** blocks or corrupts money / orders; **S2** daily friction for
staff or a missing common workflow; **S3** nice to have. Scope: **S** ≤ 1 day,
**M** 2–5 days, **L** > 1 week.

## Matrix

### 1. POS billing and order entry
1. **Workflow / source:** counter billing, "3-click billing" [O: Billing].
2. **RESTORA [S]:** `/pos` (`src/features/pos/components/PosScreen.tsx`), search + keyboard entry, named hold list (`Order.holdLabel`), rounds with Idempotency-Key, open-orders board, KOT on submit; `src/server/services/orders.ts` (`placeOrder`, `addOrderRound`, `submitOrder`). Tests: `tests/domain/pos-backend.test.ts`, `tests/ui/pos-open-orders.test.tsx`, `tests/api/order-ops-routes.test.ts`.
3. **Confirmed missing / defective [S]:** an item already sent to the kitchen **cannot be removed on its own**: `removeOrderItem` refuses any line with a KOT (`orders.ts`, "already sent to the kitchen"). The kitchen can cancel a whole ticket at the KDS, after which the quantity may be edited, but there is no single-line void with a reason and no cancellation slip for just that line; otherwise the whole order is cancelled (step-up `order.void`) and re-entered.
4. **Unknown:** how many taps Petpooja needs for a repeat item, whether it supports a per-line void after KOT with a reason and a "cancelled" KOT, and its shortcut keys.
5. **Staff impact:** cashiers re-key whole orders for a one-line change; the kitchen gets no per-line cancellation.
6. **Risk:** S2 (audit of voids stays correct; friction and re-keying errors).
7. **Scope:** M (line void with reason + step-up, cancellation KOT per station, stock and totals follow).
8. **Acceptance test:** sent order with 2 lines → void line 2 with a reason → kitchen shows a CANCELLED ticket line for that station only; order total drops; audit `VOID` with reason; a paid order refuses it.
9. **Recommendation:** **P1** – build after owner approval.

### 2. Modifiers and variants
1. [O: Menu]. 2. **[S]:** `ModifierGroup` / `ModifierOption` / `MenuItemVariant` (`prisma/schema.prisma`), priced server-side in `addOrderItem` and `priceGuestLines`; captain and guest carts carry `variantId` + `modifierOptionIds`. Tests: `tests/domain/menu.test.ts`, `tests/domain/outlet-menu.test.ts`, `tests/ui/guest.test.tsx`.
3. **Confirmed missing:** none found in code.
4. **Unknown:** Petpooja's nested / mandatory-min-max modifier rules, half-and-half, combo builder.
5–7. —
8. **Acceptance:** a mandatory modifier group with min 1 / max 2 refuses 0 and 3 options at the server, from POS and from QR.
9. **Recommendation:** no work until a [D] observation shows a difference.

### 3. Quantity, discount and tax
1. [O: Billing]. 2. **[S]:** order-level discount (`applyDiscount`, permission `order.discount`, coupon interaction, total may never fall below collected payments: `assertTotalCoversPaymentsTx`); coupons (`src/server/services/coupons.ts`); per-item `taxPct` with frozen invoice tax breakdown (`issueInvoiceTx`); Decimal money (`src/domain/money.ts`). Tests: `tests/domain/growth-coupons.test.ts`, `tests/db/decimal-precision.test.ts`, `tests/domain/payment-balance.test.ts`.
3. **Confirmed defect [S] (fixed 2026-10-19, `tests/domain/order-ops.test.ts`):** `PATCH /api/orders/items/:id` accepted a per-line `discount` with only `order.modify`, so a CAPTAIN (no `order.discount`) could discount a line; the change was not audited and was not capped at the line's value. **Confirmed missing:** the POS screen offers only an order-level amount (`DiscountDialog.tsx`); no discount **reason**; no percentage discount at the counter.
4. **Unknown:** Petpooja's discount types, approval limits per role, service charge and round-off handling.
5. **Impact:** "10 % off for staff" must be computed by hand; no reason trail for discounts.
6. **Risk:** S2 (discount leakage visibility). 7. **Scope:** S–M.
8. **Acceptance:** cashier applies 10 % to one line with reason "staff meal"; total and tax recompute; report lists discounts by reason and person; a role without `order.discount` is refused at the API.
9. **Recommendation:** **P2**; confirm with a [D] observation of Petpooja's discount screen first.

### 4. Table and floor management
1. [O: Captain Ordering App]. 2. **[S]:** tables and areas (`src/server/services/masterData.ts`), table status board (`/captain`, `/tables`), transfer / merge / split (`src/server/services/orderOps.ts`), reservations + waitlist. Tests: `tests/api/floor-routes.test.ts`, `tests/domain/floor-extras.test.ts`, `tests/domain/order-ops.test.ts`, `tests/domain/reservation-concurrency.test.ts`.
3. **Confirmed missing:** a drawn floor plan (layout positions) is not built; the board is a list/grid. Captain web app has no offline queue (MB-04 NOT BUILT).
4. **Unknown:** Petpooja's floor-plan editor and timers.
5. **Impact:** captains lose orders during a Wi-Fi drop (they must retry).
6. **Risk:** S2 for the offline captain. 7. **Scope:** offline captain L; floor plan M.
8. **Acceptance (offline captain):** captain takes a round with Wi-Fi off → it is queued visibly → on reconnect it is sent once (same Idempotency-Key) → one KOT.
9. **Recommendation:** P3 (needs design approval; desktop POS already works offline).

### 5. KOT and kitchen display
1. [O: Kitchen Display System; body copy "generate KOT"]. 2. **[S]:** one KOT per station (`src/server/services/kot.ts`), KDS (`/kitchen`, `KitchenScreen.tsx`) with Accept / Start / Ready / Served timestamps, prep-time expectations, ESC/POS KOT printing (`src/integrations/printers`). Tests: `tests/domain/kitchen-production.test.ts`, `tests/domain/kot-lifecycle-timestamps.test.ts`, `tests/db/kot-concurrency.test.ts`, `tests/ui/kitchen-timing.test.tsx`.
3. **Confirmed [S] findings:** no per-line cancellation KOT (see row 1). The KDS ticket poll counts as user activity, so a kitchen screen never reaches the 15-minute idle sign-out (`KitchenScreen.tsx` poll without `BACKGROUND_HEADER`); this keeps an unattended KDS working but contradicts `docs/security.md` ("background polling does not extend it"). **Owner decision needed** (see `docs/production-readiness.md`).
4. **Unknown:** Petpooja KDS bump-bar / recall / colour timers.
5–9. Row 1 covers the cancellation KOT; the idle behaviour is a security decision, not a feature.

### 6. Split and partial payments
1. [O: Billing]. 2. **[S]:** multiple payments up to the outstanding balance (`assertPayableTx`, re-checked in the transaction that makes a payment SUCCESS), bill split into separate orders (`splitOrder`), guests paying a share from their phones. Tests: `tests/domain/bill-split.test.ts`, `tests/domain/guest-split-reorder.test.ts`, `tests/db/settlement-concurrency.test.ts`, `tests/domain/payment-balance.test.ts`.
3. **Confirmed defect [S] (fixed 2026-10-19, see `tests/domain/payment-balance.test.ts`):** a split payment that was partly refunded before the bill was settled was not counted toward settlement, so the order could never become PAID while no further payment was allowed.
4. **Unknown:** Petpooja's split-by-item vs split-by-amount UI.
5–9. Defect fixed; no further work proposed.

### 7. Refunds and cancellation
1. [O: Billing]. 2. **[S]:** append-only `Refund` rows, never above the refundable amount, gateway refund with a stable idempotency key, credit note per refund, loyalty / referral / coupon reversal on a full refund; order cancel behind step-up `order.void`. Tests: `tests/domain/idempotency-refunds.test.ts`, `tests/domain/coders-cafe-razorpay.test.ts`, `tests/db/append-only.test.ts`.
3. **Confirmed missing:** cancellation **reason codes** are free text only; no void report by reason (see row 3).
4. **Unknown:** Petpooja's refund approval flow.
6. S3. 7. S. 9. P3, together with row 3's reason codes.

### 8. Guest QR ordering
1. [O: Scan & Order]. 2. **[S]:** `/t/<token>` storefront, server-priced cart, sold-out and price-change refusal, idempotent placement with same-key replay and a "Check order status" unknown state (`src/features/guest/orderSubmit.ts`), cash orders go to the kitchen at placement, Razorpay online payment. Tests: `tests/ui/guest-order-submit.test.ts`, `tests/db/guest-checkout-concurrency.test.ts`, `tests/api/guest-routes.test.ts`, `tests/domain/qr-transaction.test.ts`.
3. **Confirmed missing:** photos and allergens on the guest menu (QR-03 NOT BUILT); delivery / takeaway ordering website (QR-09 NOT BUILT). Hosted latency: see `docs/production-readiness.md` (region decision pending).
4. **Unknown:** Petpooja's QR payment-first vs order-first options.
6. S2 (photos / allergens). 7. M. 9. P2.

### 9. Inventory and stock counts
1. [O: Inventory]. 2. **[S]:** stock ledger, `StockCount` with variance, low-stock / reorder, batches and expiry (IN-14 PARTIAL), indents and issues, inter-outlet transfers. Tests: `tests/domain/inventory-procurement.test.ts`, `tests/db/stock-post-concurrency.test.ts`, `tests/domain/expiry.test.ts`, `tests/domain/advanced-inventory.test.ts`.
3. **Confirmed missing:** FSSAI lot handling is partial (IN-14).
4. **Unknown:** Petpooja's day-end stock closing flow.
9. No work until a [D] observation shows a difference.

### 10. Recipes, costing and wastage
1. [O: Inventory]. 2. **[S]:** recipes and sub-recipes, theoretical cost, menu engineering, production batches, wastage with reasons, consumption on payment. Tests: `tests/domain/recipes.test.ts`, `tests/domain/costing-engineering.test.ts`, `tests/domain/production-wastage.test.ts`, `tests/domain/recipe-cycle.test.ts`.
3. **Confirmed missing:** none found.
9. No work.

### 11. Procurement, GRN and vendor payments
1. [O: Purchase Manager]. 2. **[S]:** purchase requests / orders, approvals, `GoodsReceipt` (GRN) with batch / expiry, `VendorPayment`, vendor ledger, reorder suggestions. Tests: `tests/domain/purchasing-rules.test.ts`, `tests/domain/procurement-queue.test.ts`, `tests/api/purchasing-routes.test.ts`, `tests/domain/reorder.test.ts`.
3. **Confirmed missing:** Tally / Zoho import not externally verified (PP-14, AD-03).
9. External verification only (needs a Tally / Zoho company).

### 12. Staff roles, Owner / Manager permissions
1. [O: none named]. 2. **[S]:** RBAC per outlet and org-wide (`src/server/auth/rbac.ts`), step-up for sensitive actions, staff invite by email, second-owner support and owner recovery codes (2026-10-19). Tests: `tests/auth/auth-matrix.test.ts`, `tests/auth/backup-owner.test.ts`, `tests/auth/owner-recovery.test.ts`, `tests/domain/staff.test.ts`.
3. **Confirmed missing:** tips are not recorded (SO-06); punch / geofenced attendance (SO-02 NOT BUILT).
9. P3 for tips if the owner wants tip distribution.

### 13. Customer information and loyalty
1. [O: CRM, Loyalty Program, Customer Feedback, Marketing Manager]. 2. **[S]:** customers by phone, consent per channel, loyalty tiers, coupons, referrals, campaigns, feedback requests, win-back and date offers. Tests: `tests/domain/crm-loyalty.test.ts`, `tests/domain/growth-*.test.ts`.
3. **Confirmed missing:** no live messaging provider has sent a real message (CM-01..06 NOT EXTERNALLY VERIFIED); gift cards / prepaid packages (AD-08 NOT BUILT).
9. External verification (WhatsApp / SMS credentials) before any new feature.

### 14. Finance, reconciliation and reporting
1. [O: Reporting, Order Reconciliation, Analytics & Insights]. 2. **[S]:** cash drawer sessions and movements (`CashDrawerSession`, `CashDrawerMovement`), day close, bank deposits, expenses, gapless GST invoices and credit notes, aggregator payout reconciliation, reports and CSV exports. Tests: `tests/domain/money-desk.test.ts`, `tests/domain/finance-p4.test.ts`, `tests/db/day-close-concurrency.test.ts`, `tests/domain/reports.test.ts`, `tests/domain/aggregator-finance.test.ts`.
3. **Confirmed missing:** e-invoice IRN (AD-02 NOT BUILT; needs GSP credentials); reports by chef / shift (XC-06 PARTIAL).
9. P3 for e-invoicing only if turnover requires it (accountant's call).

### 15. Offline operation, sync and recovery
1. [O: Offline POS]. 2. **[S]:** the desktop app runs fully offline on SQLite; Cloud Sync pulls hosted QR orders into the desktop POS / KOT and queues status changes while offline (`src/server/sync/*`). Tests: `tests/sync/desktop-sync.test.ts`, `tests/sync/cloud-sync-api.test.ts`, `tests/sync/desktop-prisma-boundary.test.ts`.
3. **Confirmed defect [S] (fixed 2026-10-19, `tests/api/middleware-matcher.test.ts`):** taking a payment on a cloud order from the desktop called hosted `/api/payments` with the device token and no cookie; the hosted edge middleware answered 401, so the desktop reported "cloud sign-in has ended". Captain app offline queue: row 4.
4. **Unknown:** how Petpooja Offline POS reconciles conflicting edits.
9. Done 2026-10-19 on the Preview: a counter payment on a cloud order settled once; the desktop's write timeout was raised to 45 s (5e1758c) because a slow cloud settlement was reported to the cashier as a failure. Rebuild and reinstall the desktop to ship it.

### 16. Backup, restore and desktop updates
1. [O: none named]. 2. **[S]:** verified backup before every migration, restore, upgrade refusal on a newer database, rollback (`desktop/runtime/*`). Tests: `tests/desktop/backup.test.ts`, `tests/desktop/upgrade-restore.test.ts`, `tests/desktop/migrator.test.ts`.
3. **Confirmed missing:** installers are **not signed** (`Get-AuthenticodeSignature`: NotSigned, 2026-10-19); no automatic updater (by decision, `docs/desktop-release.md`); the local `dist-desktop` holds a rebuilt `1.0.0-rc.1` whose size and hash differ from the published manifest (`src/site/release-manifest.json`), so two different binaries share one version.
5. **Impact:** SmartScreen warnings; updates are manual.
6. S2. 7. Signing needs a certificate (external); version bump per build is S.
9. **P1:** never ship a rebuilt binary under an existing version; buy an OV/EV certificate before public distribution.

## Proposed priorities (for approval)

| Priority | Rows | Why |
|---|---|---|
| P1 | 1 (line void + cancellation KOT), 16 (version hygiene; certificate) | daily counter friction; release integrity |
| P2 | 3 (line / % discounts with reasons), 8 (photos, allergens) | common restaurant workflows |
| P3 | 4 (offline captain), 7 (reason codes), 12 (tips), 14 (e-invoice if required) | need design or external decisions |
| none | 2, 9, 10, 11, 13 | no confirmed gap; wait for [D] observations |
