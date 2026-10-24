# Working-tree diff review — 2026-10-22

Branch `release/coders-cafe-2026-10-13`, HEAD `a26b788`, 2 commits ahead of
`origin/release/coders-cafe-2026-10-13`. Everything below is **uncommitted**:
50 modified tracked files and 18 untracked files at the start of this review
(backup: tracked patch + untracked tar outside the repository, reverse-apply
checked). Nothing was staged, committed or pushed.

`git diff --check`: clean (before and after this pass).

## What the diff is

Four pieces of work, all in this tree since `a26b788`:

1. **Common restaurant QR** (one code for every table; guests order with no
   table; staff assign the table later) — `docs/common-qr-ordering.md`.
2. **Concurrency fixes** for the guest limits (per-table 3 waiting / 6
   unsettled; common QR 30 waiting per outlet in 15 min), counted again inside
   the order's transaction under an advisory lock.
3. **The two order-handling decisions** (customer record inside the order
   transaction; explicit, audited staff override of table limits).
4. **Ops / readiness**: `--expect-migration` for backup / restore / verify,
   `qr:audit` exit 3 on an empty database and the common-QR row, read-only
   Production audit SQL, Demo Café sample seed, documentation.

## Review matrix — source

| File | Why it changed | Functional impact | Security | DB / migration | Tests | Required | Concern |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `prisma/schema.prisma`, `prisma/migrations/20261026100000_outlet_common_qr`, `prisma/postgres/migrations/20261026100000_outlet_common_qr` | `Outlet.guestQrToken String? @unique` | Holds the common QR token | Random token, same namespace as table tokens | Additive: nullable column + unique index; identical SQL for SQLite and PG; no backfill | `tests/ops/expected-migration.test.ts`, `infrastructure.test.ts` | Yes | None |
| `src/server/ops/readiness.ts` | `EXPECTED_MIGRATION` → `20261026100000_outlet_common_qr` | Readiness fails until the migration is applied | — | Deploy order: migrate before the app | `infrastructure.test.ts` | Yes | Production must be migrated before this build serves (documented in preflight) |
| `src/server/services/_workflow.ts` | `lockInTx` (PG `pg_advisory_xact_lock(hashtextextended(key,0))`; SQLite no-op) | Serializes read-then-decide counts under READ COMMITTED | Key is parameterised (tagged template), no SQL injection | Transaction-scoped: released on commit / rollback | PG barrier tests | Yes | SQLite relies on `runInTx`'s write queue (tested) |
| `src/server/services/guestOrdering.ts` | Common-QR resolution; limits re-counted in-tx; rate limit per table / per device; customer passed to `placeOrder` | Outlet / org always from the token's DB row; no table for common QR; refused submissions roll back | Strict body schema (no outletId / tableId accepted); price from server; token never logged in audit | No schema change | `common-qr.test.ts`, `guest-checkout-concurrency.test.ts`, `common-qr-routes.test.ts` | Yes | `meta.ip` missing → all such devices share one bucket "unknown" (fail-safe: stricter, not looser) |
| `src/server/services/orders.ts` | `placeOrder` `opts.customer`: find-or-create the CRM customer **inside** the order tx under `customer-phone:<org>:<phone>` lock; request hash recomputed with the real id; P2002 replay path re-reads the winner's customer | A refused order leaves no customer row; one phone's racing first orders make one customer | Phone normalised before (`normalizeGuestPhone`) so the pre-tx lookup and the stored phone are the same string (checked) | No schema change | 3 tests in `guest-checkout-concurrency.test.ts` (pre-fix: 4 customers for 1 placed order) | Yes | None found |
| `src/server/services/orderOps.ts` | `setOrderTable` (assign / change table; compare-and-set; limit check after table row lock, same lock order as guest tx; `TableGuestLimitError` 409 unless `overrideGuestLimits`; audit `guestLimitOverride`), `listQrOrdersForTables` | Staff seat common-QR orders; over-limit needs an explicit override, audited with the acting user | `assertOutletAccess` + `assertCan("order.modify")`; table must be in the order's outlet and org | — | `common-qr.test.ts` (normal, over-limit, override, concurrent, unauthorized, cross-outlet), route + UI tests | Yes | See finding R2 |
| `src/server/qr/tableToken.ts` | Token issuance checks both namespaces | No token can open two places | — | — | `table-qr-token.test.ts`, `common-qr.test.ts` | Yes | None |
| `src/server/qr/scan.ts`, `src/features/backoffice/tableQrScanner.tsx` | Scanner understands the common QR (table null) | — | Out-of-scope codes still answer not-found | — | `common-qr.test.ts` | Yes | None |
| `src/server/services/masterData.ts`, `src/app/api/master/[[...path]]/route.ts` | get / rotate / revoke outlet common QR | Outlet managers only | `assertOutletManager`; audit records issued/rotated/revoked, never the token | — | `common-qr-routes.test.ts` (session, role, same-origin) | Yes | None |
| `src/app/api/orders/[[...path]]/route.ts` | `GET qr-tables`, `POST :id/table` | — | Existing router auth + CSRF/same-origin | — | route tests | Yes | `qr-tables` declared before `:id` (checked) |
| `src/app/api/qr/[[...path]]/route.ts` | Per-token limit moved into `placeGuestOrder` (knows table vs common) | Invalid tokens refused before counting (tested) | Per-IP guest write limit still applies at the router | — | `common-qr-routes.test.ts` | Yes | None |
| `src/app/t/[token]/layout.tsx`, guest components, `storefront.tsx` | "Sit anywhere" copy when table is null | — | — | — | `common-qr-ui.test.tsx` | Yes | None |
| `src/features/pos/components/{OpenOrdersDialog,PosScreen,QrTablesPanel}.tsx` | "QR tables" tab; assign / change; over-limit dialog (Cancel / Assign anyway) | Staff see the server's numbers before overriding | Server owns every rule | — | `common-qr-ui.test.tsx` | Yes | None |
| `src/features/backoffice/tables.tsx` | Restaurant QR card (issue / rotate / disable, SVG download) | Managers only (`outlet.manage`) | Confirm dialogs on rotate / disable | — | covered via API tests | Yes | `window.location.origin` read in render, but only after the client fetch resolves (no SSR mismatch) |
| `src/features/kitchen/{kds.ts,components/TicketCard.tsx}` | "No table yet" on common-QR tickets | — | — | — | `common-qr-ui.test.tsx`, `common-qr.test.ts` | Yes | None |
| `scripts/ops/{db-verify,pg-backup,pg-restore,pg-common}.mjs` | `--expect-migration` (must be a migration dir of this checkout); restore refuses a backup older than expected before touching the target | Lets the pre-upgrade Production backup be verified | URLs redacted in errors | Read-only verify; restore target always explicit | `expected-migration.test.ts` | Yes | None |
| `scripts/qr/audit-table-tokens.ts` | Common-QR row; exit 3 when no tables | Wrong `DATABASE_URL` cannot look clean | Never prints tokens | Tolerates P2022 on old schema | `table-qr-token.test.ts`, `common-qr.test.ts` | Yes | Summary line counts the restaurant-QR row as a "table" (cosmetic) |
| `scripts/ops/prod-readonly-audit.sql` (new) | Read-only Production audit | — | `READ ONLY` session + tx, ends in ROLLBACK; prints counts / classes only | Never writes | `prod-readonly-audit-sql.test.ts` (static) | Yes | Has never been run against Production (blocked) |
| `prisma/demo-cafe/*`, `prisma/seed-demo-cafe.ts`, `package.json` (`db:seed:demo-cafe`) | Sample café dataset in its own organization | Opt-in flag; refused in production; one transaction; idempotent; reset refuses if non-demo accounts exist | Demo password never logged; no real supplier data | Additive rows only | `tests/db/demo-cafe-seed.test.ts` (13) | Yes (demo) | None |
| `package-lock.json` | `http-cache-semantics` 4.2.0 → 4.3.0 | None at runtime | Dev-only, transitive | — | — | Kept (see below) | — |
| `e2e/growth.spec.ts` | Locator ambiguity ("Thank you!" also in the payment banner) | Test-only | — | — | e2e | Yes | Assertion not weakened (more specific role locator) |
| `e2e/common-qr.spec.ts` (new) | Browser flow for the common QR | — | — | — | — | Yes | — |
| `tests/**` (modified / new) | Coverage of the above | — | — | — | — | Yes | Modified tests only add cases or follow the table→nullable type change (reviewed: no assertion removed) |
| `docs/**` | Runbooks, readiness, demo data, common QR | — | No secrets / connection strings (searched) | — | — | Yes | — |

