# Common restaurant QR ordering

_Implemented 2026-10-21 on `release/coders-cafe-2026-10-13` (uncommitted when
written). Tested locally only: not deployed, not on any Preview or Production
database, no real payment. Production (`a80caa9`) does not have it._

One QR code for the whole restaurant, on every table. A guest scans it, sits
wherever they like, browses, orders and pays **without choosing a table**.
Staff then assign the table. Per-table QR codes keep working alongside it.

```
scan the restaurant QR → menu → cart → checkout → order placed (no table)
→ online payment verified by the server → kitchen (ticket: "QR · no table yet")
→ staff assign the table (POS → Open orders → QR tables) → served
```

## How it works

| Piece | What changed | Where |
| --- | --- | --- |
| The code | Each outlet can hold one random **common token** (`Outlet.guestQrToken`, 18 CSPRNG bytes, unique, nullable). The QR opens `/t/<token>` — the same guest address as a table code, so the whole guest site, payment and security path is reused. The token names no table and no outlet id; the server looks it up | `prisma/schema.prisma`, migration `20261026100000_outlet_common_qr` (SQLite + PostgreSQL) |
| Token rules | Table and common tokens share one namespace (a new token is checked against both); same generator; rotation kills the old code at once | `src/server/qr/tableToken.ts` |
| Resolution | `lookupTableToken` resolves a table token **or** a common token; outlet and organization always come from the database row of that token, never from the request. Unknown, malformed, revoked and inactive-outlet codes all get the same "not valid" answer | `src/server/services/guestOrdering.ts` |
| Ordering | A common-QR order is created with **no table** (`tableId` null — never inferred or defaulted), source / channel `QR`, `OPEN` until its online payment is verified; then the existing gate sends it to the kitchen (unchanged) | `placeGuestOrder` |
| Duplicate submissions | The idempotency key is scoped to the outlet's common QR (`qr:outlet:<outletId>:<key>`); a retry replays the same order. Table codes keep `qr:<tableId>:<key>` | `placeGuestOrder` |
| Abuse limits | Order rate limit: per table code as before (20 / 10 min); on the common code **per code and client IP** (20 / 10 min), so one phone cannot use up the restaurant's allowance. The IP is the address added by the outermost trusted proxy (`TRUSTED_PROXY_HOPS`, default 1), so a forged `X-Forwarded-For` prefix does not change it; never a phone number or anything else the client sends. Plus at most 30 unpaid common-QR orders placed in the last 15 minutes per outlet (abandoned, paid, cancelled, refunded and seated orders do not count), checked early **and again inside the order's transaction under a per-outlet lock** (new orders run READ COMMITTED on PostgreSQL, so a transaction-scoped advisory lock — `lockInTx` — makes concurrent counts run one at a time across every server instance; SQLite queues writes), so concurrent submissions cannot exceed it. Table codes get the same in-transaction recount under a per-table lock for their two limits. The per-IP write limit of the guest API still applies | `placeGuestOrder`, `src/app/api/qr/[[...path]]/route.ts` |
| Payment | Unchanged: online only, verified server-side; the browser's word is never enough; repeat confirmations release the order once | `payment.ts`, `kitchenGate.ts` |
| Staff: assign / change table | `POST /api/orders/:id/table` (`order.modify` at that outlet). No table yet → assigned (a table may be shared by one group's orders; a table being cleaned or of another outlet is refused; reservations are respected). Running order at a table → the normal move. Prepaid order still cooking → where to take it can be set or changed. Finished, cancelled, refunded → refused. Concurrent assignments: one wins, the other is told to reload. The counter sends `fromTableId` (the table it showed, `null` for none), so a request made from a stale screen is a `409` conflict instead of silently moving an order a colleague has just seated (callers omitting it keep the old behaviour). A mis-seated **unpaid** order can be moved only to a table with no running order (the normal move rule). **Past the table's guest limits** (3 waiting for payment / 6 unsettled QR orders, counting this one): refused once with the numbers (`409 TableGuestLimit`); the counter sees them and may choose **Assign anyway** (`overrideGuestLimits: true`), recorded in the audit row (`guestLimitOverride`, with the staff member). The limits themselves do not change: the table's own QR keeps refusing new guest orders until some are paid. Audited | `src/server/services/orderOps.ts` `setOrderTable` |
| Staff: list | `GET /api/orders/qr-tables?outletId=` (`order.view`): QR orders not finished, no-table first | `listQrOrdersForTables`; POS → Open orders → **QR tables** |
| Kitchen display | A common-QR ticket reads **"QR · no table yet"** with a "No table yet — ask the counter" badge, until a table is assigned (the board refreshes) | `src/features/kitchen/kds.ts`, `TicketCard.tsx` |
| Guest site | "Sit anywhere" instead of a table number; checkout says staff bring the order, and the guest may say where they sit in the note (optional) | `src/features/guest/` |
| Admin | Tables screen → **Restaurant QR (any table)**: issue, download (SVG), rotate, disable. Outlet managers only (`outlet.manage`) | `src/features/backoffice/tables.tsx`, `/api/master/outlets/:id/common-qr` |
| Audits | `npm run qr:audit` lists the common code as row `(restaurant QR)` with its class; `scripts/ops/prod-readonly-audit.sql` section 6b classifies it (skipped on a schema without the column). Tokens are never printed | `scripts/qr/audit-table-tokens.ts`, `scripts/ops/prod-readonly-audit.sql` |
| Staff QR scanner | Reports a valid common code as "restaurant QR (any table)" | `src/server/qr/scan.ts` |

## Generating the code

1. Back office → **Floors & tables** → **Restaurant QR (any table)** →
   **Issue restaurant QR**.
2. **Open the back office at the restaurant's public address** (or set
   `PUBLIC_BASE_URL`) before downloading: without `PUBLIC_BASE_URL` the code
   points at the address the screen is open at.
