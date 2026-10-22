# Production / Preview isolation and backup-restore — operator checklist and evidence form

Status on 2026-10-22: **BLOCKED** (both). Nothing here has been checked against
the real hosting account or database: the engineering sessions have no access,
and reading the hosting API was not permitted. This page is what the owner (or
someone they authorise) fills in. **Never write a secret value, connection
string or password on this page, in the repository, a terminal log or a chat.**
Record names, environment assignments, host *labels* and yes / no answers only.

Commands referenced here exist and their flags were checked against the
scripts on 2026-10-22 (`scripts/ops/pg-backup.mjs`, `pg-restore.mjs`,
`db-verify.mjs`, `scripts/ops/prod-readonly-audit.sql`). Full procedure:
`docs/production-migration-preflight.md`; read-only audit:
`docs/production-readonly-audit.md`.

## 1. Production / Preview isolation (hosting dashboard, read-only)

Vercel → Project → Settings → Environment Variables. Do not reveal values; the
list view shows names and the environments each record is assigned to.

| # | Check | How | Answer (yes / no / name) |
| --- | --- | --- | --- |
| I1 | Which records named `DATABASE_URL` exist, and which environments (Production / Preview / Development) each is assigned to | List view | |
| I2 | Production has its own `DATABASE_URL` record | List view | |
| I3 | Preview has a record that is **not** also assigned to Production | List view | |
| I4 | The two records point at different databases | Owner opens the database provider's console and compares the **project / branch / database names** behind each (not the URL) | |
| I5 | No other variable could point Preview at Production (`DIRECT_URL`, `BACKUP_DATABASE_URL`, provider integration variables) | List view, filter "DATABASE" / "POSTGRES" / "NEON" | |
| I6 | Preview deployments do not inherit Production variables (shared / team variables included) | List view + team-level variables page | |
| I7 | The build command runs no migration or seed | `vercel.json` in the repository sets only a cron (checked 2026-10-22), so the dashboard's Build & Development settings decide: confirm the build command is the default / `npm run build` (Prisma generate + `next build`) with no `migrate deploy` and no `db:seed*` | |
| I8 | The Production database role used by the app is not the owner / superuser (least privilege) | Database provider console → roles | |
| I9 | Secrets are marked Sensitive where the provider supports it | List view | |

**Pass only if I2–I7 are all "yes"** (I8 / I9 are hardening; record them). If
anything is unclear, the release stays **BLOCKED**: a Preview build of this
branch would run against the live café's data.

## 2. Backup, restore proof and migration preflight (Production)

Run only with the owner's written go-ahead, from a machine the owner trusts,
with credentials entered into that machine's environment directly (never
pasted into a chat or committed).

| # | Step | Command / action | Evidence to record (no secrets) |
| --- | --- | --- | --- |
| P1 | Approved backup mechanism | Provider snapshot / branch (e.g. Neon branch) **and** `pg-backup.mjs` (encrypted custom-format dump + manifest) | Mechanism name, retention |
| P2 | Identify the database | Database provider console | Provider, project / database **name**, region; date-time |
| P3 | Schema version | `prisma migrate status` with a read-only role (`docs/production-readonly-audit.md` §2.4) | Newest applied migration name; pending list |
| P4 | Backup | `node scripts/ops/pg-backup.mjs --expect-migration <newest applied> --verify-restore <scratch database>` (`BACKUP_DATABASE_URL`, `BACKUP_DIR`, `BACKUP_ENCRYPTION_KEY` set in the environment) | Backup file name, manifest checksum, row counts from the manifest, timestamp |
| P5 | Restore into an isolated scratch database | `node scripts/ops/pg-restore.mjs --file <backup>.dump.enc --target <scratch database> --expect-migration <newest applied>` | Exit code 0; the `"msg": "restore complete"` JSON line (it includes the verify result) |
| P6 | Integrity and foreign keys | `node scripts/ops/db-verify.mjs --url <scratch database> --expect-migration <newest applied> --fingerprint` | "INTEGRITY OK"; constraints validated |
| P7 | Critical counts without customer data | Row counts from P6 vs the manifest (counts only; no rows) | Equal / differences |
| P8 | Read-only Production audit | `psql` as the read-only role: `scripts/ops/prod-readonly-audit.sql` (READ ONLY session, ends in ROLLBACK, prints counts and classes only) | Output saved by the owner (no tokens, no customer data are printed) |
| P9 | Expected vs actual migrations | Compare P3's list with `prisma/postgres/migrations/` of the release commit; rehearse `npm run db:pg:deploy` **on the restored scratch copy** (preflight §4) | Rehearsal exit code; `db-verify` after it |
| P10 | Approval | Owner's written approval naming the window, after P1–P9 | Date, name |

A local disposable-PostgreSQL drill (done repeatedly, most recently in the
2026-10-21/22 sessions) shows the scripts work; it is **not** evidence that a
real Production backup restores.

## 3. Results

| Item | Status | Date | Who | Notes |
| --- | --- | --- | --- | --- |
| Isolation (I1–I9) | BLOCKED — not checked | | | |
| Backup (P4) | BLOCKED — not run | | | |
| Restore proof (P5–P7) | BLOCKED — not run | | | |
| Read-only audit (P8) | BLOCKED — not run | | | |
| Migration rehearsal (P9) | BLOCKED — not run | | | |
| Approval (P10) | WAITING FOR OWNER | | | |
