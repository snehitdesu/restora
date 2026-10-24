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

---

## 7. Final end-to-end readiness mission (2026-10-21, later the same day)

Continues sections 1–6 (not repeated). Base `a26b788` on
`release/coders-cafe-2026-10-13`, 2 commits ahead of `origin` (`44ece0d`,
`a26b788`), both intact. **Everything below is uncommitted working-tree
change for review.** No commit, push, PR, tag, deploy, release, Production
connection, payment, QR rotation or provider change happened.

Labels: **VERIFIED** = command run in this pass, output below; **REPO** = read
from the code / config; **INFERENCE** = reasoned from evidence, not run;
**EXTERNAL** = needs someone outside the repository; **OWNER** = needs the
owner's decision.

### 7.1 Executive summary

**NOT READY — EXTERNAL DEPENDENCIES / OWNER DECISIONS REMAIN.** No engineering
blocker was found in the code that can be fixed from the repository. This pass
fixed two tooling defects that would have misled an operator during the
Production upgrade (a pre-upgrade backup reported as failed; an empty or wrong
database audited as "clean"), corrected several documentation defects (one of
them made the documented Production QR audit command fail), added regression
tests for QR resolution and the SBI stub, cleared one dev-tooling advisory,
and rehearsed the Production upgrade path end to end on a disposable
PostgreSQL database built from `a80caa9`'s schema. Production itself is still
unknown: provider, backups, migration state and QR tokens are unverified, and
online guest payment (SBI UPI) does not exist.

### 7.2 Changes in this pass (uncommitted)

