# Online payment safety, kitchen gate, recovery and the direct-bank UPI checkout

Status (2026-10-20, branch `release/coders-cafe-2026-10-13`, committed locally in `2ba65ee`, not pushed):

| Item | State |
| --- | --- |
| Kitchen gate for guest QR orders (server-side) | Implemented, tested |
| Bank calls outside DB transactions / locks; compare-and-set apply | Implemented, tested |
| Late-payment fulfilment window (hold for staff) | Implemented, tested |
| Pending-payment recovery (bounded, fair, claimed) | Implemented, tested |
| Recovery schedule on Vercel | **BLOCKED** — needs an external scheduler (§3) |
| Direct-bank UPI checkout (QR screen, polling, callbacks) | Implemented against the local bank **emulator** only |
| SBI adapter (`sbi_upi`) | **NOT IMPLEMENTED** — SBI specification / UAT missing (`docs/sbi-upi-integration.md`) |
| Razorpay | Retired for new checkouts; legacy settlement / refunds kept (`docs/payments-razorpay.md`) |

**Live-payment status: NOT IMPLEMENTED for SBI.** While `PAYMENT_PROVIDER` is
`sbi_upi` (or the retired `razorpay`), online payment reports *unavailable*, and
because guest QR orders are paid online before they reach the kitchen, **guest
QR ordering is refused** ("please order with the staff"). Counter POS, captain
and kitchen workflows are unaffected.

## 1. The kitchen gate

A guest's own QR order (source `QR`, no staff creator) reaches the kitchen only
when verified online payments cover its total.

- **Enforced in one place:** `kot.createKOTsForOrder` (the only code that
  creates kitchen tickets) calls `kitchenGate.assertKitchenReleasableTx`. That
  covers POS accept / submit, captain rounds and fire, desktop Cloud Sync
  `ACCEPT` (answered `CONFLICT`) and the prepaid release in
  `payment.verifyPayment`. There is no override for any role.
- **Verified** = a `SUCCESS` / `PARTIAL` payment with a provider in
  `GATEWAY_PROVIDERS` and `verifiedAt` set by `verifyPayment` after the bank
  confirmed it. Counter payments (cash, card terminal, till UPI) cannot be
  created for, or verified into, a guest QR order still waiting for its online
  payment (`assertCounterPaymentAllowed`). Guest checkout refuses
  `paymentMethod: "CASH"` (422) and ordering while online payment is
  unavailable.
- **Exactly once:** the verified payment, `PAID`, the invoice, inventory and the
  KOTs are written in one transaction; repeats, callbacks, the recovery job and
  concurrent confirmations find the payment already decided.
- **Split bills:** each part is a separate online payment; the kitchen gets the
  order once, when the last part makes verified payments cover the total.
- **Staff orders are never gated.** Cash / UPI / card / split payments, holds,
  rounds and fire work as before.
- **Older orders:** pay-at-the-counter QR orders that were already `SENT` stay in
  the kitchen and can still be paid at the counter; new kitchen tickets for such
  an order are refused until verified online payments cover it.

## 2. Verifying a payment

`verifyPayment` asks the bank **outside** any database transaction and outside
the outlet's settlement lock (`askGateway`), then applies the answer in one
short transaction that re-reads the payment and applies it only if the amount
and stored reference are unchanged (compare-and-set on the status). A timeout,
network error or malformed answer writes nothing: the payment stays `PENDING`.

What counts as paid (direct-bank adapters, `integrations/payment/upiStatus.ts`
`decideUpiTxn`): a **final** success status for **our** transaction reference,
**our** merchant, the **exact** amount in paise and **INR**. A final success
that does not match is a *mismatch*: never paid, the payment stays `PENDING`,
and a HIGH `RECONCILIATION_MISMATCH` anomaly asks staff to check the bank
statement. Pending / deemed / unknown statuses stay `PENDING`; a final failure
or an expired QR is `FAILED` and the guest may get a new QR.

