# RESTORA — launch-readiness report, 2026-10-21

Commit under test: `e7fedf8b72e0df73591612dc59cc9ee4c50e7666` on
`release/coders-cafe-2026-10-13` (equal to `origin`, 0 ahead / 0 behind).
Nothing in this pass was deployed, published, tagged, migrated in Production or
paid for real. The owner-side steps and their order are in
`docs/owner-go-live-checklist.md`; this file is the dated evidence snapshot.

**Status: CODE VERIFIED; OPERATIONAL READINESS INCOMPLETE.** Not ready for a
Production deployment or the pilot: online guest payment (SBI) does not exist,
Production's database is unknown and unbacked-up as far as the evidence goes,
and the Production QR tokens are the legacy derivable ones.

## 1. Automated verification on `e7fedf8`

| Suite | Where | Command / job | Result |
|---|---|---|---|
| Vitest, SQLite | local, 4 sequential shards | `npm test -- --shard=i/4` | 198 files; 2355 passed, 8 skipped, 0 failed (494 / 893+6s / 570+1s / 398+1s) |
| Vitest, SQLite | CI `SQLite` job 118868106138 | `npm test` | 198 files; 2355 passed, 8 skipped |
| Vitest, PostgreSQL 16 | CI `PostgreSQL 16` job 118868106544 | targeted + `npx vitest run` | targeted 604 passed / 11 skipped; full 2296 passed / 67 skipped (desktop-only suites are SQLite-gated) |
| Migrations + drift | CI SQLite + PostgreSQL jobs | `prisma migrate deploy`, `migrate status`, `migrate diff` | "up to date", "No difference detected" on both engines |
| Typecheck / lint | local + CI | `npm run typecheck`, `npm run lint` | 0 errors, 0 warnings |
| Web build | CI SQLite job; local inside `npm run e2e` | `npm run build` | exit 0 |
| Main browser E2E, SQLite | CI job 118868106284 | `npm run e2e` | 134 passed |
| Main browser E2E, SQLite | local | `npm run e2e` | 134 passed (25.2 min, 1 worker) |
| Investor E2E | CI job 118868106284 and local | `npm run e2e:investor` | 4 passed (both) |
| Acceptance E2E (30 steps) | CI job 118868106284 and local | `npm run e2e:acceptance` | 7 passed (both) |
| Web E2E, PostgreSQL 16 | CI job 118868106499 | `npx playwright test` on a PG build | 134 passed |
| Desktop Windows | CI job 118868106314 | `desktop:build`, `desktop:e2e`, `electron-builder --dir`, `desktop:verify` | E2E 9 passed; 23/23 packaged-app checks |
| Desktop macOS arm64 | CI job 118868106451 | same + DMG | E2E 9 passed; 24/24 checks; DMG built (unsigned, not published) |
| Desktop macOS x64 | CI job 118868106588 | same + DMG | E2E 9 passed; 24/24 checks; DMG built (unsigned, not published) |
| Desktop build | local | `npm run desktop:build` | exit 0, secret scan clean |
| PostgreSQL backup → destroy → restore drill | local disposable cluster | `scripts/ops/backup-drill.mjs` | **PASSED 10/10** (below) |

CI run: GitHub Actions run 39492234842 (`ci`, all 7 jobs success). The previous
run on `5503ab7` failed only on the stale STARTER-002 desktop spec fixed in
`e7fedf8`.

## 2. Work done in this pass

- Collected the four Vitest shard results and the in-flight main E2E run left
  by the previous session (none re-run needlessly).
- Read every CI job log of run 39492234842 for exact counts.
- **PostgreSQL restore drill on the current schema** (the last one, 2026-10-05,
  predates 14 migrations): fresh `restora_drill` via `npm run db:pg:deploy`
  (21 PG migrations), demo + Coders' Cafe seed, then the drill — 122 tables /
  2,159 rows, encrypted backup 0.37 MB, tampered / wrong-key / overwrite
  refused, source dropped, restored, every table count + md5 identical,
  invariants identical, 127 s. Recorded in
  `docs/database-recovery-and-migrations.md` §4.
- Dependency audit (`npm audit --omit=dev`), section 4.
- No application code changed: no genuine defect was found that the evidence
  supports fixing.

## 3. Confirmed facts (not carried over from old reports)

