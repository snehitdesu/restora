# Production migration preflight (PostgreSQL, 9 pending migrations)

_Prepared 2026-10-21 from the repository at `e7fedf8` (+ this pass's working
tree). Nothing here has been run against Production. Production's database,
its backups and its migration state are **unverified**: there is no
Production `DATABASE_URL` on record (Vercel has had no Production-scoped
record since 2026-10-15), so who hosts it and what it holds is unknown._

Use this in order. Each step has a **stop** condition; stopping is always safe
because nothing before step 6 changes Production.

## Evidence that exists vs. evidence that is missing

| | Status | Evidence |
| --- | --- | --- |
| Backup → destroy → restore drill, current schema | **Passed (local only)** | `scripts/ops/backup-drill.mjs` 10/10 on a disposable local PostgreSQL 16.14 database, 2026-10-21 (`docs/database-recovery-and-migrations.md` §4) |
| The 9 migrations apply cleanly from empty | **Passed (CI)** | CI run 39492234842, `PostgreSQL 16` job: `db:pg:deploy`, `migrate status`, both drift checks |
| The 9 migrations apply on top of Production's real data | **Not verified** | needs step 4 |
| A Production backup exists and restores | **Not verified** | needs steps 2–3 |
| Production's applied migrations | **Unknown** | needs step 1 (`migrate status`) |

The local drill proves the tooling and the procedure. It says nothing about
Production's data, size, provider, roles or backups.

## 0. Approvals and people (before anything)

- [ ] Owner's written approval for: read-only access (step 1), the backup and
      scratch restore (steps 2–3), and separately for the migration window (step 6).
- [ ] The Production database's provider and console access identified. The
      connection string comes from the provider console / a secret manager into
      an environment variable of the operator's shell — **never** typed on a
      command line, pasted into chat, a ticket, this repository or a log. All
      scripts below read it from the environment and redact it in errors.
- [ ] Preview and Production use **different** databases (on 2026-10-14 one
      `DATABASE_URL` record covered both). Do not proceed while they share one.
- [ ] A closed window agreed (no service, no open orders).

## 1. Identify the target and its migration state (read-only)

```
npx prisma migrate status --schema prisma/postgres/schema.prisma
```

with `DATABASE_URL` set to Production (a read-only role is enough for this).

| Expected result | Meaning |
| --- | --- |
| 12 applied, last `20261016100000_integrations_control_room`; these 9 not yet applied: `20261017100000_growth_crm` … `20261025100000_recipe_estimates` | matches build `a80caa9`; continue |
| Some of the 9 already applied | possible if a build of this branch was ever deployed against it; continue only after reviewing which, and repeat step 4 on the restore |
| A failed migration, or names this repository does not have | **stop**: investigate; never edit `_prisma_migrations` by hand |
| Cannot connect / unknown host | **stop**: the target is not established |

Also record (read-only): PostgreSQL server version, database size, row counts
of `Order`, `Payment`, `AuditLog`, `InventoryLedger`, and whether the
`restora_owner` / `restora_app` / `restora_backup` roles of
`scripts/ops/pg-roles.sql` exist (or the database uses one provider role).

## 2. Backup

Two independent copies:

1. **Provider snapshot / PITR point** (managed PostgreSQL): note its id and time.
2. **`pg_dump` archive** with the repository tool:
   `BACKUP_DATABASE_URL=… BACKUP_DIR=… BACKUP_ENCRYPTION_KEY=… node scripts/ops/pg-backup.mjs --verify-restore <scratch database url>`

**Trap — run the backup from a checkout of `a80caa9`, not from this release.**
`db-verify.mjs` (used by `--verify-restore` and `pg-restore.mjs`) requires the
newest migration *of the checkout it runs from* (`expectedMigration()` in
`scripts/ops/pg-common.mjs`). From this release it expects
`20261025100000_recipe_estimates`, which a pre-upgrade database cannot have,
so a good backup would be reported as failed. The four ops scripts are
byte-identical between `a80caa9` and HEAD (`git diff --stat a80caa9 HEAD --
scripts/ops/pg-backup.mjs scripts/ops/pg-restore.mjs scripts/ops/db-verify.mjs
scripts/ops/pg-common.mjs` is empty), so:
`git worktree add ../restora-a80caa9 a80caa9`, `npm ci` there, and run the
backup and the step-3 verification from that folder.

- `pg_dump` / `pg_restore` client major version ≥ the server's.
- `BACKUP_ENCRYPTION_KEY` stored apart from the backup files.
- [ ] Stop if the backup or its verification fails.

