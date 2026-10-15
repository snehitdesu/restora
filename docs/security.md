# RESTORA security

_Phase 13 (2026-10-05). Describes the controls that exist in the code and how
each is verified. "Verified" = an automated test or an executed check named
here; nothing is claimed from intent alone._

## 1. Threat model (summary)
Assets: orders and payments, GST invoice data, stock and costing, staff
accounts, customer contact data, integration secrets (gateway / messaging /
webhook keys). Actors: anonymous Internet users (sign-in page, QR links,
webhooks), guests holding a table QR, staff with a role at one outlet,
org-wide roles, a malicious or compromised staff device, a forged provider
webhook, an operator with database access.

## 2. Authentication
| Control | Detail | Verified by |
|---|---|---|
| Passwords | bcrypt (cost 10); policy ≥ 10 chars, letter + digit/symbol, ≤ 72 bytes (no silent bcrypt truncation), common / email / name refused | `tests/auth/password-lifecycle.test.ts`, `PWD-*` E2E |
| Sessions | opaque random token in an `httpOnly`, `SameSite=Lax`, `Secure` (production) cookie; only its SHA-256 is stored; 7-day absolute, 15-min idle (configurable); revoked on sign-out, password change (other sessions), deactivation | `tests/auth/session-security.test.ts`, `SESSION-001/002`, `ADMIN-001` |
| Sign-in throttling | per email (10 / 15 min) and per client IP (50 / min); client IP from the right of `X-Forwarded-For` by `TRUSTED_PROXY_HOPS` (not spoofable from the left). `RATE_LIMIT_STORE=database` counts every limit in the shared `RateLimitWindow` table for multi-instance hosting (one atomic upsert per hit, keys `policy:sha256(subject)`, per-process fallback on a database error) | rate-limit tests, `SESSION-003`, `tests/api/rate-limit-store.test.ts` (concurrent hits counted exactly; window reset; sweep; fallback), `tests/auth/auth-matrix.test.ts` (no raw email or IP stored) |
| Enumeration | identical error and timing (dummy bcrypt) for unknown accounts; forgot-password answers the same for known / unknown emails, and does the lookup, link and email **after** the response (`runAfterResponse` → Next `after()`), so response time does not depend on the account or on the mail provider | `SESSION-003`, `PWD-005`, password-lifecycle "answers before the lookup and send finish" |
| Step-up re-authentication | owner / settings / refunds / voids / restore require a fresh password confirmation (short-lived grant, never adds a privilege) | `REAUTH-*`, `tests/auth/reauth-client.test.ts` |
| Account provisioning | first owner only on an empty database (`bootstrap:owner`); staff get single-use setup links (72 h); reset links 1 h; links hashed at rest | `PWD-001…004` |
| Open redirect | post-login destination restricted to same-site paths | `SESSION-004` |
| Password-reset delivery | Resend only when `RESEND_API_KEY` + `RESEND_FROM` + `PUBLIC_BASE_URL` are all set; a link counts as delivered only when Resend returns an email id; a failed send retires only its own link. Without email the page says so ("not set up … ask your manager") instead of promising a link | `tests/auth/password-reset-email.test.ts`, `PWD-005` |
| Session replacement | signing in ends the session cookie the browser already held (same or another account), not just overwrites it | `tests/auth/auth-matrix.test.ts` |

