# RESTORA Demo Café — sample menu, recipes and inventory

_Added 2026-10-22 (uncommitted when written). Data: `prisma/demo-cafe/data.ts`.
Builder: `prisma/demo-cafe/seed.ts`. CLI: `prisma/seed-demo-cafe.ts`. Tests:
`tests/db/demo-cafe-seed.test.ts`._

**Everything in this dataset is SAMPLE data written for demonstrating RESTORA.**
It is not any restaurant's real menu, price list, recipe book, supplier list or
tax configuration, and nobody has approved it. The real Coders' Cafe menu
(`prisma/coders-cafe`, `docs/coders-cafe-menu.md`) and its draft recipes are a
separate dataset; the demo never reads or changes them.

## What it is for

Showing the whole restaurant flow on a local or disposable database without
inventing a real café's data:

menu with sizes and add-ons → POS or guest QR order → kitchen tickets routed to
KITCHEN / BAR → payment → **stock deducted by the recipes** (including a
sub-recipe and stock-linked add-ons) → **food cost and margin per dish** →
**low-stock list** → stock movement history → suppliers linked to ingredients
for purchasing.

## Running it

```powershell
# a disposable SQLite file (relative paths resolve inside prisma/)
$env:DATABASE_URL = "file:./demo-cafe.db"
npx prisma migrate deploy
npm run db:seed:demo-cafe -- --confirm-demo-database=demo-cafe.db
npm run dev        # sign in as one of the accounts below
```

| Command | Effect |
| --- | --- |
| `npm run db:seed:demo-cafe -- --confirm-demo-database=<database>` | Creates the demo organization. If it already exists: **nothing changes** (the report says so). |
| `… --confirm-demo-database=<database> --reset` | Deletes **only** the demo organization and builds it again. Refused if anyone other than the four demo accounts has been added to it (then it is no longer a pure demo). |

Guards (all enforced by the CLI, tested):

- `--confirm-demo-database=<database>` is always required and must **name the
  target database**: the SQLite file name (`file:./demo-cafe.db` →
  `demo-cafe.db`) or the PostgreSQL database name. A bare flag or another name
  is refused, and the refusal says which database `DATABASE_URL` points at
  (never the URL, user, host or password). So a confirmation typed for the demo
  file can never seed a different database that happens to be in the
  environment (`prisma/demo-cafe/target.ts`, `tests/ops/demo-seed-target.test.ts`).
- `dev.db` (the working local database) is always refused, even when named.
- The guard checks the `DATABASE_URL` the seed will actually use, including one
  loaded from `.env` (checked 2026-10-22: with no variable in the shell, `.env`
  points at `dev.db` and the seed refuses). Always set `DATABASE_URL` explicitly
  for the command.
- Refused under `NODE_ENV=production`.
- PostgreSQL additionally needs `DEMO_DATABASE_CONFIRMED=true` and a unique
  `DEMO_STAFF_PASSWORD` of at least 12 characters (the Coders' Cafe seed's
  rules). SQLite uses `DEMO_STAFF_PASSWORD` or the documented local demo password
  (`prisma/coders-cafe/seed.ts`); the password is never printed.
- The whole dataset is built in **one transaction** through RESTORA's own
  services (menu, master data, recipes, opening stock, table QR), so every row
  has its normal audit record and a failure leaves nothing behind.
- It lives in its **own organization**. No other organization's data is
  changed, and reset deletes nothing outside it (tested next to another
  restaurant's menu and customers).

Sign-in accounts (demo organization only): `owner@demo-cafe.restora.local`
(OWNER), `manager@…` (MANAGER), `chef@…` (KITCHEN), `cashier@…` (CASHIER),
all `@demo-cafe.restora.local`.

## How to tell demo data from real data

| Where | Marker |
| --- | --- |
| Organization | **RESTORA Demo Café — sample data** (outlet code `DEMO01`, invoice series `DEMO`) |
| Menu items | POS codes `DEMO-101` … `DEMO-902` |
| Ingredients | SKUs `DEMO-…` |
| Suppliers | "Demo … Supplier (sample)", no phone, GSTIN or bank details, note "SAMPLE supplier … not a real vendor" |
| Recipes | Every version's note starts "SAMPLE recipe written for the RESTORA demo café: illustrative quantities, not a chef-verified or weighed recipe. Allergens not verified." |
| Stock | Opening-stock note "DEMO opening stock: sample quantities at demo-estimate rates (not supplier prices)" |

## Contents (counted from a seeded database, 2026-10-22)

| | Count | Notes |
| --- | --- | --- |
| Menu categories | 10 | Hot Beverages, Cold Beverages, Breakfast, Snacks, Burgers & Wraps, Starters, Main Course, Rice & Biryani, Breads, Desserts |
| Menu items | 40 | 38 veg, 2 non-veg (Chicken Tikka, Chicken Biryani); sample prices ₹30–₹300 |
| Sizes | 3 | "Large" on Masala Chai (+₹15), Cappuccino (+₹30) and Café Latte (+₹30), 1.5× the recipe |
| Modifier groups | 6 (11 options) | Sugar level, Spice level, Lime soda style; **stock-linked:** Extra shot (+₹30, 9 g espresso), Extra cheese (+₹30, 20 g), Extra paneer (+₹60, 50 g) |
| Ingredients | 40 + 1 prepared | base units kg / L / pc; opening stock and reorder levels set; **Paneer opens below its reorder level** so the low-stock list shows something |
| Recipes | 26 | 25 dishes + the Sambar sub-recipe (2 kg batch, used by Masala Dosa and Idli Sambar); one serving each; approved **inside the demo organization only** so stock and food cost can be shown |
| Sample suppliers | 3 | Dairy, Produce, Dry goods; linked to their ingredients at the demo rates |
| Tables | 6 | D01–D06 with random QR tokens; the restaurant (common) QR is left for staff to issue |
| Users | 4 | see above |

Items with a recipe: Masala Chai, Filter Coffee, Cappuccino, Espresso,
Americano, Café Latte, Cold Coffee, Lemon Iced Tea, Fresh Lime Soda, Masala
Chaas, Masala Dosa, Idli Sambar (2 pc), Veg Sandwich, Veg Burger, Paneer Wrap,
French Fries, Paneer Tikka, Paneer Butter Masala, Dal Tadka, Veg Biryani, Jeera
Rice, Curd Rice, Butter Naan, Garlic Naan, Gulab Jamun (2 pc).
(Espresso, Americano, Café Latte, Lemon Iced Tea, Veg Burger, Paneer Wrap and
French Fries, the Burgers & Wraps category and the bun, wrap, lemon, frozen
fries and ketchup ingredients were added on 2026-10-22, second pass.)
The other 15 items have none on purpose: selling one shows RESTORA's
**unmapped sale** queue (the sale is recorded, stock is not guessed).

Tax: every item uses RESTORA's default **5 %** (`MenuItem.taxPct` default, GST
on restaurant service) — a documented demo configuration, not tax advice.

