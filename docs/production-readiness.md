# Production readiness — Aharos

_Audit of 2026-10-01 (production verification & hardening pass). Every "verified"
item below was executed, not inferred; see PROJECT_STATUS.md for exact results._

## Status update — Phases 9–10 (2026-10-05)

Supersedes the per-item status below where they differ:
- **M7 database roles:** `scripts/ops/pg-roles.sql` creates `restora_owner` / `restora_app` (DML only, append-only `AuditLog` + `InventoryLedger` enforced, session timeouts) / `restora_backup`; verified in the DR drill. Applying it per deployment remains an operator step.
- **M8 backups:** encrypted, verified backups (`pg-backup.mjs`), guarded restore (`pg-restore.mjs`), backup→destroy→restore drill **11/11** and PITR drill **7/7** executed; RPO/RTO, schedule and procedure in `docs/production-infrastructure.md` §8. Scheduling the job and WAL archiving / managed PITR remain operator steps.
- **M11 health:** `/api/health/live`, `/api/health/ready` (DB + migrations), metrics, graceful shutdown — verified (`verify-runtime.mjs` 18/18).
- **Observability** ("can be added after"): structured redacting JSON logs with request ids, metrics, alert webhook — done (Phase 9).
- **M4 (HTTPS), M5 (proxy hops), M6 (one instance), M9 (secrets/providers), M10 (EXPORT_DIR)** remain per-deployment configuration, enforced or warned by startup validation; see `docs/release-checklist.md`.

## Status update — Groups 6-9 (2026-10-09)

Supersedes the per-item status below where they differ:
- **M6 rate limits across instances:** `RATE_LIMIT_STORE=database` shares the counters between instances (one atomic upsert per limited request; a database error falls back to per-process counting and is logged). Measured: no difference from the in-memory store at the load test's scale (`docs/production-infrastructure.md` §7.1). Exports are still written to local disk (one instance, or an `EXPORT_DIR` on shared storage).
- **M7 append-only history:** `AuditLog` and `InventoryLedger` are now refused by the database itself (triggers on both engines, TRUNCATE too on PostgreSQL) in addition to the role grants; they survive backup / restore (drill 10/10 on the current schema, §8.0).
- **Load:** the end-to-end HTTP load test was re-run on the current build against PostgreSQL 16: no correctness violation (no overpaid or doubly paid order, no duplicate order per key, outbox drained), 0 deadlocks; the only non-200 outcome is the documented `503 Busy` on contended goods-receipt posting.
- **Browser E2E is a CI release gate** on both SQLite and PostgreSQL (it was a manual gate); desktop build, E2E, packaged-app verification and DMG run on Windows and both macOS architectures.
- **Accessibility / responsive:** every screen is scanned with axe (WCAG 2.1 A and AA) at a phone and a desktop width and opened at ten viewports (320-1920 px, plus a phone held sideways); serious or critical findings fail the suite.
- Still external, unchanged: hosting and HTTPS, scheduled backups / WAL archiving on real infrastructure, provider credentials and live runs (Razorpay `rzp_test_` / live, Petpooja, WhatsApp / SMS, Resend, Tally, Zoho, Google Sheets, Zomato / Swiggy), code-signing certificates, a hosted PostgreSQL instance, PostgreSQL row-level security before a second untrusted organization shares a database.

## Status update — completion and authentication pass (2026-10-13, reconciled with Groups 6-9)

See `docs/system-audit.md` (defects D1–D12, gap register, test counts). In short: guest checkout no longer answers 500 for placed orders under load and never loses the staff alert (D1); SQLite lock waits are 503 Busy (D2); the back-office "saved but nothing happened" freeze has a navigation watchdog (D3); forgot-password is honest when no email is configured and no longer leaks account existence through timing (D4, D5); sign-in ends the browser's previous session (D7); shared rate limits are available for multi-instance hosting (D8); checkout refuses a stale shown total (D9). Still external or approval-gated: migrating the original `prisma/dev.db` (plan ready), real Razorpay test-mode keys, Resend credentials, the hosted demo (no URL), installer testing on a disposable Windows machine, code signing.

## Status update — recovery, finance and sync audit (2026-10-19)