| # | Change | Defect / gap (evidence) | Regression evidence |
| --- | --- | --- | --- |
| 1 | `--expect-migration <name>` for `scripts/ops/db-verify.mjs`, `pg-backup.mjs`, `pg-restore.mjs` (`resolveExpectedMigration` in `pg-common.mjs`); the name must be a migration of the checkout | The tools required the checkout's newest migration, so a correct backup of Production on `a80caa9` failed verification from this release (and so would a rollback restore). VERIFIED on PG: without the flag backup / restore / verify all failed with "expected migration 20261025100000_recipe_estimates is not applied" | `tests/ops/expected-migration.test.ts` (4, failed before the code existed); PG run 7.4 |
| 2 | `qr:audit` exits **3** ("No tables found … Nothing was audited") on a database with no tables (`auditExitCode`) | An empty / wrong database exited 0, the same as a clean audit. VERIFIED: freshly migrated empty SQLite DB → exit 0 before, exit 3 after; investor-DB copy still exit 2 | `tests/domain/table-qr-token.test.ts` exit-code test (failed first: function missing) |
| 3 | Tests: each token resolves only its own table / outlet / organization; a table whose organization does not own its outlet is `not_found` | The org-mismatch branch of `lookupTableToken` had no test | mutation check: removing the branch fails the new test (1 failed), restored |
| 4 | `tests/domain/sbi-upi-fail-closed.test.ts`: with `PAYMENT_PROVIDER=sbi_upi` guests are never offered online payment (fresh or cached, UAT or `production`); a callback to `/api/webhooks/payment/sbi_upi` is 401 even when signed with the deployment secret; the payment stays `PENDING`, the order is not paid, no event `PROCESSED` | The stub was tested only at adapter level | 2 passed |
| 5 | `package-lock.json`: `http-cache-semantics` 4.2.0 → 4.3.0 (one entry; inside `cacheable-request`'s `^4.0.0`; published 2026-10-04) | GHSA-ch52-4w7c-c8xp (high), path `electron-builder` → `@electron/get` → `got` → `cacheable-request`: desktop packaging only. Tarball diff: adds `status()`, stricter `Vary` matching | full audit 29 → 28; module smoke (`@electron/get` loads, policy works); `desktop:pack` NOT run |
| 6 | Docs | see 7.3 | — |

### 7.3 Documentation corrected or completed

- `docs/production-migration-preflight.md`: the `a80caa9` worktree workaround
  replaced by `--expect-migration 20261016100000_integrations_control_room`
  in steps 2–3; local upgrade rehearsal recorded (schema only); PG client
  prerequisite for the read-only commands.
- `docs/qr-token-rotation.md`: exit code 3; **the PostgreSQL client
  prerequisite** — `DATABASE_URL=<prod> npm run qr:audit` on a normal checkout
  fails ("the URL must start with the protocol `file:`", VERIFIED) because the
  generated Prisma client is SQLite and `prisma/postgres/schema.prisma` is
  generated and gitignored; decision-points / evidence table.
- `docs/production-infrastructure.md`: `EXPECTED_MIGRATION` said
  `20261021100000_append_only_rate_limit`; the code says
  `20261025100000_recipe_estimates`.
- `docs/production-runbook.md`, `docs/owner-go-live-checklist.md`: restore of an
  older release's backup needs `--expect-migration`.
- `docs/real-phone-qr-test.md`: automated-vs-real-device coverage matrix, stage-2
  environment, sign-off evidence list.
- `docs/kitchen-recipe-data/README.md`: grouped chef review report.
- `docs/release-notes.md`: **draft** rc.2 notes (not released, version not bumped).

### 7.4 Database and recovery — VERIFIED on a disposable PostgreSQL 16.14 cluster (port 55433, scratchpad, stopped afterwards)

| Step | Result |
| --- | --- |
| Database at `a80caa9`'s schema: its 12 migrations via `prisma migrate deploy` | applied; 102 tables |
| `db-verify` default / `--expect-migration 20261016100000_integrations_control_room` / mistyped name | exit 1 (expected migration missing) / exit 0 INTEGRITY OK / exit 1 refused |
| `pg-backup --verify-restore` default / with flag / mistyped flag | exit 1 / exit 0, encrypted, manifest `expectedMigration` = the flag's value, `restoreVerified` / exit 1 before any dump |
| `pg-restore` default / mistyped flag / with flag | verification failed / refused before touching the target (0 tables) / restore complete, ok |
| Wrong `BACKUP_ENCRYPTION_KEY` | refused (AES-GCM authentication) |
| Upgrade rehearsal: HEAD's 21 migrations on the restored `a80caa9`-state DB | the 9 new ones applied in order; `migrate status` up to date; `migrate diff` "No difference detected" (exit 0); `db-verify` default INTEGRITY OK, 122 tables |
| `backup-drill.mjs` on the upgraded DB (default path, no flag) | **PASSED 10/10** in 199 s |

Limits: **no business rows** in that database (schema only), so this proves the
tools, the SQL and the procedure, not duration or behaviour on Production's
data. A stale generated `prisma/postgres/schema.prisma` (gitignored, from
2026-10-20) first produced a false `migrate diff` difference
(`RecipeVersion.estimated`); regenerating it with `node scripts/pg-schema.mjs`
cleared it — now noted in the preflight.

Still unknown (EXTERNAL): Production's provider, an authorized read-only
connection, its applied migrations, any backup and any restore of one, RPO /
RTO expectations, and the migration window (OWNER).

### 7.5 QR security

VERIFIED: 23 QR / guest / token files, 273 tests passed (plus the new tests in
7.2). Token source: 18 CSPRNG bytes (144 bits), unique index + retry
(`src/server/qr/tableToken.ts`); lookup token → table → outlet with an
organization-consistency check, guest context scoped to that one outlet
(`lookupTableToken`). Guest API logs record the route pattern, not the token
(`tests/domain/qr-token-logging.test.ts`). Local label generation on an
investor-DB copy: 10 SVG + `labels.html` + `manifest.json` (`printReady:
false`) + `NOT-FOR-CUSTOMER-PRINTING.txt` (deleted afterwards). Missing database
file: audit and production labels both exit 1, nothing written (Prisma
leaves an empty file at a mistyped SQLite path — harmless, noted). PG audit
procedure: 7.10.

Not done (AUTHORIZATION / OWNER): Production audit and rotation. Production's
build `a80caa9` accepts counter-paid QR orders (REPO: `a80caa9:src/server/services/guestOrdering.ts:311`,
`paymentMethod: z.enum(["CASH", "ONLINE"])`), so rotation needs the closed
window in `docs/qr-token-rotation.md`. **Option to note, not taken:** a runtime
refusal of derivable tokens in production would kill every current Production
card on deploy; that is a rollout decision, not a fix.

### 7.6 Payments, scheduler, Razorpay

- SBI UPI: REPO + VERIFIED — stub refuses every operation, unhealthy, every
  callback 401 at the route, cannot be enabled by a default
  (`SBI_UPI_IMPLEMENTED = false` is a constant; unset `PAYMENT_PROVIDER` is
  `mock`, refused in production). Provider requirements, request template,
  acceptance and UAT matrix: `docs/sbi-upi-integration.md` §2–§5 (the
  documents are written, nothing invented; **no UAT has run**). EXTERNAL: SBI product, spec, UAT, credentials, sign-off.
- Recovery job: REPO — claimed per payment (compare-and-set), bounded (20
  probes, deadline), fair lanes; tests for duplicate workers, deadline, timeouts,
  route auth (bearer `CRON_SECRET`, false when unset, constant-time).
  `/api/health/metrics` exists (404 without `METRICS_TOKEN`, 401 without the
  bearer); documented metric names exist in code. OWNER: hosting plan and the
  trigger (`docs/payment-safety.md` §3 has the exact `vercel.json` entry and the
  external-scheduler contract). No scheduler was configured.
- Late-payment window: REPO — implemented with default 10 minutes
  (`GUEST_FULFILMENT_WINDOW_MINUTES`, 1–240, `src/server/services/kitchenGate.ts`);
  **not approved** (OWNER). This pass changed nothing about it.
- Razorpay (legacy) — read-only code audit, VERIFIED against the code: no
  checkout path (no `createCheckout` / `resumeCheckout`; `getCheckoutProvider`
  refuses it); still reachable server-side for verification, recovery,
  webhooks (`x-razorpay-signature`), refunds, settlements; env keys optional
  but all-or-nothing; browser loader and test emulator removed. The read-only
  SQL in `docs/payments-razorpay.md` was checked against both the current and
  `a80caa9` schemas (columns and status values exist). **Recommendation:
  RETAIN (legacy-only) until the Production queries return 0 pending / 0 open
  anomalies and the refund window has passed; then remove after migration** as
  that document lists. Production usage: **unknown**.

### 7.7 Recipes — VERIFIED from `prisma/coders-cafe/recipes.ts`

Generator rerun: all 5 sheets byte-identical; recipe source unchanged since
`e7fedf8`; no fill-in column pre-filled in any sheet; 64 menu items = 61
drafts + 3 not covered; 429 lines, 0 unknown ingredients, 0 non-positive
quantities; 54 / 54 ingredients without a price (none in the source); 4 lines
use 0.5 egg; 24 sizes at factor 1×. Recipe / costing tests 5 files 43 passed.
Grouped report: `docs/kitchen-recipe-data/README.md` "Chef review report".
EXTERNAL: chef review of all 61; none is approved.

### 7.8 Performance

Not re-run. INFERENCE with evidence: `git diff 5503ab7 HEAD -- src prisma` is
empty and the only `next.config.mjs` change applies to the desktop build
(`AHAROS_STANDALONE=1`), so the 2026-10-20 lab measurements
(`docs/performance-and-load-test.md`) still describe this web code. They are
laptop-lab numbers (SQLite and local PostgreSQL), not a capacity claim.
EXTERNAL: a staging deployment with its own database, a traffic profile and
agreed thresholds (plan in that document; proposed thresholds await the owner).

### 7.9 Dependencies

`npm audit --omit=dev`: 5 (4 high, 1 moderate), unchanged — `deepmerge-ts`
7.1.5 (via `@prisma/config` 6.19.3) and `postcss` 8.4.31 (pinned by `next`
15.5.27). Full audit (dev tooling included, never covered before): 29 → **28**
(14 moderate, 12 high, 2 critical); the criticals are `vitest` 2.1.9 /
`tinypool` (local test runner, not shipped; fix = vitest 5, major).

Compatibility evidence for the two proposed overrides (isolated scratch
projects; the repository was not changed):

| Override | Evidence (VERIFIED) | Still needed before applying |
| --- | --- | --- |
| `@prisma/config` → `deepmerge-ts` 8.0.2 | `npm audit` 0 in the scratch project; `prisma validate` both schemas; `migrate diff --from-empty` output byte-identical to the repo's unoverridden Prisma (SQLite 2,889 lines, PG 3,212 lines); `prisma generate` ok; a `prisma.config.ts` loads through the c12 merge path. Only use: the merger for config files (the repo has none) | owner approval; then in the repo: `npm install`, both `prisma generate`s, CI |
| `next` → `postcss` ^8.5.23 | `globals.css` compiled with the repo's Tailwind + Autoprefixer under postcss 8.4.31 and 8.5.28: byte-identical (77,277 bytes, same SHA-256, 0 warnings) | owner approval; then `npm run build` + main / investor / acceptance E2E (Next's own CSS pipeline, not exercised by this comparison) |

