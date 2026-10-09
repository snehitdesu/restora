# RESTORA master feature audit

Source of truth: *Restaurant ERP & Digital Systems: Technology Proposal* (Yeswant Sai,
September 2026, 23 pages; `Downloads/Restaurant-Technology-Proposal-Yeswant-Sai.pdf`,
all three copies are byte-identical, md5 `2946530e…`). Page numbers are the proposal's
printed page numbers. Existing RESTORA decisions (QR journey, Razorpay authority,
desktop, public website, Coders' Cafe) extend the proposal and are audited too.

Audit started 2026-10-07 against commit `a1f2955` (plus the uncommitted tree).
The **Status** column is the verified status. Work was first planned in groups
(1 integrity, 2 reorder, 3 menu engineering / leakage, 4 department costing, 5 kitchen
production, 6 money desk / floor / search, 7 external). From 2026-10-08 the master
program renumbers them (`docs/group3-implementation-map.md`): 3 kitchen production +
money desk, 4 menu engineering + advanced inventory + costing, 5 integrations (the old
group 7), 6 growth, 8 mobile + advanced operations, 9 infrastructure. A row only becomes
COMPLETE when it is implemented and tested; "group N" in **Verification** marks pending
work by the new numbering.

Status values (exactly one per row; redefined in the 2026-10-08 stabilization pass, see below):

- **IMPLEMENTED + VERIFIED**: database, rules, service, API and authorization exist and are covered by automated tests that pass on SQLite and PostgreSQL at the audited commit; the **Verification** column names them. A screen with no automated UI or browser test is called out in that column and in "Screens with no automated test" below. Verified means *tested here*, not *proven against a live provider*.
- **IMPLEMENTED + NOT EXTERNALLY VERIFIED**: the code path exists and is tested against an emulator, mock or sandbox, but it needs credentials, hardware, hosting, a real partner file or a real-world run before it can be called working. Nothing in this state may be sold as live.
- **PARTIAL**: something real exists; *Missing work* says exactly what does not.
- **NOT BUILT**: no implementation.
- **INTENTIONALLY DEFERRED**: explicit product decision (multi-outlet / multi-restaurant).

(Before 10-08 the file used COMPLETE / PRODUCTION VERIFICATION REQUIRED / DEFERRED for the first, second and last of these; the rows were renamed mechanically, and every row changed by hand is listed in the pass section.)

Priority: P0 correctness/security, P1 core operations, P2 finance/inventory/procurement/kitchen/POS completeness, P3 customer/CRM/comms, P4 mobile, P5 reservations/reputation/staff, P6 aggregators/integrations, P7 advanced/optional.

Paths are relative to the repo root. `svc/` = `src/server/services/`, `bo/` = `src/features/backoffice/`.

---

## Summary

See the bottom of this file ("Totals") for counts. The proposal's **core back office**
(modules 01 to 09, pages 4 to 12) is where RESTORA is strongest; the proposal's
**optional** layer (section 05, pages 15 to 17) is where most NOT BUILT rows are.


## Stabilization pass 2026-10-08 (after commit `d922cda`)

What this pass checked, and what it changed in this file. Evidence is in `docs/stabilization-report.md`.

**Rows corrected by hand** (they were stale: the code and tests existed and the audit still said NOT BUILT / PARTIAL):
ME-01, ME-02, ME-03, KP-05, KP-06, IN-02, MD-10, AD-10, AD-17 (group 4: now IMPLEMENTED + VERIFIED); PS-05, PA-06, AD-03, AG-02 (group 5: IMPLEMENTED + NOT EXTERNALLY VERIFIED); AG-03, PS-08, MD-20 (group 5: IMPLEMENTED + VERIFIED); IN-09 (stays PARTIAL, text corrected: a report exists, a chart does not).

**Screens with no automated test** (service and API are tested; the screen was only exercised by hand): Finance > Aggregators (`aggregators.tsx`), Integrations > Accounting mapping / sync cards and Sheets panel (`integrationsSync.tsx`), the Integrations control room. `/analytics/departments` (department P&L, daily costing) has a jsdom test but no browser spec.

**Post-save navigation stall (was open):** fixed in the follow-up pass; root cause was the route-level `loading.tsx` under `(app)` (Next 15.5 router race), see `docs/stabilization-report.md` section 4.

**Defects fixed in this pass:** the aggregator provider factory returned the mock in production (status pushes were recorded as SENT without any platform being contacted; connection tests reported success); the demo seed's reconciliation date used the host's calendar day instead of the outlet's business day (made `e2e/money-desk.spec.ts` fail between 18:30 and 24:00 UTC); `tests/desktop/shell-policy.test.ts` asserted a Windows path on every OS; the desktop CI jobs never installed Playwright's Chromium (`STARTER-002` could not launch).

---

## Module 01: Master data (p. 4)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MD-01 | M01 p4 | Raw material catalogue with short code (RM-0001), category | IMPLEMENTED + VERIFIED | `Material.sku`, `MaterialCategory`; `svc/masterData.ts`; `/master/materials` | none | P1 | | `tests/domain/master-data.test.ts`, `e2e/catalog.spec.ts` |
| MD-02 | M01 p4 | Material brand | NOT BUILT | none | brand field + form | P7 | | |
| MD-03 | M01 p4 | Purchase unit vs stock unit + conversion factor | IMPLEMENTED + VERIFIED | `Material.purchaseUnitId`, `baseUnitId`, `UnitConversion` (global + per material); `/master/units` | none | P1 | | master-data tests |
| MD-04 | M01 p4 | PAR level | IMPLEMENTED + VERIFIED | `Material.reorderLevel` (reorder point), `minStock` (safety stock), optional `parLevel` (order up to; group 2, never below the reorder level); material form | none | P1 | | master-data tests, reorder test F7 |
| MD-05 | M01 p4 | Default vendor and last purchase price | IMPLEMENTED + VERIFIED | `Material.preferredVendorId`, `VendorMaterial.preferred/lastRate`, `OutletMaterialCost.lastCost` | none | P1 | | |
| MD-06 | M01 p4 | Recipe builder from raw materials and sub-recipes | IMPLEMENTED + VERIFIED | `Recipe/RecipeVersion/RecipeLine`, `svc/recipe.ts`, `/recipes` | none | P1 | | `tests/domain/recipes.test.ts`, `recipe-cycle.test.ts`, `e2e/catalog.spec.ts` |
| MD-07 | M01 p4 | Nested sub-recipes up to 12 levels, cycle-safe | IMPLEMENTED + VERIFIED | `explodeRecipe` MAX_DEPTH + cycle guard, `src/domain/recipe/cycle.ts` | none | P1 | | recipe-cycle tests |
| MD-08 | M01 p4 | Change a sub-recipe once, all dishes re-cost | IMPLEMENTED + VERIFIED | costing is computed live from versions + `OutletMaterialCost.avgCost` | none | P1 | | recipes tests |
| MD-09 | M01 p4 | Yield portions per recipe | IMPLEMENTED + VERIFIED | `RecipeVersion.yieldQty/yieldUnitId/servingSize` | none | P1 | | |
| MD-10 | M01 p4 | Overhead % per recipe | IMPLEMENTED + VERIFIED | `RecipeVersion.overheadPct` (default 0): plate cost = ingredient cost x (1 + overhead %); food cost % stays ingredients / price; the recipe form sends it; a later overhead edit never rewrites sale-time history (frozen `OrderItem.unitCost`) | none | P7 | MD-06 | costing-engineering tests (F1, E2b); no browser spec for the recipe form field |
| MD-11 | M01 p4 | Live cost per plate, selling price, gross margin, food-cost % | IMPLEMENTED + VERIFIED | `menuItemCostAndMargin`, recipe/menu screens | none | P1 | | catalog E2E |
| MD-12 | M01 p4 | Recipe linked to the POS item code for auto-depletion | IMPLEMENTED + VERIFIED | `MenuItem.posCode`, POS normalisation + `UnmappedSale` mapping | none | P1 | | `tests/domain/pos-backend.test.ts` |
| MD-13 | M01 p4 | Weighted average cost re-averaged from purchase bills | IMPLEMENTED + VERIFIED | `recordPurchaseReceipt` updates `OutletMaterialCost` | none | P1 | | inventory-procurement tests |
| MD-14 | M01 p4 | Theoretical consumption per dish sold | IMPLEMENTED + VERIFIED | `consumeInventoryForOrder` (SALE_CONSUMPTION) | none | P1 | | flows tests |
| MD-15 | M01 p4 | Vendor master: GSTIN, bank / UPI details, payment terms, contacts | PARTIAL | `Vendor` (gstin, bankAccount, bankIfsc, upiId, paymentTerms, phone, email; masked without vendor.manage) | nature of supply, vendor category, multiple contact people | P2 | | master-data tests |
| MD-16 | M01 p4 / M02 p5 | New vendors start PENDING and must be approved; Active / Inactive / Blacklisted; buying from an unapproved vendor is blocked | IMPLEMENTED + VERIFIED | `Vendor.status` + `VENDOR_STATUS_TRANSITIONS`, `setVendorStatus` (approval needs org-wide purchase.approve; other moves vendor.manage; blacklist needs a reason, lifting returns to PENDING); PO / GRN / direct bill creation and PO submit/approve/order refuse non-ACTIVE vendors; bills for received goods and dues payments stay possible; vendor screens show status and actions; UPI id masked like bank details (group 1, 10-07) | none | P0 | MD-15 | `tests/domain/core-gaps.test.ts`, `master-data.test.ts` |
| MD-17 | M01 p4 | Full purchase and payment history per vendor; downloadable statement | IMPLEMENTED + VERIFIED | `vendorStatement`, `/api/finance/vendor-statement`, vendor detail page | none | P2 | | `tests/domain/finance-p4.test.ts` |
| MD-18 | M01 p4 | Departments (Store / Kitchen / Bar / Bakery) | IMPLEMENTED + VERIFIED | `Department.kind`, `/settings/departments` | none | P1 | | |
| MD-19 | M01 p4 | Material categories / vendor categories / cuisine tags | PARTIAL | material categories | vendor categories, cuisine tags on menu items | P7 | | |
| MD-20 | M01 p4 | Outlet settings, POS credentials, aggregator commission % | IMPLEMENTED + VERIFIED | `Outlet` settings, `IntegrationConnection` (encrypted credentials), `Aggregator.commissionPct` editable on the Aggregators screen (integration.manage, audited with before / after, validated) | none | P6 | AG-* | aggregator-finance test (AF1), integrations tests; the screen has no automated UI or browser test |
| MD-21 | M01 p4 | Bulk import from Excel | PARTIAL | Coders' Cafe starter menu import (`svc/starterMenu.ts`) | generic CSV/Excel import for materials, recipes, vendors | P7 | | starter-menu tests |

## Module 02: Procure-to-pay (p. 5)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PP-01 | M02 p5 | Reorder engine: everything below PAR sorted by days of cover from the last 14 days of real consumption | IMPLEMENTED + VERIFIED | `svc/reorder.ts` (group 2, 10-08): live from the ledger at one `asOf`; net usage over the window (7 to 90 days, default 14) divided by the days observed; reorder point = max(reorder level, minimum) raised to minimum + usage x lead time when history is long enough; stock position nets open POs, open indents and draft GRNs without a PO; sorted by priority then days of cover; draft-only cover listed separately; `/procurement/reorder` | none | P1 | MD-04 | `tests/domain/reorder.test.ts`, `tests/api/reorder-routes.test.ts`, `tests/db/reorder-concurrency.test.ts`, `tests/ui/procurement-reorder.test.tsx` |
| PP-02 | M02 p5 | Suggested order quantity, estimated spend at current average cost, usual vendor pre-filled, total budget | IMPLEMENTED + VERIFIED | order up to `Material.parLevel` (or the reorder level), rounded up to whole purchase packs or 4 dp; spend at outlet average cost (else last cost); vendor = ACTIVE vendors only (preferred, preferred link, lowest rate, shortest lead time), blocked preferred vendor explained; vendor price comparison; budget and per-vendor totals | none | P1 | PP-01, MD-16 | reorder tests (A, D, F6) |
| PP-03 | M02 p5 | Raise POs from the reorder screen, pre-filled | IMPLEMENTED + VERIFIED | `POST /api/procurement/reorder/purchase-orders` (one DRAFT PO per vendor, purchase unit at base rate x factor) and `/reorder/indents`; mandatory Idempotency-Key, one transaction, Group 1 vendor gate before any write, 409 when stock was ordered since the screen loaded (concurrent raises: exactly one wins); audit records suggestion vs order; nothing auto-submitted or approved | none | P1 | PP-01 | reorder tests (C, E, F, I), concurrency test on SQLite and PostgreSQL |
| PP-04 | M02 p5 | Vendor PO and internal indent share one queue; status tabs | IMPLEMENTED + VERIFIED | `svc/procurementQueue.ts` + `GET /api/procurement/queue`: purchase orders and indents in one list, newest first, tabs Needs approval / In progress / Done / All with counts, kind filter, paging by (createdAt, id) across both tables; `/procurement/queue` with Approve on submitted rows (same endpoint and permission as the document); a kitchen login sees indents only, with no amounts | none | P7 | | `tests/domain/procurement-queue.test.ts` (Q1–Q3, SQLite + PostgreSQL), `tests/ui/procurement-queue.test.tsx`, `e2e/procurement-queue.spec.ts` (PROC-Q-001) |
| PP-05 | M02 p5 | Admin approval gate; PO status only moves forward | IMPLEMENTED + VERIFIED | `PURCHASE_ORDER_TRANSITIONS`, `purchase.approve` | none | P0 | | workflows tests, `e2e/backoffice-ops.spec.ts` |
| PP-06 | M02 p5 | Line-level approve / edit quantity / reject | PARTIAL | whole-document approve/reject | per-line approval status | P2 | | |
| PP-07 | M02 p5 / S06 p18 | Approval rules: skip for small orders, second approver for large ones | NOT BUILT | single approver | configurable thresholds | P7 | | |
| PP-08 | M02 p5 | Store dispatches an indent; stock moves department to department | PARTIAL | indents (purchase requests) and issues (dept to dept, ledger) both exist | link an issue to the indent it fulfils | P2 | | |
| PP-09 | M02 p5 | Receiving a PO writes stock automatically (actual qty and rate) | IMPLEMENTED + VERIFIED | `createGRN` + `postGRN` -> PURCHASE_RECEIPT, re-average | none | P0 | | inventory-procurement tests, backoffice-ops E2E, `tests/db/stock-post-concurrency.test.ts` (one GRN posted twice at once: received once) |
| PP-10 | M02 p5 | Short delivery and price-spike flag at receipt | IMPLEMENTED + VERIFIED | GRN qty vs PO qty, `detectAnomalies` PRICE_SPIKE | none | P1 | | anomaly tests |
| PP-11 | M02 p5 | Bill creates a payable due | IMPLEMENTED + VERIFIED | `createPurchaseBill`, unique vendor invoice no | none | P0 | | |
| PP-12 | M02 p5 | Dues tracker per vendor (purchased, paid, outstanding) | IMPLEMENTED + VERIFIED | `vendorDues`, `vendorAging` | none | P1 | | finance-p4 tests |
| PP-13 | M02 p5 | Payment run: record payment with mode and reference; cannot be deleted or silently altered | IMPLEMENTED + VERIFIED | `payVendor` (idempotent), reversal keeps the row (`reverseVendorPayment`) | none | P0 | | finance-p4 tests |
| PP-14 | M02 p5 | Accounting CSV for Tally / Zoho Books | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `svc/accounting.ts` vouchers, exports | confirm import into a real Tally / Zoho company | P6 | | `tests/domain/integrations-p7.test.ts` |
| PP-15 | M02 p5 | Every action stamped with staff, outlet and time | IMPLEMENTED + VERIFIED | `createdById/actorId`, `AuditLog` | none | P0 | | |

## Module 03: Inventory control (p. 6)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| IN-01 | M03 p6 / S09 p21 | Append-only ledger, balances derived, corrections are new rows | PARTIAL | `InventoryLedger`, `appendLedger` single writer, `recordCorrection`; enforced in the services | the proposal says "the database physically refuses" edits: PostgreSQL triggers / RLS are design only | P0 | SE-08 | `tests/db/invariants.test.ts` |
| IN-02 | M03 p6 | Live stock matrix: materials x departments, qty and value at WAC | IMPLEMENTED + VERIFIED | `stockMatrix` (group 4): every material against every department, qty and flags, valued at average cost for cost viewers only; kitchen sees quantities only and has no export; `/inventory/matrix` | none | P1 | IN-11 | advanced-inventory test (M1), costing-screens test, `e2e/costing.spec.ts` (G4-MX-001, G4-MX-002) |
| IN-03 | M03 p6 | Stock value grouped by category | IMPLEMENTED + VERIFIED | analytics inventory value by category | none | P2 | | analytics tests |
| IN-04 | M03 p6 | Below-PAR highlighted, negative stock flagged | IMPLEMENTED + VERIFIED | `lowStock`, `negativeStock`, Stock screen | none | P1 | | |
| IN-05 | M03 p6 | Full movement history per material | IMPLEMENTED + VERIFIED | `/inventory/stock/[materialId]`, ledger filters | none | P1 | | |
| IN-06 | M03 p6 | Issue to kitchen (cost follows stock) | IMPLEMENTED + VERIFIED | `createIssue/postIssue`: OUT of the source department (or unassigned stock) and IN to the required destination department at the same cost; WAC and last price untouched (group 1, 10-07). Before: the issue removed stock from the outlet and the sale removed it again. Legacy posted issues are not backfilled (decision 10-07): a stock count corrects them | none | P0 | | `tests/domain/inventory-procurement.test.ts`, `workflows.test.ts`, `tests/db/stock-post-concurrency.test.ts` (one issue posted twice at once moves stock once; both requests answer) |
| IN-07 | M03 p6 | Inter-department transfer, nets to zero | IMPLEMENTED + VERIFIED | same issue document between any two departments; the outlet total is unchanged; source-department availability enforced | none | P1 | IN-06 | inventory-procurement tests (concurrency + shortage) |
| IN-08 | M03 p6 | Stock count sheet pre-filled, variance qty and rupees, accept posts reconciliation | IMPLEMENTED + VERIFIED | `StockCount` freeze -> count -> review -> approve -> COUNT_ADJUSTMENT | none | P1 | | workflows tests |
| IN-09 | M03 p6 | Variance trend over time | IMPLEMENTED + VERIFIED | `countVarianceTrend` (one row per approved count: loss, surplus, net) delivered as the report COUNT_VARIANCE_TREND (table / CSV) and, on the report screen, a chart of loss and surplus per count with the verdict in words ("the leak is closing / widening / steady", first half of the counts against the second half; `features/backoffice/varianceTrend.tsx`) | none | P2 | | advanced-inventory test (T1) for the data, `tests/ui/variance-trend.test.tsx` for the verdict and the chart; no browser spec for the chart |
| IN-10 | M03 p6 | Wastage at raw material level with reason and department, costed at average rate | IMPLEMENTED + VERIFIED | `Wastage` documents, `recordWastage`; back-dated `occurredAt` ledgers on the day of the loss; refused into a closed day; line costs hidden from logins without cost rights (group 3); one document posted twice at the same moment moves stock once and the second request gets a clean 422 (gate 10-08: `isLedgerKeyRace` in `server/db/conflict.ts`, re-run by `runInTx`; before, PostgreSQL answered 500) | none | P1 | | production-wastage tests, `tests/domain/kitchen-production.test.ts` (W), `tests/db/stock-post-concurrency.test.ts` |
| IN-11 | M03 p4/p6/p7 | Sales depletion from the right department | IMPLEMENTED + VERIFIED | `consumeInventoryForOrder` depletes the department whose kind matches the line's station (KITCHEN / BAR / BAKERY), unassigned stock when there is none (group 3) | none | P1 | | `tests/domain/kitchen-production.test.ts` (P1) |
| IN-12 | M03 p6 | Wastage at dish level ("3 pizzas") | IMPLEMENTED + VERIFIED | `createDishWastage` (recipe exploded at plate cost, from the dish's department); wastage screen "Whole dishes" mode; the worksheet logs wasted portions through the same register (one stock path) | none | P2 | | `tests/domain/kitchen-production.test.ts` (W1, S2, S3), `tests/ui/group3-screens.test.tsx` |
| IN-13 | M03 p6 | Manual sale (dish sold outside the POS) depletes stock | IMPLEMENTED + VERIFIED | `svc/manualSales.ts`: one settled MANUAL order at menu price, back-dated to the business day, idempotent, depletes once; "Log dish sales" on the worksheet and the money desk; refused into a closed day | none | P1 | | `tests/domain/kitchen-production.test.ts` (M1), `tests/api/group3-routes.test.ts`, `tests/domain/money-desk.test.ts`, `tests/db/stock-post-concurrency.test.ts` (the same log sent twice at once: one order, consumed once, the second answer is the replay; before the gate PostgreSQL answered it with a raw unique-constraint error) |
| IN-14 | S06 p18 | Batch numbers, expiry dates, FSSAI lot codes | PARTIAL | `batchNo/expiryDate` on GRN lines, ledger, production | expiry alerts, FSSAI lot field, FEFO | P7 | | |

## Module 04: POS and sales automation (p. 7)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PS-01 | M04 p7 | POS webhook per outlet key, signature checked, duplicate-proof | IMPLEMENTED + VERIFIED | `/api/webhooks/pos/[provider]`, `WebhookEvent` unique, `IntegrationConnection.externalRef` tenant binding | none | P0 | | webhooks-reconciliation, webhook-tenant tests |
| PS-02 | M04 p7 | Petpooja integration live | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `src/integrations/pos/petpooja.ts` field mapping (skeleton for live pull) | run against a Petpooja account, finish the mapping from a real payload | P6 | credentials | |
| PS-03 | M04 p7 | Recipe explosion, cycle-safe, 12 levels, costed at average rate | IMPLEMENTED + VERIFIED | `explodeRecipe`, `consumeInventoryForOrder` | none | P0 | | flows tests |
| PS-04 | M04 p7 | Unmapped sales queue; map once from a dropdown | IMPLEMENTED + VERIFIED | `UnmappedSale`, `svc/unmapped.ts`, anomaly | none | P1 | | pos-backend tests |
| PS-05 | M04 p7 | Nightly re-pull at 1:30 AM fills gaps; never double counts | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `runNightlyPosRepull` in `server/ops/scheduled.ts` (group 5), run by the worker tick (`runScheduledJobs`): at 01:30 on the outlet's own clock, yesterday's business day is re-pulled with auto-import, once per outlet per day (`JobRun` claim), failures recorded with a safe reason, retried after an hour, at most three attempts; an order the webhook already delivered is never imported or consumed twice | a live POS adapter: the Petpooja adapter is a mapping skeleton (PS-02), so no real provider has ever been pulled | P2 | PS-02 | `tests/domain/scheduled-jobs.test.ts` (J1-J5, mock provider, SQLite + PostgreSQL) |
| PS-06 | M04 p7 | Daily revenue and covers; sales by channel; day-part; item-wise CSV | IMPLEMENTED + VERIFIED | `dailySales`, `dayPartSales`, reports + CSV | none | P2 | | analytics tests |
| PS-07 | M04 p7 | Manual sales log for a day (no POS) | IMPLEMENTED + VERIFIED | see IN-13 | none | P1 | | see IN-13 |
| PS-08 | M04 p7 | Aggregator gross and net after commission | IMPLEMENTED + VERIFIED | `AggregatorOrder` gross / commission / net payout; aggregator admin screen and the platform and per-dish net margin report (group 5, `svc/aggregatorFinance.ts`, `/finance/aggregators`) | none | P6 | AG-* | `tests/domain/aggregator-finance.test.ts` (AF1, AF7, AF8); the screen has no automated UI or browser test |

## Module 05: Kitchen production (p. 8)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| KP-01 | M05 p8 | Dish production worksheet: prepared (chef), sold (auto), wastage (chef), variance, wastage cost at plate cost | IMPLEMENTED + VERIFIED | `svc/productionWorksheet.ts`, `/inventory/worksheet`: prepared entered, sold from settled orders, wasted = posted dish-wastage documents (pending approval shown apart), unexplained gap and its cost at plate cost; costs hidden from the kitchen; preparing does not move stock (no double consumption) | none | P1 | IN-11 | `tests/domain/kitchen-production.test.ts` (S), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `tests/db/stock-post-concurrency.test.ts` (a double-tapped "add wasted" is one document posted once; before the gate the second tap answered 422), `e2e/money-desk.spec.ts` (G3-KP-001) |
| KP-02 | M05 p8 | Sub-recipe batch production (consumes inputs, costs the batch, per-unit rate) | IMPLEMENTED + VERIFIED | `ProductionBatch`, `svc/production.ts`; group 3: only batch-produced sub-recipes (`Recipe.stocked`) can be produced and dishes draw on their prepared stock (fixed raw materials being consumed twice), department per batch, partial yield / corrected inputs, idempotent planning; the batch page shows the batch cost, cost per unit, yield against the plan, department and who planned / completed it, read from the ledger rows the batch posted (costs left out for the kitchen) (`getProductionBatch`, gate 10-08) | none | P1 | | production-wastage tests, `tests/domain/kitchen-production.test.ts` (P1-P6), `tests/db/stock-post-concurrency.test.ts` (one completion of a batch, competing batches never take a department negative, SQLite + PostgreSQL), `tests/ui/backoffice.test.tsx` (batch page) |
| KP-03 | M05 p8 | Daily view of what each department produced | IMPLEMENTED + VERIFIED | dish worksheet per day with department filter; batches carry their department (list column, API filter) | none | P2 | | `tests/domain/kitchen-production.test.ts`, `tests/ui/group3-screens.test.tsx` |
| KP-04 | M05 p8 | Kitchen's own workspace without vendor pricing, dues or P&L | IMPLEMENTED + VERIFIED | KITCHEN role: wastage, production, worksheet, dish sales log, raise / submit / withdraw indents (`indent.create`); costs removed server-side for logins without reports / purchase / finance access (stock, ledger, movements, counts, wastage, worksheet, recipe cost and margin are 403 or blank); material names from the outlet stock list | none | P1 | | `tests/domain/kitchen-production.test.ts` (W2, K1), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, backoffice-support tests |
| KP-05 | M05 p8 | Department P&L: sales value, cost issued in, wastage, gross margin, margin % | IMPLEMENTED + VERIFIED | `departmentPnl` in `svc/departmentCosting.ts` (group 4): sales by the station's department, cost issued in and wastage from the ledger, margin and margin %; store departments hold stock and are not listed; CSV export; `/analytics/departments` | none (the screen has a jsdom test but no browser spec) | P2 | IN-11 | `tests/domain/advanced-inventory.test.ts` (P1, X1), `tests/ui/costing-screens.test.tsx` ("department costing") |
| KP-06 | M05 p8 | Daily costing view: opening, receipts, issues, consumption, closing per department per day | IMPLEMENTED + VERIFIED | `dailyCosting`: opening + receipts - issues out - consumption - wastage + adjustments = closing, and the closing equals the department's ledger value; the screen refuses more than 31 days before asking the server | none (jsdom test only, no browser spec) | P2 | IN-11 | advanced-inventory test (P2), costing-screens test |

## Module 06: The money desk (p. 9)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MO-01 | M06 p9 | Daily close: collected per method vs expected | IMPLEMENTED + VERIFIED | PAYMENTS reconciliation, completed and locked by the day close (`svc/moneyDesk.ts closeDay`); a day without payments is counted from the screen too (cash drawer row; before the gate such a day could not be closed from the UI) | none | P1 | | finance tests, `tests/domain/money-desk.test.ts`, `tests/db/day-close-concurrency.test.ts`, `e2e/money-desk.spec.ts` (G3-MD-001) |
| MO-02 | M06 p9 | Three-way check: POS rang vs declared vs reached the bank, with aggregator commission | IMPLEMENTED + VERIFIED | `/finance/money-desk`: billed per channel vs declared (SALES reconciliation), menu-price cross-check, commission at the stored % (or recorded), expected to bank vs deposits; exception lines and bank gaps raise anomalies at close; a no-sales day is declared as zero (dine-in row) | none | P1 | MO-01 | `tests/domain/money-desk.test.ts`, `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `e2e/money-desk.spec.ts` (G3-MD-001: declare, count, deposit, close, locked, unexpected deposit raised as a discrepancy, reopen with password; runs on every E2E pass, it used to skip itself) |
| MO-03 | M06 p9 | Petty cash register with category, MTD and category breakdown | IMPLEMENTED + VERIFIED | `PettyCashTxn`, petty cash screen; money desk shows the day's opening / in / out / closing and month-to-date by category; refused into a closed day | none | P2 | | finance tests, `tests/domain/money-desk.test.ts` |
| MO-04 | M06 p9 | Manager workspace: vendor dues, petty cash, recent reconciliations, sales-log form | IMPLEMENTED + VERIFIED | money desk page: vendor dues, petty cash (day + month), recent closes, "Log dish sales" | none | P2 | PS-07 | `tests/ui/group3-screens.test.tsx` |
| MO-05 | M06 p9 | Cash drawer sessions with variance | IMPLEMENTED + VERIFIED | `CashDrawerSession` | none | P2 | | finance tests |
| MO-06 | M06 p9 | Bank deposit recording | IMPLEMENTED + VERIFIED | `BankDeposit` (cash slips and UPI / card credits per sales day, reference, account; void with reason and re-auth, never deleted; allowed after the close) | none | P2 | | `tests/domain/money-desk.test.ts`, `tests/api/group3-routes.test.ts` |

## Module 07: Menu engineering (p. 10)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| ME-01 | M07 p10 | Star / Plow-horse / Puzzle / Dog from median volume and median margin of the own menu | IMPLEMENTED + VERIFIED | `svc/menuEngineering.ts` `menuEngineering` (group 4): median volume / median margin % of this menu, the proposal's four verdicts and advice, every size counted as a dish sold; no verdict without data (E5, E6); `/analytics/menu-engineering` | none | P1 | MD-11 | `tests/domain/costing-engineering.test.ts` (E1, E5, E6, E7), `tests/ui/costing-screens.test.tsx`, `e2e/costing.spec.ts` (G4-ME-001) |
| ME-02 | M07 p10 | Report: price, plate cost, margin, food cost %, sold, verdict, what to do; any date range | IMPLEMENTED + VERIFIED | same report: price, plate cost, margin, food cost %, units sold, verdict, advice, historical plate cost and change; any date range; CSV through the export endpoint (formulas neutralised) | none | P1 | ME-01 | costing-engineering tests (E2, E2b, E3, E8), costing-screens test, `e2e/costing.spec.ts` (G4-ME-001: verdicts or the reason there are none, and a CSV) |
| ME-03 | M07 p10 | Re-cost anything over 38% food cost | IMPLEMENTED + VERIFIED | `HIGH_FOOD_COST_PCT = 38`: a dish above it carries the re-cost advice, also when it is too early to classify | none | P1 | ME-01 | costing-engineering tests (E1, E5), costing-screens test |
| ME-04 | S05 p16 | Upsell prompts driven by menu-engineering data | IMPLEMENTED + VERIFIED | `svc/upsell.ts` (`upsellSuggestions`: dishes paid-ordered together at this outlet (60 days, ≥2 orders) first, then menu-engineering PUZZLE / STAR dishes; never sold-out, switched-off, inactive or already-ordered dishes; reason in words, menu price only, never cost or margin); `GET /api/menu/upsell`; `UpsellStrip` on the POS and the captain app, one tap adds the dish | none | P4 | ME-01 | `tests/domain/upsell.test.ts` (U1–U5, SQLite + PostgreSQL), `tests/api/kitchen-menu-routes.test.ts`, `tests/ui/upsell-strip.test.tsx` |

## Module 08: Cost, profit and alerts (p. 11)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| CP-01 | M08 p11 | Leakage report: revenue, theoretical food cost, wastage, count variance, actual food cost, leakage gap, % of sales | IMPLEMENTED + VERIFIED | `foodCostLeakage` + per-material `consumptionVariance` (`svc/variance.ts`), `/inventory/variance` | none | P1 | | `tests/domain/kitchen-production.test.ts` (V1), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `tests/domain/reports.test.ts` (CONSUMPTION_VARIANCE rows + CSV, outlet scope) |
| CP-02 | M08 p11 | Anomaly: negative stock | IMPLEMENTED + VERIFIED | `detectAnomalies` | none | P1 | | anomaly tests |
| CP-03 | M08 p11 | Anomaly: large count variance | IMPLEMENTED + VERIFIED | `detectAnomalies` COUNT_VARIANCE | none | P1 | | anomaly tests |
| CP-04 | M08 p11 | Anomaly: vendor price spike | IMPLEMENTED + VERIFIED | PRICE_SPIKE | none | P1 | | anomaly tests |
| CP-05 | M08 p11 | Anomaly: unmapped POS item | IMPLEMENTED + VERIFIED | UNMAPPED_ITEM | none | P1 | | |
| CP-06 | M08 p11 | Anomaly: heavy item wastage | IMPLEMENTED + VERIFIED | HEAVY_WASTAGE | none | P1 | | anomaly tests |
| CP-07 | M08 p11 / S05 p16-17 | Morning digest on WhatsApp / email / notification (9 AM summary) | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `buildDigest` (previous business day: orders, revenue net of refunds, average order, unhappy feedback, items to reorder, open anomalies) shown as a notification and a Growth settings preview; sent to the owner's number when set | a real provider for the message (the in-app summary needs none) | P3 | CM-* | `growth-lifecycle` (L5), `tests/ui/growth-screens.test.tsx` |
| CP-08 | M08 p11 | Financial overview KPIs, revenue trend, vendor cash-flow, variance by category, stock value by category, daily P&L, day-part, preset ranges | IMPLEMENTED + VERIFIED | `/analytics`, `financeOverview`, reports | none | P2 | | analytics tests, `tests/ui/analytics.test.tsx` |

## Module 09: People, access and growth (p. 12)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PA-01 | M09 p12 | Six role levels (Owner, Area Manager, Admin, Manager, Store, Kitchen) | IMPLEMENTED + VERIFIED | `ROLE_PERMISSIONS` (+ Captain, Cashier) | none | P0 | | rbac E2E, auth tests |
| PA-02 | M09 p12 / S09 p21 | Enforced at the database itself (RLS) | PARTIAL | enforced in every service (`assertCan`, org/outlet scope); RLS is design only (`docs/postgres-rls.md`) | apply PostgreSQL RLS policies | P0 | PostgreSQL deploy | org-isolation tests |
| PA-03 | M09 p12 | Staff invite by name, email and role; set own password; re-send or copy | PARTIAL | `createStaff`, `issuePasswordLink` (copy link) | sending the invite email (needs email provider) | P3 | email provider | password-lifecycle tests |
| PA-04 | M09 p12 | Removing someone revokes access instantly; name stays on records | IMPLEMENTED + VERIFIED | `setUserActive` kills sessions; actor ids kept | none | P0 | | rbac E2E |
| PA-05 | M09 p12 | Universal search with keyboard shortcut (vendors, materials, recipes, POs, indents, bills, departments, categories, staff) | IMPLEMENTED + VERIFIED | `svc/search.ts` (`universalSearch`: customers, menu items, materials, vendors, recipes, orders / invoices, tables, purchase orders, staff; each group only with the permission that opens that kind of thing elsewhere; outlet-limited; case-insensitive on both databases; `%` and `_` searched literally); `GET /api/search` (rate-limited); `SearchPalette` in the top bar, Ctrl/⌘+K or "/", arrow keys, Enter, Esc | indents and goods receipts are not searched (their screens have their own filters) | P2 | | `tests/domain/search.test.ts` (7, SQLite + PostgreSQL), `tests/api/search-route.test.ts`, `tests/ui/search-palette.test.tsx`, `e2e/search.spec.ts` (SEARCH-001/002) |
| PA-06 | M09 p12 | Google Sheets two-way sync | IMPLEMENTED + NOT EXTERNALLY VERIFIED | group 5: `svc/sheetsSync.ts` + `src/integrations/sheets` (Sheets API v4, service-account JWT, values written RAW): materials two-way (team edits applied through master-data service, audited; conflicts never overwritten, a person settles them), stock / vendor dues / daily sales push-only, lease against concurrent syncs, a tab that is not ours is never overwritten; Integrations > Sheets panel | never run against a real spreadsheet (emulator of the documented request / response shapes and an in-memory mock only); the panel has no automated UI or browser test | P6 | Google credentials | `tests/domain/sheets-sync.test.ts` (H1-H11), `tests/integrations/group5-adapters.test.ts` |
| PA-07 | M09 p12 | CSV exports for Tally / Zoho / CA | IMPLEMENTED + VERIFIED | reports CSV, export jobs, accounting export | none | P2 | | export tests |
| PA-08 | M09 p12 | Multi-outlet: portfolio roll-up, outlet switcher, team per outlet, RLS isolation | INTENTIONALLY DEFERRED | outlet switcher and per-outlet scoping exist; portfolio page and org-wide roll-up architecture deferred | product decision | — | | |

## Section 03 / 04 / 06 / 09 (pp. 13, 14, 18, 21): cross-cutting claims

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| XC-01 | S02 p3 / S09 p21 | Daily encrypted backups, point-in-time recovery | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `scripts/ops/pg-backup.mjs`, `pitr-drill.mjs`, desktop backups, backup freshness check | scheduled job on real hosting | P0 | hosting | `tests/desktop/backup.test.ts`, DR drill |
| XC-02 | S09 p21 | Export everything to CSV at any time | IMPLEMENTED + VERIFIED | reports + export jobs | none | P2 | | |
| XC-03 | S06 p18 | Add a department yourself | IMPLEMENTED + VERIFIED | departments screen | none | P2 | | |
| XC-04 | S06 p18 | Own vocabulary (rename "indent" etc.) | NOT BUILT | | label dictionary | P7 | | |
| XC-05 | S06 p18 | Interface in Telugu or Hindi, per user | NOT BUILT | | i18n | P7 | | |
| XC-06 | S06 p18 | Reports grouped by cuisine, chef, shift | NOT BUILT | | | P7 | MD-19 | |
| XC-07 | S09 p21 | Cloud-hosted in Mumbai, HTTPS | IMPLEMENTED + NOT EXTERNALLY VERIFIED | deployment docs and rehearsal | real hosting | P0 | hosting | `docs/production-infrastructure.md` |

## Section 05: QR ordering and own website (p. 15)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| QR-01 | S05 p15 | Physical table QR, secure token, table known; invalid / disabled QR handled | IMPLEMENTED + VERIFIED | `RestaurantTable.qrToken`, rotate/revoke, `/t/[token]` | none | P0 | | `tests/domain/qr-transaction.test.ts`, `e2e/storefront.spec.ts` |
| QR-02 | S05 p15 | Menu with categories, search, variants, modifiers; sold-out hidden | IMPLEMENTED + VERIFIED | guest storefront, server pricing | none | P1 | | guest-storefront tests |
| QR-03 | S05 p15 | Photos and allergens on the guest menu | NOT BUILT | | image + allergen fields, upload | P3 | | |
| QR-04 | S05 p15 | Notes, cart, server-side price revalidation, duplicate submission protection | IMPLEMENTED + VERIFIED | quote route, idempotent placement | none | P0 | | guest-storefront, storefront E2E |
| QR-05 | S05 p15 | Kitchen gets it instantly (KOT) | IMPLEMENTED + VERIFIED | placement -> KOT (cash after staff confirmation) | none | P0 | | investor E2E |
| QR-06 | S05 p15 | Pay from the phone (UPI / card / wallet) via Razorpay; webhook authoritative | IMPLEMENTED + NOT EXTERNALLY VERIFIED | Razorpay Checkout + webhook + recovery; emulator tested | run with `rzp_test_` keys and one phone payment | P0 | Razorpay keys | `tests/integrations/razorpay.test.ts`, investor E2E |
| QR-07 | S05 p15 | Order tracking, bill, customer can only see own order | IMPLEMENTED + VERIFIED | `/o/[orderId]` with order key | none | P0 | | guest tests |
| QR-08 | S05 p15 | Split bill from the phone; re-order in 2 taps | NOT BUILT | | guest-side "order the same again" and a bill split by the guest from the phone (staff can already split and merge: MB-03); needs the order's lines exposed to the guest page and a guest-side split rule | P3 | |  |
| QR-09 | S05 p15 | Own ordering website: delivery and takeaway, delivery radius, slots, pre-order | NOT BUILT | QR dine-in storefront only | delivery/takeaway channel, address, radius rules | P3 | | |
| QR-10 | S05 p15 | Coupons, first-order offers, referral links | IMPLEMENTED + VERIFIED | coupons (`Coupon`: percent / fixed, cap, minimum order, validity, usage and per-guest limits, first order only, minimum tier, order types, stackable) priced by the server through the order discount; guest cart shows the saving; the POS takes a code; one redemption per order, reversed on cancel or full refund; referral links (CR-06) | none | P3 |  | `tests/domain/growth-coupons.test.ts` (K1-K10), `tests/api/growth-routes.test.ts` (R2b, R3), `tests/ui/growth-guest.test.tsx`, `e2e/growth.spec.ts` (GROWTH-002, -003) |
| QR-11 | S05 p15 | Brand website: gallery, story, timings, directions, booking, SEO | PARTIAL | Coders' Cafe storefront About / Contact from outlet facts; RESTORA product site | gallery, online table booking, SEO pages per restaurant | P3 | | |
| QR-12 | S05 p15 | Price / sold-out change is live everywhere instantly | IMPLEMENTED + VERIFIED | one menu, per-outlet overrides | none | P1 | | outlet-menu tests |

## Section 05: Mobile, KDS, billing counter (p. 16)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MB-01 | S05 p16 | Guest Android app (Play Store) | NOT BUILT | responsive guest web only | native app | P4 | Play account | |
| MB-02 | S05 p16 | Captain app: table map with status and timers, order at table, modifiers, notes, sends to kitchen, sold-out shown | PARTIAL | `/captain` web app (table board, rounds, modifiers, notes, KDS status) | native Android packaging, course timing, upsell, offline | P4 | | `tests/api/mobile-routes.test.ts` |
| MB-03 | S05 p16 | Captain: split bill, merge tables, transfer table | IMPLEMENTED + VERIFIED | `svc/orderOps.ts`: `transferOrderTable` (the order and its tickets move; old table frees, new one shows the order's state; a seated reservation moves with it), `mergeOrders` (lines and tickets fold into one bill; the emptied order closes with a note; replay-safe), `splitOrder` (whole lines or part of a line onto a new bill at the same table; shared kitchen tickets divided without cooking anything twice; order discount shared by value; own invoice per bill; Idempotency-Key); `POST /api/orders/:id/transfer|merge|split`; captain app: Move / Merge / Split dialogs and a bill switcher per table (`features/mobile/OrderActions.tsx`). Refused: a bill that holds a payment or coupon cannot be split, an order with a payment / coupon / discount cannot be merged away, billed orders cannot be merged | split by guest from the guest's own phone (QR-08); equal-share split (use split tender) | P2 | | `tests/domain/order-ops.test.ts` (T1–T5, SQLite + PostgreSQL), `tests/api/order-ops-routes.test.ts`, `tests/ui/order-actions.test.tsx`, `e2e/floor-ops.spec.ts` (FLOOR-001) |
| MB-04 | S05 p16 | Captain works through a Wi-Fi drop, syncs after | NOT BUILT | | offline queue | P4 | | |
| MB-05 | S05 p16 | Owner app: sales, profit, alerts, approve PO, dues, outlets, 9 AM summary, attendance | IMPLEMENTED + VERIFIED | `/manager` web app on a phone: sales, live operations, alerts, dues, plus an **Approvals** tab: purchase orders waiting for approval at the outlet (oldest first, vendor, amount, item count, note), Approve / Reject with confirmation through the ordinary `POST /api/procurement/purchase-orders/:id/transition` (`purchase.approve` / `purchase.create` re-checked by the server, audited); `managerSummary.approvals` is null without `purchase.approve` | a store-installed native app and push notifications (MB-01; the web app polls every minute) | P4 | | `tests/domain/manager-approvals.test.ts` (M1–M4, SQLite + PostgreSQL), `tests/ui/mobile.test.tsx`, `e2e/staff-mobile.spec.ts` (MOB-002, MOB-004) |
| MB-06 | S05 p16 | KDS: tickets colour-coded by age; station lanes; bump; captain and guest see it | IMPLEMENTED + VERIFIED | `/kitchen`, `urgency()`, station filter, guest tracker | none | P1 | | KDS UI tests, order-lifecycle E2E |
| MB-07 | S05 p16 | KDS: average prep time per dish, measured | IMPLEMENTED + VERIFIED | `svc/prepTimes.ts` (`dishPrepTimes`: median / average / p90 minutes per dish from `Kot.readyAt − Kot.createdAt`, cooking-only median from Start, per-station table; cancelled, never-ready, >12 h and other-outlet tickets are not measurements; 5 tickets before a dish counts as reliable); `GET /api/kitchen/prep-times`; `/analytics/prep-times`; `kot.ts` stamps `acceptedAt/startedAt/readyAt/servedAt` | none | P2 | | `tests/domain/prep-times.test.ts` (P1–P3, SQLite + PostgreSQL), `tests/api/kitchen-menu-routes.test.ts`, `tests/ui/kitchen-timing.test.tsx` |
| MB-08 | S05 p16 | KDS late-ticket alerts before the guest complains | IMPLEMENTED + VERIFIED | KDS ticket lateness from the measured time of the slowest reliable dish on the ticket: warn at the usual time, late at max(1.5×, +3 min); READY tickets never late; fixed 10 / 20 min fallback until a dish has enough history; late border, "Running late" badge and "usually ~N min" on the card (`features/kitchen/kds.ts`, `TicketCard.tsx`, `KitchenScreen.tsx`) | none (an audible alert and a push to a phone stay with the native-app row MB-01) | P2 | | `tests/ui/kitchen-timing.test.tsx` (10), `tests/domain/prep-times.test.ts` |
| MB-09 | S05 p16 | Billing counter: keyboard entry, held bills, KOT printing | IMPLEMENTED + NOT EXTERNALLY VERIFIED | POS: `/` search, keyboard entry, a named hold list: Save keeps the bill unsent with its name and time (`Order.holdLabel`, `heldAt`, `GET /api/orders?held=true`), Held tab in Open orders (oldest first, "old" flag after 2 h), held count on the button, resume by opening it; ESC/POS KOT printing (simulated without hardware) | KOT printing on real printer hardware (PS/printer rows) | P2 | printer hardware | `tests/domain/floor-extras.test.ts` (H1–H5, SQLite + PostgreSQL), `tests/api/floor-routes.test.ts`, `tests/ui/floor-extras.test.tsx`, `e2e/floor-ops.spec.ts` (FLOOR-002); printing: see the printer rows |
| MB-10 | S05 p16 | GST invoice with logo, printed or on WhatsApp | PARTIAL | `TaxInvoice` gapless series, bill view + print | WhatsApp delivery (provider), logo upload | P3 | | invoicing tests |
| MB-11 | S05 p16 | Cash / UPI / card split tender | IMPLEMENTED + VERIFIED | split payments | none | P1 | | payment tests |
| MB-12 | S05 p16 | Day-end Z-report | IMPLEMENTED + VERIFIED | money desk "Print day report" (print layout of the day's figures, closes and discrepancies; inputs print as their saved figures) | none | P2 | | browser check 10-08: print-media render of the production build at 390 / 768 / 1024 / 1440 px (no controls, outlet + business day + print time, saved figures) |
| MB-13 | S05 p16 | Shared codebase so iOS is an increment | NOT BUILT | | | P4 | MB-01 | |

## Section 05: Growth, guests and staff (p. 17)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| CR-01 | S05 p17 | Points on every bill, redeemable | IMPLEMENTED + VERIFIED | loyalty ledger, earn on PAID only; the tier a guest held before the order sets the earn multiplier (`earnMultiplierPct`) | none | P3 |  | crm-loyalty tests, `growth-loyalty-tiers` (T1-T4) |
| CR-02 | S05 p17 | Tiers (silver, gold) with perks | IMPLEMENTED + VERIFIED | `LoyaltyTier` (owner-defined code, name, spend threshold, earn multiplier %, perks); tier derived from the last 365 days of net spend, so it can go down; nightly refresh job; tier change audited; Loyalty & referrals screen; tier card on the customer page; coupons can require a tier | none | P3 |  | `tests/domain/growth-loyalty-tiers.test.ts`, `growth-lifecycle` (L4), `tests/ui/growth-screens.test.tsx`, `e2e/growth.spec.ts` (GROWTH-001, -002) |
| CR-03 | S05 p17 | Automatic birthday and anniversary offers | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `Customer.anniversary`; birthday / anniversary offer jobs (`svc/lifecycle.ts sendDateOffers`): once per guest per year, only guests who agreed to offers, the owner's chosen coupon, quiet hours, 29 February handled; switched on by choosing the coupon in Growth settings | a real WhatsApp / SMS / e-mail provider (every message is verified against the MOCK provider only) | P3 | CM-* | `growth-lifecycle` (L1), `growth-consent-settings` (M1) |
| CR-04 | S05 p17 | "Haven't seen you in 45 days" win-back | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `sendWinback`: guests whose last paid order is older than N days (default 45), once per cooldown window (default 90 days), consented, quiet hours, the owner's coupon; Growth settings | a real provider (MOCK only) | P3 | CM-* | `growth-lifecycle` (L2) |
| CR-05 | S05 p17 | Spend, frequency, favourite dish per guest | IMPLEMENTED + VERIFIED | `customerStats`, profile | none | P3 | | crm tests |
| CR-06 | S05 p17 | Referral codes that track | IMPLEMENTED + VERIFIED | `ReferralCode` (RF + 6 characters), invite link `/r/<code>` keeps the code on the friend's phone, checkout field (needs a phone number), `Referral`: both guests are rewarded on the friend's first PAID order only, monthly cap per guest, minimum order, points taken back if that order is fully refunded; staff can record a code on a profile | none | P3 |  | `tests/domain/growth-referrals.test.ts`, `tests/api/growth-routes.test.ts` (R3), `e2e/growth.spec.ts` (GROWTH-006) |
| CM-01 | S05 p17 | WhatsApp Business API (official) with outbox, retries, idempotency, callbacks | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `IntegrationDelivery` outbox, worker retries, messaging adapters, status callbacks | live WhatsApp credentials, approved templates | P3 | credentials | phase7 tests |
| CM-02 | S05 p17 | Order confirmation / out for delivery / digital bill messages | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `queueOrderMessage` | live provider | P3 | CM-01 | |
| CM-03 | S05 p17 | Booking confirmation and reminder | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `runBookingMessages`: confirmation when a booking is made and a reminder N hours before (default 2); order-message consent (opt-out) respected; one message per booking per kind; off until switched on | a real provider (MOCK only) | P5 | CM-01 | `growth-lifecycle` (L3) |
| CM-04 | S05 p17 | Weekend specials to a segmented list (campaigns) | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `Campaign`: audience rules over live consent / spend / visits / last visit / birthday / anniversary month / tier / segment, live audience count, schedule guards, resumable bounded batches, quiet-hours deferral, weekly cap per guest, cancel, per-recipient outcomes, unsubscribe link in every message; Campaigns screens | a real provider (MOCK only) | P3 | CM-01 | `tests/domain/growth-campaigns.test.ts` (K1-K8), `e2e/growth.spec.ts` (GROWTH-004) |
| CM-05 | S05 p17 | Feedback request 2 h after the visit | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `FeedbackRequest` scheduled when an order is paid; the worker sends the link `/f/<token>` after the owner's delay (default 2 h) on WhatsApp, then SMS, then e-mail; expires after 7 days | a real provider (MOCK only) | P5 | CM-01 | `tests/domain/growth-feedback.test.ts` (F1), `tests/api/growth-routes.test.ts` (R4) |
| CM-06 | S05 p17 | Daily business summary pushed at 9 AM | IMPLEMENTED + NOT EXTERNALLY VERIFIED | in-app daily summary notification per outlet and `queueDigestMessage` to the owner's number (WhatsApp, then SMS), once per day | a real provider (MOCK only) | P3 | CM-01 | `growth-lifecycle` (L5) |
| RS-01 | S05 p17 | Reservations, table-map aware, no double booking | IMPLEMENTED + VERIFIED | `ReservationSlot` locks | none | P5 | | reservation-concurrency tests |
| RS-02 | S05 p17 | Online booking from website / app / Google | NOT BUILT | staff-entered only | public booking page, Reserve with Google | P5 | | |
| RS-03 | S05 p17 | Digital waitlist with SMS when ready | IMPLEMENTED + NOT EXTERNALLY VERIFIED | Waitlist (`WaitlistEntry`, seat / arrived / left) and `svc/waitlistNotify.ts`: "Table ready" message through the one message gate (WhatsApp then SMS, transactional so quiet hours and marketing consent do not apply, opt-out respected, masked number in the outbox, three tells per party, two-minute double-tap guard); the host sees who was told and when, or the plain reason when nothing could be sent; `POST /api/reservations/waitlist/:id/notify` | a live SMS / WhatsApp provider account (only the mock provider has been run; delivery receipts from a real provider are unverified) | P5 | SMS provider | `tests/domain/floor-extras.test.ts` (W1–W6, SQLite + PostgreSQL), `tests/api/floor-routes.test.ts`, `tests/ui/floor-extras.test.tsx`, `e2e/floor-ops.spec.ts` (FLOOR-003, mock provider) |
| RS-04 | S05 p17 | No-show tracking | IMPLEMENTED + VERIFIED | NO_SHOW status | none | P5 | | |
| RS-05 | S05 p17 | Deposits for large groups | NOT BUILT | | | P5 | Razorpay | |
| RS-06 | S05 p17 | Special-occasion notes that reach the kitchen | IMPLEMENTED + VERIFIED | `svc/orders.ts` `createOrderTx`: the note of the party seated at the table (booking SEATED) is added to the order as "Booking note: …" and prints on the kitchen ticket ("Order note"); the bookkeeping note of a waitlist walk-in is not carried | none | P5 | | `tests/domain/floor-extras.test.ts` (B1–B4, SQLite + PostgreSQL), `e2e/floor-ops.spec.ts` (FLOOR-004) |
| RV-01 | S05 p17 | Post-meal feedback via QR or WhatsApp | IMPLEMENTED + VERIFIED | order-page rating after payment (stars + comment), feedback link `/f/<token>` (token is the credential), one answer per order (the first stands), staff inbox with source and status | none for the QR path; delivery of the link by WhatsApp / SMS / e-mail is CM-05 | P5 |  | `growth-feedback` (F1-F3), `tests/api/growth-routes.test.ts` (R3, R4), `tests/ui/growth-guest.test.tsx`, `e2e/growth.spec.ts` (GROWTH-002) |
| RV-02 | S05 p17 | Happy guests routed to Google / Zomato; unhappy reach you privately | IMPLEMENTED + VERIFIED | a rating of 4-5 and above the owner's "unhappy" line is offered the owner's public review page (https, allowlisted hosts: Google, Zomato, Swiggy, TripAdvisor, Justdial); lower ratings stay private, raise a LOW_RATING alert and enter the follow-up workflow (new, acknowledged, resolved with a note) | none | P5 | RV-01 | `growth-feedback` (F2, F3), `growth-consent-settings` (S1), `e2e/growth.spec.ts` (GROWTH-002, -006) |
| RV-03 | S05 p17 | Complaint trends by dish, shift, staff | IMPLEMENTED + VERIFIED | `feedbackTrends`: by dish (ranked only with enough rated orders), time of day, server and day; Trends tab | none | P5 | RV-01 | `growth-feedback` (F4), `tests/ui/growth-screens.test.tsx` |
| SO-01 | S05 p17 | Attendance check-in / out | IMPLEMENTED + VERIFIED | `Attendance`, manager corrections | none | P5 | | staff tests |
| SO-02 | S05 p17 | QR punch or selfie check-in with geofence | NOT BUILT | | | P5 | | |
| SO-03 | S05 p17 | Shift roster | PARTIAL | `Shift` definitions | assignment of people to shifts | P5 | | |
| SO-04 | S05 p17 | Leave requests | IMPLEMENTED + VERIFIED | `LeaveRequest` approve/reject | none | P5 | | staff tests |
| SO-05 | S05 p17 | Overtime and hours feeding payroll | NOT BUILT | hours derivable from attendance | payroll export | P5 | | |
| SO-06 | S05 p17 | Sales per staff member and tip distribution | NOT BUILT | `Order.createdById` | report + tips | P5 | | |
| SO-07 | S05 p17 | Training checklists, opening / closing duty lists | PARTIAL | `Task` with verify step | checklist templates | P5 | | |
| AG-01 | S05 p17 | Zomato and Swiggy orders pulled into the same ledger | IMPLEMENTED + NOT EXTERNALLY VERIFIED | aggregator webhook -> order, `AggregatorOrder` | partner API access | P6 | partner credentials | webhooks tests |
| AG-02 | S05 p17 | Payout reconciliation | IMPLEMENTED + NOT EXTERNALLY VERIFIED | `runAggregatorReconciliation` (feed) and, group 5, statement import (CSV, once per statement, changed line refused, one bad line imports nothing), line-by-line reconciliation (matched, short-paid with reason, unknown, duplicate payment, cancelled, wrong outlet), one anomaly per reviewed shortfall, "what the platform still owes" | a real Zomato / Swiggy statement: the CSV layout is RESTORA's own and has never been checked against a platform's file; the Aggregators screen has no automated UI or browser test | P6 |  | aggregator-finance tests (AF2-AF5, AF8), `webhooks-reconciliation` tests |
| AG-03 | S05 p17 | Commission, penalty, ad-spend as real costs; net margin per aggregator, per dish | IMPLEMENTED + VERIFIED | `createAggregatorCharge` / `voidAggregatorCharge` (penalty, ad spend, fee, other; once per key, voided with a reason, never deleted) and `aggregatorMargin`: per platform and per dish, commission, fees and charges as real costs, food cost from the cost frozen on the sale, no margin shown when a cost is missing | none | P6 |  | aggregator-finance tests (AF6, AF7, AF8); the screen has no automated UI or browser test |
| AG-04 | S05 p17 | Switch items on/off across platforms | NOT BUILT | | | P6 | partner APIs | |

## Section 05 item 12: smaller things (p. 17)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| AD-01 | S05 p17 | GST invoice | IMPLEMENTED + VERIFIED | `TaxInvoice` CGST/SGST/IGST, credit notes | none (no legal compliance claim) | P2 | | invoicing tests |
| AD-02 | S05 p17 | E-invoice (IRN) | NOT BUILT | | IRP integration | P7 | GSP credentials | |
| AD-03 | S05 p17 | Tally / Zoho deep integration | IMPLEMENTED + NOT EXTERNALLY VERIFIED | group 5: `svc/accountingSync.ts` + Tally gateway and Zoho Books clients (`src/integrations/accounting`): ledger / party mapping (owner only, audited), one outbox row per voucher (sent once however often synced), partial failure, bounded retries by the worker, interrupted sends reconciled (Zoho) or held for a person (Tally), refused login final and flagged; Integrations > Accounting cards | never run against a real Tally gateway or Zoho Books organisation (emulators only); the cards have no automated UI or browser test | P7 |  | `tests/domain/accounting-sync.test.ts` (G1-G8), `tests/integrations/group5-adapters.test.ts` |
| AD-04 | S05 p17 | Central kitchen and commissary | INTENTIONALLY DEFERRED | inter-outlet transfers exist | multi-outlet decision | — | PA-08 | |
| AD-05 | S05 p17 | Franchise / licensee reporting | INTENTIONALLY DEFERRED | | multi-outlet decision | — | PA-08 | |
| AD-06 | S05 p17 | Catering and bulk-order quotations | NOT BUILT | | | P7 | | |
| AD-07 | S05 p17 | Event and private-party booking | NOT BUILT | | | P7 | | |
| AD-08 | S05 p17 | Gift cards and prepaid packages | NOT BUILT | | | P7 | | |
| AD-09 | S05 p17 | Subscription coffee plans | NOT BUILT | | | P7 | | |
| AD-10 | S05 p17 | Supplier price-comparison board | IMPLEMENTED + VERIFIED | `supplierPriceComparison` + `/procurement/prices`: every vendor per base unit and per purchase unit, lead time, status (a blacklisted vendor is never the cheapest), last received rate and purchase price history with change and weighted average | none | P7 |  | advanced-inventory tests (S1, S2, X1), costing-screens test, `e2e/costing.spec.ts` (G4-SP-001) |
| AD-11 | S05 p17 | Energy and utility cost tracking | PARTIAL | expenses with UTILITIES category | meter readings, trend | P7 | | |
| AD-12 | S05 p17 | Asset and equipment maintenance log | NOT BUILT | | | P7 | | |
| AD-13 | S05 p17 | FSSAI temperature and hygiene checklists | NOT BUILT | | | P7 | SO-07 | |
| AD-14 | S05 p17 | Google Business Profile sync | NOT BUILT | | | P7 | | |
| AD-15 | S05 p17 | Instagram menu feed | NOT BUILT | | | P7 | | |
| AD-16 | S05 p17 | Digital signage for the counter screen | NOT BUILT | | | P7 | | |
| AD-17 | S05 p17 | Barcode / QR stock labels | IMPLEMENTED + VERIFIED | `stockLabels` + `/inventory/labels`: printable labels carry the SKU (never an internal id); scan / type a code to find the material, stock per department and (cost viewers) value; unknown, malformed and other tenants' codes find nothing | none | P7 |  | advanced-inventory tests (L1, L2), costing-screens test, `e2e/costing.spec.ts` (G4-LB-001) |

## RESTORA platform requirements (existing product decisions)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| SE-01 | S09 p21 | Authentication, opaque sessions, idle timeout, step-up re-auth | IMPLEMENTED + VERIFIED | `src/server/auth/*` | none | P0 | | auth tests, session E2E |
| SE-02 | | CSRF / origin checks on every state change | IMPLEMENTED + VERIFIED | `assertSameOrigin` | none | P0 | | same-origin tests |
| SE-03 | | Rate limiting (login, webhooks, guest, reports) | PARTIAL | in-memory limiter | shared store for multi-instance | P0 | hosting | security tests |
| SE-04 | | Webhook signatures + idempotency | IMPLEMENTED + VERIFIED | HMAC, `WebhookEvent` unique | none | P0 | | webhook tests |
| SE-05 | | Payment never trusted from the client; refunds capped at captured | IMPLEMENTED + VERIFIED | `svc/payment.ts` | none | P0 | | idempotency-refunds, payment-balance tests |
| SE-06 | | Audit log with before / after | IMPLEMENTED + VERIFIED | `AuditLog`, `/audit` | none | P0 | | |
| SE-07 | | Secrets never sent to the browser; integration secrets encrypted | IMPLEMENTED + VERIFIED | `server/integrations/secrets.ts` | none | P0 | | integrations tests |
| SE-08 | S09 p21 | Append-only enforced by the database | PARTIAL | service-level only on SQLite | PostgreSQL triggers / RLS | P0 | PostgreSQL deploy | |
| SE-09 | | Background jobs and failure recovery (outbox worker) | IMPLEMENTED + VERIFIED | `src/server/ops/worker.ts` | none | P0 | | ops tests |
| SE-10 | | Observability: health, metrics, request timing | IMPLEMENTED + VERIFIED | `/api/health/*`, metrics | none | P1 | | config tests |
| SE-11 | | Production configuration validation | IMPLEMENTED + VERIFIED | `src/server/config/env.ts` | none | P0 | | env-validation tests |
| SE-12 | | Windows desktop app (Electron) with local DB, backups, upgrades | IMPLEMENTED + VERIFIED | `desktop/` | none | P1 | | desktop tests |
| SE-13 | | macOS desktop | IMPLEMENTED + NOT EXTERNALLY VERIFIED | config + CI job | a green macOS CI run | P4 | Mac / CI | |
| SE-14 | | Code signing | IMPLEMENTED + NOT EXTERNALLY VERIFIED | | certificates | P4 | | |
| SE-15 | | Public RESTORA website | IMPLEMENTED + VERIFIED | `src/app/(site)` | none | P1 | | `tests/site/website.test.ts` |
| SE-16 | | PostgreSQL production database | IMPLEMENTED + NOT EXTERNALLY VERIFIED | suite + E2E executed on PG 16 | hosted instance | P0 | hosting | `docs/postgres.md` |

---

## Totals

Counted from the tables above by script (one row = one feature), after the 2026-10-08 stabilization pass.

| Status | Rows |
|---|---|
| IMPLEMENTED + VERIFIED | 116 |
| IMPLEMENTED + NOT EXTERNALLY VERIFIED | 24 |
| PARTIAL | 17 |
| NOT BUILT | 27 |
| INTENTIONALLY DEFERRED | 3 |
| **Total** | **187** |