## Searches

- Hard-coded credentials / connection strings in the diff: none
  (`postgresql://` appears only as `postgresql://...` usage placeholders).
- Raw SQL: `lockInTx` uses a Prisma tagged template (parameterised). No
  `$queryRawUnsafe` / `$executeRawUnsafe` added.
- Client-controlled price, payment status, outlet or table: the guest order
  schema is `.strict()`; prices come from `priceGuestLines`; outlet and org come
  from the token's row (test: "a table or outlet named in the request body is
  refused").
- Cross-outlet: `setOrderTable` checks org, `assertOutletAccess`, permission,
  and that the target table is in the order's outlet (tested).
- Unsafe redirects: none added.
- Test-only behaviour in production code: `issueTableQrToken(source)` is
  replaceable only for tests (pre-existing pattern, not reachable from routes).
- Tokens in logs / audit: audit rows record `commonQrIssued/Rotated/Revoked`
  booleans and the table code, never a token.

## Findings

| # | Severity | Finding | Action |
| --- | --- | --- | --- |
| R1 | Info | The two open decisions of the previous checklist (customer row before the tx; staff assignment ignoring guest limits) are both implemented in this tree with tests. Re-reviewed: the replay hash stays stable because the guest phone is normalised before both the lookup and the insert. | None |
| R2 | Low (usability) | "Change table" on an **unpaid** order already at a table goes through `transferOrderTable`, which refuses any target table that already has a running order ("merge the orders instead"). So a mis-seated common-QR order cannot be moved onto a table where its group already has another order; staff must cancel / re-place or merge. Not a limit bypass: a transfer target always has no running order, and the caps are ≥ 1. | Documented; not changed (changing transfer semantics affects reservations moving with the order). |
| R3 | Info | `audit-table-tokens` summary says "N tables" including the restaurant-QR rows. | Cosmetic; left. |
| R5 | **Medium — FIXED** | Lost update in staff table assignment. `setOrderTable` decided "assign" vs "move" from the order's state at request time. When two staff both saw a common-QR order with no table, and the second request arrived after the first had committed, it became a *transfer*: the order a colleague had just seated was silently moved (both requests "succeeded"). The existing test was named "exactly one wins" but asserted `>= 1`, so it hid this. **Reproduced** with a new test (second, stale assignment resolved instead of rejecting). **Fix:** optional `fromTableId` (the table the caller saw; `null` = none) on `POST /api/orders/:id/table`: checked before choosing the path, inside the assign transaction, and inside the transfer transaction; mismatch → 409 Conflict "reload it". The POS "QR tables" panel always sends it; callers that omit it behave as before. Tests: concurrent pair asserts exactly one winner + a ConflictError (10/10 repeated runs), stale-view sequential case, and the missing REFUNDED refusal. | `orderOps.ts`, `QrTablesPanel.tsx`, `common-qr.test.ts`, `common-qr-ui.test.tsx` |
| R4 | Info | Demo dataset had 14 dish recipes; the brief asks for 20–30 and for café staples. | Extended to 25 dish recipes + sambar (see `docs/demo-menu-and-recipe-guide.md`). |

