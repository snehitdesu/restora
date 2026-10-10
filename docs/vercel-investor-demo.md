# Investor demonstration on Vercel

This is the operator checklist for a **sample-data, simulated-payment** public
demo of RESTORA. It is not a live restaurant go-live.

Do **not** run the commands in §3 until you have confirmed the PostgreSQL
database is **new, empty, and disposable**, and you have approved the operation
in chat. The app never migrates or seeds itself.

## Architecture constraints (honest)

RESTORA’s production shape is **one Node process** (`next start`) plus
PostgreSQL. Vercel is serverless:

| Concern | What this repo does on Vercel |
|---|---|
| Prisma client | `npm run build` generates the **PostgreSQL** client when `VERCEL=1` |
| Schema deploy | **Manual** `npm run db:pg:deploy` against the demo database — never `db push` |
| Maintenance worker | In-process `setInterval` is **disabled**. `GET /api/cron/worker` (Bearer `CRON_SECRET`) is invoked by Vercel Cron |
| Export files | Default `EXPORT_RUNNER=inline`; files live in the function `/tmp` and **are not durable** |
| Rate limits | In-memory per instance — weakened across lambdas |
| SQLite | Not used on Vercel |

Hobby Cron is at most once per day. `vercel.json` schedules
`GET /api/cron/worker` at `30 20 * * *` (20:30 UTC, 02:00 IST). That tick is
the demo's only background work. It is not a continuous worker, and a tick
that the platform kills waits until the next day.

This schedule is for an India outlet. POS re-pull is due at 01:30 in the
outlet's own time zone. 02:00 IST is thirty minutes after 01:30 IST, so an
Asia/Kolkata restaurant is included. One UTC schedule cannot also fall at
01:30 in other time zones; do not use it for outlets outside India.

Outbox retries are built for the in-process worker (about every 30 seconds,
then 1 min / 5 min / 30 min / 2 h). On this daily cron a failed delivery is
attempted again only on a later day, once `nextAttemptAt` is already past.
A failed POS re-pull waits an hour and allows three attempts; with one tick
per day that is at most one attempt per day. Session and password-link
housekeeping runs on the same daily tick, not hourly.

## 1. Create (do not migrate yet)

1. A **new** PostgreSQL 16 database (Vercel Postgres / Neon / similar). Empty.
2. A Vercel project pointed at this repository. Framework: Next.js. Build:
   `npm run build` (already in `package.json`). Install: `npm ci`.
3. Do **not** click Deploy until environment variables in §2 are set **and**
   §3 has been approved and run.

## 2. Environment variable names

Set these on the Vercel project. Values are never recorded here.

### Required

| Name | Why |
|---|---|
| `DATABASE_URL` | PostgreSQL URL for the **app** role (`sslmode=require`, `connection_limit` kept small, e.g. 5) |
| `AUTH_SECRET` | ≥ 32 random characters, **not** the development placeholder |
| `CRON_SECRET` | ≥ random; Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Not `dev-cron-secret` |
| `PUBLIC_BASE_URL` | `https://<this-deployment>` — table QR codes and callbacks |
| `DEMO_DEPLOYMENT` | `true` — demo banner; **refuses live Razorpay keys** and **refuses `ALLOW_MOCK_PROVIDERS`** |

### Required for simulated payments

Use **Razorpay test mode**. Do not set `ALLOW_MOCK_PROVIDERS` on this public demo. Mock adapters approve any payment and are refused together with `DEMO_DEPLOYMENT`. `rzp_test_…` keys only. Never `rzp_live_`.

| Name | Why |
|---|---|
| `PAYMENT_PROVIDER` | `razorpay` |
| `RAZORPAY_KEY_ID` | must start with `rzp_test_` |
| `RAZORPAY_KEY_SECRET` | test secret |
| `RAZORPAY_WEBHOOK_SECRET` | test webhook secret |

Startup **refuses** `rzp_live_` when `ALLOW_MOCK_PROVIDERS` or `DEMO_DEPLOYMENT` is set.

### Strongly recommended

