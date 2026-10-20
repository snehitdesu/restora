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
   Expected before rotation: `legacy-derivable` for T01–T10, exit code 2.
   Without database access, note which tables have a QR on the Tables screen.
4. **Rotate.** Tables screen → each table T01–T10 → **Rotate**. Rotate only
   the tables in scope. Don't use **Disable** unless that table should stop
   taking QR orders.
5. **Generate the new labels.**
   `npm run qr:tables -- --mode production --base-url https://<public host>`
   with `DATABASE_URL` set to Production. `--base-url` is required on every
   `qr:tables` run; `PUBLIC_BASE_URL` is never used as a fallback. This only reads the database. It
   writes to the git-ignored `artifacts/table-qr/production/`. You can also
   download each table's QR from the Tables screen.
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

## Rollback

Restoring the old tokens is deliberately impossible from the app: they are
public. If a new label is wrong, rotate that table again and reprint. A
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
