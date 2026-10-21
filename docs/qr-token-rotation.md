# Table QR token rotation (Production)

A table QR is `https://<site>/t/<qrToken>`. The token is the only thing an
anonymous guest presents, so anyone who knows it can open that table's menu
and place orders there.

## Why this exists

Until 2026-10-20 the Coders' Cafe demo seed stored tokens computed from public
constants (`legacyCafeTableToken` in `prisma/coders-cafe/seed.ts`: a SHA-256
of `restora-demo:coders-cafe:table:<code>`). Anyone with the source can work
out those tokens. Production was seeded that way, so its T01–T10 codes, and
the images in `artifacts/coders-cafe-qr/`, carry guessable tokens.

A second, even simpler pattern exists in databases seeded before 2026-10-05:
the general demo seed (`prisma/seed.ts` before commit `3b88053`) stored
`<outlet code>-<table code>` (for example the G1 table of outlet HYDCEN got
`HYDCEN-G1`). `prisma/dev.db` still holds 26 of them (audit below). Whether
Production holds any is unknown until the audit is run there; the audit
reports both patterns as `legacy-derivable` since 2026-10-21 (before that it
reported the second one as `nonstandard`, which still failed the gate with
exit code 2, but looked less urgent than it is). **Rotate every table the
audit flags, not only T01–T10.**

New tokens now always come from `src/server/qr/tableToken.ts`: 18 bytes from
the OS CSPRNG, written as 24 base64url characters. The seed, the starter
import and the Tables screen's **Rotate** all use it. Code changes never
rewrite stored tokens, so Production keeps its current tokens until an
authorised operator rotates them as described below.

## What rotation changes

- `POST /api/master/tables/:id/qr` (Tables screen → **Rotate**) replaces only
  that table's `qrToken` (and `updatedAt`), then writes one
  `RestaurantTable UPDATE { qrRotated: true }` audit row. The audit row does
  not contain the token.
- Table ids, codes, floors, menu, orders, payments, invoices and history are
  not touched.
