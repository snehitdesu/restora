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

Status values (exactly one per row):

- **COMPLETE**: database, rules, service, API, authorization, UI where needed and automated tests exist in the repository.
- **PARTIAL**: something real exists; *Missing work* says exactly what does not.
- **NOT BUILT**: no implementation.
- **PRODUCTION VERIFICATION REQUIRED**: the code path exists and is tested against an emulator / sandbox, but needs credentials, hardware, hosting or a real-world run.
- **DEFERRED**: explicit product decision (multi-outlet / multi-restaurant).

Priority: P0 correctness/security, P1 core operations, P2 finance/inventory/procurement/kitchen/POS completeness, P3 customer/CRM/comms, P4 mobile, P5 reservations/reputation/staff, P6 aggregators/integrations, P7 advanced/optional.

Paths are relative to the repo root. `svc/` = `src/server/services/`, `bo/` = `src/features/backoffice/`.

---

## Summary

See the bottom of this file ("Totals") for counts. The proposal's **core back office**
(modules 01 to 09, pages 4 to 12) is where RESTORA is strongest; the proposal's
**optional** layer (section 05, pages 15 to 17) is where most NOT BUILT rows are.

---

## Module 01: Master data (p. 4)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MD-01 | M01 p4 | Raw material catalogue with short code (RM-0001), category | COMPLETE | `Material.sku`, `MaterialCategory`; `svc/masterData.ts`; `/master/materials` | none | P1 | | `tests/domain/master-data.test.ts`, `e2e/catalog.spec.ts` |
| MD-02 | M01 p4 | Material brand | NOT BUILT | none | brand field + form | P7 | | |
| MD-03 | M01 p4 | Purchase unit vs stock unit + conversion factor | COMPLETE | `Material.purchaseUnitId`, `baseUnitId`, `UnitConversion` (global + per material); `/master/units` | none | P1 | | master-data tests |
| MD-04 | M01 p4 | PAR level | COMPLETE | `Material.reorderLevel` (reorder point), `minStock` (safety stock), optional `parLevel` (order up to; group 2, never below the reorder level); material form | none | P1 | | master-data tests, reorder test F7 |
| MD-05 | M01 p4 | Default vendor and last purchase price | COMPLETE | `Material.preferredVendorId`, `VendorMaterial.preferred/lastRate`, `OutletMaterialCost.lastCost` | none | P1 | | |
| MD-06 | M01 p4 | Recipe builder from raw materials and sub-recipes | COMPLETE | `Recipe/RecipeVersion/RecipeLine`, `svc/recipe.ts`, `/recipes` | none | P1 | | `tests/domain/recipes.test.ts`, `recipe-cycle.test.ts`, `e2e/catalog.spec.ts` |
| MD-07 | M01 p4 | Nested sub-recipes up to 12 levels, cycle-safe | COMPLETE | `explodeRecipe` MAX_DEPTH + cycle guard, `src/domain/recipe/cycle.ts` | none | P1 | | recipe-cycle tests |
| MD-08 | M01 p4 | Change a sub-recipe once, all dishes re-cost | COMPLETE | costing is computed live from versions + `OutletMaterialCost.avgCost` | none | P1 | | recipes tests |
| MD-09 | M01 p4 | Yield portions per recipe | COMPLETE | `RecipeVersion.yieldQty/yieldUnitId/servingSize` | none | P1 | | |
| MD-10 | M01 p4 | Overhead % per recipe | NOT BUILT | none | `overheadPct` on version + costing | P7 | MD-06 | |
| MD-11 | M01 p4 | Live cost per plate, selling price, gross margin, food-cost % | COMPLETE | `menuItemCostAndMargin`, recipe/menu screens | none | P1 | | catalog E2E |
| MD-12 | M01 p4 | Recipe linked to the POS item code for auto-depletion | COMPLETE | `MenuItem.posCode`, POS normalisation + `UnmappedSale` mapping | none | P1 | | `tests/domain/pos-backend.test.ts` |
| MD-13 | M01 p4 | Weighted average cost re-averaged from purchase bills | COMPLETE | `recordPurchaseReceipt` updates `OutletMaterialCost` | none | P1 | | inventory-procurement tests |
| MD-14 | M01 p4 | Theoretical consumption per dish sold | COMPLETE | `consumeInventoryForOrder` (SALE_CONSUMPTION) | none | P1 | | flows tests |
| MD-15 | M01 p4 | Vendor master: GSTIN, bank / UPI details, payment terms, contacts | PARTIAL | `Vendor` (gstin, bankAccount, bankIfsc, upiId, paymentTerms, phone, email; masked without vendor.manage) | nature of supply, vendor category, multiple contact people | P2 | | master-data tests |
| MD-16 | M01 p4 / M02 p5 | New vendors start PENDING and must be approved; Active / Inactive / Blacklisted; buying from an unapproved vendor is blocked | COMPLETE | `Vendor.status` + `VENDOR_STATUS_TRANSITIONS`, `setVendorStatus` (approval needs org-wide purchase.approve; other moves vendor.manage; blacklist needs a reason, lifting returns to PENDING); PO / GRN / direct bill creation and PO submit/approve/order refuse non-ACTIVE vendors; bills for received goods and dues payments stay possible; vendor screens show status and actions; UPI id masked like bank details (group 1, 10-07) | none | P0 | MD-15 | `tests/domain/core-gaps.test.ts`, `master-data.test.ts` |
| MD-17 | M01 p4 | Full purchase and payment history per vendor; downloadable statement | COMPLETE | `vendorStatement`, `/api/finance/vendor-statement`, vendor detail page | none | P2 | | `tests/domain/finance-p4.test.ts` |
| MD-18 | M01 p4 | Departments (Store / Kitchen / Bar / Bakery) | COMPLETE | `Department.kind`, `/settings/departments` | none | P1 | | |
| MD-19 | M01 p4 | Material categories / vendor categories / cuisine tags | PARTIAL | material categories | vendor categories, cuisine tags on menu items | P7 | | |
| MD-20 | M01 p4 | Outlet settings, POS credentials, aggregator commission % | PARTIAL | `Outlet` settings, `IntegrationConnection` (encrypted credentials), `Aggregator.commissionPct` | aggregator admin screen to edit commission % | P6 | AG-* | integrations tests |
| MD-21 | M01 p4 | Bulk import from Excel | PARTIAL | Coders' Cafe starter menu import (`svc/starterMenu.ts`) | generic CSV/Excel import for materials, recipes, vendors | P7 | | starter-menu tests |

