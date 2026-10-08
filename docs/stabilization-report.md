# RESTORA stabilization / verification report (2026-10-08)

Scope: Groups 1-5 as they stand at `main` = `d922cda`, plus the fixes made in this pass.
No Group 6 work. Evidence only: every number below was produced by a command run in
this pass or read from the GitHub Actions run for `d922cda`; nothing is carried over from
older reports. Where something could not be run, it says so.

Environment of the local runs: Linux, Node 22.22, Prisma 6.19.3, Next 15.5.27, React 19.0.8,
PostgreSQL 16.15 (throwaway cluster, server time zone Asia/Kolkata like CI), Chromium 1194
(pre-installed). No real database, `.env` or secret was touched.

## 1. CI on `d922cda` (GitHub Actions run 37828263103) was red on all five jobs

| Job | Result | Cause |
|---|---|---|
| SQLite (typecheck, lint, tests, migrations) | failed at "Tests": 1 failed, 1172 passed, 6 skipped | `tests/desktop/shell-policy.test.ts` asserted a Windows path on Linux |
| PostgreSQL 16 | failed at "full suite": 1 failed, 1150 passed, 28 skipped; the 216-test security / concurrency subset passed; migrate deploy, status and both drift checks passed | the same single test |
| Desktop (Windows) | desktop E2E 8 passed, 1 failed; packaging and `desktop:verify` skipped | `STARTER-002` could not launch Playwright's Chromium (not installed on the runner) |
| Desktop (macOS arm64 / x64) | the same: 8 passed, 1 failed; packaging, `desktop:verify`, DMG skipped | the same |

So the two Linux jobs failed for exactly one reason that is not a product defect, and the desktop
jobs failed for a missing workflow step. In CI, the desktop E2E on Windows and macOS **did run**
(8/9 each) and the desktop payload build and secret scan **did pass** on all three. The
packaged-app verification (fuses, upgrade from the previous release, launch attacks, asar integrity),
the DMG and code signing have **never run on this commit**.

## 2. Verification results (local, after the fixes)

