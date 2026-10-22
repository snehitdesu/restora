# Production environment identification and read-only audit

_Prepared 2026-10-21. **Nothing here has been run against Production.** It is
the procedure for an authorized operator (the owner, or someone the owner
names in writing). It comes before `docs/production-migration-preflight.md`
and the QR rotation (`docs/qr-token-rotation.md`), and before any push of the
release branch._

## 1. What is known, and how

| Fact | Status | Evidence |
| --- | --- | --- |
| Production runs on Vercel, project `restora` (team `snehitdesus-projects`), alias `restora-beta-six.vercel.app` | VERIFIED 2026-10-21 | GitHub deployment records of `snehitdesu/restora` (environment `Production`), repo homepage |
| Production serves build `a80caa9` (= `origin/main`) | VERIFIED as far as GitHub records go | the only `Production` deployment record is `a80caa9` (2026-10-10), rebuilt 3× that morning, last 07:18 UTC. A redeploy made only in the Vercel dashboard may not appear there: confirm on the dashboard |
| Every push of a branch creates a Vercel **Preview** deployment | VERIFIED | `Preview` records for each push of this branch, newest `e7fedf8` (2026-10-20, success) |
| The repository is **public** | VERIFIED | GitHub API (`private: false`) — the seed constants behind the legacy QR tokens are public |
| Production's database provider and host | **UNKNOWN** | `DATABASE_URL` is a Sensitive Vercel variable (unreadable by design). 2026-10-14: it was typed in by hand at import (no integration); the Prisma Postgres store and the Neon project `restora` both proved **not** to be what Production serves (the live T01 token is absent from them) |
| Preview vs Production `DATABASE_URL` | **UNVERIFIED now** | 2026-10-14: one record scoped Production **and** Preview. 2026-10-15: narrowed to Preview only; Production has no record since (its live deployment keeps the value baked in at build). 2026-10-19: a Preview was shown to use a Neon *test branch*. Whether that is still true is unknown |
| A read-only role on Production's database | **UNKNOWN** | depends on the provider (most managed PostgreSQL allow `CREATE ROLE`; some single-role "serverless" offers do not) |
| Vercel access from this machine | **none** | the CLI's stored session expired 2026-10-19 (API 403); not renewed here |

**Consequence:** a push of `release/coders-cafe-2026-10-13` creates a Preview
whose database is unverified. Builds never migrate, the Preview is behind
Vercel SSO, and Vercel Cron runs only on Production, so a Preview does nothing
on its own — but anyone who signs in to it uses whatever database it points at.
Do check 2.2 before pushing.

## 2. Owner checks (no credential is ever shown, copied or pasted)

### 2.1 Which build Production runs
Vercel dashboard → project `restora` → **Deployments** → filter
*Production*: note the current deployment's commit (expected `a80caa9`) and
date. Record: commit SHA, deployment URL id, date.

### 2.2 Where `DATABASE_URL` points, per environment
Vercel dashboard → **Settings → Environment Variables** → filter `DATABASE_URL`:
note for every record its **environments** (Production / Preview / Development),
any **Git branch** restriction, and the **last updated** date. Do not reveal or
copy the value. Then, in the **database provider's** console (whoever hosts it —
check the owner's accounts: Neon, Supabase, Prisma, Railway, AWS, …), list
databases / branches and their hosts.

Values cannot be compared on Vercel. Prove which database each environment
uses with the **live probe** (2.3) instead.

### 2.3 Live probe: is *this* database the one the deployment uses?
Read-only on both sides. The operator holds a connection to a candidate
database (from its provider console) and runs, before and after the probe:

```sql
SELECT relname, seq_scan, idx_scan FROM pg_stat_user_tables
WHERE relname IN ('RestaurantTable', 'MenuItem', 'Outlet') ORDER BY relname;
```

The probe: open the guest menu from a **printed table card** 5 times on the
Production site (each load reads `RestaurantTable` by token and the menu).
If `idx_scan` of `RestaurantTable` rose by about 5 (± other traffic), the
deployment uses this database; if it did not move, it does not. Repeat with
the **Preview** deployment URL (sign in through Vercel SSO first): if the
*Production* database's counters move when only the Preview is loaded,
**Preview shares Production's database — stop; give Preview its own database
before any push.** (Statistics can lag ~1 s; wait before the second reading.)