Never proof of payment: the guest's "I paid", a screenshot, the UPI app
returning to the browser, a URL, or any payload the browser sends (the
emulator adapter ignores it; the SBI adapter must too).

Refunds still call the bank inside the outlet lock: money going out stays
serialized per outlet, and the stable idempotency key plus the unique
`Refund.providerRef` stop it being applied twice.

## 3. Pending-payment recovery and scheduling

`services/paymentRecovery.ts` → `recheckPendingPayments` asks the bank about
`PENDING` online payments that are older than 2 minutes and younger than
`PAYMENT_RECHECK_MAX_AGE_HOURS` (default 26) and have a bank reference:

- a status probe (`getPaymentStatus`); only `CAPTURED` / `FAILED` leads to the
  full `verifyPayment` (which asks the bank again and checks everything);
- **fair:** payments younger than 1 hour are probed at most every 2 minutes,
  older ones every 30 minutes, tracked durably in `Payment.recheckedAt`; the
  least recently probed go first (never-probed first, then newest), the young
  lane before the old one — abandoned checkouts cannot starve a fresh payment;
- **claimed:** each payment is claimed (compare-and-set on `recheckedAt`)
  before it is probed, so concurrent workers / cron calls never probe or settle
  the same payment twice;
- **bounded:** at most 20 probes per run and no new probe after the caller's
  deadline; it runs **last** in the worker tick, after deliveries, stuck-work
  recovery, scheduled jobs and housekeeping;
- payments whose adapter is refused on this deployment, or has no status API,
  are skipped — never probed or settled — but their `recheckedAt` is stamped
  like a probe, so a pile of them cannot fill every run's read window ahead
  of payable payments (tests/domain/payment-recovery.test.ts); the MOCK adapter answers
  `UNKNOWN` and is never settled by this job; Razorpay (legacy) payments are
  still recovered.

### Who runs it

| Deployment | Trigger | Effective? |
| --- | --- | --- |
| Self-hosted / desktop (`node server`, Electron) | In-process worker every 30 s (`startWorker`, `instrumentation-node.ts`; disabled when `VERCEL=1` or `WORKER_DISABLED=true`) | Yes |
| Vercel | `vercel.json` cron → `GET /api/cron/worker` at `30 20 * * *` (once a day) | **No — daily only** |
| Vercel + external scheduler | `GET /api/cron/payments` every 1–2 min | Yes, **once configured — not configured or proven yet (BLOCKED)** |

The repository does not record the Vercel plan. A more frequent schedule was
**not** added to `vercel.json`: on a plan that limits cron frequency the deploy
would be refused, and the plan has to be confirmed first.

### External scheduler (to configure — needs owner approval)

- **Request:** `GET https://<production-domain>/api/cron/payments`
  (POST also accepted), header `Authorization: Bearer <CRON_SECRET>`, no body.
- **Frequency:** every 1 minute (every 2 is acceptable). Overlapping calls are
  safe. The route returns within ~40 s plus one bank timeout (`maxDuration` 60).
- **Secret:** the existing `CRON_SECRET` of that environment, stored only in the
  scheduler's secret store. Never paste it into chat, tickets or logs.
- **Response:** `200 {"ok":true,"result":{"checked":…,"settled":…,"failed":…,"stillPending":…,"errors":…,"claimLost":…,"budgetExhausted":…},"ms":…}` —
  counts only, never a payment id, reference or amount. `401` = wrong / missing
  secret. `503` = the job failed (alert on repeated 503s).
- **Verify it works:** after enabling, the scheduler's log shows `200` every
  minute, and the deployment logs show `payment_recheck` events when something
  is settled. On a Preview: place a QR order, pay it at the bank (UAT), close
  the browser before it confirms, and see the order become `PAID` within ~3
  minutes without anyone opening the page.