What "approved" means here: RESTORA uses only an approved recipe version for
stock and food cost, so the seed approves the demo recipes (audited as the
system). That is the demo's switch, **not** a chef's sign-off.

Allergens: RESTORA has no verified allergen field. A recipe's note lists only
what its own sample ingredient list contains (milk, wheat (gluten)) and says it
is not verified. Nothing is labelled allergen-free.

## Verified (tests/db/demo-cafe-seed.test.ts, SQLite and PostgreSQL 16)

1. Seeds a fresh database next to another restaurant's data.
2. Seeding again changes nothing (counts, audit rows, ledger rows, users).
3. Every item, recipe, ingredient and table belongs to the demo organization;
   all prices and size prices are positive.
4. Every recipe is approved, references real demo records, has positive
   quantities and carries the sample / not-verified note.
5. Food cost from RESTORA's costing (`menuItemCostAndMargin`) equals the cost
   worked out by hand from `data.ts` (including the sambar sub-recipe).
6. The low-stock list is exactly the ingredients opened at or below reorder.
7. A cashier sees the 40 items; an order (2 × Large Masala Chai + Masala Dosa)
   sent to the kitchen makes BAR and KITCHEN tickets, nothing is deducted
   before payment, and after the normal cash payment the stock falls by exactly
   the recipes (× 1.5 for Large; the sambar exploded into its ingredients);
   no stock goes negative.
8. Without a database: every recipe names a menu item and known ingredients;
   kg / L quantities per serving are below 1 and piece quantities are whole
   (a gram figure typed as kg would fail); each recipe's food cost is 2–45 % of
   its sample price; every category is used.
9. Reset rebuilds only the demo organization; refused once a non-demo account
   exists in it.

The CLI's refusals (no flag; `NODE_ENV=production`; PostgreSQL without
confirmation) were run by hand on a disposable SQLite file.

## Owner / chef review checklist

The demo stays SAMPLE data. The real café's data needs its own review; nothing
below may be copied into a real restaurant without it.

| Area | Demo data (sample, unapproved) | Real café: who must confirm |
| --- | --- | --- |
| Menu items | 40 illustrative Indian café items | Owner: the real menu (Coders' Cafe boards are transcribed in `prisma/coders-cafe/menu.ts`; unreadable entries are listed there as UNRESOLVED) |
| Selling prices | Plausible ₹ examples | Owner: approved prices, sizes and add-on prices |
| Recipes | 26 sample recipes, one serving each | Chef: weighed recipes and yields per dish (the Coders' Cafe drafts are `estimated` and cannot be approved until confirmed) |
| Ingredient quantities | Illustrative, consistent with each yield | Chef: per-portion quantities, wastage % |
| Ingredient costs | Demo estimates used as opening-stock rates | Owner / purchasing: real costs come from received purchases (GRNs), not typed rates |
| Suppliers | 3 "Demo … (sample)" suppliers without contact details | Owner: real vendors, terms, GSTIN, bank details (verified separately) |
| Units and conversions | kg / L / pc base units | Chef + purchasing: purchase units and conversions per ingredient |
| Taxes | 5 % default on every item | Owner / accountant: GST rate per item and invoicing details |
| Allergens and dietary claims | Notes list milk / wheat in the sample lists only, unverified; veg flags follow the sample recipes | Chef / owner: allergen and veg / non-veg claims before any guest sees them |
| Opening stock and reorder levels | Sample quantities | Store: a real opening stock count |

Sign-off for the real café is recorded in `docs/owner-go-live-checklist.md`,
not here.