A copy restored from Production holds the same rows, so content checks alone
(`menu_ids` in section 3) cannot tell the live database from a copy: only the
probe can.

### 2.4 Read-only role (the provider's admin, once)
If the provider allows roles (PostgreSQL syntax; names are suggestions):

```sql
CREATE ROLE restora_auditor LOGIN PASSWORD '<generated in the provider console>';
GRANT CONNECT ON DATABASE <db> TO restora_auditor;
GRANT USAGE ON SCHEMA public TO restora_auditor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO restora_auditor;
```

Section 2 of the audit then shows `false` in every write column. If the
provider offers only one all-powerful role, the audit is still safe (read-only
session and transaction, ends in `ROLLBACK`; verified below), but treat the
credential as a write credential: keep it in the operator's shell only and
drop the session afterwards.

## 3. The audit

PostgreSQL client tools (`psql`) of a major version ≥ the server's. From a
checkout of this repository, with the connection string placed in the shell
by the provider console or a secret manager (never typed into a command, chat,
ticket or file):

```
psql -X -v ON_ERROR_STOP=1 -f scripts/ops/prod-readonly-audit.sql -d "$AUDIT_DATABASE_URL"
```

Optional live-menu content check: save the guest menu JSON of one printed
card (`/api/qr/t/<token from that card>`; do not write the token down), list
its item `id`s, and add `-v menu_ids='{id1,id2,…}'` before `-f`. On Windows keep
`-d`: `psql` ignores options written after a bare connection string.

| Section | What to read | Stop if |
| --- | --- | --- |
| 1 Identity | database, role, server address / version, `read_only_tx = on` | not the database the probe (2.3) identified |
| 2 Privileges | all `false` for a read-only role | (informational) |
| 3 Migrations | expected: 12 applied, newest `20261016100000_integrations_control_room`, 0 unfinished | unfinished / failed rows, or names this repository lacks |
| 4 Organizations / outlets | the real restaurant (Coders' Cafe, `CC01`) and nothing unexpected | names are not the restaurant's |
| 5 Live menu | `found_here` = `served_ids` | fewer found: wrong database |
| 6 QR classes | `legacy-derivable` tables = the rotation scope | — |
| 7 Open orders / pending payments | what a window would interrupt | — (plan the window around it) |
| 8 Razorpay | the five counts of `docs/payments-razorpay.md` | — (decides when Razorpay code can go) |
| 9 Inconsistencies | all 0 | any non-zero: investigate before migrating or rotating |
| 10 Size | database size, row counts | — (backup / window estimate) |

The output holds names and counts, never tokens, references or amounts; it
can be filed as evidence. `npm run qr:audit` gives the same QR classes per
table but needs the PostgreSQL Prisma client (`docs/qr-token-rotation.md` step 3).

**Backups (not provable by SQL):** in the provider console, record whether
automatic backups / point-in-time restore exist on the current plan, their
retention, and the newest restore point. "A restore was proven" needs
preflight step 3 (restore into a new, isolated database); nothing else counts.

## 4. Verified locally (2026-10-21, disposable PostgreSQL 16.14)

On a database built from `a80caa9`'s 12 migrations, with seeded Coders' Cafe
tables holding a legacy hash token, a `CC01-<table>` token, a random token, a
non-standard value and none, plus an open QR order and a pending Razorpay
payment:

- as a `SELECT`-only role: exit 0; every write privilege `false`; 12 migrations;
  classes correct for every table and identical to `npm run qr:audit` (TS);
  `menu_ids` with one real and one absent id → 2 served / 1 found; the
  planted Razorpay pending payment and open QR order reported;
- as a superuser: exit 0, and a per-table count + md5 fingerprint taken before
  and after both runs was identical (0 tables changed);
- none of the 8 stored tokens appears in the output;
- on the release schema (21 migrations) it also runs (exit 0).

Guarded by `tests/ops/prod-readonly-audit-sql.test.ts` (read-only statements
only, ends in `ROLLBACK`, token column only classified, same rules as
`qr:audit`). Not run: against any real Production or Preview database.