- Migrations newer than Production's last-known build `a80caa9`: **9**
  (`20261017100000_growth_crm` … `20261025100000_recipe_estimates`), from
  `git ls-tree a80caa9 prisma/migrations`. Whether Production has applied any
  of them is unknown: there is no Production `DATABASE_URL` on record.
- Draft recipes with estimated quantities in the investor demo database:
  **61** (`RecipeVersion` status `DRAFT`, `estimated = 1`), read-only query.
  Chef sheet: `docs/kitchen-recipe-data/`.
- `prisma/dev.db` (the user's own database, SHA-256 prefix `249a564f`) is at 23
  migrations ending with the orphan `20261017100000_rate_limit_buckets`, behind
  HEAD; untouched. `prisma/investor-demo-2026-10-20.db` (`6f3ad94e`) untouched.
- Payment provider guards: `mock`, `upi_emulator` and `ALLOW_MOCK_PROVIDERS`
  are refused in Production (`src/server/config/env.ts`); `sbi_upi` is a stub
  that refuses every call, so guest QR ordering is refused with "please order
  with the staff" (asserted by desktop STARTER-002 and the QR unit suites).
- No debug, seed or reset API routes exist under `src/app/api`.

## 4. Security findings (scope: dependency audit + spot checks; the full
reviews are `docs/security.md` and earlier passes)

| Finding | Severity (practical) | Status |
|---|---|---|
| `npm audit`: `deepmerge-ts` < 8 via `@prisma/config` (GHSA-ggr8-5vv4-36mx) | Low — build/CLI config loading only, no request input | Open; fix = Prisma upgrade, needs a full re-verification cycle |
| `npm audit`: `postcss` ≤ 8.5.22 via `next` (GHSA-qx2v-qp2m-jg93 and file-read advisory) | Low — compiles our own CSS at build time | Open; fix offered is Next 16 (major) |
| `npm audit`: `source-map-js` 1.0.0–1.2.1 (GHSA-68fv-2mgg-jv7q) | Low — build tooling | Open |
| Production QR tokens are legacy/derivable | High for Production | Owner-approved rotation needed (`docs/qr-token-rotation.md`) |

## 5. Outstanding work (all outside the codebase)

| # | Item | Blocks | Next action | Who |
|---|---|---|---|---|
| 1 | SBI UPI: spec, onboarding, UAT credentials, sign-off | Production guest QR, pilot | Obtain items in checklist §A; then implement `sbi_upi` against the real spec | Owner + SBI |
| 2 | Production database: identity, backup, proven restore, 9 migrations | Production deploy | Owner supplies `DATABASE_URL` source; backup + restore into a scratch DB; read-only `migrate status`; then `db:pg:deploy` (checklist §D) | Owner (+ hosting) |
| 3 | Production QR token audit + rotation + reprinted cards | Pilot | Read-only `npm run qr:audit`, then approved rotation (checklist §I) | Owner |
| 4 | Payment-recovery scheduler (`/api/cron/payments`) | Production online payments | Choose Vercel Pro cron or an external scheduler; verify 200s (checklist §B) | Owner |
| 5 | Late-payment window (10 min proposed) | Pilot | Approve / change / reject (checklist §E) | Owner |
| 6 | Physical bill printer | Pilot | Run `docs/physical-printer-test.md` on the real printer | Staff with hardware |
| 7 | Physical phones QR test | Pilot | Real phones on the café Wi-Fi / mobile data, after #1 and #3 | Owner / QA |
| 8 | 61 estimated recipes + real prices | Stock-cost accuracy (not the deploy) | Chef fills `docs/kitchen-recipe-data/` (checklist §F) | Chef |
| 9 | Release rc.2 + signing decision | Distribution | Owner decides signing; then checklist §H | Owner |
| 10 | Legacy Razorpay read-only audit | Razorpay retirement | Owner-approved read-only access (checklist §C) | Owner |
| 11 | Dependency advisories (section 4) | Nothing immediately | Schedule a Prisma / Next upgrade with full re-verification | Engineering |
| 12 | Capacity | Claims about scale | Only lab evidence exists (`docs/performance-and-load-test.md`); load-test a staging copy of the real hosting | Engineering + owner |

---

## 6. Post-verification pass (2026-10-21, later the same day)