| Name | Why |
|---|---|
| `POS_PROVIDER` / `WHATSAPP_PROVIDER` / `EMAIL_PROVIDER` / `GOOGLE_SHEETS_PROVIDER` | leave unset. `mock` needs `ALLOW_MOCK_PROVIDERS`, which a `DEMO_DEPLOYMENT` refuses |
| `NEXT_PUBLIC_SITE_URL` | same https origin as the site, if the marketing pages are served |
| `TRUSTED_PROXY_HOPS` | `1` (Vercel) |
| `INTEGRATION_SECRETS_KEY` | ≥ 32 chars; otherwise derived from `AUTH_SECRET` |
| `SESSION_TTL_SECONDS` | e.g. `43200` (12 h) for a short demo |

### Do **not** set on the running app

| Name | Why |
|---|---|
| `ALLOW_DEMO_SEED` | Startup refuses it in production (the seed wipes data) |
| `ALLOW_MOCK_PROVIDERS` | Startup refuses it together with `DEMO_DEPLOYMENT` (mock adapters approve any payment) |
| `RATE_LIMIT_DISABLED` | Startup refuses `true` |
| `RAZORPAY_API_BASE` | Test emulator only |
| `RAZORPAY_KEY_ID` live (`rzp_live_`) | Real charges |
| `DEMO_DATABASE_CONFIRMED` / `DEMO_STAFF_PASSWORD` | CLI seed only, never the app |

### Optional / unused on Vercel demo

`EXPORT_DIR`, `METRICS_TOKEN`, `ALERT_WEBHOOK_URL`, `BACKUP_*`, `WORKER_DISABLED`
(already implied by `VERCEL=1`).

## 3. Database (approval required — do not run yet)

Against the **confirmed empty demo database only**:

```bash
# 1. migrations (owner role). NEVER prisma db push / migrate reset / migrate dev.
DATABASE_URL=postgresql://… npm run db:pg:deploy

# 2. Coders' Cafe sample data only (does not wipe other orgs; still refused
#    unless you confirm the database and set a unique staff password).
#    NODE_ENV must not stay production on this one-off command unless
#    ALLOW_DEMO_SEED=true is set for that command only.
set DEMO_DATABASE_CONFIRMED=true
set ALLOW_DEMO_SEED=true
set DEMO_STAFF_PASSWORD=<unique-12+-char-password>
set DATABASE_URL=postgresql://…
set PUBLIC_BASE_URL=https://<this-deployment>
npx prisma generate --schema prisma/postgres/schema.prisma
npm run db:seed:cafe
```

Then **remove** `ALLOW_DEMO_SEED`, `DEMO_DATABASE_CONFIRMED`, and
`DEMO_STAFF_PASSWORD` from the shell. Do not put them on Vercel.

Staff emails (password = the `DEMO_STAFF_PASSWORD` you chose, **not** the
local `Demo@12345` value):

- `cafe.owner@demo.local` (OWNER)
- `cafe.manager@demo.local` (MANAGER)
- `cafe.chef@demo.local` (KITCHEN)
- `cafe.cashier@demo.local` (CASHIER)

## 4. Deploy (approval required — do not run yet)

1. Confirm §2 variables are on the Vercel project.
2. Deploy the current git revision (no force).
3. Smoke: `GET /api/health/live` → 200; `GET /api/health/ready` → 200
   (migrations include `20261016100000_integrations_control_room`).
4. Sign in as owner with the unique password from §3.
5. Open Tables → a T01–T10 QR → guest menu (Coders' Cafe, unchanged) → cart →
   order → Razorpay test-mode payment (no live charge) → kitchen KDS.
6. Confirm the demo banner is visible and a live Razorpay key cannot be saved
   in this environment.

## 5. Rollback

- Instant: revert the Vercel deployment to the previous successful build.
- Data: restore the PostgreSQL backup taken **before** §3, or drop the
  disposable demo database. Do not `db:reset` a database that is not this demo.

## 6. What this demo does not prove

- Durable CSV exports (ephemeral `/tmp`)
- Multi-instance rate limiting
- Live payment capture
- Background jobs more often than the Vercel plan’s cron
- Multi-restaurant / multi-outlet expansion (explicitly deferred)
