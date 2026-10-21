# RESTORA — owner go-live checklist (Coders' Cafe)

Status 2026-10-21, branch `release/coders-cafe-2026-10-13`: `origin` is at
`e7fedf8`, which contains the 2026-10-20 review commits listed in the earlier
version of this line. Two local commits on top, **not pushed** (owner approval
needed): `44ece0d` QR tooling and the readiness documentation
(`docs/launch-readiness-2026-10-21.md` §6).
**Ready for the local investor demo. Not ready for SBI UAT or
Production.** Every item below needs a person or organisation outside this
codebase. Nothing here has been sent, deployed, migrated or published.

**Online guest payments are unavailable** until the real SBI adapter is
implemented from SBI's specification, passes SBI UAT and the owner approves
activation (A). Until then guest QR ordering is refused and guests order
through the staff; the local UPI emulator and `mock` provider are for a
disposable local demo only and are refused in Production.

| Verified locally (tests, E2E against the local UPI emulator, local databases) | Not verified, needs Production / external parties |
| --- | --- |
| Counter POS, KDS, back office, bill content and ESC/POS layouts; kitchen gate, late-payment hold, payment recovery logic; QR CLI and token audit; the nine migrations on a copy of the local database | SBI (A); recovery scheduler on Vercel (B); legacy Razorpay audit (C); Production database, backup and migrations (D); owner policy (E); real recipes (F); the physical printer (G); a release build (H); Production QR token rotation and new cards (I) |

Details live in the linked documents; this page is the order to do them in.
`docs/sbi-upi-integration.md` §6–7 gives the dependency order and who owns each step.

| # | Item | Owner / external party | Blocks |
| --- | --- | --- | --- |
| A | SBI direct UPI | Owner + SBI relationship manager | Any live online payment |
| B | Payment-recovery scheduler | Owner (Vercel / scheduler dashboard) | Production QR ordering |
| C | Razorpay legacy audit | Owner (read-only DB / Razorpay access) | Removing Razorpay code |
| D | Production database rollout | Owner (DB provider + Vercel) | Any Production deploy of this branch |
| E | Late-payment policy | Owner | Production QR ordering |
| F | Real recipes | Coders' Cafe kitchen | Stock and food-cost figures |
| G | Physical bill printer | Owner / counter staff | Printed bills at go-live |
| H | Release candidate | Owner (approval), then build PC | Desktop distribution |
| I | Table QR token rotation + new printed cards | Owner (written approval, closed window) | Real guests scanning table QRs |

## A. SBI direct UPI — `docs/sbi-upi-integration.md`

Today the `sbi_upi` adapter is a stub that refuses every call
(`SBI_UPI_IMPLEMENTED = false`). **Live SBI payment is not operational.** SBI
publishes no merchant UPI collection API, so none has been assumed or invented.

Ask SBI (the ready-to-send list is §2 of that document) for:

- [ ] The product name and written merchant approval for per-transaction dynamic
      UPI collection on the outlet's current account.
- [ ] The API specification: dynamic QR and/or UPI Intent creation (fixed
      amount, expiry, our order reference echoed back).
- [ ] The transaction-status API (by our reference), with its final and
      non-final states and rate limits.
- [ ] Callback security: signing / encryption scheme, IP allow-list, replay
      protection, retry policy, callback URL registration.
- [ ] UAT access, UAT credentials (delivered out of band, never in chat or
      source control) and the merchant / terminal identifiers that appear in
      responses.
- [ ] Refund process (API or manual) and the daily MIS / settlement report format.

Then: write the adapter against the specification, check it against the
acceptance matrix (§3.1), run the UAT scenarios in §5, and only after SBI signs
off follow the activation plan and checklist in §6.

## B. Payment-recovery scheduler — `docs/payment-safety.md` §3

Pending guest payments are re-checked by `GET /api/cron/payments` (POST also
accepted), header `Authorization: Bearer <CRON_SECRET>`, no body. Overlapping
calls are safe (each payment is claimed before it is probed).

Trigger status today (from `vercel.json` and the 2026-10-19/20 checks):

| Environment | Frequent trigger for `/api/cron/payments` |
| --- | --- |
| Production | **None.** Only the daily `/api/cron/worker` (20:30 UTC). |
| Preview | **None.** |
| Desktop / self-hosted | In-process worker every 30 s. |

- [ ] Confirm the Vercel plan. Pro or higher: add
      `{ "path": "/api/cron/payments", "schedule": "* * * * *" }` to
      `vercel.json` (Vercel sends the bearer header itself; Production only).
      Hobby: use an external HTTPS scheduler that keeps the header in a secret
      field, every 1–2 minutes. GitHub Actions `schedule` is a backstop only.
- [ ] Copy `CRON_SECRET` inside the dashboards only. **Never paste it into
      chat, tickets, logs or this repository.** Preview uses its own secret.