- **Owner recovery** (verified email + offline recovery codes + a second owner): see `docs/security.md` §2. A sole owner sees a dashboard notice until recovery is set up.
- **Fixed, with regression tests:**
  - A linked desktop could not take payment for a cloud order: the hosted edge middleware answered 401 to its `Authorization: Bearer` device token (no cookie) on `/api/payments`. The middleware now lets a Bearer header through; the router validates the device token as before (`tests/api/middleware-matcher.test.ts`, `tests/sync/cloud-sync-api.test.ts`).
  - Settlement counted only SUCCESS payments, the balance rule SUCCESS + PARTIAL: a split bill with a partly refunded part could never become PAID (`tests/domain/payment-balance.test.ts`).
  - A per-line discount (`PATCH /api/orders/items/:id`) needed only `order.modify` (a captain could discount), was not audited and was not capped (`tests/domain/order-ops.test.ts` T6).
  - Guest QR order: 2 fewer database round trips for one line, 4 fewer per extra line (32 → 30 operations; +9 → +5 per line), held by `tests/perf/guest-order-statements.test.ts`.
- **Guest order latency on the hosted Preview:** 22.9 s for one line (measured 2026-10-19), about 0.47 s per statement because the functions run in `iad1` and the database is in Singapore (`ap-southeast-1`); a one-line order is ~47 SQL statements after this change. Reducing statements further gives seconds; co-locating the functions with the database (`sin1`) would remove most of the ~0.4 s per statement. **Not changed:** the region setting also applies to Production — owner approval needed.
- **Verified on the hosted Preview (commit 4fb126f, isolated Neon test branch, 2026-10-19):**
  - Owner recovery in a real browser (Playwright, 19/20 checks; the 20th was a stale status line after saving codes, fixed in 4076953): signed-out pages redirect; forgot-password states that email reset is not available; an unknown email with a guessed code gets the uniform 422; a bogus verification link is refused and the token leaves the address bar; codes are generated only after the password, shown once (10, no-store), redeemed with lower-case and spaces, single use; the old session is revoked, the old password fails and the new one works.
  - One labelled demo QR order (cash, 1 line): 19.2 s end to end (server 18.3 s); a replay of the same key returned the same order in 3.8 s; one order, one KOT, one staff alert.
  - Cloud Sync with the installed desktop (isolated data folder) through a pairing code from the hosted owner: LINKED; the demo order arrived once in the desktop POS and KDS (same items, total, tax); a reused pairing code was refused; a cash payment taken on the desktop reached the cloud with the device token alone (the middleware fix) and settled the hosted order once (one payment, one invoice); a KDS change made during a cloud outage was queued, survived a desktop restart and was applied once after reconnection (sent twice in a race, one receipt); revoking the device from the cloud put the desktop in AUTH_REQUIRED.
  - Found there and fixed in 5e1758c (desktop rebuild needed): the desktop's 15 s cloud timeout fired before a ~15 s cloud settlement and told the cashier "temporarily unavailable" for a paid bill; writes now wait 45 s.
  - Not verifiable here: real email delivery (no `RESEND_API_KEY` / `RESEND_FROM` / `PUBLIC_BASE_URL` on the Preview, no controlled mailbox).
