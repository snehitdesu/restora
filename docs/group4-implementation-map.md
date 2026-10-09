# Group 4 implementation map: menu engineering, advanced inventory, costing

> Design record written before the group was built. Where it says something "does not exist" or is a "draft", it describes that moment, not the repository today: current state is in `docs/master-feature-audit.md` and `docs/stabilization-report.md`.

Written 2026-10-08 after Group 3, from a read of `svc/menuEngineering.ts`,
`svc/departmentCosting.ts` (both drafts from the 10-07 pass), `svc/recipe.ts`,
`svc/orderConsumption.ts`, `svc/analytics.ts` and the proposal (pp. 4, 6, 8,
10, 11, 17).

## What exists

| Area | State |
|---|---|
| Plate cost, food cost %, margin per dish | `menuItemCostAndMargin` (live, current average cost) |
| Menu engineering | draft `menuEngineering`: median volume / median margin %, four classes, advice text, >38% re-cost flag; route wired, no UI, no tests |
| Leakage | done in Group 3 (`/inventory/variance`) |
| Stock matrix, department P&L, daily costing | drafts in `svc/departmentCosting.ts`; routes wired; no UI, no tests |
| Stock ageing, consumption, purchase trend, vendor purchasing | analytics, existing |
| Supplier prices | `VendorMaterial.lastRate` per vendor, shown inside the reorder screen only |
| Barcode / QR labels | none (the `qrcode` package is already used for table QR) |

## Gaps and decisions

1. **Historical cost was not kept per dish.** Sale consumption is written per
   order and material, so the cost of a dish when it was sold could not be
   recovered once prices moved. `OrderItem.unitCost` is now frozen at
   consumption (recipe explosion x the average cost used for the ledger rows,
   per unit). Historical plate cost of a period = sum of those costs / portions
   sold; current = today's recipe cost. Cost change and margin change follow.
2. **Overhead % per recipe** (proposal p. 4) is not built.
   `RecipeVersion.overheadPct` (default 0, so nothing changes until set):
   plate cost = ingredient cost x (1 + overhead %). Food cost % stays
   ingredients / price, as the proposal's table shows; margin is price -
   plate cost.
3. **Menu engineering data sufficiency** (no invented thresholds): a class is
   given only when the period has sales and at least two dishes can be scored
   (a median split needs two). A dish that was not on the menu for the whole
   period (created after its start) is listed as "new in this period", not
   judged. Dishes without an approved recipe or a price stay unscored, with the
   reason. Recommendations are exactly the proposal's (p. 10).
4. **Supplier price comparison** (p. 17): per material, every vendor link at
   its base-unit rate, purchase unit and factor, lead time, preferred flag,
   vendor status (only ACTIVE can be bought from, Group 1), plus the last
   received rate per vendor from posted GRNs. Incompatible units are never
   compared: everything is per base unit.
5. **QR stock labels** (p. 17 "Barcode / QR stock labels"): printable labels
   carrying the material's SKU (not its internal id), and a scan / look-up
   screen that resolves a SKU to the material's stock and movements.
6. Department P&L, daily costing, stock matrix (pp. 6, 8): finish the drafts
   with tests and screens; variance trend over counts (p. 6).