- [ ] Verify: the scheduler log shows `200` every run with counts only, and a
      test payment's `recheckedAt` advances.

## C. Razorpay transition — `docs/payments-razorpay.md`

- [x] New Razorpay checkout disabled in code; Razorpay is never a fallback.
- [x] Legacy verify, signed webhooks, refunds and settlement reconciliation
      retained (server-side only).
- [ ] Keep `RAZORPAY_*` keys and the webhook configured in Production until the
      audit below says no legacy payment can still need them.
- [ ] **Production payment / refund audit — BLOCKED.** Needs an owner-approved,
      genuinely read-only reporting connection (a read-only DB role or replica,
      and Razorpay dashboard read access). The queries are in "Outstanding
      obligations" of that document. Do not use a read-write credential for it.

## D. Production database rollout — `docs/payment-safety.md` §7

Production runs `main` `a80caa9`; its newest migration is
`20261016100000_integrations_control_room`. This branch adds **nine**, all
additive, applied in this order:

1. `20261017100000_growth_crm`
2. `20261018100000_floor_ops`
3. `20261019100000_purchasing_rules_expiry`
4. `20261020100000_staff_ops`
5. `20261021100000_append_only_rate_limit` (append-only triggers on `AuditLog`, `InventoryLedger`)
6. `20261022100000_cloud_sync`
7. `20261023100000_owner_recovery`
8. `20261024100000_upi_checkout`
9. `20261025100000_recipe_estimates`

- [ ] Supply Production's `DATABASE_URL` source (Vercel has no
      Production-scoped record as of 2026-10-19) and confirm it is not shared
      with Preview.
- [ ] Backup: provider snapshot or `pg_dump`, and **prove it restores** into a
      scratch database.
- [ ] Read-only check: `npx prisma migrate status --schema prisma/postgres/schema.prisma`.
- [ ] Schema before code: `npm run db:pg:deploy` (never `db push` or `migrate reset`).
- [ ] Deploy the build; `/api/health` readiness must be `ok` (it reports
      `pending` until `20261025100000_recipe_estimates` is applied).
- [ ] Validate: one counter cash order, its bill, the KOT, and the dashboard totals.
- [ ] Rollback: redeploy the previous build (it ignores the new columns and
      tables). Do not reverse migrations 1–7 (they hold business records and an
      audit guarantee). There are no down-migration files; only 8–9 have a
      documented manual reversal (SQL in `docs/payment-safety.md` §7, step 6),
      to be used only after a fresh backup.
- These migrations exist in the repository and were applied to a copy of the
  local database; that says nothing about Production. Only `migrate status`
  on Production shows what is applied there.
- Step-by-step preflight with stop conditions, including the backup trap
  (take the pre-upgrade backup from a checkout of `a80caa9`):
  `docs/production-migration-preflight.md`.

## E. Late-payment policy — **owner approval required**

Proposed (implemented as the default, not approved): a guest QR payment
verified more than **10 minutes** after the order was placed is recorded as
received but **not** sent to the kitchen; it is held for staff to send or
refund, with a `LATE_PAYMENT_HELD` alert. Configurable 1–240 minutes with
`GUEST_FULFILMENT_WINDOW_MINUTES`.

- [ ] Owner approves 10 minutes, picks another value, or rejects the policy.
- [ ] Staff briefed on what to do with a held order.

## F. Real recipes — `docs/kitchen-recipe-data/`

RESTORA holds 61 **draft, estimated** recipes written from dish names. They
are labelled *Estimated*, cannot be approved until quantities are confirmed,
and are excluded from stock consumption and food cost. Missing ingredient
costs show *Cost unavailable*, never ₹0.00. Keep them as drafts until the
kitchen supplies:

- [ ] Track progress per dish in `recipe-signoff.csv` (61 rows, menu order).
- [ ] Real quantity and unit per base-size portion for each of the 429
      ingredient lines (`recipe-lines.csv`), plus missing ingredients and yield.
- [ ] Portion yields and Medium / Large consumption factors for the 24 sized
      dishes (`size-factors.csv`).
- [ ] Ingredient prices actually paid, with bill date and GST basis
      (`ingredients.csv`), entered as goods receipts.
- [ ] Allergens **with evidence** (label photo or supplier sheet) per
      ingredient; without evidence RESTORA keeps showing *NOT VERIFIED*.
- [ ] Contents of the 3 combos (`not-covered.csv`) and the 10 unreadable
      menu-board entries.
- [ ] A named person signs off each recipe; then Confirm quantities → Approve.

## G. Physical bill printing — `docs/physical-printer-test.md`

| | Status |
| --- | --- |
| Software: bill content, payment states, 58/80 mm ESC/POS layouts, no side effects of printing | **Verified** (unit tests, BILL-001 E2E, ESC/POS over a real TCP socket) |
| Paper from the actual counter printer | **Not verified** — no receipt printer on the build PC |