## Module 02: Procure-to-pay (p. 5)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PP-01 | M02 p5 | Reorder engine: everything below PAR sorted by days of cover from the last 14 days of real consumption | COMPLETE | `svc/reorder.ts` (group 2, 10-08): live from the ledger at one `asOf`; net usage over the window (7 to 90 days, default 14) divided by the days observed; reorder point = max(reorder level, minimum) raised to minimum + usage x lead time when history is long enough; stock position nets open POs, open indents and draft GRNs without a PO; sorted by priority then days of cover; draft-only cover listed separately; `/procurement/reorder` | none | P1 | MD-04 | `tests/domain/reorder.test.ts`, `tests/api/reorder-routes.test.ts`, `tests/db/reorder-concurrency.test.ts`, `tests/ui/procurement-reorder.test.tsx` |
| PP-02 | M02 p5 | Suggested order quantity, estimated spend at current average cost, usual vendor pre-filled, total budget | COMPLETE | order up to `Material.parLevel` (or the reorder level), rounded up to whole purchase packs or 4 dp; spend at outlet average cost (else last cost); vendor = ACTIVE vendors only (preferred, preferred link, lowest rate, shortest lead time), blocked preferred vendor explained; vendor price comparison; budget and per-vendor totals | none | P1 | PP-01, MD-16 | reorder tests (A, D, F6) |
| PP-03 | M02 p5 | Raise POs from the reorder screen, pre-filled | COMPLETE | `POST /api/procurement/reorder/purchase-orders` (one DRAFT PO per vendor, purchase unit at base rate x factor) and `/reorder/indents`; mandatory Idempotency-Key, one transaction, Group 1 vendor gate before any write, 409 when stock was ordered since the screen loaded (concurrent raises: exactly one wins); audit records suggestion vs order; nothing auto-submitted or approved | none | P1 | PP-01 | reorder tests (C, E, F, I), concurrency test on SQLite and PostgreSQL |
| PP-04 | M02 p5 | Vendor PO and internal indent share one queue; status tabs | PARTIAL | indents and POs each have lists with status filters | a single combined queue view | P7 | | |
| PP-05 | M02 p5 | Admin approval gate; PO status only moves forward | COMPLETE | `PURCHASE_ORDER_TRANSITIONS`, `purchase.approve` | none | P0 | | workflows tests, `e2e/backoffice-ops.spec.ts` |
| PP-06 | M02 p5 | Line-level approve / edit quantity / reject | PARTIAL | whole-document approve/reject | per-line approval status | P2 | | |
| PP-07 | M02 p5 / S06 p18 | Approval rules: skip for small orders, second approver for large ones | NOT BUILT | single approver | configurable thresholds | P7 | | |
| PP-08 | M02 p5 | Store dispatches an indent; stock moves department to department | PARTIAL | indents (purchase requests) and issues (dept to dept, ledger) both exist | link an issue to the indent it fulfils | P2 | | |
| PP-09 | M02 p5 | Receiving a PO writes stock automatically (actual qty and rate) | COMPLETE | `createGRN` + `postGRN` -> PURCHASE_RECEIPT, re-average | none | P0 | | inventory-procurement tests, backoffice-ops E2E, `tests/db/stock-post-concurrency.test.ts` (one GRN posted twice at once: received once) |
| PP-10 | M02 p5 | Short delivery and price-spike flag at receipt | COMPLETE | GRN qty vs PO qty, `detectAnomalies` PRICE_SPIKE | none | P1 | | anomaly tests |
| PP-11 | M02 p5 | Bill creates a payable due | COMPLETE | `createPurchaseBill`, unique vendor invoice no | none | P0 | | |
| PP-12 | M02 p5 | Dues tracker per vendor (purchased, paid, outstanding) | COMPLETE | `vendorDues`, `vendorAging` | none | P1 | | finance-p4 tests |
| PP-13 | M02 p5 | Payment run: record payment with mode and reference; cannot be deleted or silently altered | COMPLETE | `payVendor` (idempotent), reversal keeps the row (`reverseVendorPayment`) | none | P0 | | finance-p4 tests |
| PP-14 | M02 p5 | Accounting CSV for Tally / Zoho Books | PRODUCTION VERIFICATION REQUIRED | `svc/accounting.ts` vouchers, exports | confirm import into a real Tally / Zoho company | P6 | | `tests/domain/integrations-p7.test.ts` |
| PP-15 | M02 p5 | Every action stamped with staff, outlet and time | COMPLETE | `createdById/actorId`, `AuditLog` | none | P0 | | |

