# Group 3 implementation map: kitchen production, money desk, daily operations

Written 2026-10-08 before any Group 3 code, from a read of the services, schema,
routes, screens and tests listed below. Proposal references are printed page
numbers of the Yeswant Sai proposal.

## Roadmap numbering and the old "Group 7"

The first gap pass (`docs/master-feature-audit.md`) numbered its groups
1 integrity, 2 reorder, 3 menu engineering / leakage, 4 department costing,
5 kitchen production, 6 money desk / floor / search, 7 external.
The master program renumbers them:

| Master program group | Absorbs from the first pass |
|---|---|
| 3 kitchen production + money desk + daily ops | old 5, old 6 (money desk, Z-report), CP-01 leakage (variance) |
| 4 menu engineering + advanced inventory + costing | old 3 (menu engineering), old 4 (department costing, stock matrix) |
| 5 integrations + accounting + external | **old 7 (external)** |
| 6 growth / CRM / comms | section 05 p. 17 |
| 8 mobile + advanced operations | section 05 pp. 16-17, old 6 floor items (captain split / merge / transfer, universal search) |
| 9 infrastructure | section 09 |

Old Group 7 is therefore not lost: every "external" row (Petpooja, Google
Sheets, Tally / Zoho, aggregators, WhatsApp provider) is Group 5 or Group 6
scope and is tracked by its audit row ID.

## What exists (audited)

| Area | Code | State |
|---|---|---|
| Sub-recipe batches | `svc/production.ts` | DRAFT -> IN_PROGRESS -> COMPLETED; inputs PRODUCTION_CONSUMPTION, output PRODUCTION_OUTPUT at input cost / actual qty; one-shot; no department |
| Recipe explosion | `svc/recipe.ts explodeRecipe` | explodes every SUB_RECIPE line down to raw materials, always |
| Sale depletion | `svc/orderConsumption.ts` | recipe explosion per settled order, once (`stockConsumed`); department-per-station change in the tree, untested |
| Material wastage | `svc/wastage.ts` | DRAFT -> POSTED, approval above Rs 2,000, idempotent, txnType by reason |
| Dish wastage | `createDishWastage` | draft in the tree, untested |
| Dish worksheet | `svc/productionWorksheet.ts`, `DishProduction` | draft in the tree, untested; posts its own WASTAGE rows |
| Manual sales log | `svc/manualSales.ts` | draft in the tree, untested |
| Count variance | `StockCount` | complete |
| Leakage | `foodCostLeakage` in `svc/menuEngineering.ts` | draft, untested |
| Payments reconciliation | `saveDailyReconciliation` | expected vs counted per method (+ BANK), locks on completion |
| Petty cash | `recordPettyCash` | append-only, opening once, no overdraw, idempotent |
| Cash drawer | `CashDrawerSession` | open / pay-in / pay-out / close with frozen variance |
| Daily closing | `dailyClosing` | summary + blockers only; **no closed state, nothing is locked** |
| Discrepancies | `svc/anomaly.ts` | OPEN -> ACKNOWLEDGED -> RESOLVED / DISMISSED, audited |
| Kitchen role | `rbac.ts` | KDS, recipes, stock view only; cannot log wastage, production or dish sales (proposal p. 8 / p. 12 says it can) |

## Defects found by the audit

1. **Double consumption through batch-produced sub-recipes (P0).** Every
   SUB_RECIPE has an output material and can be produced as a batch, which
   consumes the raw materials into prepared stock. A dish sale then explodes
   the same sub-recipe down to the raw materials *again*, and the prepared
   stock never goes down. Fix: a recipe is either *batch-produced*
   (`Recipe.stocked`): dishes draw on its prepared stock, and only such
   recipes can be produced; or not, and dishes explode through it as today.
   The migration marks recipes that already have a completed batch as
   batch-produced (that is what their owners were doing).