Recommendation unchanged in substance, now with evidence: both overrides are
low-risk; apply together as one dependency change after approval. Prisma 7 /
Next 16 / Vitest 5 are separate upgrade projects. OWNER decision.

### 7.10 PostgreSQL read-only audit procedures — VERIFIED

Same disposable cluster, database at `a80caa9`'s schema with 3 seeded tables
(an `<outlet>-<table>` token, a random token, none):

| Command | Result |
| --- | --- |
| `DATABASE_URL=<pg url> npm run qr:audit` with the checkout's default (SQLite) client — the command the runbook used to give | **fails**: "the URL must start with the protocol `file:`", exit 1 |
| after `node scripts/pg-schema.mjs && npx prisma generate --schema prisma/postgres/schema.prisma`, same command | `legacy-derivable` / `random` / `none`, no token printed, exit 2 |
| same, on an empty database at that schema | "No tables found", exit 3 |
| `node scripts/ensure-sqlite-client.mjs` afterwards | SQLite client back (`provider = "sqlite"`) |
| the 5 read-only Razorpay queries of `docs/payments-razorpay.md`, in a `default_transaction_read_only` session | all run on `a80caa9`'s schema, exit 0 |
| `prisma migrate status` | exactly the 9 newer migrations "not yet applied" (what preflight step 1 expects) |

Cluster stopped afterwards. Runbooks updated (`docs/qr-token-rotation.md`
step 3, `docs/production-migration-preflight.md` step 1).

### 7.11 Test and build evidence (this pass)

All on this machine (Windows 11, Node 24.20.0, SQLite unless stated), after
the changes, on the final working tree unless stated:

| Check | Command | Result |
| --- | --- | --- |
| Full Vitest | `npm test -- --shard=i/4`, 4 sequential shards | **200 / 200 files, 2,366 passed, 8 skipped, 0 failed** (498 / 883+6 / 558+1 / 427+1); every file on disk ran exactly once (log vs `find tests`), including the new ones added during the run |
| Changed + related suites, final content | `npx vitest run tests/ops …table-qr… sbi-upi-fail-closed upi-direct-bank razorpay payment-recovery coders-cafe-recipes` | 10 files, 131 passed |
| QR / guest / token suites | `npx vitest run qr guest token …` | 23 files, 273 passed |
| Recipe / costing | `npx vitest run recipe cost` | 5 files, 43 passed |
| Typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint`; `npx eslint` on the 7 changed script / test files | 0 warnings / errors; exit 0 |
| Production web build | `npm run build` | exit 0, compiled in 33.6 s |
| Browser E2E (targeted) | `npm run e2e:test -- qr-transaction guests bill-print` on that build | 12 passed (2.3 min) |
| PostgreSQL | disposable 16.14 cluster | 7.4 and 7.10 (drill 10/10, upgrade rehearsal, PG audit) |

**Not run, and why:** the full main E2E (134 specs, ~25 min) and the
investor / acceptance suites — no application code changed (`git diff
5503ab7 HEAD -- src prisma` empty; this pass changed only ops / QR CLI
scripts, tests, docs and one dev-tooling lockfile entry), the last full runs
were green on `e7fedf8`; the PostgreSQL Vitest suite (`npm run test:pg`) —
same reason, and green in CI on `e7fedf8`; `desktop:build` / `desktop:pack` /
`desktop:verify` — the only change touching packaging is the
`http-cache-semantics` bump (module smoke only); CI — nothing is pushed.

### 7.12 Release and signing

Version still `1.0.0-rc.1`; no rc.2 built, signed, tagged or published. Signing
options (unchanged, `docs/desktop-release.md` "Code signing"): (a) unsigned,
restaurant-internal only (SmartScreen / Gatekeeper prompts; no updater
trust); (b) Windows OV/EV certificate on a hardware token or a cloud signing
service (Azure Trusted Signing or similar — check eligibility in the
publisher's country) plus, only if Macs are used, Apple Developer ID +
notarization. Wiring exists (`WIN_CSC_LINK` / `CSC_LINK`, `MAC_CSC_LINK`,
`electron-builder.yml`); no certificate exists.

| | State |
| --- | --- |
| A. Engineering readiness | Code, tests, tooling verified locally (7.11); CI last green on `e7fedf8` (section 1) — the two local commits and this pass's changes have **not** run in CI (they are not pushed) |
| B. Release-artifact readiness | Not ready: no rc.2 build, no signing decision, version not bumped, `website.test` manifest tracks rc.1 |
| C. Owner authorization | Not given: push, rc.2, signing, Production steps |
| D. Production / pilot readiness | Not ready: SBI, Production DB, QR rotation, scheduler, physical tests, recipes |

### 7.13 Release gate

1. **Release candidate (rc.2) approval** needs: review + push of the local
   commits and this pass; CI green on that commit; signing decision; version
   bump + rc.2 build; `desktop:verify` on the artifacts; owner's written OK.
2. **Staging / pilot approval** needs: SBI UAT access and an implemented,
   UAT-passed `sbi_upi`; a staging deployment with its own database and a
   payment scheduler; rotated cards; real-phone stages 1–2 and the printer test
   signed off; late-payment window decided; load test on staging.
3. **Production approval** needs: Production DB identified, backed up and a
   restore proven (preflight steps 1–4); migration window approved; QR rotation
   done in a closed window; SBI production credentials and certification;
   scheduler live and verified; Razorpay residual queries answered; chef
   sign-off before stock-cost figures are relied on.

### 7.14 External blockers, owner decisions, next actions

| Blocker | Required input | From | Next action once it arrives | Done when |
| --- | --- | --- | --- | --- |
| A. SBI UPI | Product + approval, API spec, status API, callback security, UAT credentials, certification steps (`docs/sbi-upi-integration.md` §2, ready to send) | SBI branch / RM via the owner | Implement `sbi_upi` from the spec; run §5 UAT matrix | UAT results + SBI sign-off on file |
| B. Production DB | Provider identity, read-only connection (in the operator's shell, never in chat), backup evidence | Owner / hosting | Preflight steps 1–4 (`migrate status`, backup with `--expect-migration`, isolated restore, rehearsal) | All four pass; window approved |
| C. QR rotation | Read-only audit (PG client, 7.10), approved closed window | Owner | Audit → rotate → labels → phone check (`docs/qr-token-rotation.md`) | Audit exit 0 after; evidence table filled |
| D. Phones / printer | Two phones (iPhone + Android), café Wi-Fi + mobile data, the receipt printer + its IP | Owner / staff | Stage 1 after C; printer A.1–A.8; stage 2 after A | Record tables filled |
| E. Recipes | Weighed quantities, size factors, allergen evidence, paid prices for 61 dishes / 54 ingredients | Chef | Fill sheets; enter, confirm, approve in RESTORA | Both last columns of `recipe-signoff.csv` filled |
| F. Performance | Staging deployment with its own DB, traffic profile, thresholds | Owner + engineering | Staging plan in `docs/performance-and-load-test.md` | Pass criteria met on staging |
| G. Scheduler | Hosting plan; choice of trigger | Owner | Add the `vercel.json` entry or configure the external scheduler | 200s every minute; recovery seen on Preview |

**Owner decisions:** (1) push the 2 local commits + review / commit this
pass's changes; (2) late-payment window — 10 minutes (implemented default),
another value, or reject; (3) scheduler trigger; (4) apply the two
dependency overrides (7.9) or defer; (5) signing option (a) or (b), then rc.2;
(6) Production read-only access, then the migration window and the QR
rotation window, each separately.

**Single highest-priority next action:** the owner identifies Production's
database provider and grants a read-only connection, so preflight step 1 and
the QR audit (7.10) can run — every Production step and the QR rotation wait
on it. (SBI is the long-lead item for the pilot: send §2 the same day.)

---

## 8. Change review and owner decision sheet (2026-10-21, after section 7)

Review of the uncommitted section-7 changes on `a26b788` (2 ahead of `origin`,
0 behind; nothing staged). Still nothing committed, pushed, deployed or
released; no Production connection.

### 8.1 Findings of the review (fixed)

| Finding | Fix | Evidence |
| --- | --- | --- |
| A pre-upgrade backup restored **without** `--expect-migration` was detected only **after** `pg_restore --clean` had run on the target. With `--confirm-overwrite` that wipes the target first, then reports failure. `pg-backup --verify-restore` likewise restored into the scratch DB before failing | `backupMeetsExpected` (`pg-common.mjs`): `pg-restore` checks the manifest's `latestMigration`, `pg-backup` the source's newest migration, **before** any database is touched; the error names the flag to pass | 2 new tests in `tests/ops/expected-migration.test.ts` (failed first: restore went straight to `psql`); disposable PG: scratch left with 0 tables; a non-empty target with `--confirm-overwrite` kept its table and row |
| `qr:audit` exit 3 catches an empty database, not a different non-empty one | runbook step 3: check the printed organization / outlet names are Production's | doc only |
| Test-only type error in the new restore tests (JS parameters inferred as required) | explicit optional fields | `npm run typecheck` exit 0 |

### 8.2 Safeguards re-verified (disposable PostgreSQL 16.14, port 55433, stopped afterwards)

Documented workflow on the `a80caa9`-schema database: backup with
`--verify-restore --expect-migration 20261016100000_integrations_control_room`
gave `restoreVerified: true`; restore with the flag into an empty DB ok;
`db-verify` with the flag INTEGRITY OK; HEAD's migrations on it: 9 applied,
`migrate diff` exit 0, `db-verify` (default) INTEGRITY OK; `backup-drill.mjs`
**10/10** (179 s). Limits as in 7.4 (no business rows).

**Mutation checks** (each safeguard disabled in turn, the named tests run,
the source restored byte-for-byte, SHA-256 compared; `src/` unchanged):

| Safeguard disabled | Result |
| --- | --- |
| SBI `verifyWebhook` returns true | 1 test failed |
| SBI `healthCheck` returns true | 1 test failed |
| `qr:audit` empty database gives exit 0 | 1 test failed |
| `--expect-migration` typo accepted | 1 test failed |
| restore / backup pre-check off | 2 tests failed |

Unchanged since 7.10 (those scripts not modified since): the PG read-only QR
audit and the Razorpay read-only SQL on the `a80caa9` schema.

### 8.3 Dependency overrides: full compatibility test in an isolated copy

A copy of the working tree with its own real `node_modules` (scratchpad). The
repository's `package.json` and lockfile were **not** changed by this.

- Paths and reach (VERIFIED): `deepmerge-ts` 7.1.5 only under
  `prisma` > `@prisma/config` (CLI config loading; GHSA-ggr8-5vv4-36mx, `<8.0.0`);
  `postcss` 8.4.31 only under `next` 15.5.27, pinned exactly (GHSA-qx2v-qp2m-jg93,
  GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, GHSA-r28c-9q8g-f849). Neither is in
  the server's runtime trace (`.next/next-server.js.nft.json`: 0 files) and
  `@prisma/client`'s runtime does not use `deepmerge-ts`: **build / CLI time only**.
- **How to apply (found by trying):** `"overrides": {"next": {"postcss": "8.5.28"}}`
  does **not** take effect: npm keeps the lockfile's nested 8.4.31 ("invalid").
  Working form: `"overrides": {"@prisma/config": {"deepmerge-ts": "8.0.2"},
  "postcss": "$postcss"}` and delete the lockfile entry
  `node_modules/next/node_modules/postcss` before `npm install`. Lockfile diff:
  those two packages only.

| Check in the overridden copy | Result |
| --- | --- |
| `npm audit --omit=dev` | **0** (from 5) |
| `prisma generate`; `migrate diff --from-empty` SQLite + PostgreSQL vs. the unoverridden repo | ok; byte-identical (2,889 / 3,212 lines) |
| Vitest: `tests/ops`, QR token, QR payment gate, decimal precision, guest UI | 7 files, 126 passed, 6 skipped |
| `npm run build` | exit 0; the 3 emitted CSS files byte-identical to the repo's own build |
| `npm run e2e:test -- qr-transaction guests bill-print` | 12 passed |
| Not run with the overrides | full Vitest, full E2E, PG suite, desktop build / package / verify |

Residual risk: overriding a dependency Next pins exactly is not supported by
Next; re-check on every Next upgrade.

### 8.4 A. Engineering work verified locally

Full Vitest 200 files / 2,366 passed / 8 skipped / 0 failed (section 7, before
this review's script change). After the review: the 10 affected files 155
passed, `tests/ops/expected-migration.test.ts` 7 passed, typecheck exit 0,
ESLint on all changed scripts / tests exit 0, `git diff --check` clean. Build
and targeted E2E (12) on the section-7 tree (no application or build change
since). PG workflow, drill, upgrade rehearsal, PG QR audit and mutation checks
as above. Not run: full main E2E, PG Vitest, desktop packaging, CI (nothing pushed).

### 8.5 B. External prerequisites, not verified

SBI spec / UAT / credentials / certification; Production DB provider,
read-only access, backup and restore evidence, applied migrations; Production
QR audit; hosting plan (scheduler); staging environment; phones, café network,
receipt printer; chef data (61 recipes, 54 prices). None of these happened.

### 8.6 C. Owner decisions (each separate; approving one approves nothing else)

| # | Decision | Trade-off | Recommendation |
| --- | --- | --- | --- |
| 1 | Push `44ece0d` + `a26b788` (and, separately, commit this pass's changes) | Pushing is the only way to get CI on them. It will very likely start a Vercel Preview build of this branch (builds never migrate, but that Preview serves whatever Preview `DATABASE_URL` points at) | Yes, a normal push after your review, once you have confirmed Preview's `DATABASE_URL` is not Production's. Commit this pass as two commits (ops / QR tooling + tests; docs) |
| 2 | Late-payment window | 10 min is implemented as the default (1–240). Shorter: fewer stale tickets, more held orders. Without a frequent scheduler, a payment found only by the daily job is past the window and held | Keep 10 as the default; give formal approval at SBI UAT, when it can be observed. Moot until SBI is live |
| 3 | Scheduler | Vercel Cron every minute needs Pro or higher (Vercel sends the secret itself, no extra service); an external HTTPS scheduler works on any plan but is another account holding `CRON_SECRET` | On Pro: add the `vercel.json` entry; otherwise an external scheduler. Not needed until SBI is live |
| 4 | Dependency overrides | Clears all 5 production-audit advisories, all build/CLI-time; evidence 8.3; residual risk is the unsupported pin under Next | Apply as its own commit (working form in 8.3) after decision 1, then full CI including the 3 desktop jobs. Deferring is also safe: no runtime exposure |
| 5 | Code signing | Unsigned: SmartScreen / Gatekeeper prompts, no update trust, free. Certificate or cloud signing: cost, identity verification, key custody | Unsigned for restaurant-internal pilot machines; buy signing only before distributing to anyone else |
| 6 | Production read-only access | Unblocks preflight step 1, the QR audit and the Razorpay queries; risk minimal with a read-only role kept in the operator's shell | **Approve first** |
| 7 | Migration window | Deploying this release turns QR ordering off until SBI is live ("please order with the staff"), because QR orders are online-payment only: a guest-visible change from today's `a80caa9` | Schedule only after preflight steps 1–4 pass **and** you accept QR ordering being off until SBI; otherwise wait for SBI |
| 8 | QR-rotation window | Production's tokens are derivable today and `a80caa9` accepts counter-paid QR orders, so anyone with the source can place orders at your tables. Needs a closed window and new cards | **Approve soon**, independent of the migration: it can run on `a80caa9` from the Tables screen |
| 9 | rc.2 | Needs 1 and 5, a version bump, a build and `desktop:verify` | Not yet: authorize after decisions 1 and 5 and green CI |

### 8.7 D. Prohibited until separately authorized

Commit, push, PR, tag; any deploy (Preview or Production); rc.2 build for
distribution or publication; any Production connection (even read-only) or
mutation; Production migrations; QR token rotation; enabling SBI or any
payment provider; real payments or test orders on Production; scheduler,
hosting or environment-variable changes; dependency changes in the repository
(the overrides); purchases (certificates, plans).

---

## 9. Production preflight and owner decision gate (2026-10-21, after section 8)

Base unchanged: `a26b788`, 2 ahead / 0 behind, nothing staged. New in this
pass (uncommitted): `scripts/ops/prod-readonly-audit.sql`,
`docs/production-readonly-audit.md`, `tests/ops/prod-readonly-audit-sql.test.ts`,
and edits to `docs/qr-token-rotation.md` and this report. No Production
database, Preview database or Vercel setting was touched: Vercel access from
this machine has expired (API 403) and was not renewed.

### 9.1 Production environment identification

From GitHub's deployment records (read-only API) and earlier dated
observations; full table in `docs/production-readonly-audit.md` §1.

- **VERIFIED:** Production = Vercel project `restora`, alias
  `restora-beta-six.vercel.app`, build `a80caa9` (only Production deployment
  record, 2026-10-10, last rebuilt 07:18 UTC). Every push creates a Preview
  (newest `e7fedf8`, 2026-10-20). The repository is **public**.
- **UNKNOWN:** Production's database provider / host; whether Preview's
  `DATABASE_URL` is Production's today (history: shared on 10-14, narrowed to
  Preview-only on 10-15 with Production keeping its baked value, Preview on a
  Neon test branch on 10-19); whether the provider allows a read-only role.
- **Consequence for decision 1 (push):** do the live probe of
  `docs/production-readonly-audit.md` §2.3 first. Vercel cannot show the
  values; the probe proves which database a deployment uses without any
  credential being displayed.
- **Hazard recorded (as of 2026-10-19, unverified since):** Production has no
  `DATABASE_URL` record, so **any** new Production deployment — including a
  dashboard "Redeploy" of `a80caa9` to change an env var — would start without
  a database.

### 9.2 Read-only audit readiness — PREPARED and VERIFIED LOCALLY, not run on Production

`scripts/ops/prod-readonly-audit.sql` (psql only, no Prisma client switch):
identity, privileges, migration state, organizations / outlets, live-menu id
check, QR classes, open orders / pending payments, Razorpay counts,
inconsistencies, size. Read-only session + transaction, ends in `ROLLBACK`.

VERIFIED on the disposable `a80caa9`-schema database (PostgreSQL 16.14):
exit 0 as a `SELECT`-only role (every write privilege `false`); identical QR
classes to `npm run qr:audit` for all 8 tables; 0 of 8 stored tokens in the
output; per-table count + md5 fingerprint identical before and after two runs
(one as superuser); live-menu check 2 served / 1 found as seeded; runs on the
release schema too. Found and fixed while testing: on Windows `psql` ignores
options written after a bare connection string, so the documented form uses
`-d`. Guard test: `tests/ops/prod-readonly-audit-sql.test.ts` (4 passed; a
`ROLLBACK`→`COMMIT` edit makes it fail).

Because a copy restored from Production holds the same rows, content checks
cannot identify the live database: the runbook requires the live probe (§2.3)
before the audit output is interpreted. Backups and restore proof come from
the provider console and preflight step 3, never from this SQL.

### 9.3 QR risk assessment (code of `a80caa9`; nothing tested on Production)

| Question | Answer (evidence) |
| --- | --- |
| Can an attacker get a token without visiting? | Yes, if Production still holds the seed's tokens (it did on 2026-10-13): T01–T10 are a SHA-256 of public constants in this **public** repository |
| What can they do with it? | Read the menu (public anyway); place orders at that table. An order is `OPEN`, waiting for staff to accept, with a NEW_ORDER alert to staff (`guestOrdering.ts`); ≤ 3 waiting per table, 20 per table per 10 min, 60 writes per IP per min (in-memory, per server instance — weaker on Vercel). They cannot read other guests' orders (per-order key) |
| Kitchen tickets without staff? | **Yes, via a verified online payment**: `payment.ts` sends an `OPEN` QR order to the kitchen, issues the next invoice number and consumes stock when its payment verifies ("prepaid"). With Razorpay in SANDBOX (seen 2026-10-13), Razorpay's public test cards complete payments: fake orders could reach the kitchen and the invoice series with no money paid. INFERENCE from code + the 10-13 observation |
| Does rotation disrupt guests? | Only guests mid-visit at a rotated table (their page stops working); orders already placed are unaffected. Needs new printed cards |
| Interim mitigations without a deployment | (a) **Rotate** every table (Tables screen; `a80caa9` already issues 144-bit random tokens) — removes remote guessing; (b) **Disable QR ordering** per table until new cards are out — stops QR ordering completely; (c) staff void QR tickets for tables that are not occupied. Changing Production's environment (e.g. removing the Razorpay test keys) needs a redeploy — **unsafe** while Production has no `DATABASE_URL` record |

**Recommendation:** if Production is used by guests, rotate all flagged
tables in the next closed window and print new cards; if it is only an
investor demo nobody orders from, disable QR ordering on every table now and
rotate when cards are needed. Neither brings an old card back: a disabled
table is re-enabled only by issuing a **new** token (corrected in 10.2). Do
neither without your explicit approval.

### 9.4 Release gates: complete vs prepared vs external

| Item | State |
| --- | --- |
| Backup / restore tooling incl. `--expect-migration` and the pre-checks | **Complete (local)**: tests + mutation checks + disposable-PG workflow and drill 10/10. Production backup / restore: **external** |
| Migration upgrade path `a80caa9` → release | **Complete (local, schema only)**; on Production data: **external** |
| QR audit + label guards; read-only audit SQL | **Complete (local)**; Production audit: **external** (access) |
| SBI fail-closed | **Complete** (adapter + route tests, mutation-checked). SBI integration: **external** (no spec / UAT) |
| Payment recovery job | **Complete in code / tests**; scheduler: **owner** (hosting plan) |
| 10-minute late-payment window | **Implemented default, not approved** (owner) |
| Dependency overrides | **Prepared** (isolated-copy evidence, §8.3); not applied (owner) |
| Recipes | **Prepared** (sheets, report); chef sign-off: **external** |
| Phones / printer | **Prepared** (procedures, matrix); not run: **external** (hardware) |
| Performance | Lab results (2026-10-20) still describe the web code; staging test: **external** |
| Signing / rc.2 | **Prepared** (options, notes draft); decisions: **owner** |
| CI on the current tree | **Not run** — nothing pushed. Do not read any section of this report as "CI passed" for these changes |

### 9.5 Owner decision sheet (each separate; none executed)

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Production read-only access | **Approve first.** Owner names the provider, creates a `SELECT`-only role (§2.4 of the audit runbook) and runs the live probe + audit, or authorizes an operator in writing |
| 2 | Push `44ece0d` + `a26b788` | Yes, after the §2.3 probe shows Preview does **not** use Production's database (a push creates a Preview). Commit this pass's work separately for review |
| 3 | Late-payment window | Keep 10 min as the default; approve or change it at SBI UAT. Moot until SBI is live |
| 4 | Scheduler | Confirm the Vercel plan in the dashboard: Pro → Vercel Cron every minute; Hobby → external HTTPS scheduler. Not needed until SBI is live |
| 5 | Dependency overrides | Apply as their own commit after decision 2 with full CI incl. desktop jobs, or defer (build/CLI-time only) |
| 6 | Code signing | Unsigned for restaurant-internal pilot machines; signing before any outside distribution |
| 7 | Production migration window | Only after preflight steps 1–4 pass, a `DATABASE_URL` record for Production is restored (else the deploy has no database), and you accept QR ordering being off until SBI is live |
| 8 | QR rotation / disable window | **Soonest of all Production actions** (9.3): rotate all flagged tables in a closed window, or disable QR ordering now if Production is demo-only |
| 9 | rc.2 | Not yet: after 2 and 6 and green CI |

### 9.6 Validation in this pass

`npx vitest run tests/ops/prod-readonly-audit-sql.test.ts`: 4 passed;
disposable-PG runs as in 9.2. No application code changed (`src/` untouched
in the whole working tree), so the full suite, build and E2E were not re-run;
their latest results are sections 7.11 and 8.4.

---

## 10. Production safety and Preview isolation gate (2026-10-21, after section 9)

No live change, no Production / Preview connection, no credential renewed.
Repository unchanged except the two doc edits below (`a26b788`, 2 ahead,
nothing staged).

### 10.1 Environment identity — evidence re-read

| Item | Status | Evidence (non-secret only) |
| --- | --- | --- |
| Production project / deployment | VERIFIED | GitHub records (by `vercel[bot]`): environment `Production` holds only `a80caa9` (created 2026-10-10 04:28 UTC, last status success 07:18 UTC); `origin/main` = `a80caa9` |
| Preview deployments | VERIFIED | environment `Preview`, one per push; newest `e7fedf8` (2026-10-20) |
| Production DB provider / host | **UNKNOWN** | no record in the repository or GitHub; Vercel holds it as a Sensitive value; this machine's Vercel session expired 2026-10-19 (API 403) |
| Preview `DATABASE_URL` scope / value | **UNKNOWN today** | last direct observation 2026-10-19 (Preview-only record; Preview then on a Neon test branch) |
| Local configuration | VERIFIED | no `.vercel/` link in the repository; `.env` and `.env.local-backup` define `DATABASE_URL` as a local SQLite file only — no Production credential on this machine |

**Preview / Production isolation: BLOCKED.** Nothing available here can show
which database a Preview uses; it is not assumed safe. Unblocking needs the
owner's dashboard check and the live probe (`docs/production-readonly-audit.md`
§2.2–2.3).

### 10.2 QR mitigation — corrections and the owner's choice

Verified from `a80caa9`'s code: (1) **Disable QR ordering** cannot be undone
for the existing cards — re-enabling issues a new token, so it ends in a
rotation with new cards (section 9.3 said "reversible"; corrected there).
(2) With `PUBLIC_BASE_URL` unset, the Tables screen encodes the address it is
opened at; replacement cards must be made with the backoffice open at
`https://restora-beta-six.vercel.app`, not a deployment-specific
(SSO-protected) URL. Options A (rotation + replacement cards) and B (disable)
with prerequisites, guest / kitchen effect, rollback and evidence:
`docs/qr-token-rotation.md` "Owner choice for Production today".