- **Options:** Vercel Cron with `"* * * * *"` on a plan that allows it (add a
  second entry for `/api/cron/payments` to `vercel.json`); or any HTTPS
  scheduler (e.g. a GitHub Actions `schedule`, cron-job.org, the hosting
  provider's scheduler). Keep the daily `/api/cron/worker` entry either way.

**Choosing the trigger (final closeout, 2026-10-20).** The configured trigger in
each environment today: Production none frequent (daily `/api/cron/worker` only),
Preview none frequent, desktop / self-hosted the in-process 30 s worker. So
**recovery does not run automatically every few minutes on Vercel yet.**

| Option | Cadence it can really give | Notes |
| --- | --- | --- |
| Vercel Cron, Pro (or higher) plan | every minute | Add `{ "path": "/api/cron/payments", "schedule": "* * * * *" }` to `vercel.json`. Vercel sends `Authorization: Bearer $CRON_SECRET` itself. Runs on Production deployments only (not Previews). On Hobby, crons are limited to once a day and such a schedule is refused at deploy time. |
| External HTTPS scheduler (e.g. cron-job.org, the owner's own server's crontab, an uptime monitor with custom headers) | every 1–2 min | Must support a custom `Authorization` header and keep it in a secret field. |
| GitHub Actions `schedule` | **every 5 min at best, often delayed or skipped under load** | Acceptable only as a backstop, not as the primary trigger. |

Preview deployments behind Vercel Deployment Protection also need the
`x-vercel-protection-bypass` header (a Protection Bypass for Automation secret)
on each scheduled call; use Preview's own `CRON_SECRET`, never Production's.

Owner steps (need dashboard access; not done here): (1) confirm the Vercel plan;
(2) pick one row above; (3) set the job to `GET /api/cron/payments` with the
header from the environment's `CRON_SECRET` (copy it inside the dashboards,
never through chat); (4) check the first runs return `200` with
`"checked":0` or more; (5) run the Preview test in "Verify it works" before
calling recovery live.

Until this is in place on Vercel, a guest who pays and closes the page is
settled only when the guest reopens the order page and taps *Resume payment*
(the server then asks the bank), by a bank callback (once SBI provides one), or
by the daily sweep.

## 4. Late payments (fulfilment window)

`GUEST_FULFILMENT_WINDOW_MINUTES` (default **10**, 1–240; the owner should
confirm the number). Measured from order placement to the moment RESTORA
verifies the payment. **Policy status 2026-10-20: proposed, NOT approved for
Production.** The 10 minutes is only the code default; the owner must confirm
the number (or set another) before the Production pilot, and confirm that a
late payment is held for staff rather than refunded automatically.

- Verified **after** the window: the payment is recorded as `SUCCESS` (the
  money is real), but the order is **not** sent to the kitchen and not
  settled (no KOT, no invoice, no inventory). A HIGH `LATE_PAYMENT_HELD`
  anomaly and a staff alert are raised; the guest sees *"Payment received —
  please see the staff"* (never "preparing"); the POS lists it as *"QR · paid
  late · send or refund"*.
- **Staff decide:** *Send* on the POS releases the tickets once and settles the
  bill (the gate passes because it is paid); or *refund* the payment (Refund on
  the payment; bank refund via the provider) and then cancel the order (cancel
  is refused while it holds money). Nothing is refunded automatically.