## 3. Prove the backup restores (isolated)

Restore into a **new, empty** database that nothing serves from (a provider
branch / clone, or a scratch database on another server):

```
BACKUP_ENCRYPTION_KEY=… node scripts/ops/pg-restore.mjs --file <backup>.dump.enc --target <scratch url>
node scripts/ops/db-verify.mjs --url <scratch url>
```

(from the `a80caa9` worktree, as above). Pass = restore exit 0, `db-verify`
exit 0, row counts equal to the backup manifest. Never pass
`--confirm-overwrite` with the Production database's name.

## 4. Rehearse the migration on the restored copy

From **this release** checkout, against the scratch database:

```
npm run db:pg:deploy
npx prisma migrate status --schema prisma/postgres/schema.prisma
npx prisma migrate diff --from-url <scratch url> --to-schema-datamodel prisma/postgres/schema.prisma --exit-code
node scripts/ops/db-verify.mjs --url <scratch url>
```

Pass = 9 applied, "up to date", no difference (exit 0), `db-verify` exit 0
(now expecting `recipe_estimates`), row counts of every pre-existing table
unchanged. Time the run: it is the expected window length.

## 5. Compatibility review (done 2026-10-21 from the files; re-check if migrations change)

Static scan of the 9 files in `prisma/postgres/migrations/`:

- No `DROP`, `RENAME`, column type change, `UPDATE` / `DELETE`, or `NOT NULL`
  column without a default. 20 new tables, 31 added columns (nullable or with
  defaults).
- The one new unique index on an existing table,
  `Task_templateItemId_runDate_key`, covers two columns added in the same
  migration (all `NULL` on existing rows), so it cannot fail on existing data.
- Plain (non-concurrent) index builds on existing tables: `Feedback` ×2,
  `InventoryIssue`, `Payment`, `Task`. Each blocks writes to that table while
  it builds. Seconds at one café's size; that's why the migration runs in the
  closed window.
- `20261021100000_append_only_rate_limit` adds triggers that refuse `UPDATE`,
  `DELETE` and `TRUNCATE` on `AuditLog` and `InventoryLedger`. No application
  code updates or deletes these tables (searched `src/` and `scripts/`), but
  any manual clean-up, provider "reset" or retention job that does will start
  failing. That is intended.
- The previous build (`a80caa9`) keeps working on the migrated schema (it
  ignores new tables and columns), which is what makes "redeploy the previous
  build" a valid rollback.
- If the database uses the split roles, re-run `scripts/ops/pg-roles.sql`
  after migrating (new tables need grants).

## 6. Execute (separate approval; closed window)

1. Fresh backup (step 2) taken in the window, noted.
2. Schema before code: `npm run db:pg:deploy` as the owner role. Never
   `db push`, `migrate reset`, `migrate dev` or a seed.
3. Roles (if used): `pg-roles.sql`.
4. Deploy the build of this release.

## 7. Verify after

- [ ] `migrate status`: up to date (21 migrations).
- [ ] `migrate diff --from-url … --exit-code`: no difference.
- [ ] `/api/health/ready`: `ready` (it reports `pending` until
      `20261025100000_recipe_estimates` is applied: `src/server/ops/readiness.ts`).
- [ ] `db-verify.mjs`: exit 0.
- [ ] `node scripts/ops/smoke-test.mjs` (read-only form, `docs/production-runbook.md` §1.6).
- [ ] One counter cash order → bill → KOT → dashboard totals; cancel / refund it.
- [ ] `npm run qr:audit` (read-only) and record the result for `docs/qr-token-rotation.md`.

## 8. Rollback / forward recovery

| Situation | Action |
| --- | --- |
| New build misbehaves, migrations fine | Redeploy the previous build; keep the schema |
| A migration failed part-way | Readiness stays 503; `migrate status` names it. Fix forward on a scratch restore first, or restore the step-6 backup into a **new** database and point `DATABASE_URL` at it |
| Data damaged | Restore (`docs/production-runbook.md` §4) to the step-6 backup or PITR point |
| Need to remove 8–9 only | Manual SQL in `docs/payment-safety.md` §7 step 6, after a fresh backup. Migrations 1–7 are not reversed (business records and the audit guarantee) |

## 9. Record

Date, operator, approver, provider, server version, size, backup ids (snapshot
+ archive name and checksum), scratch-restore result, rehearsal duration,
`migrate status` before / after, readiness, smoke result, QR audit summary.