### 10.3 Local validation

`npx vitest run` on the audit-SQL guard, QR token, QR labels, QR logging, QR
transaction and expected-migration suites: 6 files, **77 passed**; ESLint exit
0; `git diff --check` clean. No migration, deployment or shared database.

### 10.4 Blockers to a safe push

1. Preview's database not proven separate from Production's (10.1).
2. The current working tree (5 new + 16 modified files) is uncommitted and
   unreviewed: decide what goes into the push.
3. No CI result exists for anything after `e7fedf8`.

---

## 11. Common restaurant QR ordering (2026-10-21, after section 10)

Implemented locally, uncommitted (`docs/common-qr-ordering.md` is the
reference). One QR for every table: guests order and pay without choosing a
table; staff assign it; the kitchen shows "no table yet" until then. Table QR
codes unchanged and still working. **Not deployed; Production (`a80caa9`)
does not have it; Production QR codes were not touched.**

- Schema: **one** additive migration, `20261026100000_outlet_common_qr`
  (`Outlet.guestQrToken` nullable + unique index), in both histories;
  `EXPECTED_MIGRATION` bumped. Production now needs **10** migrations, not 9
  (preflight, checklist, release notes updated). Orders needed no schema
  change (`Order.tableId` was already nullable).
- Reused unchanged: guest site and API (`/t/<token>`), server pricing,
  online-only payment verified server-side, the kitchen gate, idempotent
  replays, invoice numbering, stock deduction, payment recovery, KOT routing.