3. **Download QR (SVG)**, print, and scan the print with a phone before putting
   it out: it must open the menu with "Sit anywhere".
4. Rotate if a print goes astray (every print of the old code stops working at
   once); Disable to stop common-QR ordering (re-issuing creates a **new**
   code: old prints never work again).

The production label CLI (`npm run qr:tables`) still prints **table** codes
only; the common code is downloaded from the Tables screen.

## Staff instructions

- **Counter / captain:** POS → **Open orders** → **QR tables**. Orders marked
  *no table yet* come first. Find the guest (name, note, the order on their
  phone), then **Assign table** → pick the table. If it was wrong, **Change
  table** while the food is still being prepared.
- **Kitchen:** a ticket with **No table yet — ask the counter** is cooked as
  usual; before sending it out, check the ticket again or ask the counter
  where it goes. Never guess a table from another order.
- **Guests asking at the counter:** they do not need a table to order; their
  order page shows its progress.
- **"Table … is over its guest limits":** the table already has several QR
  orders waiting for payment (or unsettled). Check it is really the same
  group, then **Assign anyway** (your name goes in the audit log) or pick
  another table. Guests at that table cannot order more from its QR until some
  orders are paid; that is intended.

## Guest phone numbers and customer records

A guest who gives a phone number is linked to the restaurant's customer record
for that number (found or created). Since 2026-10-22 this happens **inside the
order's own transaction** (`placeOrder` with `customer`), so an order refused
there — a limit reached by a concurrent submission, an item that sold out, a
reused idempotency key — leaves **no** customer record or customer audit row
behind. Two first orders from one new number at the same moment create one
record (a per-phone transaction lock on PostgreSQL). An existing record's name
is never changed, and the guest is never told whether the number was known.
Records created before this change by refused orders are not cleaned up
automatically (they are real phone numbers guests typed; delete by hand only
if the owner wants to).

## Rollout

1. Deploy a build containing this change (needs migration
   `20261026100000_outlet_common_qr`, the tenth after `a80caa9`; follow
   `docs/production-migration-preflight.md`). **Not authorized yet.**
2. Keep the table QR codes in place. Issue the restaurant QR, print one or two,
   and run a staffed trial (real phones, `docs/real-phone-qr-test.md`; online
   payment requires SBI UPI, which is not live — without it QR ordering of any
   kind is refused with "please order with the staff").
3. When the trial is signed off, put the restaurant QR on every table. Table
   codes can then be disabled per table (Tables screen) or left in place; both
   work at once.

## Security review (2026-10-21, later the same day)