| Check | Result |
|---|---|
| `prisma validate` / `generate` (SQLite and PostgreSQL clients) | pass |
| `tsc --noEmit` against the SQLite client and against the PostgreSQL client | pass, pass |
| `next lint` | no warnings or errors |
| `next build` | pass (also with the PostgreSQL client) |
| SQLite migrations: `migrate deploy` on a fresh file, `migrate diff` | applied, no difference |
| PostgreSQL: `db:pg:deploy` on a fresh database, `migrate status`, drift (migrations vs schema, database vs schema) | applied, up to date, no difference |
| Vitest on SQLite (full) | **110 files, 1176 passed, 7 skipped, 0 failed** (153 s) |
| Vitest on PostgreSQL 16 (full, fresh migrated database) | **110 files, 1154 passed, 29 skipped, 0 failed** (156 s). The skips are mostly tests that run on the other engine only |
| Vitest PostgreSQL security / tenant / payment / idempotency / concurrency / Decimal subset (CI's own list) | 21 files, 216 passed, 9 skipped, 0 failed |
| Browser E2E on SQLite (production build, Chromium, 1 worker) | **90/90 passed** |
| Investor flow `npm run e2e:investor` (Razorpay emulator: pay online, decline, cash) | **3/3 passed** |
| Browser E2E on PostgreSQL (fresh database) | 89/90: one failure, the intermittent navigation defect in section 4 (the same test passes on re-runs) |
| Desktop payload build and secret scan on Linux | pass (migrations in the payload equal the repo's 22 SQLite migrations; no `.env` or `.db` in the payload) |
| Desktop E2E, packaging, `desktop:verify` | **not run**: no Windows or macOS here, and the Electron binary cannot be downloaded in this sandbox |

Notes on the harness: Playwright 1.63 expects Chromium build 1243 but this image ships 1194, so the
runs used a throwaway wrapper config outside the repository (same suite, same web server, only
`launchOptions.executablePath`); no repository config changed for it. The web browser E2E suite is not
part of `.github/workflows/ci.yml` (it is a manual release gate in `docs/release-checklist.md`).

## 3. Defects found and what was done

| # | Defect | Evidence | Action |
|---|---|---|---|
| 1 | `shell-policy` test used a Windows path on every OS (`sqliteUrl` resolves with the host's path rules, which is right for a desktop app that only sees native paths) | CI and local: `file:/home/runner/work/restora/restora/C:/Users/...` | **Fixed (test only)**: the Windows assertion runs on Windows, an equivalent POSIX assertion (spaces, `?`, `#`) runs elsewhere. Implementation unchanged. Windows CI will execute the Windows branch |
| 2 | The aggregator provider factory returned the mock in production. Payment, POS, notification, Sheets and messaging all refuse mocks there; aggregators did not, so a status push was recorded SENT with no platform contacted, connection tests answered "healthy", and settlement reconciliation ran against an empty feed | `getAggregatorProvider` had no `assertMockAllowed`; callers `pushAggregatorStatus`, `testConnection`, `runAggregatorReconciliation` | **Fixed**: the factory now calls `assertMockAllowed("aggregator")`. `pushAggregatorStatus` catches the refusal, counts and logs it and returns without a delivery row, so the kitchen "order ready" flow is not broken. New `tests/integrations/production-providers.test.ts` covers all three factories |
| 3 | The demo seed built the completed PAYMENTS reconciliation's date from the host calendar day (`new Date().toDateString()`), the app uses the outlet's business day (Asia/Kolkata). Between 18:30 and 24:00 UTC the seed locked what the app calls yesterday and `e2e/money-desk.spec.ts` G3-MD-001 failed every time | reproduced with seed data only; seed rows dated `2026-10-08` while the app's day was `2026-10-09` | **Fixed**: `businessDateKey(new Date(), outlet.timezone)`. The spec is unchanged and passes (7/7 and in the full run) |
| 4 | Desktop CI jobs never install Playwright's Chromium, which `desktop/e2e/starter.spec.ts` launches directly | Windows and macOS logs: "Executable doesn't exist" | **Fixed in the workflow** (an `npx playwright install chromium` step before `desktop:e2e` in the Windows and both macOS jobs). Not yet proven: it needs a CI run |
| 5 | After a create dialog saves, the navigation to the new document sometimes never commits | section 4 | **Fixed** (route-level `loading.tsx` removed; guard test + 60-round regression spec) |

## 4. Post-save navigation stall: root cause found and fixed (follow-up pass)

`FormDialog` calls `onClose()` then `onDone()`, which does `router.push('/inventory/wastage/<id>')` (and the equivalent for purchase
orders, recipes and other documents). Sometimes the URL never changed and the user stayed on the list. First seen as `RECIPE-001` in
Phase 14; reproduced here on SQLite and PostgreSQL (about 1 in 10 on a cold server).

How it was isolated (each step measured over 50-125 repeated runs from a fresh page load):
- The create `POST` returned 200 in about 25 ms and the router fetched the new page's RSC payload and chunk, but the page never mounted. After a stall the React root had two suspended transition lanes, nothing scheduled and nothing pinged, and the router hook held a transition update whose promise was already *fulfilled* with the new URL: the router's work was done, React never rendered it.
- Not the database, not the order of `onClose` / `onDone`, not `flushSync` around the close, not the sidebar prefetch (`prefetch={false}` on every shell link changed nothing; experiments that blocked prefetch requests only looked like fixes because route interception adds latency to every request and hides a timing race).
- A bare `window.next.router.push(...)` with no dialog and no application code stalled 11 times in 105: it is the framework, not the form.
- Removing `src/app/(app)/loading.tsx` (the Suspense boundary Next wraps around every back-office page) gave **0 stalls in 105** for the bare push and **0 in 105** for the real create dialog. Next 15.5.27 is the newest 15.5 release; the next line is the Next 16 major.

Fix: `src/app/(app)/loading.tsx` is deleted. Back-office screens show their own loading states, so only the instant skeleton between a click and the server's first byte is gone. Guards:
`tests/ui/no-loading-boundary.test.ts` fails if a `loading.tsx` / `loading.js` reappears under `src/app/(app)`, and `e2e/nav-after-save.spec.ts`
(30 rounds of the create dialog and 30 rounds of a bare `router.push`, each from a fresh page load) fails within 5 rounds on the old build and passes on the fixed one.
The sign-in redirect (`router.replace('/dashboard')`) uses the same router path and is expected to benefit; the desktop jobs in CI will show it.

## 5. Production-safety audit (read from code, with tests)

- Mock providers: payment, POS, notification, Sheets and messaging refuse mocks when `NODE_ENV=production` unless `ALLOW_MOCK_PROVIDERS=true`; the webhook entry point (`resolveProvider`) refuses them too; unknown provider names fail instead of falling back to a mock. Aggregators were the gap (defect 2, now closed).
- `validateProductionEnv` (server start): refuses `*_PROVIDER=mock`, development placeholder webhook secrets, an incomplete Razorpay configuration (`RAZORPAY_KEY_ID` pattern, key secret, webhook secret), `RAZORPAY_API_BASE` (the test emulator), `ALLOW_DEMO_SEED`, a short or placeholder `AUTH_SECRET`, `RATE_LIMIT_DISABLED`. `tests/config/env-validation.test.ts` covers it.
- Webhooks: `hmacMatches` returns false for a missing secret or signature; per-tenant secrets are encrypted at rest and an unreadable one never falls back to a shared secret; the mock providers' `dev-webhook-secret` default is reachable only where mocks are allowed.
- Secrets: nothing secret is in `NEXT_PUBLIC_*`; a tracked-file scan found no live keys, only `.env.example`, `rzp_test_` fixtures in tests and the investor config, and the desktop build's own secret scan passed. `.env` and `*.db` are not tracked.
- Still true: `ALLOW_MOCK_PROVIDERS=true` is an explicit opt-in that logs a warning at every boot; the E2E configs set it, a public deployment must not.

## 6. Group 1-5 final gate

Legend: Impl = implemented as the audit describes; Tests = automated tests pass on SQLite at this commit;
PG = pass in the full PostgreSQL run; E2E = browser coverage; External = needs something outside the repository.

| Group | Implementation | Tests | PostgreSQL | E2E | External | Status |
|---|---|---|---|---|---|---|
| 1 Integrity: vendor approval gate, issue-to-department stock moves, idempotency / locking | yes | `core-gaps`, `master-data`, `inventory-procurement`, `workflows`, `stock-post-concurrency` pass | pass (incl. `tests/db` concurrency) | `inventory-procurement`, `backoffice-ops` specs (one flaky navigation, section 4) | none | IMPLEMENTED + VERIFIED |
| 2 Reorder engine, POs and indents from it | yes | `reorder`, `reorder-routes`, `reorder-concurrency`, `procurement-reorder` UI | pass | none (jsdom UI test only) | none | IMPLEMENTED + VERIFIED (no browser spec) |
| 3 Kitchen production, wastage, worksheet, manual sales, variance, money desk, day lock | yes | `kitchen-production`, `money-desk`, `group3-routes`, `group3-screens`, `day-close-concurrency` pass | pass | `money-desk.spec` 7/7 (after defect 3 fix) | none | IMPLEMENTED + VERIFIED |
| 4 Menu engineering, department P&L / daily costing, stock matrix, supplier prices, QR labels, overhead % | yes | `costing-engineering`, `advanced-inventory`, `group4-routes`, `costing-screens` pass | pass | `costing.spec` 5/5 (matrix, kitchen matrix, supplier prices, menu engineering, labels); department P&L has no browser spec | none | IMPLEMENTED + VERIFIED |
| 5 Accounting sync (Tally, Zoho), Sheets sync, aggregator finance, nightly POS re-pull, integrations control room | yes | `accounting-sync`, `sheets-sync`, `aggregator-finance`, `scheduled-jobs`, `group5-adapters`, `integrations-routes` pass | pass | none for the Aggregators, accounting and Sheets screens | real Tally / Zoho / Google Sheets / platform statements / Petpooja never exercised | IMPLEMENTED + NOT EXTERNALLY VERIFIED |

## 7. What remains

1. **Confirmed defects**: none open; defects 1-5 fixed (4 and the sign-in redirect proven only by the next CI run).
2. **Verification gaps**: a green CI run on the new commit (the two desktop fixes are untested); desktop E2E packaging / `desktop:verify` / DMG on real Windows and macOS runners; the web browser suite is not in CI; no browser test for the Aggregators, accounting-sync and Sheets screens or department P&L; no investor flow on PostgreSQL.
3. **Documentation gaps**: closed by this pass (audit, status, README, final report, testing guide); `docs/postgres.md` and the phase reports are historical records and keep their original numbers.
4. **Genuine missing product features** (not built, per the audit): material brand, generic CSV / Excel import, a variance-trend chart, FSSAI lots and expiry alerts, a combined PO / indent queue, line-level PO approval and thresholds, aggregator item on/off, captain split / merge / transfer, KDS prep-time measurement, universal search, offline captain, plus everything in Groups 6-9.
5. **External production blockers**: hosting in Mumbai with HTTPS, scheduled backups and point-in-time recovery on real infrastructure; Razorpay test-mode run, then live keys; live Petpooja, Zomato and Swiggy access; WhatsApp credentials and approved templates; a real Tally / Zoho / Google Sheets run; Windows code-signing certificate and a green macOS CI run.
