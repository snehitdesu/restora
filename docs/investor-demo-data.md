# Investor demo data — what is real, what is synthetic, what to clean

Status 2026-10-20. Dry run only: **no database was changed.**

## Datasets and their provenance

| Dataset | Where | Contents | Class |
| --- | --- | --- | --- |
| Coders' Cafe menu | `prisma/coders-cafe/menu.ts` (source of truth), loaded by `npm run db:seed:cafe` | 8 categories, 64 items, sizes, the pizza add-ons — transcribed from the owner's board photos; 10 unreadable entries deliberately not imported (`UNRESOLVED`) | **A — owner's real menu.** Never edit to "improve" the demo. |
| Coders' Cafe draft recipes | `prisma/coders-cafe/recipes.ts` | 61 DRAFT recipes, every quantity **estimated** (not the kitchen's), no ingredient prices | Demo aid, labelled as estimates everywhere; never consumed or costed until confirmed + approved |
| Coders' Cafe seed | `prisma/coders-cafe/seed.ts` | org, outlet CC01, tables T01–T10, four role users, the menu, the draft recipes | **No orders, payments, customers, reviews or revenue are generated.** Dashboards start honestly empty. |
| "Aharos Demo Restaurant Group" | `prisma/seed.ts` (`npm run db:seed`, `npm run setup`) | 2 outlets, 22 items, sample orders / payments / customers / stock | **B — synthetic.** Used by the main E2E suite (`e2e/prepare-db.ts`) and local development. Never run against the investor demo database (docs/vercel-investor-demo.md already forbids it). |
| Investor E2E DB | `prisma/e2e-investor.db` | rebuilt every run: migrations + Coders' Cafe seed + the test bank binding | **C — test fixture**, disposable |
| Hosted investor demo (PostgreSQL) | not reachable from this work | Coders' Cafe only; orders / payments empty at the last read-only check (docs/vercel-investor-demo.md) | **D — shared.** Not touched. |

## `prisma/dev.db` (local development database) — dry-run classification

Read on a copy (`dev.db` itself was not opened for writing):

| Organization | Outlets | Menu items | Orders | Payments | Invoices | Customers | Stock ledger rows | Recipes | Users |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Aharos Demo Restaurant Group (created 2026-09-27, `prisma/seed.ts`) | 2 | 22 | 8 | 8 | 0 | 21 | 189 | 15 | 9 |
| Coders' Cafe (created 2026-10-06) | 1 | 64 | 4 | 2 | 2 | 1 | 0 | 0 | 4 |

The four Coders' Cafe orders are QR test orders from 2026-10-06 and 2026-10-13
(one of them the approved post-migration check, #CP6B44). They are test
activity, not fabricated history, but who placed each one is not recorded, so
they are **not** deleted.

**Decision: nothing deleted.** `dev.db` is the owner's working development
database (migrated with explicit approval on 2026-10-13, with backups), not a
conclusively disposable investor database. The Aharos organization is
synthetic but lives only in development / test databases and never in the
investor dataset.

## Getting a clean investor database (owner's choice)

The investor demo should be a database that holds **only** Coders' Cafe:

- **New disposable database (recommended):** migrate it, then
  `npm run db:seed:cafe`. The result has the real menu, tables, users and the
  draft recipes, and no transactions. For PostgreSQL the CLI demands
  `DEMO_DATABASE_CONFIRMED=true` and a unique `DEMO_STAFF_PASSWORD`.
- **Existing hosted demo database:** add only the draft recipes with
  `npm run db:seed:cafe -- --add-draft-recipes` (additive and idempotent: it
  never changes the menu and never deletes anything). It needs the
  `20261025100000_recipe_estimates` migration first. Do not run `--reset`
  there (docs/vercel-investor-demo.md).
- **If the owner wants dev.db cleaned anyway:** back it up first
  (`copy prisma\dev.db prisma\dev.db.before-cleanup-<date>.bak`), then remove
  only the Aharos organization with the same organization-scoped delete the
  seed uses (`deleteOrganizationData`, prisma/coders-cafe/seed.ts), and verify
  the Coders' Cafe counts above are unchanged. This needs the owner's go-ahead.

## Owner-recovery warning on the demo dashboard (kept on purpose)

The clean local demo database `prisma/investor-demo-2026-10-20.db` shows the
dashboard's owner-recovery warning. It is **true** for that database and is not
suppressed: the demo owner (`cafe.owner@demo.local`) has no recovery codes, its
`@demo.local` address cannot receive mail so it can never be confirmed, and it is
the only owner. Generating recovery codes alone would clear one of the three
gaps, not the banner, and would add security records to the clean database, so
it was not done.

If the owner wants a demo without the banner, the minimal manual steps (local
demo only, never on a real or hosted account) are, signed in as the demo owner:

1. **Account → Security → Generate recovery codes.** Save them in a password
   manager or a user-only file outside the repository; never commit or paste them.
2. **Staff → add a second owner** (Account → Security → "Open Staff") with a
   real email address that person controls.
3. The "email not confirmed" line stays while the demo owner uses
   `@demo.local`; it clears only for an owner whose real address is confirmed.

Or present the banner as what it is: RESTORA warning an owner who could be
locked out.
