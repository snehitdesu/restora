# System audit and gap register — 2026-10-13

_Completion, debugging, hardening and authentication pass. One authoritative
register for this pass; the long-lived feature register stays in
`docs/master-feature-audit.md`. "Verified" means an automated test or an
executed check named here passed in this pass._

Companion documents (requested names → where the content lives):
`security-audit` → `docs/security.md` §9; `performance-and-load-test` →
`docs/performance-and-load-test.md`; `database-recovery-and-migrations` →
`docs/database-recovery-and-migrations.md`; `test-coverage-matrix`,
`desktop-and-customer-e2e`, `ui-ux-quality-report`, `release-readiness` → §4–§8
below; production readiness / infrastructure → `docs/production-readiness.md`,
`docs/production-infrastructure.md` (updated).

## 1. Starting state (verified, not taken from earlier reports)

- Branch `main` at `a80caa9`; 31 modified + 5 untracked files before this pass (storefront, guest ordering, reset email, docs, e2e). All preserved; nothing was reverted, stashed, committed or pushed.
- The user's `next dev` on :3000 (one instance, PID 7992, `DATABASE_URL=file:./dev.db`) answered 200 on `/`, `/login`, `/api/health`. Left running and untouched throughout.
- `prisma/dev.db`: 15 of 22 migrations (now 23), integrity ok, byte-identical to `prisma/dev.db.pre-migrate-2026-10-12.bak`. Not modified.
- `CafeScene.tsx`: complete (543 lines, 4 layers sharing one viewBox), type-checks; earlier "interrupted" work is the finished state.

## 2. Defects found and fixed in this pass