Continues from sections 1–5 (not repeated). Base `e7fedf8`; the changes are
two local commits on top: `44ece0d` (QR tooling + tests) and the documentation /
lockfile commit that adds this section. **Not pushed** (pushing needs the
owner's approval). Nothing touched
Production, a Production database, live QR tokens, a payment provider, a
deployment or a release.

### 6.1 Changes

| Area | Change | Why (evidence) |
| --- | --- | --- |
| QR audit | `scripts/qr/audit-table-tokens.ts` also classifies the pre-2026-10-05 demo-seed token `<outlet>-<table>` as `legacy-derivable` | On a copy of `prisma/dev.db` the 26 demo-group tables held exactly that pattern and were reported only as `nonstandard` |
| QR labels | `scripts/qr/generate-table-qrs.ts` refuses `--mode production` (exit 1, nothing written) while any T01–T10 token is derivable (the legacy hash or `CC01-<table>`, the same two patterns `qr:audit` reports); local / `--purpose` sheets unchanged | A failing test first showed production mode wrote print-ready labels for a legacy token; the commit review added the second pattern (also test-first) |
| Tests | 2 new tests in `tests/domain/table-qr-token.test.ts` and `tests/domain/table-qr.test.ts` | Both failed before the fix, pass after |
| Recipes | `scripts/coders-cafe/kitchen-template.ts` also writes `docs/kitchen-recipe-data/recipe-signoff.csv` (61 rows, menu order, 429 lines in total) | A per-dish tracker for the chef / owner; the 4 existing sheets regenerate byte-identical |
| Dependencies | `package-lock.json`: `source-map-js` 1.2.1 → 1.2.2 (inside postcss's `^1.0.2` range; one lockfile entry) | Clears GHSA-68fv-2mgg-jv7q |
| Docs | `docs/qr-token-rotation.md` (second pattern, every flagged table, label guard, card swap plan, label handling, rehearsal record); new `docs/production-migration-preflight.md`; new `docs/real-phone-qr-test.md`; `docs/physical-printer-test.md` (pre-checks, record table); `docs/performance-and-load-test.md` (staging load-test plan); `docs/desktop-release.md` (macOS DMG status note); `docs/owner-go-live-checklist.md` (stale "none pushed" status line corrected, links) | — |

### 6.2 Verification (commands run in this pass)

| Command | Result |
| --- | --- |
| `npx vitest run tests/domain/table-qr.test.ts tests/domain/table-qr-token.test.ts tests/domain/qr-token-logging.test.ts` | 3 files, 41 passed (after the final edits) |
| `npx vitest run tests/domain/coders-cafe-recipes.test.ts` + regenerating the chef sheets | 10 passed; the 4 existing sheets and `recipe-signoff.csv` regenerate byte-identical; per-dish line counts match `recipe-lines.csv`, no box pre-filled |
| `npm run qr:tables -- --mode production --base-url https://menus.example.com` on scratch copies (output deleted) | unrotated investor-demo copy: refused, exit 1; rotated rehearsal copy: `printReady: true`, exit 0 |
| `npx vitest run` on the 6 payment-guard / infra suites (`upi-direct-bank`, `security`, `env-validation`, `coders-cafe-upi`, `upi-checkout-flow`, `infrastructure`) | 6 files, 104 passed |
| `npx vitest run tests/domain/payment-recovery.test.ts` | 11 passed (one of them the cron route: 401 without the bearer secret, counts only) |
| `npm run typecheck` | exit 0 (after the final edits) |
| `npx eslint` on the 5 changed code files | exit 0 |
| `npm run build` (after the lockfile change; no server running) | exit 0, compiled in 54 s |
| `npm audit --omit=dev` | 6 → 5 advisories (4 high, 1 moderate) |
| Doc checks: every backticked repo path and `npm run` script named in the changed docs exists | 0 missing |
| Secret scan of the diff + new files (DB URLs with passwords, Razorpay keys, private keys, bearer tokens, the 10 legacy table tokens, 24-character token shapes) | 0 hits |

The full Vitest / E2E suites were **not** re-run: the code change is limited to
two QR CLI scripts and a doc generator, covered by the targeted suites above,
and the lockfile change is build tooling, covered by the build.

### 6.3 QR security audit

- `npm run qr:audit` reads `DATABASE_URL` (from `.env`: `file:./dev.db`
  unless set in the shell); it only runs two `findMany` queries. It was run on
  **byte copies** in the session scratchpad, never on the originals
  (`dev.db` `249a564f`, investor DB `6f3ad94e`, both unchanged).
- Copy of `dev.db`: 36 tables, all derivable (10 hash + 26 `<outlet>-<table>`), exit 2.
  Copy of the investor-demo DB: 10 tables, all derivable, exit 2.
- Full rotation rehearsed on a third copy (table in `docs/qr-token-rotation.md`):
  10/10 old tokens dead, 10/10 new tokens on the right table, 10 audit rows by
  the owner without tokens, audit exit 0 afterwards, production labels then
  allowed.
- **Production: not audited** (no read-only connection exists). Its current
  build `a80caa9` accepts QR orders paid at the counter, so rotation there
  needs a closed window.

### 6.4 SBI UPI

Unchanged: `sbi_upi` is a stub (`SBI_UPI_IMPLEMENTED = false`) that refuses
every call, reports unhealthy and rejects every callback. Unset
`PAYMENT_PROVIDER` resolves to `mock`, which is refused in production, as are
`upi_emulator` and `ALLOW_MOCK_PROVIDERS` on Vercel Production (asserted by
the 104 tests above). SBI publishes no merchant UPI collection API (checked
three times on 2026-10-20, `docs/sbi-upi-integration.md` §1); not re-searched.
Needed from SBI: the items in that document's §2 (product + approval, API spec,
status API, callback security, UAT credentials, refunds / MIS).

### 6.5 Database and recovery

- The 9 PostgreSQL migrations newer than `a80caa9` match the checklist list.
  A static scan of the 9 files found no drop, rename, type change, data
  update/delete or NOT NULL column without a default. The only new unique
  index on an existing table covers two new nullable columns. Plain index
  builds (5 indexes on 4 existing tables) lock writes briefly, and append-only triggers
  are added on `AuditLog` / `InventoryLedger` (no code updates or deletes them).
- **Found: backup trap.** `db-verify.mjs` (used by `pg-backup.mjs
  --verify-restore` and `pg-restore.mjs`) requires the newest migration of the
  checkout it runs from. From this release, a good pre-upgrade backup of
  Production would be reported as failed. Workaround documented (run the
  backup from an `a80caa9` worktree; the ops scripts are identical there); no
  code change.
- Builds never migrate (`build` = Prisma generate + `next build`), so earlier
  Preview deploys sharing Production's `DATABASE_URL` could not have applied
  migrations.
- Local restore drill passed (section 2). **Production backup: no evidence
  that one exists or has ever been restored; provider unknown.** The
  preflight is `docs/production-migration-preflight.md`.

### 6.6 Scheduler

`/api/cron/payments` exists (bearer `CRON_SECRET`, counts only; its route test is in `tests/domain/payment-recovery.test.ts`).
`vercel.json` schedules only the daily `/api/cron/worker`. Compatible options:
Vercel Cron `* * * * *` on Pro or higher, or an external HTTPS scheduler with a
secret header (GitHub Actions only as a backstop). While `sbi_upi` is a stub no
online payment can be created, so the scheduler is a prerequisite of SBI
go-live, not a blocker today. Instructions and verification:
`docs/payment-safety.md` §3, checklist §B.

### 6.7 Printer, phones, recipes, capacity, signing

- Printer: procedure made actionable (pre-checks, record table). The only
  transports are network ESC/POS (raw TCP 9100) and browser printing. Needs the
  real printer.
- Phones: new `docs/real-phone-qr-test.md`, not run. Stage 1 needs rotated
  cards; stage 2 needs SBI UAT.
- Recipes: 61 draft / estimated versions, 429 lines (investor DB copy, chef
  sheets and source agree). Tracker `recipe-signoff.csv`. None verified by a chef.
- Capacity: staging load-test plan added; nothing measured beyond the lab.
- Signing: Windows installers unsigned (`NotSigned`), macOS DMGs ad-hoc
  signed, not notarized. **Decision needed before rc.2 goes to anyone outside
  the restaurant:** (a) restaurant-internal only, unsigned, accepting
  SmartScreen / Gatekeeper prompts; or (b) buy a Windows OV/EV certificate or
  a cloud signing service (check eligibility for the publisher's country)
  and, if Macs are needed, an Apple Developer ID with notarization. Wiring:
  `docs/desktop-release.md` "Code signing".

### 6.8 Dependency advisories (`npm audit --omit=dev`, 5 remaining)

| Package (path) | Severity | Fix available | Compatible remediation | Tests it would need |
| --- | --- | --- | --- | --- |
| `deepmerge-ts` 7.1.5 (via `@prisma/config` ← `prisma` 6.19.3), GHSA-ggr8-5vv4-36mx; counted 3× as `deepmerge-ts`, `@prisma/config`, `prisma` (all high) | high (practical: low, CLI config loading only) | Prisma 7.10.1 (major); no fixed 6.x (6.19.3 is the newest and pins 7.1.5) | (a) `overrides` `deepmerge-ts@8.0.2` under `@prisma/config`: same `deepmerge(...)` signature, CJS + ESM kept (checked in a scratch tarball, not installed); (b) Prisma 7: config file, client generator, engine and desktop packaging changes | (a) `prisma generate` for both schemas, `migrate deploy` / `status` / `diff` on SQLite + PG, build, `desktop:build` + `desktop:verify`; (b) the full cycle: all Vitest, all E2E, PG CI, desktop on 3 platforms |
| `postcss` 8.4.31 (pinned exactly by `next` 15.5.27; 15.5.28 pins the same), 4 advisories (high), surfaced on `next` as moderate | high / moderate (practical: low, compiles our own CSS at build) | Next 16.4.2 (major, ships postcss 8.5.23) | (a) `overrides` `postcss@^8.5.23` under `next` (minor within 8.x); (b) Next 16 | (a) build, then the main + investor + acceptance E2E (styled pages); (b) the full cycle |

Recommendation: no change before the pilot. Schedule (a) for both as one
small dependency change with the listed tests. Plan Prisma 7 / Next 16 as a
separate upgrade project.

### 6.9 Remaining approvals and external dependencies

Unchanged from section 5 except: item 3 (QR) now has a rehearsed procedure
and a label guard; item 2 (database) has a preflight and the backup-trap
workaround; item 11 (dependencies) is 5 advisories, not 6.

| State | Item | Exact next action | Who / what |
| --- | --- | --- | --- |
| DONE | QR audit tooling, rotation rehearsal, label guard | — | — |
| DONE | Migration preflight + compatibility review | — | — |
| DONE | Printer / phone / load-test / recipe-tracker procedures | — | — |
| REQUIRES OWNER APPROVAL | Push this pass's 2 local commits | Review, then `git push origin release/coders-cafe-2026-10-13` (normal push, never force) | Owner |
| BLOCKED | SBI UPI | Send `docs/sbi-upi-integration.md` §2 via the branch / RM | Owner + SBI |
| BLOCKED | Production DB identity, backup, restore proof, `migrate status` | Supply the DB provider / `DATABASE_URL` source; run preflight steps 1–4 | Owner (+ hosting provider) |
| BLOCKED | Production QR audit | A read-only connection, then `npm run qr:audit` | Owner |
| BLOCKED | Physical printer | Pre-checks + record in `docs/physical-printer-test.md` | Staff with the printer |
| BLOCKED | Real-phone stage 1 / stage 2 | Stage 1 after rotation; stage 2 after SBI UAT | Owner / QA with phones |
| BLOCKED | Recipes | Fill the sheets, tick `recipe-signoff.csv`, approve in RESTORA | Chef + owner |
| BLOCKED | Staging load test | Provide a staging deployment with its own DB | Owner + engineering |
| REQUIRES OWNER APPROVAL | QR rotation in Production | Written approval + closed window + verified backup | Owner |
| REQUIRES OWNER APPROVAL | Production migration window | Approve preflight step 6 after steps 1–4 pass | Owner |
| REQUIRES OWNER APPROVAL | Scheduler choice (Vercel plan) | Confirm plan; Pro cron or external scheduler | Owner |
| REQUIRES OWNER APPROVAL | Late-payment window (10 min proposed) | Approve / change / reject | Owner |
| REQUIRES OWNER APPROVAL | Signing decision, then rc.2 | Choose (a) or (b) in 6.7; then checklist §H | Owner |
| REQUIRES OWNER APPROVAL | Legacy Razorpay read-only audit | Grant read-only DB + dashboard access | Owner |
| REQUIRES OWNER APPROVAL | Dependency overrides | Approve the small change in 6.8 | Owner / engineering |