- The old token stops working at once. A guest on the old link sees the
  page "This QR code isn't working" (the API answers 404 "This table QR
  code is not valid"). There is no overlap window.
- Orders already placed are unaffected and still appear to staff. A guest who
  is mid-visit loses their `/t/<old>` page, so rotate while the café is closed.

## Checklist

Needs: an OWNER or MANAGER login for the outlet, and written approval for this
rotation. Do not run a demo seed or a `--reset` against Production.

1. **Approve and schedule.** Pick a closed window. Make sure there are no open
   QR orders or unpaid guest checkouts (Orders screen).
2. **Back up.** Take and verify a backup by following
   `docs/production-runbook.md` §4 (Restore / disaster recovery).
3. **Record the starting state (read-only).** If you have a read-only
   connection to the database:
   `DATABASE_URL=<prod, read-only> npm run qr:audit`
   This prints organization, outlet, table and class, never the token.
   Expected before rotation: `legacy-derivable` for T01–T10 (and for any
   demo-group tables Production holds), exit code 2. Any `nonstandard` row is
   a hand-set or test value (for example a `load-` token left by
   `scripts/ops/load-test.mjs`): rotate it too, or **Disable** it if the table
   should not exist. Without database access, note which tables have a QR on
   the Tables screen.
4. **Rotate.** Tables screen → each table the audit flagged → **Rotate**
   (there is no bulk rotate; one click per table). Rotate only the tables in
   scope. Don't use **Disable** unless that table should stop
   taking QR orders.
5. **Generate the new labels.**
   `npm run qr:tables -- --mode production --base-url https://<public host>`
   with `DATABASE_URL` set to Production. `--base-url` is required on every
   `qr:tables` run; `PUBLIC_BASE_URL` is never used as a fallback. This only reads the database. It
   writes to the git-ignored `artifacts/table-qr/production/`. Since
   2026-10-21 production mode **refuses** (exit 1, nothing written) while any
   T01–T10 table still holds a derivable legacy token, so labels cannot be
   printed before step 4. The CLI covers Coders' Cafe T01–T10 only; for other
   tables download each QR from the Tables screen. Treat the label files as
   secrets until they are on the tables (anyone holding them can order at that
   table): print them on the restaurant's own printer, don't e-mail or chat
   them, and delete `artifacts/table-qr/production/` afterwards (rerun the
   command if a reprint is needed).
6. **Verify the new codes.**
   - Scan every new label with a phone. It must show the right restaurant and
     table code.
   - Scan one old printed card or old image. It must show "This QR code isn't working".
   - Run `npm run qr:audit` again. Every rotated table must be `random`, with
     no `legacy-derivable` left, and exit code 0.
   - Audit log: one `qrRotated` row per rotated table, made by your user.
7. **Swap the physical cards.** Put out the new cards, then collect and
   destroy the old ones.
8. **Retire the legacy assets.** Archive or delete `artifacts/coders-cafe-qr/`
   (git-ignored, now dead links). Don't run `scripts/qr/demo-assets.ts` for
   Production again: it can only draw the legacy tokens.

## Replacing the cards without disrupting service

- **Production today still runs build `a80caa9`, which accepts QR orders paid
  at the counter** (`paymentMethod: "CASH"`). A rotation there ends the page of
  any guest mid-visit, so it needs the closed window below. On a build of this
  release with `PAYMENT_PROVIDER=sbi_upi` (a stub until SBI is live) guest QR
  ordering is refused anyway ("Online payment isn't available right now …
  Please order with the staff"), so rotating then cannot interrupt a guest
  order. Either way, rotate before any card is printed for guests.
- Do it in one closed window, in this order: rotate (step 4) → generate
  (step 5) → print → verify each card with a phone (step 6) → swap cards
  (step 7). The CLI's refusal makes the wrong order (print, then rotate)
  impossible for T01–T10.
- Prepare before the window: the receipt / label printer tested, card stock,
  one person rotating and one checking with a phone. For 10 tables expect
  well under an hour; nothing else in RESTORA is touched.
- If a card cannot be printed before opening, that table's old card shows
  "This QR code isn't working": put a "please order at the counter" sign on
  it. Do not restore or reuse an old token.
- If the window must end half-way, the tables already rotated stay rotated;
  continue later with the rest. Re-run `npm run qr:audit` to see what is left.

## Local rehearsal (2026-10-21, no Production access)

Run on byte copies in a scratch folder; `prisma/dev.db` (SHA-256 prefix
`249a564f`) and `prisma/investor-demo-2026-10-20.db` (`6f3ad94e`) were read
only to copy them and are unchanged. Tokens were never printed.

| Step | Command / action | Result |
| --- | --- | --- |
| Audit, copy of `dev.db` | `DATABASE_URL=file:<copy> npm run qr:audit` | 36 tables: 10 `legacy-derivable` (Coders' Cafe T01–T10) + 26 `<outlet>-<table>` (demo group; `nonstandard` before the classifier fix, `legacy-derivable` after); exit 2 |
| Audit, copy of the investor-demo DB | same | 10 tables, all `legacy-derivable`; exit 2 |
| Labels before rotation | `npm run qr:tables -- --mode production --base-url https://menus.example.com` | refused: "Tables T01 … T10 still hold a derivable legacy QR token. Rotate them first"; exit 1; nothing written |
| Rotate T01–T10 | `rotateTableQr` (the service behind Tables → **Rotate**) as the Coders' Cafe owner | 10/10 old tokens answer `not_found`; 10/10 new tokens resolve to the same table code; 10 audit rows `{"qrRotated":true}` by the owner, none containing a token; order count unchanged |
| Audit after | `npm run qr:audit` | 10 `random`, exit 0 |
| Labels after | same `qr:tables` command | `printReady: true`, 10 SVG + `labels.html` + `manifest.json` (deleted afterwards) |

Not rehearsed: a phone scan of printed cards (needs the public host and a
phone) and a click on the Tables screen's **Rotate** button. The service is
covered by `tests/domain/table-qr-token.test.ts` and the HTTP route
(`POST /api/master/tables/:id/qr`) by `e2e/growth.spec.ts`.

## Rollback

Restoring the old tokens is deliberately impossible from the app: they are
public, and a rotation is never "undone". If a new label is wrong, rotate that table again and reprint. A
database restore (step 2 backup) would bring back every legacy token. Use it
only for an unrelated disaster, then repeat this checklist.

## Abuse protection that stays in place

- Guest routes (`/api/qr/...`) are rate limited per IP (reads 600/min,
  writes 60/min, quotes 240/min). Order placement is also limited per table
  token (20 per 10 minutes).
- Tokens are checked against `^[A-Za-z0-9_-]{6,64}$` before any lookup. An
  unknown, rotated, revoked or inactive table gets the same generic error.
- Guest state-changing requests reject cross-origin `Origin` headers.

With 144-bit random tokens, guessing within these limits is infeasible. The
limits do nothing against a token that can be calculated, which is why the
legacy tokens must be rotated.
