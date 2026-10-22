# Recipe, ingredient and menu sign-off (owner / chef)

Nothing in this document has been signed off. RESTORA does not approve real
recipes or prices on anyone's behalf.

## Four kinds of value — never mix them

| Kind | Where | Status | Used for real stock / money? |
| --- | --- | --- | --- |
| **Demo values** | Demo Café organization (`prisma/demo-cafe/data.ts`, `docs/demo-cafe-data.md`) | Illustrative samples, approved only inside the demo organization | **No.** Demo only |
| **Recorded (draft) values** | Coders' Cafe: 61 draft recipes (`prisma/coders-cafe/recipes.ts`), 54 ingredients, menu prices from the menu boards | Estimated by RESTORA (recipes) or transcribed (prices); recipe versions are `estimated` and cannot be approved | Not until verified |
| **Verified real values** | Filled sheets + approved recipe versions in the café's RESTORA | **None yet** | Yes, once approved |
| **Awaiting approval** | Everything in the Coders' Cafe column above | Pending | — |

## Coders' Cafe — what needs a human (as of 2026-10-22)

| Item | Count | Current recorded value | Required verification | Status | Sheet |
| --- | --- | --- | --- | --- | --- |
| Draft recipes | 61 dishes, 429 lines | Estimated quantities from the dish name | Weigh each line for one base portion; confirm the line belongs; yield | Pending | `docs/kitchen-recipe-data/recipe-lines.csv`, tracked in `recipe-signoff.csv` |
| Dishes without a draft | 3 combos | None | Combo contents | Pending | `not-covered.csv` |
| Size factors | 24 sizes | 1× base for every size | Medium / Large consumption factor | Pending | `size-factors.csv` |
| Ingredient prices | 54 ingredients | **No price recorded** (costs show "Cost unavailable") | Price actually paid, pack size, GST incl./excl., bill date | Pending | `ingredients.csv` |
| Ingredient allergens | 54 | Draft guesses, labelled NOT VERIFIED | Label photo / supplier sheet | Pending | `ingredients.csv` |
| Units | 54 | g / ml / pc per recipe line | Confirm purchase unit vs recipe unit (pack size column) | Pending | `ingredients.csv` |
| Menu prices and taxes | 64 menu dishes | From the menu boards (`docs/coders-cafe-menu.md`); GST per RESTORA default | Owner confirms each selling price and GST rate; 10 unreadable board entries stay out | Pending | `docs/coders-cafe-menu.md` |
| Specific questions | 4 egg-wash lines (0.5 egg); 3 assumptions (penne, chicken spaghetti, one fries recipe for two flavours) | As drafted | Chef answers | Pending | `docs/kitchen-recipe-data/README.md` |
| Waste / yield loss | — | Not modelled per ingredient | Only the recipe yield exists; chef states the cooked yield | Pending | `recipe-lines.csv` (yield) |

## Demo Café — what a reviewer should check (only if the demo is shown to customers)

40 sample items, 26 sample recipes, 40 ingredients at demo rates. Review list
and columns: `docs/demo-cafe-data.md` → "Review". These never become café
data; the review only checks the demo looks plausible (prices, portion sizes,
veg flags). Allergen notes in the demo are explicitly unverified.

## Procedure

1. Chef works one category at a time from `recipe-signoff.csv`; weighs the
   lines in `recipe-lines.csv` and the sizes in `size-factors.csv`; names
   themselves in "Checked by".
2. Owner fills `ingredients.csv` from real bills (price, pack, GST, date).
3. Manager enters them in RESTORA: purchases as goods receipts (this sets
   cost); recipe lines → **Confirm quantities** → **Approve**; size factors on
   each variant.
4. The tracker's last two columns (approved by, date) are filled only after
   the version is approved in RESTORA.
5. Owner confirms menu prices and GST in RESTORA's menu.
6. Spot check: three dishes' food cost in RESTORA vs a hand calculation from
   the filled sheets.

A recipe or price counts as verified only when steps 1–4 are complete for it
and a named person has signed it. Until then stock deduction and food cost for
that dish are not to be relied on.