| Severity | Finding | Status |
| --- | --- | --- |
| High (fixed) | The 30-order cap was count-then-insert: five simultaneous orders from 29 waiting all went through (34). | Fixed: recount inside the order's transaction under the outlet's advisory lock (`lockCommonQrCap`). Correction (2026-10-21, found on PostgreSQL): new orders run READ COMMITTED there, so the recount alone did not serialize; the lock does (SQLite: one writer). Test: from 29, five at once → exactly one succeeds |
| Medium (deployment requirement) | Rate limits default to an **in-process** store. On serverless / several instances each instance counts separately, so "20 per phone" becomes 20 per phone per instance. Production only warns. | Set `RATE_LIMIT_STORE=database` in Production (shared atomic counter, `RateLimitWindow`). Not enforced in code (owner / deployment decision). If the database store fails it degrades to in-process counting, logged and counted in `restora_rate_limit_store_errors_total` (tested) |
| Medium (owner decision) | Guests on the café **Wi-Fi share one public IP**, so on Wi-Fi the 20 orders / 10 min per "phone" is shared by everyone on that network (mobile-data guests have their own). A client-supplied device id would be trivially bypassed, so none is used. | Kept at 20 (no correctness defect). Owner to confirm or raise it for the café's peak |
| Low | The order limit is applied after the code is resolved (one database read per request): invalid codes cost a read but consume nobody's allowance; the per-IP write limit still bounds them. | Accepted |
| Info | `.strict()` order body: a request naming `tableId` / `outletId` is refused, nothing is created (tested). Outlet and organization come only from the token's row. Tables have no "inactive" flag (only statuses); `CLEANING` is refused for assignment. | — |

Verified by test: CSPRNG tokens and shared-namespace collision handling; tokens
absent from audit rows and the qr:audit / audit-SQL output; uniform 404 for
unknown / malformed / disabled / inactive codes (disabled indistinguishable
from never-existing); management endpoints need a session, `outlet.manage` at
that outlet and a same-origin write; assignment needs `order.modify`, rejects
other outlets / organizations / cross-origin writes and leaves no audit row
when refused; forged `X-Forwarded-For`; 19 → 20 → 21 orders; window expiry;
independent phones; duplicate replay; SBI selected → no order created;
server-verified payment releases the kitchen ticket exactly once.

## Before a staging trial

- Deployment settings: `RATE_LIMIT_STORE=database`; `TRUSTED_PROXY_HOPS`
  = the number of proxies in front of the app (`docs/production-infrastructure.md`;
  confirm it for the actual hosting with one test request before the trial); `PUBLIC_BASE_URL` set so the printed
  code points at the public address.
- Migrations: the ten after `a80caa9` on the staging database, following
  `docs/production-migration-preflight.md` (backup verified with
  `--expect-migration`).
- Staff briefing (counter, captains, kitchen): the "Staff instructions" above,
  with a dry run of assigning and changing a table.
- Physical checks: print the restaurant QR on the real card stock and scan it
  with an iPhone and an Android phone on the café Wi-Fi and on mobile data;
  the order must show "Sit anywhere"; the receipt printer test
  (`docs/physical-printer-test.md`). Not done yet.
- Online payment: needs SBI UPI UAT (`docs/sbi-upi-integration.md`); until
  then a staging trial can cover scanning, menu and cart only, or run with the
  test bank emulator on a non-Production deployment.

## Rollback and limits

- Turn it off: **Disable** the restaurant QR. Orders already placed are kept
  and still appear to staff. Table codes are unaffected.
- No old code can be restored: rotating or disabling is final for that print.
- The migration is additive (one nullable column + unique index); the
  previous build ignores it, so redeploying the previous build is a valid
  rollback. Do not drop the column while any build uses it.
- What staff do changes: someone must assign tables; until they do, the
  kitchen sees "no table yet". The guest's note is free text and is not
  checked.
- Limits are abuse guards, not capacity planning: 20 orders per 10 minutes per
  device on the common code and 30 recent unpaid common-QR orders per outlet.
  A determined attacker with many IP addresses could still fill the 30
  (orders reach the kitchen only after a verified payment, so the harm is
  clutter for staff, not tickets). Table codes keep their per-table limits.
- A shared code means anyone who has seen it can order (as with any QR menu);
  rotating the restaurant code replaces every print.

## Verification (2026-10-21, local only)

- `tests/domain/common-qr.test.ts` (19): issue / rotate / disable, namespace
  shared with table codes, menu of the right restaurant with no table,
  invalid / unknown / revoked / inactive codes, order without a table,
  CASH refused, duplicate replay vs. table-code key, server-verified payment
  releases once and keeps no table, KDS unassigned → assigned, staff assign /
  share / cleaning refused / prepaid relabel / finished refused / other
  outlet's table / no permission / cancelled / concurrent, counter list order,
  per-device rate limit, recent-unpaid cap, audit row, scanner.
- `tests/ui/common-qr-ui.test.tsx` (4): QR tables tab assigns through the
  server, stage wording, KDS ticket badge, guest "Sit anywhere".
- Existing table-QR, payment, POS and KDS suites unchanged in behaviour (the
  only test edits are null-safe reads of `table.code`).
- PostgreSQL 16 (disposable): the ten migrations apply on top of `a80caa9`'s
  schema, `migrate diff` exit 0, `db-verify` INTEGRITY OK; the read-only audit
  skips the common-QR section before the upgrade and classifies it after.
