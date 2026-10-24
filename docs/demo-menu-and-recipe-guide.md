# Demo menu and recipe guide (RESTORA Demo Café — SAMPLE data)

The detailed contents and the owner / chef review table are in
`docs/demo-cafe-data.md`. This page is the operator's how-to.

**Everything in the Demo Café is illustrative sample data**: menu prices,
recipes, quantities, ingredient rates and suppliers were written for the demo.
None of it is the Coders' Cafe menu, a supplier quotation, or a chef-verified
recipe, and none of it is approved for real stock or money decisions.

## What it creates

One separate organization, **"RESTORA Demo Café — sample data"**, outlet
`DEMO01` (INR, Asia/Kolkata, 07:00–23:00), with:

| | Count |
| --- | --- |
| Menu categories | 10 — Hot Beverages, Cold Beverages, Breakfast, Snacks, Burgers & Wraps, Starters, Main Course, Rice & Biryani, Breads, Desserts |
| Menu items | 40 (38 veg, 2 non-veg), POS codes `DEMO-…`, sample prices ₹30–₹300, GST 5 % (RESTORA default) |
| Sizes | 3 ("Large", 1.5× the recipe) |
| Modifier groups | 6 (sugar, spice, lime-soda style; stock-linked extra shot / extra cheese / extra paneer) |
| Ingredients | 40 stocked (SKUs `DEMO-…`) + 1 prepared (sambar), with opening stock |
| Recipes | 26 = 25 dishes + 1 sub-recipe (sambar), approved **inside the demo organization only** |
| Suppliers | 3, named "Demo … (sample)", no contact / tax / bank details |
| Tables | 6 (D01–D06) with random QR tokens; the restaurant (common) QR is not issued |
| Users | owner / manager / chef / cashier `@demo-cafe.restora.local` |

Dishes with a recipe include the café staples Espresso, Americano, Cappuccino,
Café Latte, Cold Coffee, Masala Chai, Filter Coffee, Lemon Iced Tea, Fresh
Lime Soda, Masala Chaas, Veg Sandwich, Veg Burger, Paneer Wrap, French Fries,
plus Indian breakfast / mains / breads (full list in `docs/demo-cafe-data.md`).
The other 15 items deliberately have no recipe, so selling one shows RESTORA's
unmapped-sale queue.

## Seed it (local or disposable database only)

```sh
# 1. A disposable SQLite database (never dev.db or a real café database)
DATABASE_URL="file:./demo-cafe.db" npx prisma migrate deploy
# 2. Seed: the confirmation must name the target database (refused when
#    NODE_ENV=production, for dev.db, and for a bare flag or another name)
DATABASE_URL="file:./demo-cafe.db" npm run db:seed:demo-cafe -- --confirm-demo-database=demo-cafe.db
```

- Password: `DEMO_STAFF_PASSWORD`, or the documented local demo password on
  SQLite. PostgreSQL additionally requires `DEMO_DATABASE_CONFIRMED=true` and a
  unique `DEMO_STAFF_PASSWORD`. The password is never printed.
- Payments: start the app with the usual local mock / emulator provider. The
  seed itself creates no payment and contacts no provider.
- Launch: `DATABASE_URL="file:./demo-cafe.db" npm run dev`, sign in as
  `manager@demo-cafe.restora.local`, pick outlet DEMO01.

## Idempotency, reset, isolation

- Running the seed again prints "already exists … nothing changed" and changes
  nothing (verified by `tests/db/demo-cafe-seed.test.ts` and by running the CLI
  twice on a fresh database on 2026-10-22: 10 / 40 / 26 both times; re-checked
  on a new disposable file with the by-name confirmation: a third run left
  every table's row count — audit log included — and the menu / stock-ledger
  content hashes identical).
- `--reset` deletes **only** the demo organization and rebuilds it. It refuses
  if any account other than the four demo accounts exists in it (someone
  started using it for real).
- The whole build is one transaction: a failure leaves nothing behind.
- Other organizations are never read for writing, changed or deleted (tested
  with a second "real" restaurant in the same database).

## Units and costing conventions

- Every ingredient has a base unit: `kg`, `L` or `pc`. Recipe lines are in that
  base unit (0.15 = 150 g / 150 ml). Piece lines are whole numbers.
- Ingredient rates are ₹ per base unit and enter RESTORA **only** as the
  opening-stock rate, which becomes the weighted-average cost. Recipe cost is
  computed by RESTORA's own costing (`menuItemCostAndMargin`), not stored.
- Sizes scale the recipe by `consumptionFactor` (Large = 1.5).
- The sambar sub-recipe yields 2 kg; dishes use it in kg and stock is
  deducted through it into its ingredients.
- Stock is deducted once, when the order is paid (verified: nothing moves
  before payment; after payment the ledger falls by exactly the recipes).
- Tests guard against unit slips: kg / L per serving must be below 1, pieces
  whole, and each dish's cost 2–45 % of its sample price.

## Telling demo data from real café data

| Signal | Demo | Real (Coders' Cafe) |
| --- | --- | --- |
| Organization | "RESTORA Demo Café — sample data" | the café's own |
| POS codes / SKUs | `DEMO-…` | café codes / `CC-…` |
| Recipe note | starts "SAMPLE recipe written for the RESTORA demo café…" | Coders' Cafe drafts are `estimated` and unapproved |
| Supplier names | "Demo … (sample)" | real vendors |
| Prices | sample | owner-approved menu only |

Never seed the demo into the café's database, and never copy demo prices or
recipes into it. The café's own 61 draft recipes and 54 unpriced ingredients
are reviewed through `docs/kitchen-recipe-data/` (see
`docs/recipe-ingredient-signoff.md`).
