# Final engineering completion report — 2026-10-22

Scope: the local engineering work of the "final completion mission" on branch
`release/coders-cafe-2026-10-13` (HEAD `a26b788`, 2 local commits ahead of
origin). Everything here is **uncommitted** in the working tree. Nothing was
staged, committed, pushed or deployed; no Production or Preview database was
contacted; no payment was initiated.

## Executive summary

**Local engineering: complete, with one engineering item still open (React
#418, intermittent, not reproduced).** Release is **blocked on external
evidence and approvals**: Production/Preview database isolation, a real
Production backup + restore, a read-only Production audit and migration
approval, SBI UPI (spec, UAT, certification), physical café testing, recipe /
price sign-off, a staging load test, and review + commit + CI of this tree
(`docs/final-release-blockers.md`).

This pass:

- reviewed the whole existing diff (`docs/diff-review-2026-10-22.md`);
- **found and fixed one real defect**: a lost update in staff table
  assignment (R5 below);
- confirmed the two order-handling decisions are implemented and tested
  (customer record inside the order transaction; explicit, audited staff
  override of table guest limits);
- extended the Demo Café sample dataset to a café menu with 40 items and 26
  recipes, with consistency tests;
- ran typecheck, lint, build, the full SQLite suite, the full PostgreSQL suite
  (+ CI's PostgreSQL migration / drift steps), repeated concurrency runs, and
  the full browser suite;
- investigated React #418 with a non-minified dev build;
- wrote the release documents listed at the end.

## What was fixed

### R5 — staff table assignment could silently move a colleague's order (Medium, FIXED)

- **Symptom.** Two staff both saw a common-QR order with no table. If the
  second "Assign" arrived after the first had committed, `setOrderTable` saw a
  running order at a table and performed a *transfer*: the order the first
  person had just seated was moved, and both requests reported success. The
  test named "exactly one wins" asserted `>= 1` winner, which hid it.
- **Reproduced:** new test "a second assigner working from a stale view …" →
  `promise resolved … instead of rejecting` before the fix.
- **Root cause:** the assign-vs-move decision used the order's state at
  request time, not what the caller saw.
- **Fix (smallest):** optional `fromTableId` (`null` = no table) on
  `POST /api/orders/:id/table`, checked before choosing the path, inside the
  assignment transaction and inside the transfer transaction; mismatch → 409
  "reload it". The POS "QR tables" panel always sends it; callers omitting it
  behave as before. Files: `src/server/services/orderOps.ts`,
  `src/features/pos/components/QrTablesPanel.tsx`.
- **Tests:** concurrent pair now asserts exactly one winner + a
  `ConflictError` (10/10 repeats on SQLite, 3/3 file runs on PostgreSQL);
  stale-view sequential case; REFUNDED refusal (was untested); UI request
  bodies include `fromTableId`.

## The two order-handling decisions (verified, already implemented in this tree)

| Decision | Implementation | Evidence |
| --- | --- | --- |
| No orphaned customer records | `placeOrder(opts.customer)` finds / creates the CRM customer inside the order's transaction under a per-phone lock (`customer-phone:<org>:<phone>`); request hash recomputed with the real id; replay path re-reads the winner's customer. Phone is normalised before both lookup and insert (checked), so the replay hash is stable | `tests/db/guest-checkout-concurrency.test.ts`: refused-at-limit submissions leave no customer; one phone from five tables at once → one customer; replay / conflicting phone cases. Previous session's pre-fix run: 4 customers for 1 placed order |
| Staff over-limit assignment | First attempt over 3 waiting / 6 unsettled → `409 TableGuestLimit` with the numbers; POS dialog shows them; **Cancel** sends nothing; **Assign anyway** sends `overrideGuestLimits: true`; audit row records `guestLimitOverride` and the acting user; limit counted under the table's advisory lock in the same lock order as guest orders; `order.modify` + outlet checks; the table's own QR keeps refusing guests | `tests/domain/common-qr.test.ts`, `tests/api/common-qr-routes.test.ts`, `tests/ui/common-qr-ui.test.tsx` |

## Demo menu and recipes

`prisma/demo-cafe/data.ts` (sample data) — own organization "RESTORA Demo
Café — sample data", built through RESTORA's services in one transaction.

| | Before this pass | Now |
| --- | --- | --- |
| Categories | 9 | 10 (+ Burgers & Wraps) |
| Menu items | 33 | 40 (+ Espresso, Americano, Café Latte, Lemon Iced Tea, Veg Burger, Paneer Wrap, French Fries) |
| Ingredients | 35 | 40 (+ burger bun, wheat wrap, lemon, frozen fries, ketchup) |
| Recipes | 14 dishes + sambar | 25 dishes + sambar (new: the 7 items above + Fresh Lime Soda, Masala Chaas, Curd Rice, Garlic Naan) |

- Idempotency: tested (seed twice → no change in counts, audit rows, ledger,
  users) and the CLI was run twice on a fresh database: 10 / 40 / 26 both
  times, second run "nothing changed"; refused without
  `--confirm-demo-database`.
- Costing: RESTORA's `menuItemCostAndMargin` equals the hand calculation for 8
  dishes incl. the sub-recipe; a sale deducts exactly the recipes, only after
  payment, never negative.
- New invariants: units (kg / L per serving < 1, pieces whole), food cost 2–45
  % of price, every category used, unique SKUs / POS codes.
- Guide: `docs/demo-menu-and-recipe-guide.md`; contents and review list:
  `docs/demo-cafe-data.md`.

## Test results (this session, after the last source edit unless noted)

| Command / suite | Result | Passed | Failed | Skipped | Exit |
| --- | --- | --- | --- | --- | --- |
| `npx tsc --noEmit` (SQLite client) | PASS | — | 0 | — | 0 |
| `npx tsc --noEmit` (PostgreSQL client, isolated copy) | PASS | — | 0 | — | 0 |
| `npm run lint` | PASS | — | 0 | — | 0 |
| `git diff --check` | PASS | — | — | — | 0 |
| `npm run build` | PASS | — | — | — | 0 |
| Full SQLite `vitest run --shard=1..4/4` (205 files) | PASS | 2439 | 0 | 11 | 0 ×4 |
| Full PostgreSQL 16 `vitest run --shard=1..4/4` (fresh DBs) | PASS | 2383 | 0 | 67 | 0 ×4 |
| PostgreSQL CI security subset (CI's file list) | PASS | 627 | 0 | 11 | 0 |
| PostgreSQL `db:pg:deploy` on a fresh DB, `migrate status` | PASS | 22 migrations | — | — | 0 |
| PostgreSQL drift: migrations vs schema (shadow DB) / deployed DB vs schema | PASS (no difference) | — | — | — | 0 / 0 |
| PostgreSQL `common-qr` + `guest-checkout-concurrency`, ×3 | PASS | 46 each | 0 | 0 | 0 ×3 |
| SQLite common-QR assignment tests ×10 (concurrent / stale / refunded) | PASS | 4 each | 0 | — | — |
| Demo seed test (SQLite) | PASS | 13 | 0 | 0 | 0 |
| Focused QR / payment / ops set (13 files, SQLite, before R5) | PASS | 186 | 0 | 3 | 0 |
| Full Playwright E2E `npx playwright test` (production build, SQLite `prisma/e2e.db`, 1 worker, retries 0) | PASS (28.1 min; QUALITY-001 all viewports passed, no #418 in this run) | 135 | 0 | 0 | 0 |
| #418 dev-build diagnostic (72 page loads) | not reproduced | — | — | — | — |
| Desktop build / package | NOT RUN (conditional) | | | | |
| Remote CI | NOT RUN (needs a push) | | | | |

Skipped tests: SQLite skips are PostgreSQL-only cases (locks, barriers); the
PostgreSQL skips are the desktop / SQLite-only suites (engine-gated).

## React #418 (intermittent, staff screens) — OPEN

- History: seen in QUALITY-001 on random staff pages (vendor detail; inventory
  issues / GRNs / customers at 320 px), always "HTML" (element) mismatch,
  ~0.5 s after navigation, DOM recovered to correct content; correlated with
  slow HTML responses; also on the pure remote branch (pre-existing since
  10-14); not on guest routes.
- This pass, static review: the shared list path (`DocumentList`, `DataTable`,
  `usePaged` / `useQuery`) fetches only in `useEffect` and has no module
  cache, so server and client both render the loading state; render-time
  `window` reads exist only inside dialogs / error states. No render-time
  date / random / media-query value found in the shell.
- This pass, dynamic: `next dev` (non-minified React, prints hydration diffs)
  on a disposable copy of the diag DB; 6 staff pages × 3 viewports
  (390×844, 320×568, 1440×900) × 2 rounds × HTML delayed 0 ms and 1500 ms =
  72 loads → **0 hydration errors** (only the dev HMR WebSocket being blocked
  under request interception).
- Conclusion: not reproduced in development, root cause unknown. The test
  assertion is kept; no warnings suppressed. Next step when memory allows: run
  the production build with React's profiling / development `react-dom`
  aliased in, under the E2E sequence, to capture the diff.

## Security findings

No security defect in the diff (searches and matrix in
`docs/diff-review-2026-10-22.md`). Notable properties verified by tests:
outlet / org always from the QR token's row; strict guest body (no outlet /
table / price accepted); tokens never in audit rows or reports; common-QR
rate limit per device with trusted-proxy IP; caps re-counted in-transaction
under advisory locks (PostgreSQL) / write queue (SQLite); SBI UPI fail-closed
(no online payment offered; even correctly signed callbacks refused, payment
stays PENDING); staff override requires `order.modify` and is audited with the
user.

## Known risks

- Common-QR per-IP order limit vs café Wi-Fi NAT (owner decision; blockers #9).
- A mis-seated unpaid order can be moved only to a table with no running order
  (normal move rule; review R2).
- React #418 above.
- In-process rate-limit store must not be used with several instances
  (`RATE_LIMIT_STORE=database` on staging / Production).

## External blockers

See `docs/final-release-blockers.md` (12 items with owners and the exact
evidence each needs) and `docs/release-acceptance-checklist.md`.

## Production / Preview isolation (Phase 8)

Not re-verified. Reading the hosting project's environment-variable metadata
through the locally stored CLI login was refused by this session's permission
policy (treated as credential access), and was not worked around. Last
recorded evidence: 2026-10-14 one `DATABASE_URL` record targeted
Production + Preview; 2026-10-19 the only `DATABASE_URL` record was
preview-only. **BLOCKED** — manual check in `docs/release-acceptance-checklist.md` A1.

## Files changed in this pass

Modified (already modified before this pass): `prisma/demo-cafe/data.ts`,
`tests/db/demo-cafe-seed.test.ts`, `src/server/services/orderOps.ts`,
`src/features/pos/components/QrTablesPanel.tsx`,
`tests/domain/common-qr.test.ts`, `tests/ui/common-qr-ui.test.tsx`,
`docs/demo-cafe-data.md`, `docs/common-qr-ordering.md`.

Added: `docs/diff-review-2026-10-22.md`,
`docs/final-engineering-completion-report.md`,
`docs/demo-menu-and-recipe-guide.md`, `docs/release-acceptance-checklist.md`,
`docs/final-release-blockers.md`, `docs/recipe-ingredient-signoff.md`.

Generated: none in the repository (`.next` rebuilt by `npm run build`; E2E
writes `prisma/e2e.db` and `e2e/.report`, `e2e/.results`, all gitignored).
Disposable databases and logs are outside the repository.

## Final repository state

Checked after the E2E run (2026-10-22 ~16:15 IST):

- HEAD `a26b788`, branch ahead of origin by 2 (unchanged); no new commit; 0
  staged files; no stash; nothing pushed; no deployment.
- `git status --short` vs the start-of-session snapshot: identical except the
  six new `docs/` files above (the eight edited files were already modified).
- `git diff --check`: clean. No database, `.env`, log or report file is
  untracked-and-unignored; secret pattern scan of the changed files: none.
- Backup of the starting tree (tracked patch + untracked tar) is outside the
  repository and reverse-applies.
- Disposable resources used: `scratchpad/h418/diag.db`, `scratchpad/demo-cli.db`,
  a disposable PostgreSQL 16 cluster on 127.0.0.1:55470 (stopped), the
  isolated copy `pgcopy`, `prisma/e2e.db` (rebuilt by the E2E harness). The
  user's `dev.db` and any Production / Preview database were not touched.

---

# Addendum — release-preparation pass (2026-10-22, evening)

Everything above is the earlier pass's record (historical evidence for this
addendum). This section records only what was re-checked or changed afterwards.
Still **uncommitted, unstaged, unpushed**; no deployment, no Production /
Preview access, no payment, no QR rotation.

## Status

**Local release candidate: ready for human review, NOT ready for release.**
One defect was fixed (R6), React #418 is now reproducible locally but still
unexplained, and every external gate in `docs/final-release-blockers.md` is
still open (none can be closed from this machine).

## Changes in this pass

| Change | Files | Evidence |
| --- | --- | --- |
| **R6 FIXED** — demo seed confirmation must name the target database (`--confirm-demo-database=<name>`); bare flag / other name refused; `dev.db` always refused; refusal never shows URL, user, host or password | `prisma/demo-cafe/target.ts` (new), `prisma/seed-demo-cafe.ts`, `tests/ops/demo-seed-target.test.ts` (new, 7 — written first, failed, then passed) | CLI on a fresh disposable SQLite file: bare flag exit 1, wrong name exit 1, three confirmed runs → 10 categories / 40 items / 26 recipes / 41 materials (40 + sambar) / 142 recipe lines; every table's row count, audit log included, and the menu / ledger content hashes identical after the 3rd run. With no `DATABASE_URL` in the shell, `.env` (→ `dev.db`) is refused |
| Café Wi-Fi limit analysis (no code change) | `docs/cafe-wifi-rate-limit-decision.md` (new) | Read from code; owner decision |
| #418 investigation: first local reproduction | `docs/hydration-418-investigation.md` (new) | See below |
| Operator forms for isolation and backup / restore | `docs/production-isolation-and-backup-evidence.md` (new) | Script flags checked against the scripts |
| SBI acceptance: callback freshness row + UAT scenario 16 | `docs/sbi-upi-integration.md` | — |
| Acceptance checklist: evidence kinds; 10 café scenarios (concurrent staff, stale screen, cleaning, refunds, timeout retry, reprint / paper width, Wi-Fi rush, forged header, permissions, old phones) | `docs/release-acceptance-checklist.md` | — |
| Docs follow the new flag; second review pass; blockers #0, #9, #11; Git / CI handoff | `docs/demo-cafe-data.md`, `docs/demo-menu-and-recipe-guide.md`, `docs/diff-review-2026-10-22.md`, `docs/final-release-blockers.md`, `docs/git-ci-handoff-2026-10-22.md` (new) | — |

## Costing re-checked by hand (demo database, RESTORA's own costing)

| Dish | Hand | RESTORA | ×2 / ×10 |
| --- | --- | --- | --- |
| Cappuccino (₹120) | 0.018 × 1200 + 0.15 × 58 + 0.008 × 45 = ₹30.66 → 25.55 % | ₹30.66, 25.55 % | 61.32 / 306.60 |
| Veg Sandwich (₹90) | 2 × 3 + 5.20 + 1.50 + 1.20 + 1.20 + 0.70 + 0.022 = ₹15.822 → 17.58 % | ₹15.82, 17.58 % | 31.64 / 158.22 |
| Idli Sambar (₹70) | sambar batch ₹77.73 / 2 kg = ₹38.865 per kg; 9.60 + 0.022 + 0.2 × 38.865 = ₹17.395 | ₹17.40, 24.86 % | 34.79 / 173.95 |

Food-cost % uses the paise-rounded portion cost (24.86 % vs 24.85 % unrounded,
review R8). Missing prices: Coders' Cafe's 54 ingredients still have **no**
price (re-counted from `prisma/coders-cafe/recipes.ts`: 61 draft recipes, 429
lines, 54 ingredients, 3 combos without a draft); nothing was invented.

## React #418

Reproduced for the first time: production build, CPU throttled 4×, with other
pages loading in parallel ("busy server"): 9 / 40, 6 / 40, 6 / 30 (desktop),
5 / 40 loads in four runs. 0 / 120 with slow client or slow HTML alone, 0 / 30
without CPU throttling, 0 / 40 in `next dev`. The server HTML of failing loads
is byte-identical to clean loads, so the server is not rendering different
content (no cross-request leak); the divergence is client-side and
timing-dependent. **Root cause unknown; not fixed**; next steps in
`docs/hydration-418-investigation.md`.

## Tests run in this pass (all after the last code change: `prisma/demo-cafe/target.ts`, `prisma/seed-demo-cafe.ts`)

| Command | Backend / target | Exit | Passed | Failed | Skipped |
| --- | --- | --- | --- | --- | --- |
| `git diff --check` (start) | — | 0 | — | — | — |
| `npx vitest run tests/ops/demo-seed-target.test.ts` **before** `target.ts` existed | — | 1 (module missing — expected red) | 0 | 1 file | — |
| `npx vitest run tests/ops/demo-seed-target.test.ts tests/db/demo-cafe-seed.test.ts` | per-run SQLite test DB | 0 | 20 | 0 | 0 |
| `npm run db:seed:demo-cafe -- …` (bare flag / wrong name / 3 confirmed runs) | fresh disposable SQLite file in the session scratchpad | 1 / 1 / 0, 0, 0 | — | — | — |
| `npm run typecheck` | SQLite client | 0 | — | 0 | — |
| `npm run lint` | — | 0 | — | 0 | — |
| `npm run build` (twice: before the #418 runs, and again after `next dev` replaced `.next`) | — | 0 / 0 | — | — | — |
| `npx vitest run --shard=1..4/4` (full suite, 206 files) | per-run SQLite test DBs | 0 ×4 | 2446 | 0 | 11 |
| Targeted PostgreSQL set: common-qr, guest-checkout-concurrency, common-qr-routes, qr-transaction, table-qr, table-qr-token, sbi-upi-fail-closed, demo-cafe-seed, demo-seed-target, idempotency-refunds, webhooks-reconciliation, payment-balance (12 files) | **new** disposable PostgreSQL 16.14 cluster, 127.0.0.1:55480 only, fresh database | 0 | 178 | 0 | 0 |
| `common-qr` + `guest-checkout-concurrency` ×3 | same cluster, a fresh database per run | 0 ×3 | 46 each | 0 | 0 |
| `npm run db:pg:deploy` + `prisma migrate status` | fresh PG database | 0 / 0 | 22 migrations, "up to date" | — | — |
| Drift: migrations vs schema (shadow DB) / deployed DB vs schema | fresh PG | 0 / 0 ("No difference") | — | — | — |
| `npx tsc --noEmit` with the PostgreSQL client | isolated copy | 0 | — | 0 | — |
| `npx playwright test -c playwright.investor.config.ts` | production build, `prisma/e2e-investor.db` | 0 | 4 | 0 | 0 |
| `npx playwright test -c playwright.acceptance.config.ts` | production build, acceptance fixture DB | 0 | 7 | 0 | 0 |
| `npx playwright test` common-qr, qr-transaction, payment, floor-ops, order-lifecycle, growth (+ auth setup) | production build, `prisma/e2e.db` | 0 | 28 | 0 | 0 |
| `npx playwright test` (full main suite, after all of the above) | production build, `prisma/e2e.db`, 1 worker, retries 0 | 0 | 135 | 0 | 0 (19.9 min; QUALITY-001 did not hit #418 this time) |
| #418 harness (production / dev builds, disposable DB copy) | see above | — | — | — | — |
| Full PostgreSQL suite | — | **NOT RUN in this pass** (historical 2383 / 0 / 67 after the last application change; this pass changed only the demo-seed CLI and added one test file, both run on PostgreSQL above) | | | |
| Desktop build / package / E2E | — | **NOT RUN** (conditional on the desktop decision) | | | |
| Staging load test | — | **NOT RUN** (no staging environment) | | | |
| Remote CI | — | **NOT RUN** (needs an approved push) | | | |

The ERROR lines printed by the SQLite shards are failure-path tests logging
what they simulate (gateway timeout, failing export storage, serialization
error); the suites passed.

## Repository state at the end of this pass

Checked at the end (2026-10-22 ~18:45 IST):

- Branch `release/coders-cafe-2026-10-13`, HEAD `a26b788`, ahead 2 / behind 0
  (unchanged). 0 staged, no stash, **nothing committed, pushed, tagged or
  deployed**.
- 51 modified tracked files (the 50 from the start + `docs/sbi-upi-integration.md`),
  30 untracked files (24 + `prisma/demo-cafe/target.ts`,
  `tests/ops/demo-seed-target.test.ts`, `docs/cafe-wifi-rate-limit-decision.md`,
  `docs/production-isolation-and-backup-evidence.md`,
  `docs/hydration-418-investigation.md`, `docs/git-ci-handoff-2026-10-22.md`);
  79 status entries. `git diff --check` exit 0.
- Original work intact: all files from the start-of-pass backup hash list match
  except the seven edited on purpose in this pass (`prisma/seed-demo-cafe.ts`
  and six docs).
- No tracked database, `.env` (other than `.env.example`), build output or
  credential; every untracked file is under `docs/`, `e2e/`, `prisma/`,
  `scripts/`, `src/`, `tests/`. `prisma/dev.db` last modified 2026-10-14
  (untouched).
- Backup: session scratchpad `preserve-20261022-final` (patch, byte-exact tar
  of modified files, untracked tar, hashes) — still present; older backups in
  sibling sessions untouched.
- Not touched: Production, Preview, any remote database, payment providers,
  live QR tokens, the hosting account, the Claude plugin installation.
  Disposable resources: scratchpad SQLite files, a PostgreSQL 16.14 cluster on
  127.0.0.1:55480 (stopped), the isolated copy `pgcopy`, `prisma/e2e*.db`
  (gitignored, rebuilt by the E2E harnesses); my diagnostic servers on
  3478 / 3479 were stopped.