With the actual intended receipt printer:

1. Print the printer's self-test page; note its IP and paper width.
2. Reserve a fixed private IP (10.x / 172.16–31.x / 192.168.x), port 9100.
3. Admin → Printers & drawer → Add printer: role Receipt, Network (ESC/POS),
   IP, port 9100, 32 characters (58 mm) or 42–48 (80 mm).
4. **Check** must say reachable; **Test print** must produce one cut slip.
5. POS: one test item, cash payment, Bill → **Send to printer**. Check name,
   address, items, sizes / add-ons, GST lines, ₹ total, "Paid", invoice
   number, nothing cut off.
6. Send again → "already sent"; **Reprint** with a reason → second copy, audited.
7. Unplug the network cable and send → must say *Print failed*; reconnect, Retry.
8. Cancel or refund the test order.
9. If using browser printing instead: method B in the document.
- [ ] Record printer model, width, method, date and who checked (record
      table at the end of `docs/physical-printer-test.md`).

## H. Release — `docs/desktop-release.md` "One version, one binary"

The published manifest (`src/site/release-manifest.json`) is `1.0.0-rc.1`, the
2026-10-06 build; its SHA-256 values match the draft GitHub release assets
(Setup `67ec34c5…`, Portable `3a1415ad…`). **No new release has been built or
published.** After the owner approves and commits the review work:

- [ ] Bump `package.json` to `1.0.0-rc.2` (and the rc.1 literals in `tests/site/website.test.ts`).
- [ ] Clean checkout of the approved commit, no dev server running:
      `npm run desktop:dist`, then `npm run desktop:verify`.
- [ ] `node scripts/site/release-manifest.mjs`, then independently
      `certutil -hashfile dist-desktop\RESTORA-Setup-1.0.0-rc.2.exe SHA256`
      (and Portable) against the manifest.
- [ ] Upload both to a new **draft** release; compare GitHub's asset digests
      with the manifest before publishing.
- [ ] Installers are unsigned (code signing not configured): decide before
      distributing to anyone outside the restaurant.

## I. Table QR tokens — `docs/qr-token-rotation.md`

- `artifacts/coders-cafe-qr/` (git-ignored; T01–T10 PNGs, a print-sheet PDF,
  `verification.json`): **confirmed 2026-10-20 by decoding every PNG**, all ten
  point to `https://restora-beta-six.vercel.app/t/<table token>`, the live
  Production site, so scanning one orders against Production. Keep them out of
  any investor-demo package unless that is intended. They are not deleted.
- New tokens are random (`src/server/qr/tableToken.ts`), but Production and the
  investor-demo database still hold the **legacy** tokens derived from the table
  code (`legacyCafeTableToken` in `prisma/coders-cafe/seed.ts`), which anyone
  reading the source can compute. They are not rotated by any code change.
- **Do not print, hand out or put on tables any existing Production QR** (from
  `artifacts/coders-cafe-qr/` or Tables → Download QR) until the audit below
  is clean or the approved rotation is done.
- [ ] Read-only audit: `npm run qr:audit` on a read-only Production connection
      (prints classes, never tokens; exit 2 while any legacy token remains).
      Rotate **every** table it flags: databases seeded before 2026-10-05 also
      hold `<outlet>-<table>` tokens (26 in `prisma/dev.db`).
- [ ] Written approval and a closed window; verified backup first.
- [ ] Rotate T01–T10 (Tables → **Rotate**), generate new labels with
      `npm run qr:tables -- --mode production --base-url https://<public host>`,
      verify each new label with a phone on mobile data (correct table) and that
      an old card shows "This QR code isn't working".
- [ ] Replace the printed cards; destroy the old ones. `qr:tables --mode
      production` refuses while T01–T10 still hold legacy tokens, so cards
      cannot be printed before rotating.
- [ ] Real phones: `docs/real-phone-qr-test.md` stage 1 (now) and stage 2
      (after SBI UAT).
- Every `npm run qr:tables` run needs an explicit `--base-url`; the CLI refuses
  to run without one.
- For an isolated local demo QR, read from the demo database and pass an
  explicit local address (`--base-url` is required on every run;
  `PUBLIC_BASE_URL` is never used):
  `$env:DATABASE_URL="file:./investor-demo-2026-10-20.db"; npm run qr:tables -- --base-url http://<this-PC's-LAN-IP>:3000 --purpose investor-demo`
  It only reads the tables, writes to the git-ignored `artifacts/table-qr/`,
  and labels the sheet *LOCAL INVESTOR DEMO — NOT FOR CUSTOMER USE* and
  *LOCAL TEST — NOT FOR CUSTOMER PRINTING*. Never use
  `scripts/qr/demo-assets.ts` for the demo: its only allowed origin is Production.