## Module 03: Inventory control (p. 6)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| IN-01 | M03 p6 / S09 p21 | Append-only ledger, balances derived, corrections are new rows | PARTIAL | `InventoryLedger`, `appendLedger` single writer, `recordCorrection`; enforced in the services | the proposal says "the database physically refuses" edits: PostgreSQL triggers / RLS are design only | P0 | SE-08 | `tests/db/invariants.test.ts` |
| IN-02 | M03 p6 | Live stock matrix: materials x departments, qty and value at WAC | PARTIAL | `stockByDepartment` (unused by UI); Stock screen is outlet totals; Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval (`stockMatrix`) | department grid UI, value hiding for kitchen | P1 | IN-11 | group 4 |
| IN-03 | M03 p6 | Stock value grouped by category | COMPLETE | analytics inventory value by category | none | P2 | | analytics tests |
| IN-04 | M03 p6 | Below-PAR highlighted, negative stock flagged | COMPLETE | `lowStock`, `negativeStock`, Stock screen | none | P1 | | |
| IN-05 | M03 p6 | Full movement history per material | COMPLETE | `/inventory/stock/[materialId]`, ledger filters | none | P1 | | |
| IN-06 | M03 p6 | Issue to kitchen (cost follows stock) | COMPLETE | `createIssue/postIssue`: OUT of the source department (or unassigned stock) and IN to the required destination department at the same cost; WAC and last price untouched (group 1, 10-07). Before: the issue removed stock from the outlet and the sale removed it again. Legacy posted issues are not backfilled (decision 10-07): a stock count corrects them | none | P0 | | `tests/domain/inventory-procurement.test.ts`, `workflows.test.ts`, `tests/db/stock-post-concurrency.test.ts` (one issue posted twice at once moves stock once; both requests answer) |
| IN-07 | M03 p6 | Inter-department transfer, nets to zero | COMPLETE | same issue document between any two departments; the outlet total is unchanged; source-department availability enforced | none | P1 | IN-06 | inventory-procurement tests (concurrency + shortage) |
| IN-08 | M03 p6 | Stock count sheet pre-filled, variance qty and rupees, accept posts reconciliation | COMPLETE | `StockCount` freeze -> count -> review -> approve -> COUNT_ADJUSTMENT | none | P1 | | workflows tests |
| IN-09 | M03 p6 | Variance trend over time | PARTIAL | variance per count, count-variance cost in P&L | trend chart across counts | P2 | | |
| IN-10 | M03 p6 | Wastage at raw material level with reason and department, costed at average rate | COMPLETE | `Wastage` documents, `recordWastage`; back-dated `occurredAt` ledgers on the day of the loss; refused into a closed day; line costs hidden from logins without cost rights (group 3); one document posted twice at the same moment moves stock once and the second request gets a clean 422 (gate 10-08: `isLedgerKeyRace` in `server/db/conflict.ts`, re-run by `runInTx`; before, PostgreSQL answered 500) | none | P1 | | production-wastage tests, `tests/domain/kitchen-production.test.ts` (W), `tests/db/stock-post-concurrency.test.ts` |
| IN-11 | M03 p4/p6/p7 | Sales depletion from the right department | COMPLETE | `consumeInventoryForOrder` depletes the department whose kind matches the line's station (KITCHEN / BAR / BAKERY), unassigned stock when there is none (group 3) | none | P1 | | `tests/domain/kitchen-production.test.ts` (P1) |
| IN-12 | M03 p6 | Wastage at dish level ("3 pizzas") | COMPLETE | `createDishWastage` (recipe exploded at plate cost, from the dish's department); wastage screen "Whole dishes" mode; the worksheet logs wasted portions through the same register (one stock path) | none | P2 | | `tests/domain/kitchen-production.test.ts` (W1, S2, S3), `tests/ui/group3-screens.test.tsx` |
| IN-13 | M03 p6 | Manual sale (dish sold outside the POS) depletes stock | COMPLETE | `svc/manualSales.ts`: one settled MANUAL order at menu price, back-dated to the business day, idempotent, depletes once; "Log dish sales" on the worksheet and the money desk; refused into a closed day | none | P1 | | `tests/domain/kitchen-production.test.ts` (M1), `tests/api/group3-routes.test.ts`, `tests/domain/money-desk.test.ts`, `tests/db/stock-post-concurrency.test.ts` (the same log sent twice at once: one order, consumed once, the second answer is the replay; before the gate PostgreSQL answered it with a raw unique-constraint error) |
| IN-14 | S06 p18 | Batch numbers, expiry dates, FSSAI lot codes | PARTIAL | `batchNo/expiryDate` on GRN lines, ledger, production | expiry alerts, FSSAI lot field, FEFO | P7 | | |

## Module 04: POS and sales automation (p. 7)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PS-01 | M04 p7 | POS webhook per outlet key, signature checked, duplicate-proof | COMPLETE | `/api/webhooks/pos/[provider]`, `WebhookEvent` unique, `IntegrationConnection.externalRef` tenant binding | none | P0 | | webhooks-reconciliation, webhook-tenant tests |
| PS-02 | M04 p7 | Petpooja integration live | PRODUCTION VERIFICATION REQUIRED | `src/integrations/pos/petpooja.ts` field mapping (skeleton for live pull) | run against a Petpooja account, finish the mapping from a real payload | P6 | credentials | |
| PS-03 | M04 p7 | Recipe explosion, cycle-safe, 12 levels, costed at average rate | COMPLETE | `explodeRecipe`, `consumeInventoryForOrder` | none | P0 | | flows tests |
| PS-04 | M04 p7 | Unmapped sales queue; map once from a dropdown | COMPLETE | `UnmappedSale`, `svc/unmapped.ts`, anomaly | none | P1 | | pos-backend tests |
| PS-05 | M04 p7 | Nightly re-pull at 1:30 AM fills gaps; never double counts | PARTIAL | `reconcilePOSOrders` / POS reconciliation (manual run, auto-import option) | schedule it in the worker | P2 | PS-02 | webhooks-reconciliation tests |
| PS-06 | M04 p7 | Daily revenue and covers; sales by channel; day-part; item-wise CSV | COMPLETE | `dailySales`, `dayPartSales`, reports + CSV | none | P2 | | analytics tests |
| PS-07 | M04 p7 | Manual sales log for a day (no POS) | COMPLETE | see IN-13 | none | P1 | | see IN-13 |
| PS-08 | M04 p7 | Aggregator gross and net after commission | PARTIAL | `AggregatorOrder` gross/commission/netPayout; aggregator reconciliation | aggregator admin screen; channel net margin report | P6 | AG-* | |

## Module 05: Kitchen production (p. 8)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| KP-01 | M05 p8 | Dish production worksheet: prepared (chef), sold (auto), wastage (chef), variance, wastage cost at plate cost | COMPLETE | `svc/productionWorksheet.ts`, `/inventory/worksheet`: prepared entered, sold from settled orders, wasted = posted dish-wastage documents (pending approval shown apart), unexplained gap and its cost at plate cost; costs hidden from the kitchen; preparing does not move stock (no double consumption) | none | P1 | IN-11 | `tests/domain/kitchen-production.test.ts` (S), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `tests/db/stock-post-concurrency.test.ts` (a double-tapped "add wasted" is one document posted once; before the gate the second tap answered 422), `e2e/money-desk.spec.ts` (G3-KP-001) |
| KP-02 | M05 p8 | Sub-recipe batch production (consumes inputs, costs the batch, per-unit rate) | COMPLETE | `ProductionBatch`, `svc/production.ts`; group 3: only batch-produced sub-recipes (`Recipe.stocked`) can be produced and dishes draw on their prepared stock (fixed raw materials being consumed twice), department per batch, partial yield / corrected inputs, idempotent planning; the batch page shows the batch cost, cost per unit, yield against the plan, department and who planned / completed it, read from the ledger rows the batch posted (costs left out for the kitchen) (`getProductionBatch`, gate 10-08) | none | P1 | | production-wastage tests, `tests/domain/kitchen-production.test.ts` (P1-P6), `tests/db/stock-post-concurrency.test.ts` (one completion of a batch, competing batches never take a department negative, SQLite + PostgreSQL), `tests/ui/backoffice.test.tsx` (batch page) |
| KP-03 | M05 p8 | Daily view of what each department produced | COMPLETE | dish worksheet per day with department filter; batches carry their department (list column, API filter) | none | P2 | | `tests/domain/kitchen-production.test.ts`, `tests/ui/group3-screens.test.tsx` |
| KP-04 | M05 p8 | Kitchen's own workspace without vendor pricing, dues or P&L | COMPLETE | KITCHEN role: wastage, production, worksheet, dish sales log, raise / submit / withdraw indents (`indent.create`); costs removed server-side for logins without reports / purchase / finance access (stock, ledger, movements, counts, wastage, worksheet, recipe cost and margin are 403 or blank); material names from the outlet stock list | none | P1 | | `tests/domain/kitchen-production.test.ts` (W2, K1), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, backoffice-support tests |
| KP-05 | M05 p8 | Department P&L: sales value, cost issued in, wastage, gross margin, margin % | NOT BUILT | Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval (`departmentPnl`) | tests, UI | P2 | IN-11 | group 4 |
| KP-06 | M05 p8 | Daily costing view: opening, receipts, issues, consumption, closing per department per day | NOT BUILT | Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval (`dailyCosting`) | tests, UI | P2 | IN-11 | group 4 |

## Module 06: The money desk (p. 9)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MO-01 | M06 p9 | Daily close: collected per method vs expected | COMPLETE | PAYMENTS reconciliation, completed and locked by the day close (`svc/moneyDesk.ts closeDay`); a day without payments is counted from the screen too (cash drawer row; before the gate such a day could not be closed from the UI) | none | P1 | | finance tests, `tests/domain/money-desk.test.ts`, `tests/db/day-close-concurrency.test.ts`, `e2e/money-desk.spec.ts` (G3-MD-001) |
| MO-02 | M06 p9 | Three-way check: POS rang vs declared vs reached the bank, with aggregator commission | COMPLETE | `/finance/money-desk`: billed per channel vs declared (SALES reconciliation), menu-price cross-check, commission at the stored % (or recorded), expected to bank vs deposits; exception lines and bank gaps raise anomalies at close; a no-sales day is declared as zero (dine-in row) | none | P1 | MO-01 | `tests/domain/money-desk.test.ts`, `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `e2e/money-desk.spec.ts` (G3-MD-001: declare, count, deposit, close, locked, unexpected deposit raised as a discrepancy, reopen with password; runs on every E2E pass, it used to skip itself) |
| MO-03 | M06 p9 | Petty cash register with category, MTD and category breakdown | COMPLETE | `PettyCashTxn`, petty cash screen; money desk shows the day's opening / in / out / closing and month-to-date by category; refused into a closed day | none | P2 | | finance tests, `tests/domain/money-desk.test.ts` |
| MO-04 | M06 p9 | Manager workspace: vendor dues, petty cash, recent reconciliations, sales-log form | COMPLETE | money desk page: vendor dues, petty cash (day + month), recent closes, "Log dish sales" | none | P2 | PS-07 | `tests/ui/group3-screens.test.tsx` |
| MO-05 | M06 p9 | Cash drawer sessions with variance | COMPLETE | `CashDrawerSession` | none | P2 | | finance tests |
| MO-06 | M06 p9 | Bank deposit recording | COMPLETE | `BankDeposit` (cash slips and UPI / card credits per sales day, reference, account; void with reason and re-auth, never deleted; allowed after the close) | none | P2 | | `tests/domain/money-desk.test.ts`, `tests/api/group3-routes.test.ts` |

## Module 07: Menu engineering (p. 10)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| ME-01 | M07 p10 | Star / Plow-horse / Puzzle / Dog from median volume and median margin of the own menu | NOT BUILT | `menuPerformance` best/worst only; Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval (`svc/menuEngineering.ts`) | tests, UI | P1 | MD-11 | group 4 |
| ME-02 | M07 p10 | Report: price, plate cost, margin, food cost %, sold, verdict, what to do; any date range | NOT BUILT | Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval | tests, UI, CSV | P1 | ME-01 | group 4 |
| ME-03 | M07 p10 | Re-cost anything over 38% food cost | NOT BUILT | Draft service in the tree (pass 10-07), not wired / tested; awaiting group design approval | tests, UI | P1 | ME-01 | group 4 |
| ME-04 | S05 p16 | Upsell prompts driven by menu-engineering data | NOT BUILT | | captain upsell hints | P4 | ME-01 | |

## Module 08: Cost, profit and alerts (p. 11)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| CP-01 | M08 p11 | Leakage report: revenue, theoretical food cost, wastage, count variance, actual food cost, leakage gap, % of sales | COMPLETE | `foodCostLeakage` + per-material `consumptionVariance` (`svc/variance.ts`), `/inventory/variance` | none | P1 | | `tests/domain/kitchen-production.test.ts` (V1), `tests/api/group3-routes.test.ts`, `tests/ui/group3-screens.test.tsx`, `tests/domain/reports.test.ts` (CONSUMPTION_VARIANCE rows + CSV, outlet scope) |
| CP-02 | M08 p11 | Anomaly: negative stock | COMPLETE | `detectAnomalies` | none | P1 | | anomaly tests |
| CP-03 | M08 p11 | Anomaly: large count variance | COMPLETE | `detectAnomalies` COUNT_VARIANCE | none | P1 | | anomaly tests |
| CP-04 | M08 p11 | Anomaly: vendor price spike | COMPLETE | PRICE_SPIKE | none | P1 | | anomaly tests |
| CP-05 | M08 p11 | Anomaly: unmapped POS item | COMPLETE | UNMAPPED_ITEM | none | P1 | | |
| CP-06 | M08 p11 | Anomaly: heavy item wastage | COMPLETE | HEAVY_WASTAGE | none | P1 | | anomaly tests |
| CP-07 | M08 p11 / S05 p16-17 | Morning digest on WhatsApp / email / notification (9 AM summary) | NOT BUILT | | in-app digest; WhatsApp needs a live provider | P3 | CM-* | group 6 |
| CP-08 | M08 p11 | Financial overview KPIs, revenue trend, vendor cash-flow, variance by category, stock value by category, daily P&L, day-part, preset ranges | COMPLETE | `/analytics`, `financeOverview`, reports | none | P2 | | analytics tests, `tests/ui/analytics.test.tsx` |

## Module 09: People, access and growth (p. 12)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| PA-01 | M09 p12 | Six role levels (Owner, Area Manager, Admin, Manager, Store, Kitchen) | COMPLETE | `ROLE_PERMISSIONS` (+ Captain, Cashier) | none | P0 | | rbac E2E, auth tests |
| PA-02 | M09 p12 / S09 p21 | Enforced at the database itself (RLS) | PARTIAL | enforced in every service (`assertCan`, org/outlet scope); RLS is design only (`docs/postgres-rls.md`) | apply PostgreSQL RLS policies | P0 | PostgreSQL deploy | org-isolation tests |
| PA-03 | M09 p12 | Staff invite by name, email and role; set own password; re-send or copy | PARTIAL | `createStaff`, `issuePasswordLink` (copy link) | sending the invite email (needs email provider) | P3 | email provider | password-lifecycle tests |
| PA-04 | M09 p12 | Removing someone revokes access instantly; name stays on records | COMPLETE | `setUserActive` kills sessions; actor ids kept | none | P0 | | rbac E2E |
| PA-05 | M09 p12 | Universal search with keyboard shortcut (vendors, materials, recipes, POs, indents, bills, departments, categories, staff) | NOT BUILT | per-screen search only | search service + palette | P2 | | group 8 |
| PA-06 | M09 p12 | Google Sheets two-way sync | NOT BUILT | provider interface + in-memory mock only (`src/integrations/sheets`) | Google API adapter + sync jobs | P6 | Google credentials | |
| PA-07 | M09 p12 | CSV exports for Tally / Zoho / CA | COMPLETE | reports CSV, export jobs, accounting export | none | P2 | | export tests |
| PA-08 | M09 p12 | Multi-outlet: portfolio roll-up, outlet switcher, team per outlet, RLS isolation | DEFERRED | outlet switcher and per-outlet scoping exist; portfolio page and org-wide roll-up architecture deferred | product decision | — | | |

## Section 03 / 04 / 06 / 09 (pp. 13, 14, 18, 21): cross-cutting claims

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| XC-01 | S02 p3 / S09 p21 | Daily encrypted backups, point-in-time recovery | PRODUCTION VERIFICATION REQUIRED | `scripts/ops/pg-backup.mjs`, `pitr-drill.mjs`, desktop backups, backup freshness check | scheduled job on real hosting | P0 | hosting | `tests/desktop/backup.test.ts`, DR drill |
| XC-02 | S09 p21 | Export everything to CSV at any time | COMPLETE | reports + export jobs | none | P2 | | |
| XC-03 | S06 p18 | Add a department yourself | COMPLETE | departments screen | none | P2 | | |
| XC-04 | S06 p18 | Own vocabulary (rename "indent" etc.) | NOT BUILT | | label dictionary | P7 | | |
| XC-05 | S06 p18 | Interface in Telugu or Hindi, per user | NOT BUILT | | i18n | P7 | | |
| XC-06 | S06 p18 | Reports grouped by cuisine, chef, shift | NOT BUILT | | | P7 | MD-19 | |
| XC-07 | S09 p21 | Cloud-hosted in Mumbai, HTTPS | PRODUCTION VERIFICATION REQUIRED | deployment docs and rehearsal | real hosting | P0 | hosting | `docs/production-infrastructure.md` |

## Section 05: QR ordering and own website (p. 15)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| QR-01 | S05 p15 | Physical table QR, secure token, table known; invalid / disabled QR handled | COMPLETE | `RestaurantTable.qrToken`, rotate/revoke, `/t/[token]` | none | P0 | | `tests/domain/qr-transaction.test.ts`, `e2e/storefront.spec.ts` |
| QR-02 | S05 p15 | Menu with categories, search, variants, modifiers; sold-out hidden | COMPLETE | guest storefront, server pricing | none | P1 | | guest-storefront tests |
| QR-03 | S05 p15 | Photos and allergens on the guest menu | NOT BUILT | | image + allergen fields, upload | P3 | | |
| QR-04 | S05 p15 | Notes, cart, server-side price revalidation, duplicate submission protection | COMPLETE | quote route, idempotent placement | none | P0 | | guest-storefront, storefront E2E |
| QR-05 | S05 p15 | Kitchen gets it instantly (KOT) | COMPLETE | placement -> KOT (cash after staff confirmation) | none | P0 | | investor E2E |
| QR-06 | S05 p15 | Pay from the phone (UPI / card / wallet) via Razorpay; webhook authoritative | PRODUCTION VERIFICATION REQUIRED | Razorpay Checkout + webhook + recovery; emulator tested | run with `rzp_test_` keys and one phone payment | P0 | Razorpay keys | `tests/integrations/razorpay.test.ts`, investor E2E |
| QR-07 | S05 p15 | Order tracking, bill, customer can only see own order | COMPLETE | `/o/[orderId]` with order key | none | P0 | | guest tests |
| QR-08 | S05 p15 | Split bill from the phone; re-order in 2 taps | NOT BUILT | | | P3 | | |
| QR-09 | S05 p15 | Own ordering website: delivery and takeaway, delivery radius, slots, pre-order | NOT BUILT | QR dine-in storefront only | delivery/takeaway channel, address, radius rules | P3 | | |
| QR-10 | S05 p15 | Coupons, first-order offers, referral links | NOT BUILT | | | P3 | | |
| QR-11 | S05 p15 | Brand website: gallery, story, timings, directions, booking, SEO | PARTIAL | Coders' Cafe storefront About / Contact from outlet facts; RESTORA product site | gallery, online table booking, SEO pages per restaurant | P3 | | |
| QR-12 | S05 p15 | Price / sold-out change is live everywhere instantly | COMPLETE | one menu, per-outlet overrides | none | P1 | | outlet-menu tests |

## Section 05: Mobile, KDS, billing counter (p. 16)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| MB-01 | S05 p16 | Guest Android app (Play Store) | NOT BUILT | responsive guest web only | native app | P4 | Play account | |
| MB-02 | S05 p16 | Captain app: table map with status and timers, order at table, modifiers, notes, sends to kitchen, sold-out shown | PARTIAL | `/captain` web app (table board, rounds, modifiers, notes, KDS status) | native Android packaging, course timing, upsell, offline | P4 | | `tests/api/mobile-routes.test.ts` |
| MB-03 | S05 p16 | Captain: split bill, merge tables, transfer table | NOT BUILT | split tender only | transfer, merge, split into bills | P2 | | group 8 |
| MB-04 | S05 p16 | Captain works through a Wi-Fi drop, syncs after | NOT BUILT | | offline queue | P4 | | |
| MB-05 | S05 p16 | Owner app: sales, profit, alerts, approve PO, dues, outlets, 9 AM summary, attendance | PARTIAL | `/manager` web app | native app, push notifications, PO approval on the mobile screen | P4 | | mobile tests |
| MB-06 | S05 p16 | KDS: tickets colour-coded by age; station lanes; bump; captain and guest see it | COMPLETE | `/kitchen`, `urgency()`, station filter, guest tracker | none | P1 | | KDS UI tests, order-lifecycle E2E |
| MB-07 | S05 p16 | KDS: average prep time per dish, measured | NOT BUILT | `Kot` stamp columns added in migration `20261012100000_core_gaps`, not yet written | stamping + report | P2 | | group 8 |
| MB-08 | S05 p16 | KDS late-ticket alerts before the guest complains | PARTIAL | ticket age colours (warn 10 min, late 20 min) | alert / count banner | P2 | | group 8 |
| MB-09 | S05 p16 | Billing counter: keyboard entry, held bills, KOT printing | PARTIAL | POS (`/` search, saved OPEN orders = held), ESC/POS KOT printing (simulated without hardware) | named "hold" list | P2 | printer hardware | pos tests |
| MB-10 | S05 p16 | GST invoice with logo, printed or on WhatsApp | PARTIAL | `TaxInvoice` gapless series, bill view + print | WhatsApp delivery (provider), logo upload | P3 | | invoicing tests |
| MB-11 | S05 p16 | Cash / UPI / card split tender | COMPLETE | split payments | none | P1 | | payment tests |
| MB-12 | S05 p16 | Day-end Z-report | COMPLETE | money desk "Print day report" (print layout of the day's figures, closes and discrepancies; inputs print as their saved figures) | none | P2 | | browser check 10-08: print-media render of the production build at 390 / 768 / 1024 / 1440 px (no controls, outlet + business day + print time, saved figures) |
| MB-13 | S05 p16 | Shared codebase so iOS is an increment | NOT BUILT | | | P4 | MB-01 | |

## Section 05: Growth, guests and staff (p. 17)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| CR-01 | S05 p17 | Points on every bill, redeemable | COMPLETE | loyalty ledger, earn on PAID only | none | P3 | | crm-loyalty tests |
| CR-02 | S05 p17 | Tiers (silver, gold) with perks | PARTIAL | `LoyaltyAccount.tier` field | tier rules and perks | P3 | | |
| CR-03 | S05 p17 | Automatic birthday and anniversary offers | NOT BUILT | birthday stored | anniversary field, scheduled offers | P3 | CM-* | |
| CR-04 | S05 p17 | "Haven't seen you in 45 days" win-back | PARTIAL | INACTIVE segment | win-back campaign send | P3 | CM-* | |
| CR-05 | S05 p17 | Spend, frequency, favourite dish per guest | COMPLETE | `customerStats`, profile | none | P3 | | crm tests |
| CR-06 | S05 p17 | Referral codes that track | NOT BUILT | | | P3 | | |
| CM-01 | S05 p17 | WhatsApp Business API (official) with outbox, retries, idempotency, callbacks | PRODUCTION VERIFICATION REQUIRED | `IntegrationDelivery` outbox, worker retries, messaging adapters, status callbacks | live WhatsApp credentials, approved templates | P3 | credentials | phase7 tests |
| CM-02 | S05 p17 | Order confirmation / out for delivery / digital bill messages | PRODUCTION VERIFICATION REQUIRED | `queueOrderMessage` | live provider | P3 | CM-01 | |
| CM-03 | S05 p17 | Booking confirmation and reminder | NOT BUILT | | | P5 | CM-01 | |
| CM-04 | S05 p17 | Weekend specials to a segmented list (campaigns) | NOT BUILT | | | P3 | CM-01 | |
| CM-05 | S05 p17 | Feedback request 2 h after the visit | NOT BUILT | | | P5 | CM-01 | |
| CM-06 | S05 p17 | Daily business summary pushed at 9 AM | PARTIAL | see CP-07 (in-app) | WhatsApp delivery | P3 | CM-01 | |
| RS-01 | S05 p17 | Reservations, table-map aware, no double booking | COMPLETE | `ReservationSlot` locks | none | P5 | | reservation-concurrency tests |
| RS-02 | S05 p17 | Online booking from website / app / Google | NOT BUILT | staff-entered only | public booking page, Reserve with Google | P5 | | |
| RS-03 | S05 p17 | Digital waitlist with SMS when ready | PARTIAL | waitlist | SMS | P5 | SMS provider | |
| RS-04 | S05 p17 | No-show tracking | COMPLETE | NO_SHOW status | none | P5 | | |
| RS-05 | S05 p17 | Deposits for large groups | NOT BUILT | | | P5 | Razorpay | |
| RS-06 | S05 p17 | Special-occasion notes that reach the kitchen | PARTIAL | reservation notes | carry to KOT | P5 | | |
| RV-01 | S05 p17 | Post-meal feedback via QR or WhatsApp | PARTIAL | `Feedback` (staff entered) | guest feedback form on the order page | P5 | | |
| RV-02 | S05 p17 | Happy guests routed to Google / Zomato; unhappy reach you privately | NOT BUILT | | | P5 | RV-01 | |
| RV-03 | S05 p17 | Complaint trends by dish, shift, staff | NOT BUILT | | | P5 | RV-01 | |
| SO-01 | S05 p17 | Attendance check-in / out | COMPLETE | `Attendance`, manager corrections | none | P5 | | staff tests |
| SO-02 | S05 p17 | QR punch or selfie check-in with geofence | NOT BUILT | | | P5 | | |
| SO-03 | S05 p17 | Shift roster | PARTIAL | `Shift` definitions | assignment of people to shifts | P5 | | |
| SO-04 | S05 p17 | Leave requests | COMPLETE | `LeaveRequest` approve/reject | none | P5 | | staff tests |
| SO-05 | S05 p17 | Overtime and hours feeding payroll | NOT BUILT | hours derivable from attendance | payroll export | P5 | | |
| SO-06 | S05 p17 | Sales per staff member and tip distribution | NOT BUILT | `Order.createdById` | report + tips | P5 | | |
| SO-07 | S05 p17 | Training checklists, opening / closing duty lists | PARTIAL | `Task` with verify step | checklist templates | P5 | | |
| AG-01 | S05 p17 | Zomato and Swiggy orders pulled into the same ledger | PRODUCTION VERIFICATION REQUIRED | aggregator webhook -> order, `AggregatorOrder` | partner API access | P6 | partner credentials | webhooks tests |
| AG-02 | S05 p17 | Payout reconciliation | PARTIAL | `runAggregatorReconciliation`, `AggregatorSettlement` | settlement import screen | P6 | | |
| AG-03 | S05 p17 | Commission, penalty, ad-spend as real costs; net margin per aggregator, per dish | NOT BUILT | commission only | penalties, ad spend, margin report | P6 | | |
| AG-04 | S05 p17 | Switch items on/off across platforms | NOT BUILT | | | P6 | partner APIs | |

## Section 05 item 12: smaller things (p. 17)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| AD-01 | S05 p17 | GST invoice | COMPLETE | `TaxInvoice` CGST/SGST/IGST, credit notes | none (no legal compliance claim) | P2 | | invoicing tests |
| AD-02 | S05 p17 | E-invoice (IRN) | NOT BUILT | | IRP integration | P7 | GSP credentials | |
| AD-03 | S05 p17 | Tally / Zoho deep integration | NOT BUILT | CSV only (PP-14) | API sync | P7 | | |
| AD-04 | S05 p17 | Central kitchen and commissary | DEFERRED | inter-outlet transfers exist | multi-outlet decision | — | PA-08 | |
| AD-05 | S05 p17 | Franchise / licensee reporting | DEFERRED | | multi-outlet decision | — | PA-08 | |
| AD-06 | S05 p17 | Catering and bulk-order quotations | NOT BUILT | | | P7 | | |
| AD-07 | S05 p17 | Event and private-party booking | NOT BUILT | | | P7 | | |
| AD-08 | S05 p17 | Gift cards and prepaid packages | NOT BUILT | | | P7 | | |
| AD-09 | S05 p17 | Subscription coffee plans | NOT BUILT | | | P7 | | |
| AD-10 | S05 p17 | Supplier price-comparison board | PARTIAL | `VendorMaterial.lastRate` per vendor | comparison screen | P7 | | |
| AD-11 | S05 p17 | Energy and utility cost tracking | PARTIAL | expenses with UTILITIES category | meter readings, trend | P7 | | |
| AD-12 | S05 p17 | Asset and equipment maintenance log | NOT BUILT | | | P7 | | |
| AD-13 | S05 p17 | FSSAI temperature and hygiene checklists | NOT BUILT | | | P7 | SO-07 | |
| AD-14 | S05 p17 | Google Business Profile sync | NOT BUILT | | | P7 | | |
| AD-15 | S05 p17 | Instagram menu feed | NOT BUILT | | | P7 | | |
| AD-16 | S05 p17 | Digital signage for the counter screen | NOT BUILT | | | P7 | | |
| AD-17 | S05 p17 | Barcode / QR stock labels | NOT BUILT | | | P7 | | |

## RESTORA platform requirements (existing product decisions)

| ID | Proposal Section | Feature | Current Status | Existing Implementation | Missing Work | Priority | Dependencies | Verification |
|---|---|---|---|---|---|---|---|---|
| SE-01 | S09 p21 | Authentication, opaque sessions, idle timeout, step-up re-auth | COMPLETE | `src/server/auth/*` | none | P0 | | auth tests, session E2E |
| SE-02 | | CSRF / origin checks on every state change | COMPLETE | `assertSameOrigin` | none | P0 | | same-origin tests |
| SE-03 | | Rate limiting (login, webhooks, guest, reports) | PARTIAL | in-memory limiter | shared store for multi-instance | P0 | hosting | security tests |
| SE-04 | | Webhook signatures + idempotency | COMPLETE | HMAC, `WebhookEvent` unique | none | P0 | | webhook tests |
| SE-05 | | Payment never trusted from the client; refunds capped at captured | COMPLETE | `svc/payment.ts` | none | P0 | | idempotency-refunds, payment-balance tests |
| SE-06 | | Audit log with before / after | COMPLETE | `AuditLog`, `/audit` | none | P0 | | |
| SE-07 | | Secrets never sent to the browser; integration secrets encrypted | COMPLETE | `server/integrations/secrets.ts` | none | P0 | | integrations tests |
| SE-08 | S09 p21 | Append-only enforced by the database | PARTIAL | service-level only on SQLite | PostgreSQL triggers / RLS | P0 | PostgreSQL deploy | |
| SE-09 | | Background jobs and failure recovery (outbox worker) | COMPLETE | `src/server/ops/worker.ts` | none | P0 | | ops tests |
| SE-10 | | Observability: health, metrics, request timing | COMPLETE | `/api/health/*`, metrics | none | P1 | | config tests |
| SE-11 | | Production configuration validation | COMPLETE | `src/server/config/env.ts` | none | P0 | | env-validation tests |
| SE-12 | | Windows desktop app (Electron) with local DB, backups, upgrades | COMPLETE | `desktop/` | none | P1 | | desktop tests |
| SE-13 | | macOS desktop | PRODUCTION VERIFICATION REQUIRED | config + CI job | a green macOS CI run | P4 | Mac / CI | |
| SE-14 | | Code signing | PRODUCTION VERIFICATION REQUIRED | | certificates | P4 | | |
| SE-15 | | Public RESTORA website | COMPLETE | `src/app/(site)` | none | P1 | | `tests/site/website.test.ts` |
| SE-16 | | PostgreSQL production database | PRODUCTION VERIFICATION REQUIRED | suite + E2E executed on PG 16 | hosted instance | P0 | hosting | `docs/postgres.md` |

---

## Totals

Counted from the tables above (one row = one feature).

| Status | Before pass 10-07 | After pass 10-07 |
|---|---|---|
| COMPLETE | filled in at the end of the pass | filled in at the end of the pass |
| PARTIAL | | |
| NOT BUILT | | |
| PRODUCTION VERIFICATION REQUIRED | | |
| DEFERRED | | |
