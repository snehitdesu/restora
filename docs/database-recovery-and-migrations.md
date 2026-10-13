# Database migrations, backups and recovery

_2026-10-13. Sections 1–4 were produced on disposable copies in the session
scratchpad. Section 5 was then approved and executed on the original
`prisma/dev.db` (see its execution record). The installed desktop database
(`%APPDATA%\Aharos\data\aharos.db`) and the hosted demo database were not
modified._

## 1. Current state (verified read-only)

| Database | Target | Migrations | Notes |
|---|---|---|---|
| `prisma/dev.db` (the user's `next dev` on :3000, `DATABASE_URL=file:./dev.db`) | SQLite, rollback-journal mode (no WAL/SHM) | **23 of 23** applied since 2026-10-13 06:17 IST (was 15 of 23, through `20261009100000_integrations`) | `PRAGMA integrity_check` = ok, 0 foreign-key violations before and after. Pre-migration backup: `prisma/dev.db.pre-migrate-2026-10-13.bak` (section 5). 2 organizations (demo group + Coders' Cafe), 3 outlets, 13 users, 86 menu items (64 Coders' Cafe), 10 orders + 1 verification order, 14 KOTs + 1. |
| `prisma/test.db`, `prisma/e2e.db`, `prisma/e2e-investor.db` | SQLite, rebuilt by the test runners | n/a | disposable |
| Hosted Vercel demo | PostgreSQL 16 | 12 of 13 PostgreSQL migrations once this code is deployed | not contacted in this pass (no URL or credentials in the repo) |

The source schema now has 23 SQLite migrations / 13 PostgreSQL migrations. The
newest, `20261017100000_rate_limit_buckets`, was added in this pass (one empty
table for the shared rate-limit store; see `docs/security.md`).

## 2. What the 8 pending dev.db migrations do

| Migration | Effect on existing data |
|---|---|
| `20261010100000_kot_number_sequence` | none (empty on SQLite; PostgreSQL-only sequence) |
| `20261011100000_fk_indexes` | 10 new indexes |
| `20261012100000_core_gaps` | new columns on Vendor / Wastage / Kot, new `DishProduction` table; backfill `Vendor.status = 'INACTIVE'` where `active = false` (0 rows in dev.db) |
| `20261013100000_reorder_engine` | new nullable columns (Material par levels, indent / PO source, indent idempotency key) + unique index |
| `20261014100000_money_desk_production` | new `DayClose`, `BankDeposit` tables, production columns; backfill `Recipe.stocked = true` for sub-recipes that already have a COMPLETED production batch (1 row in dev.db) |
| `20261015100000_costing_engineering` | `OrderItem.unitCost`, `OrderItem.lineCost` (nullable), `RecipeVersion.overheadPct` (default 0) |
| `20261016100000_integrations_control_room` | 6 new empty tables (accounting mapping, sheet sync, aggregator statements / charges, job runs) |
| `20261017100000_rate_limit_buckets` | 1 new empty table |

Nothing is dropped or renamed. The two backfills only fill columns the same
migration adds.

## 3. Trial on a byte copy (done)

`cp prisma/dev.db → scratchpad/db/migrate-trial.db`, then
`DATABASE_URL=file:<copy> prisma migrate deploy`:

- 8 migrations applied in 2.3 s; `prisma migrate status`: up to date (23).
- Row counts of every pre-existing table identical before and after; the 10 new tables are empty.
- `integrity_check` ok and 0 FK violations before and after.
- Coders' Cafe: 64 menu items and tables T01–T10 preserved.

## 4. Backup / restore drill (done)

On a copy of dev.db: `VACUUM INTO 'drill-backup.db'` (a consistent snapshot
even while another connection has the file open; 125 ms for 2 MB) → copied to
`drill-restored.db` → every table count identical, integrity ok, 0 FK
violations → `prisma migrate deploy` on the restored file → 23 migrations,
integrity ok. The desktop app's own backup / restore / upgrade code is covered
by `tests/desktop/backup.test.ts`, `upgrade-restore.test.ts`, `migrator.test.ts`
(all passing in the 2026-10-13 regression).

PostgreSQL dump / restore: `scripts/ops/backup-drill.mjs` (documented in
`docs/production-runbook.md`); not re-run in this pass.

## 5. Plan for the ORIGINAL `prisma/dev.db` — executed 2026-10-13

Approved by the user and executed on 2026-10-13 (record below). The steps:

1. Stop only the `next dev` process that serves :3000 from this repo (the user's
   own server; it holds the database open). Confirm no other process has
   `prisma/dev.db` open.
2. Re-check that `prisma/dev.db` still matches the 2026-10-12 backup
   (SHA-256). If it changed, take a new consistent backup:
   `node -e "new (require('node:sqlite').DatabaseSync)('prisma/dev.db',{readOnly:true}).exec(\"VACUUM INTO 'prisma/dev.db.pre-migrate-2026-10-13.bak'\")"`
   and verify it (`PRAGMA integrity_check`, row counts).
3. `npx prisma migrate deploy` (uses `.env` → `file:./dev.db`). Never
   `migrate dev`, `db push` or `migrate reset`.
4. Verify: `npx prisma migrate status` = up to date; integrity ok; row counts
   equal to the backup's; Coders' Cafe menu (64) and tables (10) present.
5. `npx prisma generate` while the dev server is stopped (the running server
   locks the engine DLL).
6. Start one `next dev`. Test a guest cash order on T01 → POS → KOT → KDS →
   tracking, and the dashboard / inventory / finance screens.
7. Keep both backups until the user has used the migrated database.

### Execution record (2026-10-13, 06:10–06:31 IST)

- **Target re-verified:** only `.env` exists (`DATABASE_URL="file:./dev.db"`, no
  `.env.local` / `prisma.config.*`, no `DATABASE_URL` in the shell, user or
  machine environment); `prisma migrate status` resolved `dev.db` at
  `file:./dev.db` with exactly the 8 migrations of section 2 pending.
- **dev.db had changed since the 2026-10-12 backup** (SHA-256 `2290ae8b…f921` vs
  `5dc2f07f…7aa3`; one expired `Session` row purged), so step 2's new backup
  was taken.
- **Rehearsal first:** a `VACUUM INTO` snapshot taken while the server was still
  running migrated cleanly (8 applied, counts equal, integrity ok) before
  anything was stopped.
- **Stop:** the only `next dev` tree (npm → next dev → start-server.js on :3000)
  was the only process holding `dev.db` (Windows Restart Manager). It was ended
  with no `dev.db-journal` present (no write in flight); afterwards nothing held
  the file and no journal was left. Note: on Windows, Next's dev CLI ends its
  server child with `child.kill()`, an abrupt terminate, even on Ctrl+C;
  SQLite's atomic commit is what makes this safe.
- **Backup:** `prisma/dev.db.pre-migrate-2026-10-13.bak` (`VACUUM INTO`, 2,113,536
  bytes, SHA-256 `7f2a8d87…667f`): integrity ok, 0 FK violations, 15
  migrations, and a per-table content hash (every row, by primary key) identical
  to `dev.db` for all 93 tables.
- **Restore drill:** the backup copied to a scratch file (the recovery procedure)
  was content-identical to `dev.db`; `migrate deploy` on it applied the 8
  migrations; every pre-existing column of every pre-existing table kept
  identical content.
- **Migration:** `npx prisma migrate deploy` applied the 8 migrations in ~5 s.
  `migrate status`: up to date (23). integrity ok, 0 FK violations, row counts of
  all 92 pre-existing data tables equal to the backup, 10 new tables empty,
  original-column content identical to the backup, schema DDL identical to the
  rehearsal, and `prisma migrate diff` (database vs `schema.prisma`): no
  difference. Backfills: 0 vendors changed; 1 recipe ("Ginger Garlic Paste")
  marked `stocked`.
- **Client:** `npx prisma generate` (SQLite, Prisma 6.19.3) with the server
  stopped. The client was stale before (generated 2026-10-12 21:59, before the
  `RateLimitBucket` schema edit).
- **Restart:** one `npm run dev` on :3000; `/api/health/ready` →
  `{"status":"ready","checks":{"database":"up","migrations":"ok"}}`.
- **Live order (Coders' Cafe, T01, cash, guest name "Migration Test"):**
  order `cmv5z41ic0004vnwsfecp6b44` (#CP6B44), ₹378.00 = (2 × 110 + 140) × 1.05.
  Checkout `POST /api/qr/t/:token/orders` → 200 (was 500 before the migration),
  SENT with KOT #2 at placement → POS "Open orders" → KDS Accept / Start / Ready /
  Served → guest tracking "Being prepared" → "Ready" → "Served" → cash at the POS
  → PAID, invoice `CC/2627/00002`, guest receipt identical to the POS reprint.
  Dashboard, inventory, production, finance, money desk and payments screens
  rendered. No browser console error, page error or HTTP 5xx; no server WARN or
  ERROR.
- **Found, not caused by the migration:** `Kot.acceptedAt / startedAt / readyAt /
  servedAt` (added by `20261012100000_core_gaps`) stayed NULL: `updateKOTStatus`
  set only `status`. Fixed the same day (`KOT_STAMP` in
  `src/server/services/kot.ts`, tests in
  `tests/domain/kot-lifecycle-timestamps.test.ts`); KOTs older than the fix keep
  NULL stamps (not backfilled). `OrderItem.unitCost /
  lineCost` are NULL for this order by design: Coders' Cafe has no recipes
  (`orderConsumption.ts` stamps costed lines only).

**Recovery:** stop the server, copy `prisma/dev.db.pre-migrate-2026-10-13.bak`
back over `prisma/dev.db` (delete any `dev.db-journal`), restart. The restored
file is the exact pre-migration state (verified above) and matches code at the
15-migration schema. The current code needs all 23 migrations (against the
restored file QR checkout answers 500 again), so with the current code run
`npx prisma migrate deploy` after restoring.

**Risks:** low. All changes are additive. The only failure seen before this
fix was the opposite: the current code against the un-migrated database
answers QR checkout with HTTP 500 (`OrderItem.unitCost` missing).

## 6. Desktop and hosted databases

- Desktop: the installed app migrates its own database on start with a backup
  first (`desktop/runtime/migrator.ts`, `upgrade.ts`). The new rate-limit
  migration is additive; it will apply when the user installs a newer build.
- Hosted demo (PostgreSQL): `npm run db:pg:deploy` against it requires a
  separate approval and a read-only `prisma migrate status` first
  (`docs/vercel-investor-demo.md` §3). Until then the code runs unchanged with
  `RATE_LIMIT_STORE=memory`.