- New: common-token resolution; per-device order limit and a recent-unpaid cap
  on the common code; `setOrderTable` (`POST /api/orders/:id/table`) and
  `GET /api/orders/qr-tables`; POS Open orders → **QR tables**; KDS "no table
  yet" badge; Tables screen **Restaurant QR** card; audits and scanner aware
  of the common code (the audit SQL still runs on `a80caa9`'s schema).

### Evidence (local only)

| Check | Result |
| --- | --- |
| New domain suite `tests/domain/common-qr.test.ts` | 19 passed |
| New UI suite `tests/ui/common-qr-ui.test.tsx` | 4 passed |
| Related suites (QR, guest, table, kitchen, KOT, POS, order, payment, infrastructure, scan, floor, recovery, webhook) | 48 files, 584 passed |
| Full Vitest (4 sequential shards) | 203 files: 202 passed in the run; `tests/ui/logic.test.ts` failed once on the old KDS label "QR order" for a table-less QR ticket — the intended change; expectation updated to "QR · no table yet", file 18/18. Totals 2,396 passed (incl. the fixed one), 8 skipped |
| Mutation: order limit keyed by code only (not per device) | caught (1 failed), restored |
| `npm run typecheck`; `npm run lint` + ESLint on changed tests / e2e | exit 0; 0 warnings |
| `npm run build` | exit 0 (92 s) |
| Browser E2E on that build: `qr-transaction guests bill-print pos kitchen-integration floor-ops` | 29 passed |
| New browser E2E `e2e/common-qr.spec.ts` (manager issues, guest phone orders + pays with no table, cashier assigns) | passed |
| PostgreSQL 16 (disposable): 10 migrations on `a80caa9`'s schema | applied, `migrate diff` exit 0, `db-verify` OK; read-only audit skips the common-QR section before, classifies it after |
| SQLite: fresh `migrate deploy` + `migrate diff` | no drift |

Not run: full main E2E (134 specs), investor / acceptance E2E, PostgreSQL
Vitest, desktop build / package (the desktop migrator will apply the new
migration on upgrade; not exercised), CI (nothing pushed). No real phone,
printer or SBI.

### Risks and owner decisions

- Staff workflow changes: someone must assign tables (POS → Open orders → QR
  tables); kitchen sees "no table yet" until then. Train before rollout.
- Abuse limits are guards (20 orders / 10 min per device; 30 recent unpaid
  common-QR orders per outlet). Many IPs could fill the 30 — clutter, not
  kitchen tickets (payment is still required). Owner to accept or change.
- Online payment still depends on SBI UPI: until it is live, QR ordering of
  either kind is refused in Production builds of this release.
- **Owner decisions (separate):** adopt the common QR in the rollout plan;
  accept the limits; when to retire table codes (optional). Deployment,
  migration and printing need their own approvals.

## 12. One-pass completion (2026-10-22, uncommitted on `a26b788`)

Local only. Nothing committed, pushed or deployed; no Production or Preview
access; SBI UPI stays fail-closed.

### 12.1 Changes

| Change | Files | Evidence |
| --- | --- | --- |
| **Fixed:** a guest order refused inside its transaction (racing limit, sold-out, reused key) left a CRM customer record + audit row. The phone's customer is now found or created inside the order's transaction (per-phone advisory lock on PostgreSQL); request hash unchanged | `orders.ts` (`placeOrder` `customer`), `guestOrdering.ts` | Pre-fix: 4 customer rows for 1 placed order. 3 new tests in `tests/db/guest-checkout-concurrency.test.ts`; SQLite and PostgreSQL pass |
| **Policy made explicit:** staff seating a QR order past a table's guest limits (3 waiting / 6 unsettled) is refused once with the numbers (`409 TableGuestLimit`); "Assign anyway" sends `overrideGuestLimits`, recorded in the audit row with the staff member. Lock order matches guest orders (table row, then cap lock) | `orderOps.ts`, `guestOrdering.ts` (`tableQrLoad`), `QrTablesPanel.tsx` | 3 domain + 1 HTTP + 1 UI test; PostgreSQL 5/5 repeated runs, no deadlocks |
| **New:** RESTORA Demo Café SAMPLE dataset (own organization; 9 categories, 33 items, 35 ingredients, 15 recipes, 3 sample suppliers, 6 tables), opt-in CLI, idempotent, one transaction, scoped reset | `prisma/demo-cafe/`, `prisma/seed-demo-cafe.ts`, `package.json` script, `docs/demo-cafe-data.md` | `tests/db/demo-cafe-seed.test.ts` 9/9 SQLite and PostgreSQL; CLI guards run by hand |
| Docs: common-QR "serializable" claim corrected (READ COMMITTED + advisory lock); override and customer-record behaviour documented | `docs/common-qr-ordering.md`, `docs/owner-go-live-checklist.md` | — |

### 12.2 Verification run

- Typecheck exit 0 after the last source change. Lint: NOT RUN in this pass.
- Targeted SQLite: concurrency 15 (2 PG-only skipped), common-QR 29 (1 skipped), routes 10, UI 5, demo seed 9 — all pass.
- Targeted PostgreSQL 16.14 (disposable, 127.0.0.1:55470, stopped): the same 4 backend files 63/63; concurrency + common-QR 44/44 × 5.
- Migrations: no new migration. PostgreSQL migrations vs schema and deployed vs schema: no difference; SQLite migrations vs schema: no difference.
- **Full PostgreSQL suite: INCOMPLETE** — stopped by the host for low memory after ~50 files (no failure seen before then).
- **NOT RUN:** full SQLite suite, production build, full browser E2E, desktop build — all after the last source change, so earlier green results (135/135 E2E etc.) do not cover this tree.

### 12.3 Other findings

- `package-lock.json`: `http-cache-semantics` 4.2.0→4.3.0 is dev-only, transitive (electron-builder → got → cacheable-request `^4.0.0`), from a plain `npm install` on 2026-10-21; integrity matches the registry; no advisory involves it; not needed by any feature. Owner choice: keep, or revert lockfile + `npm ci` in a separate change.
- `npm audit --omit=dev`: 5 (build-time Prisma CLI `deepmerge-ts`, Next's bundled PostCSS); fixes need a Next major — unchanged.
- React #418: no new evidence; a dev-build delayed-HTML diagnostic was prepared (scratchpad) but not run. Still open, unexplained.