2. **Production ignores departments.** With issues now moving stock into
   departments, a batch consumed from "unassigned" stock while the inputs sat
   in the kitchen. Fix: `ProductionBatch.departmentId`; inputs out of and
   output into that department.
3. **Two wastage paths for dishes.** The worksheet draft posted its own
   ledger rows, separate from the wastage register: a chef logging "3 pizzas"
   in both would deplete twice, and register reports would miss worksheet
   wastage. Fix: the wastage register is the only path; the worksheet's
   *wasted* column is read from posted dish-wastage documents of that day, and
   its "add wasted" action creates one (same approval rule).
4. **A closed day can still be changed silently.** No closed state exists.

## Rules decided for Group 3 (all from the proposal or existing behaviour)

- Preparing dishes does not move stock; selling does (p. 7), wasting does
  (p. 6). Worksheet variance = prepared - sold - wasted is a flag, not a
  ledger movement (p. 8 "unexplained gap"); unrecorded loss surfaces at the
  next count. This is what keeps consumption single.
- Wastage cost of a dish = plate cost (p. 8), i.e. its recipe exploded at
  average cost.
- Material variance (G3.6) = actual usage vs theoretical usage per material
  for a period: theoretical = sale consumption; actual = theoretical +
  wastage + count loss (p. 11). No threshold is invented: rows are ranked by
  rupee variance.
- Money desk (p. 9): declared revenue per channel (dine-in, each aggregator)
  vs POS expected gross (every item sold x its menu price) vs collected per
  method vs deposited. Aggregator commission at the stored commission %.
  Expected to bank = collected cash + UPI + card (p. 9 sample). Every gap is
  shown exactly (Decimal, 2 dp, never rounded away). Discrepancies are raised
  through the existing anomaly engine with the existing tolerance
  (`FINANCE_RULES.mismatchTolerance`), not a new threshold.
- Bank deposits: separate slips (date, amount, reference, sales day covered),
  void with reason, never deleted; a deposit made after the day closed is
  normal ("a deposit made a day late", p. 9) and is allowed.
- Daily close: one revision per close, figures frozen; the closed day refuses
  new declared figures, payment reconciliation changes, back-dated manual
  sales, worksheet entries and expenses dated into it. Correction = reopen
  (finance.reconcile, step-up re-authentication, reason) which keeps the
  frozen revision and requires a new close.
- Kitchen workspace (p. 8, p. 12): KITCHEN gains `inventory.wastage` and
  `inventory.produce` (wastage, worksheet, batches, dish sales log) and a new
  `indent.create` (raise indents only). Costs stay hidden from it.

## Build order

1. Recipe stocking + explosion modes + costing; production department.
2. Dish wastage + worksheet (on the wastage register) + manual sales log.
3. Material consumption variance + leakage.
4. Money desk: declared sales, three-way check, bank deposits, petty cash day
   summary, daily close / reopen with locks, discrepancy wiring, Z-report.
5. Kitchen permissions.
6. Screens: production (worksheet tab, batches), wastage (dish mode),
   variance, money desk, day close.
7. Tests (domain, API, UI, PostgreSQL), browser QA, audit rows.

## Group 3 gate (2026-10-08)

Verified on an isolated copy of the tree (the repo's `next dev` and the user's
databases were never touched), PostgreSQL 16.14 on a throwaway cluster.

### Defects found by the gate and fixed

1. **The money desk E2E never ran to the close.** `G3-MD-001` skipped itself
   whenever today had open orders, which it always does in the E2E dataset,
   so close / lock / reopen had never passed in a full run. Rewritten: it
   asserts that today's blockers keep "Close day" disabled, then declares,
   counts, banks, closes and reopens yesterday (no trading in the dataset)
   from the screen. No skip remains.
2. **A day without sales or payments could not be closed from the screen.**
   "Revenue by channel" had no row to declare (saving sent an empty list:
   422) and "Money collected" had no input and no save button, so the
   payments count could only be entered through the API. A no-sales day now
   shows a dine-in row (declare zero) and a cash row (count the drawer).