| # | Sev | Defect (reproduced) | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| D1 | P1 | Guest checkout returned **HTTP 500 for orders already placed and sent to the kitchen**; their audit row and staff "New QR order" alert were lost (load test: 4 × 500; 241 orders vs 237 alerts) | audit + alert written in a second transaction after the order committed, outside the queued SQLite write path → lock wait timeout (P1008) | written inside the order's own transaction (`placeOrder` `afterCreate` hook) | `tests/db/guest-checkout-concurrency.test.ts` — failed on old code with `P1008` (2/5 runs), 6/6 after |
| D2 | P1 | SQLite lock waits (`P1008`, `P2028`, "database is locked") answered 500 | not classified as transient | 503 Busy + Retry-After (client retries idempotent requests) | `tests/db/conflict-classification.test.ts` (+9) |
| D3 | P1 | Staff back office: after "Create item" / "Save draft" (and row clicks) the record is saved but the screen stays put and freezes (E2E MENU-001 failed 4 of 5 runs before the fix; INV-001 / PROC-001 intermittently) — invites duplicate entries | framework-level Next 15 / React 19 transition that never commits (vercel/next.js#83386) | `useRouterWithWatchdog`: if the URL has not changed after 4 s, the browser loads the page itself; 23 call sites in 7 screens | `tests/ui/navigation-watchdog.test.tsx`; MENU-001 5/5, back-office ops 3/3, full E2E 90/90 twice |
| D4 | P1 | `/forgot-password` promised "a reset link will be sent" when **no email is configured** (every current deployment) | message independent of configuration | page and API say email reset is not set up and to ask a manager; same answer for every address | password-lifecycle route tests; E2E `PWD-005` |
| D5 | P2 | Reset request response time revealed whether an account exists (lookup + token + Resend call ran before answering) | synchronous delivery | lookup, link and email run after the response (`after()`) | "answers before the lookup and send finish" |
| D6 | P2 | A failed reset email retired **all** of the user's links, including a newer one issued concurrently | `retireUserTokens` on failure | retire only the undelivered link | password-reset-email "a failed send retires only its own link" |
| D7 | P2 | Sign-in left the browser's previous session alive server-side | cookie overwritten, session not revoked | `loginWithPassword(…, { replacesToken })` | `tests/auth/auth-matrix.test.ts` (4) |
| D8 | P2 | Sign-in / reset limits are per instance on Vercel (several instances) | in-memory store only | opt-in `RATE_LIMIT_STORE=database` (atomic SQL upsert, hashed keys, fallback) + migration `20261017100000_rate_limit_buckets` + Vercel warning | auth-matrix store tests on SQLite and PostgreSQL (40 concurrent hits counted exactly) |
| D9 | P2 | Checkout could show a total older than the server's (quote reused 30 s; checkout never re-quotes while open) and the order was placed at a different price without notice | browser total never compared | checkout sends the shown total as a guard; mismatch → 409 PriceChanged, nothing created, new total shown, re-quoted | storefront + HTTP + UI tests |
| D10 | P2 | Online order awaiting the guest's payment showed "Waiting for the restaurant to accept" | label ignored the open payment | "Waiting for your online payment" (server label + page caption) | storefront + UI tests |
| D11 | P3 | Unpaid-cash cap of 6 per table hard-coded (a developer choice, no documented rule) | constant | `GUEST_MAX_UNPAID_ORDERS_PER_TABLE` (1–50, default 6), validated at startup; **owner decision pending** | 11 tests |
| D12 | P3 | POS: cash QR orders already in the kitchen not marked as unpaid QR orders; no QR filter; dialog untested | — | "QR · unpaid" badge, "QR orders only" filter; "New QR order" badge still counts only unaccepted orders (correct) | `tests/ui/pos-open-orders.test.tsx` |

Not changed (checked): `GET /api/customers/:id` answers 200 + `null` for another organization's id (same as a missing id; no leak, low).

## 3. Gap register (this pass's requirements)

| Area | Status | Evidence / blocker |
|---|---|---|
| Staff sign-in, sign-out, sessions (opaque, hashed, idle + absolute expiry, revocation) | Implemented and verified | auth suites; matrix: 6 session states × 15 endpoints = 401 |
| RBAC server enforcement, outlet and organization isolation | Implemented and verified | 10 roles × 15 endpoints over real routes; cross-outlet / cross-org cases |
| Step-up re-authentication | Implemented and verified | `session-security.test.ts` |
| Password change / setup / reset (single-use, hashed, expiring, superseded) | Implemented and verified | password suites, `PWD-*` E2E |
| Password-reset **email delivery** | Blocked by external configuration | needs `RESEND_API_KEY`, `RESEND_FROM`, `PUBLIC_BASE_URL`; code tested against a stubbed Resend API only |
| Owner bootstrap CLI | Implemented and verified (SQLite) | `tests/auth/bootstrap.test.ts` |
| Shared rate limits for multi-instance hosting | Implemented, verified locally; production verification required | migration + `RATE_LIMIT_STORE=database` on the hosted demo need approval |
| Guest QR ordering (token, menu, cart, server pricing, checkout, tracking, access keys) | Implemented and verified | storefront / QR / guest-route suites; E2E; investor E2E |
| Cash order → kitchen at placement, unpaid until staff record cash | Implemented and verified | investor INV-002, storefront tests |
| Online payment (simulated / emulated Razorpay) incl. decline, duplicate confirm | Implemented and verified (emulator) | investor INV-001/003 |
| Real Razorpay test-mode run | Blocked by external configuration | needs `rzp_test_` keys (`docs/payments-razorpay.md`) |
| POS / KOT / KDS / chef transitions / tracking | Implemented and verified | E2E kitchen-integration, order-lifecycle; load test |
| Inventory / finance side effects of guest orders | Implemented and verified for the tested data; Coders' Cafe has no recipes, so no stock moves for its dishes | qr-transaction suite (stock), investor finance checks |
| Full-width Coders' Cafe storefront + scroll motion + reduced motion | Implemented and verified (rendered) | §6 |
| SQLite migrations on the original dev.db | **Requires approval** | plan in `docs/database-recovery-and-migrations.md` §5 |
| PostgreSQL schema + suite | Implemented and verified on local PG 16 | §4 |
| Hosted demo (Vercel + PostgreSQL) smoke / performance | Not verified | no URL or credentials in the repo; no traffic sent |
| Desktop app (Electron) | see §7 | |
| Installer install / upgrade / uninstall on a disposable Windows machine | Not verified | no disposable Windows environment (no Docker / VM); installing here would replace the user's installed app (same app id) |
| Code signing, auto-update | Not implemented / external | certificate required |
| WhatsApp / SMS / Sheets / accounting providers | Implemented against mocks / emulators; production verification required | provider credentials |
| Multi-outlet central operations | Intentionally deferred | product decision |
| Offline / cloud sync | Not implemented (desktop is local-only, single terminal) | architecture |

## 4. Test execution (2026-10-13)

All runs on the final code unless marked. "Executions" = test cases as the runner counts them (an `it.each` row is one execution).

| Runner | Environment | Result |
|---|---|---|
| Vitest (unit / domain / API / UI / DB) | SQLite, isolated work copy, final code | **118 files, 1,586 passed, 6 skipped, 0 failed** (skips: PostgreSQL-only decimal checks) |
| Vitest, same suite | PostgreSQL 16.14, fresh local database, final code | **115 files passed + 3 skipped, 1,564 passed, 28 skipped, 0 failed** (skips: SQLite-file-only desktop backup / migrator / upgrade suites and the bootstrap CLI). All 13 PostgreSQL migrations applied in order. |
| Earlier full runs this pass (before D1–D3) | SQLite / PostgreSQL | 1,571 passed + 6 skipped / 1,549 passed + 28 skipped, 0 failed |
| Browser E2E (Playwright, `next build` + `next start`, isolated e2e.db) | 90 tests | pass 1 (before D3): 87 passed, 2 failed (MENU-001, INV-001 — navigation freeze), 1 did not run (serial dependency); reruns before the fix: PROC-001 / MENU-001 failed again (MENU-001 4 of 5 runs). After D3: MENU-001 5/5, back-office ops spec 3/3 repeats; **full pass 90/90**; final build (D1–D3): **90/90 on the first attempt** |
| Investor acceptance E2E (Coders' Cafe, T07, Razorpay emulator + cash) | 3 tests | **3/3**, twice (second on the final build) |
| Desktop E2E (Electron, real unpacked build, isolated data dir) | 9 tests | first run 8/9: STARTER-002 still drove the storefront that the earlier (uncommitted) redesign replaced (cart dialog, manual "Send to kitchen"); spec updated to the current flow (cart page → checkout → cash straight to the kitchen; POS lists it as "QR · unpaid") → **9/9**, then a clean full run **9/9** |
| Packaged app verifier (`desktop/scripts/verify-package.ts`, fused Aharos.exe) | 23 checks | **23/23** |
| Load scenarios | disposable SQLite + production build | see `docs/performance-and-load-test.md`; after the fixes 0 server errors, 0 lost or duplicated orders |
| Rendered visual QA | 4 viewports × 2 motion settings | §6 |
| `tsc --noEmit` · `next lint` · `next build` · desktop payload build · electron-builder | repo / work copy | clean · clean · success · success (secret scan clean) · success |
| `npm audit --omit=dev` | registry | 6 advisories in build / CLI tooling (security doc §9) |

Authentication-related executions in the final SQLite run: 445 (`tests/auth/*` 426 — of which the role × endpoint × tenant × session-state matrix is 330 — plus API security / same-origin / middleware 19), all passed, and the same files passed on PostgreSQL. Guest QR security (routes, storefront, QR transaction): 59. Browser E2E covering auth: login, session, RBAC, re-auth, password lifecycle, security headers specs within the 90.

New or changed tests in this pass: `tests/auth/auth-matrix.test.ts` (new, 330), `tests/db/guest-checkout-concurrency.test.ts` (new), `tests/ui/navigation-watchdog.test.tsx` (new), `tests/ui/pos-open-orders.test.tsx` (new), additions to password-lifecycle, password-reset-email, guest-storefront, guest-routes, guest UI, conflict-classification; E2E `PWD-005` and desktop `STARTER-002` updated to current behaviour (no assertion was removed to make a test pass: PWD-005 now asserts the honest notice and identical API answers; STARTER-002 still asserts exactly one order / KOT / payment / invoice / finance row).

## 5. Customer → kitchen → tracking (one product)

Verified end to end in a browser against production builds: QR token → menu → cart → server quote → checkout (cash and simulated online) → POS visibility → KOT → KDS accept / prepare / ready / served → guest tracker → payment by staff → receipt → finance (E2E `qr-transaction`, `kitchen-integration`, `storefront`; investor INV-001…003 on the real Coders' Cafe menu and Table T07). Duplicate taps, refresh after submit, lost responses (replays), decline then success, duplicate confirmations, tampered and foreign tokens, and another order's key are covered by the storefront / QR / guest-route suites and the load test (§ performance doc).

## 6. UI / UX (rendered)

Production build, real Coders' Cafe data (migrated copy of dev.db), Table T01, Chromium:

| Viewport | Result |
|---|---|
| 1440×900 | full-bleed café scene (awning, sign band, board with "Good food. Good coffee. Good code.", pendant lamps, counter, booths, plants, terrazzo), headline card with working "Order now" / "View menu", table chip; scroll reveals the menu |
| 1280×720 | same composition, nothing clipped that matters |
| 768×1024 | scene full width on top, headline and actions below |
| 390×844 | same stacked layout; view switcher fits |

All: HTTP 200, ≈ 1 s load, no horizontal page overflow (scrollWidth = viewport), 0 console errors; with `prefers-reduced-motion: reduce` no reveal content stays hidden. Screenshots: session scratchpad `visual/`. Staff screens: unchanged except the POS open-orders badge / filter and the forgot-password notice (consistent with the existing auth shell).

## 7. Desktop

Electron (confirmed: `desktop/main`, electron 44, electron-builder 26). The desktop app runs the same Next.js server and the same authentication / RBAC / session code on 127.0.0.1, with SQLite in the user's data folder.

- Security boundaries (code reviewed, and asserted by the desktop E2E): every renderer sandboxed with context isolation and no Node; the preload exposes four narrow calls; every IPC handler checks the sender frame's origin; navigation, new windows and permission requests are denied; requests outside the loopback origin are blocked; packaged builds refuse debug switches; single-instance lock.
- E2E 9/9 and verifier 23/23 (above): first-run wizard and owner bootstrap, sign-in, POS → KOT → KDS → payment, RBAC through the shell, logout ending the session, restart with data and automatic verified backup, owner-only restore, CSP with zero violations, upgrade from the previous release with a pre-migration backup (old owner still signs in, rows unchanged).
- Built: `RESTORA-Setup-1.0.0-rc.1.exe` (137 MB, NSIS, per-user) and a portable exe, **in the session scratchpad only** (not published, not copied into the repository, not installed). Authenticode: **NotSigned**.
- Not verified: installing / upgrading / uninstalling with the NSIS installer on a disposable Windows machine (none available; installing here would replace the user's installed RESTORA, which shares the app id); high-DPI and window-management checks beyond the automated window tests; printers and cash drawers (no hardware); offline behaviour beyond "the local app needs no network" (there is no cloud sync to test).

## 8. Release readiness

Verdict for this pass: **PARTIALLY VERIFIED — SPECIFIC BLOCKERS REMAIN.**

Approval-gated (prepared, not executed): migrating the original `prisma/dev.db` (plan and recovery in `docs/database-recovery-and-migrations.md` §5); applying `20261017100000_rate_limit_buckets` to the hosted demo database and setting `RATE_LIMIT_STORE=database` there; publishing the installer.

External blockers: Razorpay test-mode keys (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`); Resend (`RESEND_API_KEY`, `RESEND_FROM`, `PUBLIC_BASE_URL`); the hosted demo URL for read-only smoke and timing; a disposable Windows machine for installer tests; a code-signing certificate; messaging / Sheets / accounting provider credentials.

Owner decisions: the unpaid-cash cap per table (default 6, now `GUEST_MAX_UNPAID_ORDERS_PER_TABLE`).

Known residual risks: framework-level navigation freeze is mitigated (watchdog), not fixed upstream; `script-src 'unsafe-inline'`; no MFA; no PostgreSQL RLS; build-tooling advisories; SQLite write throughput (≈ 21 orders/s here) is a single-writer limit — far above one café's needs; the PostgreSQL path measured ≈ 63 orders/s on the same laptop with 0 errors and no lost or duplicated orders (`docs/performance-and-load-test.md` §5).