No security defect was found in the diff.

## Lockfile decision (`http-cache-semantics` 4.2.0 → 4.3.0)

- Path: `electron-builder@26.15.3 → app-builder-lib → @electron/get@3.1.0 →
  got@11.8.6 → cacheable-request@7.0.4 → http-cache-semantics@4.3.0`
  (`npm ls`). Transitive, `"dev": true`, used only by the desktop packager.
- `cacheable-request` asks for `^4.0.0`; 4.3.0 satisfies it; no `engines`
  field; Node v24.20.0 here.
- Origin: `npm install` on 2026-10-21 11:09 IST (lockfile and
  `node_modules/http-cache-semantics` share that timestamp). The known
  advisory for this package (ReDoS) was fixed in 4.1.1, so 4.2.0 was already
  patched; 4.3.0 is a routine minor update, not a security fix.
- `npm ls` reports a consistent tree (no invalid / extraneous entries).
- **Decision: keep.** It matches the installed tree; reverting would make the
  lockfile disagree with `node_modules` and needs a reinstall for no benefit.
  Commit it separately from the feature work if a clean history matters.

## Second, independent pass (2026-10-22, later session)

Started from the same tree (HEAD `a26b788`, ahead 2; 50 modified + 23
untracked; no file changed after 16:14 IST). A fresh backup was made outside the
repository (tracked patch + byte-exact tar of the modified files + untracked tar
+ SHA-256 list) and restored into a throw-away clone: 74 / 74 hashes matched
(the patch alone differs only in CRLF line endings on four files, hence the
extra tar).

