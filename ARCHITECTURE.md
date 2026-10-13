# RESTORA (working name Aharos) — Architecture

_Current as of 2026-10-09 (Groups 1-9). Per-feature state: `docs/master-feature-audit.md`. Operations: `docs/production-runbook.md`._

## Shape of the system

One Next.js 15 (App Router) application, one Prisma schema in two flavours, one set of services:

```
Browser (staff screens, guest pages, marketing site)      Electron shell (Windows / macOS desktop)
        │                                                          │ embeds the same Next build + SQLite
        ▼                                                          ▼
src/app            pages (server components) and /api/<domain>/[[...path]]/route.ts   ← thin
src/features       client screens: backoffice · pos · kitchen · mobile · billing · guest
src/server/api     createRouter (auth, Zod, rate limits, re-auth scopes, error mapping) · guestRouter (/api/qr, no cookies)
src/server/services business logic, transactions, state machines  (≈ 90 modules)
   ├─ src/server/auth        AccessContext, RBAC matrix, sessions, step-up re-authentication
   ├─ src/server/audit       writeAudit, in the same transaction as the change
   ├─ src/server/db          Prisma client, tenant scope guards, append-only guards, conflict classification
   ├─ src/server/ops         worker (outbox, recovery, housekeeping), scheduled jobs, readiness, lifecycle
   ├─ src/server/observability  structured logs (redacted), metrics, alerts, request timing
   ├─ src/domain             pure logic: money, GST, business day / time zones, bill split, opening hours, recipes
   └─ src/integrations       provider interfaces + adapters: payment, POS, aggregator, messaging, printer, accounting, sheets
src/constants       every status / type value and permission name, one source of truth
src/site            the public marketing website (content, screens, release manifest)
```

Rules that hold everywhere:
- **No business logic in routes or components.** Routes authenticate, validate with Zod, call one service and shape the answer. A screen never decides a price, a total, a payment outcome or who may do something; the server does and the screen shows it.
- **Services own transactions** (`runInTx`) and state machines (`assertTransition`); a status string is never typed by hand.
- **Every write is audited** (`writeAudit`) inside the transaction that made it, with before / after.
- **Every request that can be retried carries an Idempotency-Key** (orders, payments, rounds, refunds, vendor payments, GRNs, bills, splits): the same key and request returns the original result, the same key with another request is a 409.

## Tenancy and authorization

`buildAccessContext(db, userId)` derives an `AccessContext` (organization, outlets, roles per outlet, org-wide roles) from the database, never from client input. `assertCan(ctx, permission, outletId?)` consults the central `ROLE_PERMISSIONS` matrix (`src/server/auth/rbac.ts`); `assertOutletAccess` and the scoped query helpers (`orgScope`, `outletScope`, `authorizedOutletIds`) isolate organizations and outlets on every read and write; client-supplied outlet ids pass `assertOutletInOrg`. Sensitive actions (owner settings, refunds, voids, restores) are *re-auth scopes*: the route needs a fresh password confirmation, which never adds a privilege.

Guests have no account: a table QR token resolves server-side to table → outlet → organization; an order is reachable only with its access key (HMAC of the order id, kept in the URL fragment and sent as a header). PostgreSQL row-level security is designed but not applied (`docs/postgres-rls.md`): one organization per database is the supported shape; multi-outlet *within* an organization is supported, multi-restaurant tenancy is deferred.

## Data integrity (what the database itself enforces)