3. **Concurrent posts of one stock document answered 500 on PostgreSQL.** Two
   posts of the same wastage document (or GRN, issue, batch, transfer, count:
   every document posts "read draft, write ledger rows, mark posted") both
   read the draft; the second ledger insert collided with the first's unique
   posting key (`InventoryLedger.sourceRef`) and surfaced as a raw P2002.
   Stock never moved twice (the key held), but the request failed.
   `isLedgerKeyRace` (`server/db/conflict.ts`) makes `runInTx` re-run such a
   transaction on PostgreSQL; the re-run sees the post and answers normally
   (422 already posted, or the idempotent no-op of GRN / issue). Races are
   tested for wastage, batch completion, GRN and issue; transfer dispatch /
   receipt and count approval have the same shape and the same fix, untested.
4. **A double-tapped worksheet "add wasted" answered 422** (same key: the
   retry tried to post the document the first tap had just posted). It now
   returns the posted document.
5. **A manual sales log sent twice at once answered 500 on PostgreSQL** (the
   second insert hit the unique `externalRef`). It now replays the first.
6. **The batch page showed no cost.** The batch was costed in the ledger
   (proposal p. 8 "costs the batch, and therefore the per-litre rate") but
   no screen showed it. `getProductionBatch` now returns the batch cost,
   cost per unit, input rates, yield against the plan and who planned /
   completed it; costs are left out for logins without cost rights.
7. **Responsive / print:** the leakage card overflowed a 390 px screen by
   11 px; the money desk inputs sat off-screen on a phone; the printed day
   report showed empty input boxes on an open day. Fixed and re-checked.
8. Two tests were wrong, not the code: the report registry test predated the
   CONSUMPTION_VARIANCE / MENU_ENGINEERING reports (now covered, including a
   CSV test), and a guest-cart test read sessionStorage in the same tick as
   the render whose effect writes it (now waits for it).

### Evidence

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`), ESLint | 0 errors, 0 warnings |
| Full suite, SQLite | 100 files, 1075 passed, 6 skipped (PostgreSQL-only) |
| Full suite, PostgreSQL 16 (fresh database) | 97 files, 1053 passed, 28 skipped (desktop / SQLite-only suites) |
| Concurrency (`tests/db/stock-post-concurrency.test.ts`, `day-close-concurrency.test.ts`) | 9/9 on PostgreSQL, three fresh databases in a row; also on SQLite |
| Migration drift, PostgreSQL | migrations vs schema (shadow database) and deployed database vs schema: no difference |
| Migration drift, SQLite | migrations vs schema: no difference |
| `next build` (production) | passes |
| Browser E2E (production build, real API + DB) | 85/85, nothing skipped; money desk + finance specs re-run on the last build: 9/9 |
| Investor E2E (Coders' Cafe, T07 QR, Razorpay emulator) | 3/3 |
| Post-deploy smoke with one write transaction | 18/18 |
| Visual check (production build, disposable demo DB) | money desk (open, no-sales day, print), worksheet, variance, batches, batch page, wastage, kitchen stock at 390 / 768 / 1024 / 1440 px: no horizontal overflow, no console errors, no rupee figure on any kitchen screen |

### Known limitations carried forward

- Wastage availability is checked against the outlet's total stock, not the
  department's (issues and production check the department). Sales never
  block, so a department can still go negative through sales; the count
  corrects it. Left as is; noted for the inventory work in Group 4.
- On phones, aggregator commission / expected payout and the per-method
  difference columns of the money desk are hidden (visible from 640 px); the
  shared `DataTable` still forces full content width, so other wide tables
  scroll sideways inside their card on a phone (final UI/UX pass).
- The frozen per-line cost (`OrderItem.unitCost`, Group 4 work already in
  the tree) includes add-on ingredients; menu engineering must compare it
  with the price including add-ons (Group 4).