- **Decided (2026-10-19) — kitchen display idle exemption kept, and narrowed:** a kitchen screen must stay visible during service, so the KDS ticket poll (`GET /api/kitchen/kots`) keeps the session alive — but only for a kitchen-only account (every role `KITCHEN`), decided server-side. A manager, owner, cashier or mixed-role account watching the KDS gets no exemption (previously any account's KDS poll counted as activity), and the campaign detail page's 8 s refresh is now background polling too. Details and tests: `docs/security.md` → *Kitchen display idle exemption*. Deployment note: sign kitchen screens in with a dedicated KITCHEN-only account.

## Verdict

**Ready for a controlled production deployment once the MUST items below are done.**
The application itself (auth, RBAC, tenant/outlet isolation, workflows, POS/KDS,
back office) passed 448 unit/integration tests and 49 real-browser E2E workflows
on both SQLite and PostgreSQL 16. The remaining blockers are provisioning,
database-cutover and infrastructure tasks, not application defects — except the
missing account-provisioning flow (M1), which is a product gap.

"Controlled" means: one application instance, one organization (or a few trusted
ones), HTTPS in front, PostgreSQL with backups, operators who can read logs.

## Phase 5B — security & architecture hardening (2026-10-01)

Small production-security gaps from the audit, now closed at the application layer
(no database change; still SQLite in dev, still no RLS):

- **Organization isolation on writes.** `assertOutletAccess` is a no-op for org-wide
  / super-admin callers, so every write that accepts a client-supplied `outletId`
  now also verifies the outlet exists and belongs to the caller's organization via
  a shared `assertOutletInOrg` guard (orders, inventory ledger, procurement
  indents/POs/GRNs, expenses, petty cash, cash drawer, feedback, reservations).
  Modules that already did this check (menu, staff, master-data floors/tables,
  business-day-backed finance) were left unchanged.
- **Notification provider safety.** The mock notification provider (reports every
  send as delivered) is now refused in production unless `ALLOW_MOCK_PROVIDERS=true`,
  and an unknown provider name fails loudly — matching the payment/POS factories.
  In-app notifications are unaffected (they never use a provider).
- **Export download authorization.** Downloading/polling a stored export now
  re-checks the report's own permission (e.g. `finance.view`) in addition to
  ownership and `export.run`, so access revoked after creation blocks the download.
- **Production environment validation.** A startup check (Next.js instrumentation)
  fails fast when required production config is missing or unsafe: `DATABASE_URL`
  present, `AUTH_SECRET` present / not the dev placeholder / ≥32 chars, rate limiting
  not disabled, valid `SESSION_TTL_SECONDS`. It is a no-op outside production and
  never prints secret values.

## MUST FIX before the first production deploy

| # | Item | Why | Status |
|---|------|-----|--------|
| M1 | **Account provisioning.** New staff got an unusable placeholder password with no invite / set-password / reset flow, so nobody could sign in to a fresh production database. | Nobody can sign in to a fresh production database. | ✅ done (Phase 5A): `npm run bootstrap:owner` creates the first organization, outlet and OWNER on an **empty** database only (config via `BOOTSTRAP_*` env, password via `--password-stdin` or a hidden prompt); new staff get a one-time setup link (Team → Add staff), managers can issue a fresh link (Team → Password link); `/account/password` changes a password and signs out other sessions. Password-reset email is sent through Resend when `RESEND_API_KEY`, `RESEND_FROM` and `PUBLIC_BASE_URL` are set (`setPasswordLinkDelivery`). Otherwise `/forgot-password` records the request and sends nothing; a manager issues the link. There is still no SMS delivery. |
| M2 | **Upgrade Next.js** (15.1.4 had a critical RCE in the React flight protocol, a middleware authorization bypass, Windows/Image-optimizer RCEs, SSRF, cache poisoning). | Remote code execution. | ✅ done: next 15.5.27, react/react-dom 19.0.8 (lockfile updated). **Run `npm ci` after stopping the dev server** — local node_modules still has 15.1.4. |
| M3 | **Switch the schema to PostgreSQL and commit a PostgreSQL migration history.** `prisma/schema.prisma` is SQLite; the PostgreSQL schema and `baseline.sql` live in `/prisma/postgres/`, which is **git-ignored**. | Production migrations must be version-controlled and replayable. | ✅ H5: PostgreSQL history committed in `prisma/postgres/migrations` (baseline `20261004130000_baseline`, explicit `@db.Decimal` precision); `npm run db:pg:deploy` = `migrate deploy`; verified on fresh PostgreSQL 16 databases (deploy, no drift, full suite). H6: the CI `postgres` job runs deploy → status → drift (shadow) → full suite; configured and actionlint-clean, **not yet executed on GitHub**. |
| M4 | **HTTPS termination** (reverse proxy / load balancer). | The session cookie is `Secure` in production: over plain HTTP the browser drops it and **login silently fails**. HSTS is sent. | infra |
| M5 | **Set `TRUSTED_PROXY_HOPS`** to the number of proxies in front of the app (default 1). | Client IP for login rate limits and audit entries. | code ✅ (was trusting the client-controlled left side of X-Forwarded-For) — config per deployment |
| M6 | **Run ONE app instance, or set `RATE_LIMIT_STORE=database`.** | Export files are on local disk and break downloads across instances; rate limits are per process unless the shared store is selected. | shared rate-limit store ✅ (`RateLimitWindow`, `tests/api/rate-limit-store.test.ts`; keys hashed, `tests/auth/auth-matrix.test.ts`); exports stay single-instance |
| M7 | **Database roles:** the app connects as a non-superuser, non-owner role with DML grants only; migrations run as a separate owner role. `REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog", "InventoryLedger" FROM <app role>` (verified: the app never updates or deletes these rows). | Least privilege; append-only audit/ledger enforced by the database. | infra/SQL (no RLS plumbing needed) |
| M8 | **Backups:** automated PostgreSQL backups with point-in-time recovery, and one restore rehearsal. | Orders, payments and stock are the business record. | infra |
| M9 | **Secrets & providers:** real `PAYMENT_WEBHOOK_SECRET` / `PETPOOJA_WEBHOOK_SECRET` / `AGGREGATOR_WEBHOOK_SECRET` (long random); `PAYMENT_PROVIDER` / `POS_PROVIDER` set to real providers or left mock **only** if card/UPI gateway flows are not used. Mock providers are now refused in production by every factory unless `ALLOW_MOCK_PROVIDERS=true`. Do **not** set `ALLOW_DEMO_SEED` or `ALLOW_MOCK_PROVIDERS` in production. | Mock gateways approve anything. | code ✅ — config per deployment |
| M10 | **`EXPORT_DIR`** on a persistent, private volume (default is the OS temp dir). | Background exports vanish on restart / temp cleanup. | config |
| M11 | **Health check wiring:** point the load balancer / orchestrator at `GET /api/health` (200 = app + DB up, 503 = DB down; unauthenticated, no details). | Restart / route around a dead instance. | code ✅ (endpoint added) — infra wiring |

## CAN BE ADDED AFTER the initial deployment

| Item | Notes |
|------|-------|
| Row-Level Security (docs/postgres-rls.md) | Defense in depth. **Required before hosting a second, untrusted organization in the same database**; not required for a single-organization deployment where application-layer isolation (tested) applies. |
| Shared rate-limit store (Redis) + object storage for exports | Prerequisite for >1 instance. |
| Validation-before-authorization ordering | Services Zod-parse input before `assertCan`, so an unauthorized caller with a malformed body gets 422 (schema details) instead of 403. No data read or written. Low. |
| Session rotation | Sessions are 7-day absolute (`SESSION_TTL_SECONDS`), revoked on logout and deactivation (a new sign-in also revokes that browser's previous session), and revoked server-side after 15 minutes without meaningful activity (`SESSION_IDLE_TIMEOUT_SECONDS`; background polling does not extend it, except the kitchen display's ticket poll for kitchen-only accounts — see `docs/security.md` *Kitchen display idle exemption*; `src/server/auth/session.ts`). The token itself is not rotated during a session. |
| Script CSP with nonces | CSP restricts all sources to same-origin (see `docs/exports.md`), but `script-src` still allows `'unsafe-inline'` for Next.js hydration. |
| Structured logging + request ids, error monitoring (Sentry or similar), uptime alerts | Today: `console.error` for 5xx only. The mock notifier logs recipients (PII) to stdout **in dev/test only** (it is refused in production unless explicitly opted in). Prisma logs handled unique-constraint conflicts as errors (noise). |
| `npm audit` leftovers | `postcss` (Next's pinned build-time copy; needs attacker-controlled CSS at build time) and `deepmerge-ts` via the Prisma CLI (deploy-time). Not reachable at runtime; revisit on the next Next/Prisma upgrade. |
| `next lint` → ESLint CLI | Deprecated in Next 16. |
| Unit conversions are one-directional | Costing looks up `from → base` only; the seed defines `kg→g`, so a recipe line in grams for a kg material is rejected (with raw ids in the message). Add inverse lookup or define both directions. |
| Dockerfile / `output: "standalone"` | Not added: depends on the chosen host. |

## Exact deployment prerequisites

1. Stop the dev server, `npm ci` (installs next 15.5.27), `npm run typecheck && npm test && npm run build`.
2. Resolve **M1** (provisioning) — otherwise no one can sign in.
3. PostgreSQL 16 (managed or self-hosted) with backups/PITR (**M8**); create an owner role (migrations) and an app role (DML only, **M7**).
4. Switch the provider to PostgreSQL and commit the baseline migration (**M3**); deploy with `prisma migrate deploy` as the owner role. **Never run `prisma/seed.ts`, `prisma migrate reset` or `db push --force-reset` against production** (the seed now refuses; the others do not).
5. Environment: `NODE_ENV=production`, `DATABASE_URL` (app role), a real `AUTH_SECRET` (≥32 chars, not the dev placeholder — startup validation refuses to boot otherwise), real webhook secrets and providers (**M9**), `TRUSTED_PROXY_HOPS` (**M5**), `EXPORT_DIR` on a persistent volume (**M10**), `SESSION_TTL_SECONDS` as desired. Leave `ALLOW_MOCK_PROVIDERS` and `ALLOW_DEMO_SEED` unset, and `RATE_LIMIT_DISABLED` unset/false. Startup fails fast if any required value is missing or unsafe.
6. One instance (**M6**) behind HTTPS (**M4**); health check on `/api/health` (**M11**).
7. Smoke test after deploy: sign in, open POS / KDS / dashboard, place and pay one order, check the audit log.