## 3. Authorization and tenant isolation
- Role-based permissions (`src/server/auth/rbac.ts`) per outlet and org-wide; every service checks `assertCan` + outlet access server-side (the UI is never the only guard).
- Organization isolation on every read (scoped queries) and write (`assertOutletInOrg` for client-supplied outlet ids).
- Verified: `tests/auth/auth-matrix.test.ts` (2026-10-13): 10 roles × 15 protected endpoints over the real route handlers (allowed exactly when the role holds the endpoint's permission, else 403), outlet-scoped roles refused at a sister outlet, another organization's owner refused (404) or shown nothing, and six session states (none / forged / revoked / expired / idle / deactivated user) refused with 401 on every endpoint; a role removed mid-session is gone on the next request. Also `RBAC-001…004`, `MOB-003`, `INT-003`, route tests (`tests/api/*`), cross-org / cross-outlet tests in every domain suite, the Phase 12 day simulation (kitchen / captain cannot take payments, cashier cannot refund / cancel, outlet manager cannot move stock to another outlet).
- Not implemented: PostgreSQL Row-Level Security (defence in depth; plan in `docs/postgres-rls.md`). Required before hosting a second, untrusted organization in the same database.

## 4. Web application
- CSRF: `SameSite=Lax` cookie + Origin check on every state-changing route (incl. sign-in / sign-out).
- Security headers on every response: CSP (`default-src 'self'`; `script-src` still needs `'unsafe-inline'` for Next.js hydration — nonce CSP deferred), HSTS (production), `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, `Permissions-Policy`; API `Cache-Control: no-store`. Verified `SEC-HDR-001/002` (zero CSP violations on the main screens).
- Input validation with Zod at every service boundary; body size caps; numeric overflow → 422.
- Errors: no stack traces or internals in responses (500 = generic message + request id).
- Forms that handle passwords read their fields when submitted, so text typed before the page finished loading is never lost; the sign-in form stays actionable and the forgot / change-password buttons wait only until the page is interactive (never until something is typed, and an empty form is explained). They post with `method="post"`, so an early submit never puts anything in the address bar (`LOGIN-002b`, `PWD-007`).
- Guest bill splits: the request body is only the number of people (a strict schema refuses an amount or any other field); the share is computed on the server from the balance at that moment, every phone gets its own payment, and the payment is verified with the gateway like any other (`tests/domain/guest-split-reorder.test.ts`).
- Idempotency keys on every money / stock creation (orders, rounds, payments, refunds, vendor payments, GRNs, transfers, wastage, expenses, drawer movements) — retries never double-charge or double-post.

## 5. Integrations and webhooks
- Webhooks: raw-body HMAC (timing-safe), tenant binding by provider account id → `IntegrationConnection` (never by a body field), per-tenant secrets AES-256-GCM encrypted (`INTEGRATION_SECRETS_KEY`), event-id dedupe, amount re-verification, rate limit. Verified: `tests/domain/webhook-tenant.test.ts`, `INT-002` (forged webhook refused).
- Mock providers refused in production unless explicitly allowed (warned at every boot); development placeholder secrets refused. Covers every provider factory: payment, POS, aggregator (closed 2026-10-08), notification, messaging, Google Sheets, and the webhook entry point (`tests/integrations/production-providers.test.ts`).
- Outbound HTTP: deadlines, bounded retries, secret-free error messages.

## 6. Data protection
- Logs: structured JSON; credential keys redacted, secrets in free text scrubbed, email / phone masked (`tests/ops/infrastructure.test.ts`; `verify-runtime.mjs` "no secret material in server logs").
- Backups: AES-256-GCM encrypted with a key kept apart from the backups; checksum + authenticated decryption on restore (`backup-drill.mjs`).
- Database roles: the app role cannot alter schema and cannot UPDATE / DELETE / TRUNCATE `AuditLog` or `InventoryLedger` (`scripts/ops/pg-roles.sql`, verified in the drill).
- **History the database itself refuses to rewrite** (2026-10-09): triggers on `AuditLog` and `InventoryLedger` abort every UPDATE and DELETE (and TRUNCATE on PostgreSQL) whoever sends it, including the schema owner; they survive backup and restore; the readiness check reports missing triggers (`src/server/db/appendOnly.ts`, `tests/db/append-only.test.ts` on both engines, backup drill 10/10 afterwards). Only a disposable-database wipe lifts them, and nothing in the running application does.
- Exports: re-authorized at download, owner-bound, expire after `EXPORT_RETENTION_HOURS`.
- Desktop: DPAPI-protected install secret, loopback-only server, renderer sandbox / context isolation / no Node, navigation locked, Electron fuses (no RunAsNode, no NODE_OPTIONS, no inspector), asar integrity — `desktop:verify` 23/23.

## 7. Supply chain and secrets
- `npm ci` from the committed lockfile; `npm audit --omit=dev` reviewed each release. **2026-10-09: 6 advisories (5 high, 1 moderate), all in build / CLI tooling and none loaded by the running server:** PostCSS (XSS in stringified CSS, `sourceMappingURL` file reads) and its `source-map-js` (event-loop DoS on crafted source maps) inside Next's build pipeline, which only ever processes this repository's own CSS; `deepmerge-ts` (stack exhaustion on recursive objects) inside the Prisma CLI / `@prisma/config`, run by operators on trusted schema files. The fixes are major upgrades (Next, Prisma) or `npm audit fix --force`, which were deliberately not applied at release time; re-check at the next Next / Prisma upgrade. Dev-only advisories (test runner tooling) are not shipped.
- Secret scan of the tree each release (patterns for cloud keys, private keys, live gateway keys, tokens, passwords in URLs); `.env`, databases and backup dumps are git-ignored; the desktop build scans its payload for secrets.
- No secrets in the repository; production values only via environment / secrets manager.

## 8. Known gaps (tracked)
| Gap | Risk | Plan |
|---|---|---|
| No RLS | a code-level tenant bug could cross organizations | single-organization deployments for V1; RLS before multi-tenant hosting |
| `script-src 'unsafe-inline'` | weaker XSS containment | nonce-based CSP |
| No MFA | stolen password = account | TOTP for owner / manager (post-V1) |
| Rate limits per process by default | with `RATE_LIMIT_STORE=database` the counters are shared by every instance (`RateLimitWindow`, one atomic upsert per limited request; keys are `policy:sha256(subject)`, so no email or IP is stored; a database failure falls back to per-process counting and is logged) | choose `database` when running more than one instance; startup warns on PostgreSQL without it |
| Unsigned Windows installer | SmartScreen warnings; no publisher identity | code-signing certificate (external) |
| No customer data erasure workflow | privacy requests handled manually | `docs/data-retention.md` |

## 9. Audit 2026-10-13 (authentication completion pass)

Fixed: forgot-password timing side channel and false "a link will be sent" promise when no email is configured; failed reset send retiring a concurrently issued newer link; previous browser session left alive at sign-in; per-instance-only sign-in limits on Vercel (shared store added, opt-in).
Checked, no defect: opaque hashed sessions; idle and absolute expiry; revocation on logout / password change / reset / deactivation; RBAC rebuilt from the database on every request (no stale roles); step-up re-authentication; Origin checks; body caps; guest QR tokens (unguessable, one message for unknown / disabled / foreign); guest order access keys (HMAC, in the URL fragment, never sent to the server in the URL); desktop shell (sandbox, context isolation, IPC sender checks, navigation and permission denial, debug switches refused, single instance).
Low, documented: `GET /api/customers/:id` answers 200 with `data: null` for another organization's (or a missing) id instead of 404; no data or existence oracle.
Dependencies (`npm audit --omit=dev`, 2026-10-13): 6 advisories (5 high, 1 moderate), all in build / CLI tooling (Next's bundled PostCSS, source-map-js, the Prisma CLI's deepmerge-ts), not reachable from requests at runtime. Dev-only: 2 critical in vitest / tinypool (test runner, never shipped).