- **Money is `Decimal`** end to end (`src/domain/money.ts`; `DECIMAL_FIELDS` in `scripts/pg-schema.mjs` must classify every Decimal column). Rounding is explicit (half-up to the paisa; bill splits round down and the last payer takes the remainder).
- **Stock is derived**: `InventoryLedger` is the only writer of stock movement (signed quantities, append-only); balances are sums; average cost is kept per outlet; corrections are new rows.
- **`AuditLog` and `InventoryLedger` cannot be changed or removed, by anyone**: triggers on SQLite and PostgreSQL abort every UPDATE and DELETE (and TRUNCATE on PostgreSQL) — the application role, the schema owner, a hand-typed query. Only a disposable-database wipe (demo seed, test fixtures) lifts them, through `withAppendOnlyGuardsOff`. The readiness check proves the triggers are present.
- **Uniqueness is the idempotency layer**: `InventoryLedger.sourceRef`, `Order (org, idempotencyKey)`, `Order (outlet, source, externalRef)`, `WebhookEvent (provider, eventId)`, `Payment (provider, providerRef)`, `Refund.providerRef`, `ReservationSlot (table, slot)`, `JobRun (name, scope, runDate)`, checklist tasks `(templateItem, runDate)`.
- **Serializable transactions with bounded retry**; contention that outlasts the retries is a `503 Busy` with `Retry-After`, never a partial write or an unbounded wait. Hot rows (invoice counter, a single order's lines) are queued (`keyedLock`).

## Side effects never block a transaction

Messages, aggregator pushes, accounting syncs, printing, exports and notifications are durable rows written *after* the commit (`runAfterCommit`): `IntegrationDelivery` (kinds MESSAGE, AGGREGATOR_STATUS, AGGREGATOR_ITEM, ACCOUNTING_SYNC), `PrintJob`, `ExportJob`. The in-process worker (`src/server/ops/worker.ts`, every 30 s) retries due rows with bounded backoff, fails what crashed mid-way without re-sending anything that may have reached a provider, and does hourly housekeeping. Scheduled jobs (`src/server/ops/scheduled.ts`) are claimed with a `JobRun` row so any number of instances run each once per day per scope: the nightly POS re-pull (01:30 outlet time), the growth automations (campaigns, feedback requests, booking messages, birthday / win-back offers, the 9 AM summary) and the 08:00 stock and vendor-dues check.

Inbound webhooks (payment, POS, aggregator) are signature-verified, recorded once (`WebhookEvent`), normalized and processed idempotently; a provider account RESTORA does not know is refused, never guessed.

## Integrations

Interfaces isolate vendors (`PaymentProvider`, `POSProvider`, `MessagingProvider`, accounting / sheets / aggregator adapters). Mock / emulator adapters run with no credentials and are refused in production unless explicitly allowed; real adapters (Razorpay, Petpooja, Twilio, Resend, Tally, Zoho Books, Google Sheets, aggregator menu APIs) are selected by connection settings and environment. **Only mocks and emulators have been exercised**: nothing is claimed live until it has run against the provider (`docs/master-feature-audit.md`, status `IMPLEMENTED + NOT EXTERNALLY VERIFIED`).

Messaging is consent-gated: marketing goes only to guests who said yes on that channel, transactional messages follow the transactional flag, every send is an outbox row with a masked target and an audit entry.

## Core flows

```
Guest QR ──► quote (server prices) ──► order (Idempotency-Key) ──► [staff accepts | prepayment verifies] ──► KOT(s) ─► KDS
   │                                                                                                         │
   └─► pay (whole bill, or a part: server computes the share) ─► gateway ─► verifyPayment (server asks the gateway)
POS / captain ──► order ─► rounds ─► bill ─► payment(s) ─► PAID ─► invoice (gap-free FY number, CGST/SGST) ─► consumption from recipes
Vendor ─► indent / reorder ─► PO (approval rules) ─► GRN ─► ledger receipt (+ average cost) ─► vendor bill ─► payment
Day: opening ─► sales ─► drawer / money desk ─► day close (locks the day) ─► reports, cost, leakage, insights
```

## Desktop

The Windows / macOS app embeds the same Next build and an SQLite database in the user's data folder (`docs/desktop-architecture.md`): context-isolated renderer, fuses flipped, asar integrity, local-only server, upgrade-in-place migrations (including trigger-bearing ones). It is built, launched, attacked and packaged on real Windows and macOS runners in CI; it is not code-signed until certificates are supplied.

## Verification structure

Vitest (domain, API, UI, integration, DB) on SQLite and PostgreSQL 16; Playwright E2E on the production build on both databases; investor business flow with a Razorpay emulator; desktop E2E and packaged-app verification; scripted operations drills (backup / restore, PITR, load, smoke). Details: `TESTING.md`.