- An unpaid order past the window gets no new QR (*"too old to be sent to the
  kitchen"*); an open checkout can still complete and is then held.
- A payment for a **cancelled** (or already settled) order is never released:
  it is recorded with the existing *unapplied capture* audit and a HIGH
  `RECONCILIATION_MISMATCH` anomaly asking for the refund.

## 5. The guest's checkout (direct-bank UPI)

1. The guest places the order (server-priced, `OPEN`, not in the kitchen).
2. `POST /api/qr/orders/:id/payments` creates the payment for the server's
   outstanding amount; the provider creates a transaction-specific QR for that
   amount and RESTORA's reference (`RST<paymentId>`). The QR's public data and
   expiry are stored on the payment (`checkoutData`, `checkoutExpiresAt`) so a
   refresh shows the **same** QR, never a second bank transaction.
3. The page shows the QR (rendered by RESTORA as inline SVG; no third-party
   script), the amount, its validity, and on a phone an *Open a UPI app* link
   when the bank provides an intent URI. It can be scanned from another phone.
4. While the QR is shown the page calls `POST …/payments/confirm` every 4 s;
   the server asks the bank. *Payment successful* appears only when the server
   answers with the committed, verified payment. After expiry the server is
   asked once more, then the guest can get a new QR.
5. A signed bank callback (`POST /api/webhooks/payment/<provider>`) only
   triggers `verifyPayment`, which asks the bank itself; duplicates are
   idempotent. Today every `sbi_upi` callback is refused (401, nothing
   recorded) until the adapter exists; of the direct-bank adapters, only the
   local emulator's callbacks can be authenticated.

## 6. Production safeguards

- `PAYMENT_PROVIDER` must be one of `sbi_upi`, `upi_emulator`, `mock`,
  `razorpay`; `mock` and `upi_emulator` and any `UPI_EMULATOR_*` variable are
  refused at startup in production unless `ALLOW_MOCK_PROVIDERS=true` (non-public
  test deployments only); the adapters refuse themselves too
  (`assertMockAllowed`).
- On Vercel's Production environment (`VERCEL_ENV=production`) there is no
  opt-in at all: `ALLOW_MOCK_PROVIDERS=true`, `PAYMENT_PROVIDER=mock` and
  `PAYMENT_PROVIDER=upi_emulator` are refused at startup whatever else is set
  (tests/ops/infrastructure.test.ts). Preview may still run the emulator.
- New checkouts use `getCheckoutProvider()`: never Razorpay, no fallback.
- The SBI adapter refuses every call, reports unhealthy and rejects every
  callback until implemented from SBI's specification.
- Bank credentials are server-side environment variables only; checkout data
  sent to the browser is public (QR string, amount, expiry) and is tested not
  to contain the API key.

## 7. Pilot, monitoring and incidents

**One-outlet pilot (after SBI UAT sign-off):** enable `sbi_upi` LIVE on one
outlet's deployment; brief staff on *paid late* and refunds; watch for a week:
anomalies (`LATE_PAYMENT_HELD`, `RECONCILIATION_MISMATCH`), `payment_recheck`
counts, the scheduler's `200`s, and the bank's MIS against RESTORA's payments
each morning.

**What to watch:** repeated `503` from `/api/cron/payments` (the scheduler's
own alerting); any `RECONCILIATION_MISMATCH` or `LATE_PAYMENT_HELD` anomaly
(raised automatically, in-app). Payments `PENDING` for more than 15 minutes
have **no automatic alert yet** — check daily with `Payment.status = 'PENDING'
AND createdAt < now() - interval '15 minutes'` during the pilot.

**Bank down:** health check fails → online payment shows unavailable and QR
ordering is refused; staff take orders at the POS. Pending payments are
re-asked automatically when the bank is back.

**Rollback:** redeploy the previous build. Do **not** set
`PAYMENT_PROVIDER=razorpay` to "restore" online payment: Razorpay is retired and
the code refuses it for new checkouts. Every migration listed below is
additive (columns, tables, indexes, triggers); the previous build ignores them,
so a rollback needs no schema reversal. The repository has **no down-migration
files**; the only documented reversal is the manual SQL in step 6 below, for
this release's own two migrations.

### Production migration procedure (not run — needs the owner's approval)

New in this release (both histories, `prisma/migrations` and
`prisma/postgres/migrations`), additive only:

| Migration | Change |
| --- | --- |
| `20261024100000_upi_checkout` | `Payment.checkoutData`, `checkoutExpiresAt`, `recheckedAt` (nullable) + index `Payment(status, createdAt)` |
| `20261025100000_recipe_estimates` | `RecipeVersion.estimated BOOLEAN NOT NULL DEFAULT false` |

**Production is further behind than this release (checked 2026-10-20).** The
live Production build is `main` `a80caa9`, whose newest PostgreSQL migration is
`20261016100000_integrations_control_room`. A deploy of this branch therefore
applies **nine** migrations, in this order: `20261017100000_growth_crm`,
`20261018100000_floor_ops`, `20261019100000_purchasing_rules_expiry`,
`20261020100000_staff_ops`, `20261021100000_append_only_rate_limit` (adds
triggers that refuse UPDATE / DELETE / TRUNCATE on `AuditLog` and
`InventoryLedger`), `20261022100000_cloud_sync`, `20261023100000_owner_recovery`,
`20261024100000_upi_checkout`, `20261025100000_recipe_estimates`. All nine were
checked: no dropped table or column, and no NOT NULL column without a default,
so the `a80caa9` code still runs on the migrated schema (`a80caa9` never
updates or deletes `AuditLog` / `InventoryLedger` rows, so the triggers do not
break it). The same nine applied cleanly to a copy of the local `dev.db` with
every table's row count unchanged (SQLite, 2026-10-20). **None has been applied
to Production by this work**: a migration being in the repository, or applied
to a local copy, does not mean it is applied to Production; only step 3's
`migrate status` against Production shows that. Vercel has no
Production-scoped `DATABASE_URL` record (observed 2026-10-19), so a new
Production deploy would start without a database until the owner sets one.

1. Confirm which database Production uses (its `DATABASE_URL` is not on
   record for this work — BLOCKED until the owner supplies it) and that it is
   not shared with Preview.
2. Take a provider snapshot / `pg_dump` and check that it restores (a scratch
   database restore of the dump).
3. Read-only: `npx prisma migrate status --schema prisma/postgres/schema.prisma`
   with that `DATABASE_URL` — note every pending migration (older pending ones
   from earlier releases deploy first, in order, by the same command).
4. Schema first: `npm run db:pg:deploy` (= `prisma migrate deploy`; never
   `db push` / `migrate reset`). The new build's readiness check reports
   `pending` until `20261025100000_recipe_estimates` is applied
   (`EXPECTED_MIGRATION`), so deploy the schema before the code.
5. Deploy the build; check `/api/health` readiness is `ok`; place one test
   order on the counter (cash) and view its bill.
6. Rollback: redeploy the previous build (it ignores the new columns and
   tables). Do not reverse the earlier seven migrations: their tables hold
   business records (CRM, floor, staff, sync, recovery codes), and dropping the
   append-only triggers removes an audit guarantee. Only
   if this release's two columns themselves must go, after a fresh backup:
   `DROP INDEX "Payment_status_createdAt_idx"; ALTER TABLE "Payment" DROP COLUMN "checkoutData", DROP COLUMN "checkoutExpiresAt", DROP COLUMN "recheckedAt"; ALTER TABLE "RecipeVersion" DROP COLUMN "estimated";`
   and delete the two rows from `_prisma_migrations`. Dropping
   `checkoutData` loses the QR shown for any payment still pending.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| Guests see "online payment isn't available" | `PAYMENT_PROVIDER`; for `sbi_upi`, expected until implemented; the provider's health check; startup warnings. |
| Paid but the order did not reach the kitchen | Was it late (`LATE_PAYMENT_HELD`)? Is the payment still `PENDING` (bank undecided, mismatch anomaly)? Is the recovery scheduler running? |
| Payment stuck `PENDING` | `recheckedAt` advancing? Scheduler `200`s? Any `RECONCILIATION_MISMATCH` for it? |
| Two payments for one order | The second capture is flagged (`RECONCILIATION_MISMATCH`); refund it. |
