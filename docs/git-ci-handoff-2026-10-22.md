# Git / CI handoff (2026-10-22)

Branch `release/coders-cafe-2026-10-13`, HEAD `a26b788`, **2 commits ahead** of
`origin/release/coders-cafe-2026-10-13` (`44ece0d`, `a26b788`, both unpushed).
Everything else is **uncommitted and unstaged**. Nothing was committed, pushed,
tagged or deployed by the engineering sessions. Final counts and test evidence:
`docs/final-engineering-completion-report.md`.

Backup of the uncommitted work (outside the repository, verified by restoring
into a throw-away clone, 74 / 74 hashes, taken before this session's edits):
`%TEMP%\claude\C--Users-ADMIN-Downloads-food\99bc0d56-…\scratchpad\preserve-20261022-final\`
(`tracked.patch`, `modified-files.tar`, `untracked.tar`, `hashes.txt`,
`status.txt`, `head.txt`). Earlier backups in the sibling session folders were
left untouched.

## Proposed commits (in this order; each should pass typecheck on its own)

| # | Commit | Files | Purpose | Evidence |
| --- | --- | --- | --- | --- |
| 1 | `feat(qr): restaurant common QR — schema + migration` | `prisma/schema.prisma`, `prisma/migrations/20261026100000_outlet_common_qr/`, `prisma/postgres/migrations/20261026100000_outlet_common_qr/`, `src/server/ops/readiness.ts` | Nullable unique `Outlet.guestQrToken`; readiness expects the migration | Migrations apply on fresh SQLite + PG; identical SQL; drift none |
| 2 | `feat(qr): guest ordering through the common QR; staff assign the table` | `src/server/services/{_workflow,guestOrdering,orders,orderOps,masterData}.ts`, `src/server/qr/{tableToken,scan}.ts`, `src/app/api/{qr,orders,master}/[[...path]]/route.ts`, `src/app/t/[token]/layout.tsx`, `src/features/guest/**` (5 files), `src/features/kitchen/{kds.ts,components/TicketCard.tsx}`, `src/features/pos/components/{OpenOrdersDialog,PosScreen,QrTablesPanel}.tsx`, `src/features/backoffice/{tables,tableQrScanner}.tsx`, `scripts/qr/audit-table-tokens.ts`, **and its tests** (they follow the nullable guest table, so they must land in the same commit for typecheck to pass): `tests/domain/{common-qr,coders-cafe-upi,qr-transaction,table-qr,table-qr-token}.test.ts`, `tests/api/common-qr-routes.test.ts`, `tests/ui/{common-qr-ui.test.tsx,logic.test.ts}`, `tests/db/guest-checkout-concurrency.test.ts`, `e2e/common-qr.spec.ts` | Feature + in-transaction limit recounts (advisory locks), customer upsert inside the order tx, audited staff override, `fromTableId` stale-view conflict | Suites green (no assertion removed in modified tests) |
| 3 | `test: SBI fail-closed coverage; growth spec locator` | `tests/domain/sbi-upi-fail-closed.test.ts`, `e2e/growth.spec.ts` | New coverage; a more specific locator (not a weaker assertion) | Suites green |
| 4 | `feat(ops): --expect-migration for backup / restore / verify; read-only Production audit SQL` | `scripts/ops/{db-verify,pg-backup,pg-common,pg-restore}.mjs`, `scripts/ops/prod-readonly-audit.sql`, `tests/ops/expected-migration.test.ts`, `tests/ops/prod-readonly-audit-sql.test.ts` | Verify a pre-upgrade Production backup; read-only audit | `tests/ops/*` |
| 5 | `feat(demo): RESTORA Demo Café sample dataset with a by-name database confirmation` | `prisma/demo-cafe/{data,seed,target}.ts`, `prisma/seed-demo-cafe.ts`, `package.json` (`db:seed:demo-cafe`), `tests/db/demo-cafe-seed.test.ts`, `tests/ops/demo-seed-target.test.ts` | Opt-in sample data in its own organization | 20 tests; CLI ×3 on a fresh file, counts / hashes identical |
| 6 | `chore(deps): http-cache-semantics 4.3.0 (dev, transitive via electron-builder)` | `package-lock.json` | Keep the lockfile in line with `node_modules` | `npm ls` consistent; dev-only |
| 7 | `docs: common QR, demo data, release acceptance and blockers` | all `docs/**` in the status list | Runbooks and evidence | — |

Files that do not fit one group cleanly: `tests/ops/expected-migration.test.ts`
(touches 1 and 4 — put it in 4); `package.json` (only the demo script → 5);
`docs/launch-readiness-2026-10-21.md` (a long dated log, review separately).

## Before pushing (owner approval required for the push itself)

1. Human review of the diff (`docs/diff-review-2026-10-22.md`).
2. `git diff --check` clean; no `*.db`, `.env*` (other than `.env.example`),
   build output or secrets staged (checked 2026-10-22: none tracked).
3. Push only with approval; CI (`.github/workflows/ci.yml`) then runs: SQLite
   migrate deploy + status + drift, typecheck, lint, `npm test`, build; the
   PostgreSQL job (deploy, status, drift, security subset, full suite); E2E
   (main, investor, acceptance) on SQLite; E2E on PostgreSQL; desktop build +
   E2E + verify. Local runs are not CI.

## Pending decisions that affect the commits

- Café Wi-Fi limit (`docs/cafe-wifi-rate-limit-decision.md`) — no code change
  until decided.
- Whether the desktop app ships in this release (A12) — not part of these
  commits either way.