Re-read in full: `guestOrdering.ts`, `orderOps.ts` (`setOrderTable`,
`transferOrderTable`, `listQrOrdersForTables`), `orders.ts` (`placeOrder`
customer path), `_workflow.ts` (`lockInTx`), `masterData.ts` (common-QR admin),
`tableToken.ts`, `scan.ts`, the three API routes, the schema change and both
migrations (identical SQL apart from whitespace).

| # | Severity | Finding | Action |
| --- | --- | --- | --- |
| R6 | **Low — FIXED** | The demo seed's opt-in (`--confirm-demo-database`, plus `DEMO_DATABASE_CONFIRMED=true` on PostgreSQL) was generic: it did not name the database, so with a Production `DATABASE_URL` in the shell (and `NODE_ENV` unset) it would have added the demo organization and four sign-in accounts to Production. | The confirmation now names the target: `--confirm-demo-database=<sqlite file name / PG database name>`; a bare flag or another name is refused, and the refusal shows only the database name (never URL, user, host, password); `dev.db` is always refused. `prisma/demo-cafe/target.ts`, `tests/ops/demo-seed-target.test.ts` (7, written first and seen failing). CLI re-checked on a fresh disposable file (refusals exit 1; seed three times → every table's row count and the menu / ledger content hashes identical). |
| R7 | Info (owner decision) | Restaurant-QR order limit is per (code, client IP): café Wi-Fi guests share 20 / 10 min. Every attempt counts, including a client retry after an unanswered request. With no trusted proxy in front (bare `next start` on a network) the IP comes from a client-written header, so per-IP limits are bypassable there; the database-counted outlet cap (30 unpaid / 15 min) and table caps still hold. Desktop binds 127.0.0.1 (not affected). | `docs/cafe-wifi-rate-limit-decision.md`. No code change. |
| R8 | Info | Food-cost % is computed from the per-portion cost already rounded to paise (Idli Sambar: ₹17.395 → ₹17.40 → 24.86 %, unrounded 24.85 %). Hand calculations of three dishes (incl. the sambar sub-recipe and whole-piece bread) and ×2 / ×10 scaling otherwise match exactly. | Documented; ≤ 0.01 point. |
| R9 | Info | `setOrderTable` paths re-checked: CLOSED = PAID / CANCELLED / REFUNDED; the no-table path refuses CANCELLED / REFUNDED and finished PAID orders; compare-and-set on `tableId`; permission and outlet checks on every path (transfer path via `loadRunning`). | No defect. |

No new security defect was found in the application diff.
