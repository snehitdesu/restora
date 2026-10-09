# RESTORA — The Operating System for Restaurants

RESTORA runs a restaurant end to end: POS, QR ordering, kitchen tickets (KOT) and
kitchen display (KDS), captain and manager phone apps, payments and refunds with
GST invoices and credit notes, recipe-based inventory, procurement, finance,
analytics and reports, integrations (payment gateway, receipt/KOT printers,
customer messaging, accounting export), as a web application (PostgreSQL) and a
Windows desktop application (embedded SQLite).

> The repository and some internal identifiers still use the working name
> **Aharos** (package name, desktop app id, data folder, `AHAROS_*` variables).
> They are kept stable on purpose so existing installations upgrade in place.

## Status
V1 release candidate (1.0.0-rc.1) plus the master program, Groups 1-9: integrity, reorder, kitchen production and money desk,
menu engineering and costing, integrations, growth / CRM, floor / mobile / kitchen operations, purchasing, expiry and
staff operations, and production hardening (database-enforced append-only history, shared rate limits, accessibility,
load). **Everything that can be proven without an outside party is covered by automated tests on SQLite and PostgreSQL 16, browser
E2E on both, and desktop builds on Windows and macOS (all in CI).** Everything that needs an outside party is built against
mocks or emulators and labelled `NOT EXTERNALLY VERIFIED`: no real payment gateway, POS, aggregator, WhatsApp / SMS / e-mail
provider, accounting system, spreadsheet, printer, hosting or code-signing certificate has been used. Multi-outlet inside one
organization works; multi-restaurant tenancy (and PostgreSQL row-level security) is **intentionally deferred**.

Of the 187 rows of the feature audit: {{VERIFIED}} IMPLEMENTED + VERIFIED, {{NEV}} IMPLEMENTED + NOT EXTERNALLY VERIFIED, {{PARTIAL}} PARTIAL,
{{NOTBUILT}} NOT BUILT (later-phase items: native apps, e-invoice, event / catering modules, own ordering website ...), 3 deferred.

Start here: `PROJECT_STATUS.md` (state), `docs/master-feature-audit.md` (feature by feature, source of truth),
`docs/stabilization-report.md` (evidence and the external-dependency list), `docs/group-delivery-map.md` (where each group lives).

## Quick start (development, SQLite — no external services)
```bash
npm ci
cp .env.example .env            # development defaults
npm run setup                    # prisma generate + db push (dev.db) + demo seed
npm run dev                      # http://localhost:3000
# demo sign-in: owner@demo.local … cashier@demo.local / Demo@12345 (dev only)
```

## Checks
```bash
npm run typecheck && npm run lint
npm test                         # full suite on SQLite
TEST_DATABASE_URL=postgresql://…/fresh_db npm run test:pg   # same suite on PostgreSQL
npm run e2e                      # production build + browser E2E (Playwright), one seeded SQLite database
E2E_DATABASE_URL=postgresql://…/fresh_empty_db npm run e2e:test   # the same specs on PostgreSQL (build with `npx next build` after generating the PostgreSQL client)
npm run desktop:build && npm run desktop:e2e                # desktop app
```
Details: `TESTING.md`.

## Production
- Web: PostgreSQL 16 + `npm run db:pg:deploy` (migrations, never `db push`),
  one app instance behind HTTPS — `docs/production-infrastructure.md`,
  `docs/production-runbook.md`.
- Desktop: `npm run desktop:dist` → signed NSIS installer — `docs/desktop-release.md`.
- Never run the demo seed, `migrate reset` or `db push` against a real database.

## Documentation map
| Topic | Document |
|---|---|
| Architecture | `ARCHITECTURE.md`, `docs/desktop-architecture.md` |
| Database | `DATABASE.md`, `docs/postgres.md`, `docs/postgres-rls.md` |
| Production infrastructure, load results, backup / DR | `docs/production-infrastructure.md` |
| Operations runbook | `docs/production-runbook.md` |
| Customer website (table QR ordering) | `docs/customer-web.md` |
| Security | `docs/security.md` |
| Compliance readiness (GST etc.) | `docs/compliance-readiness.md` |
| Release checklist / notes | `docs/release-checklist.md`, `docs/release-notes.md` |
| Phase reports | `docs/phase*-*.md`, `docs/RESTORA-V1-FINAL-REPORT.md` |
| Growth / CRM (consent, messaging, campaigns) | `docs/growth.md` |
| Where each group lives (code, screens, migrations, tests) | `docs/group-delivery-map.md` |
| Stabilization evidence, feature audit | `docs/stabilization-report.md`, `docs/master-feature-audit.md` |
