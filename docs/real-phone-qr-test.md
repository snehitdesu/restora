# Real-phone table QR test (owner / QA steps)

_Prepared 2026-10-21. Status: **not run.** Automated coverage exists
(`e2e/qr-transaction.spec.ts`, `e2e/guests.spec.ts`, phone-emulated Chromium
in `docs/performance-and-load-test.md`), but no real phone, real camera app,
café Wi-Fi or mobile network has been tested._

Two stages. Stage 1 can be run as soon as the tables are rotated; stage 2 only
after SBI UAT access exists, and never with real money before SBI sign-off.

## Before you start

- The table cards must come from **rotated** tokens (`docs/qr-token-rotation.md`;
  `npm run qr:audit` shows no `legacy-derivable`). Do not test with the images
  in `artifacts/coders-cafe-qr/`: they carry the old guessable tokens.
- Phones: at least one **iPhone** (camera app → Safari) and one **Android**
  (camera / Google Lens → Chrome). Add whatever scanner guests commonly use:
  a UPI app's scanner (PhonePe, Google Pay, Paytm) may not open a web link;
  record what it does.
- Networks: the café Wi-Fi **and** mobile data with Wi-Fi off.

## Stage 1 — scan and menu (possible now)

For every table card (T01–T10), on at least one phone:

1. Scan the printed card at the table, at normal lighting and distance.
2. The page title / header shows **Coders' Cafe** and **Table T0x** matching
   the card. A wrong table is a stop-ship defect.
3. The menu loads; scroll, open an item, add it to the cart.
4. Go to checkout. What to expect depends on the build being tested:
   - a build of this release with `PAYMENT_PROVIDER=sbi_upi` (stub): *"Online
     payment isn't available right now, so orders can't be placed from the
     table. Please order with the staff."* No order is created (POS → Open
     orders stays empty);
   - the build Production runs today (`a80caa9`): it still offers paying at
     the counter, so placing the order **creates a real order and kitchen
     ticket**. Stop at the checkout screen there, or cancel the order in the
     POS straight away.

Once per phone / network:

5. Scan an **old** card or old image: it must show *"This QR code isn't working"*.
6. Rotate one table's token, reload the page opened from it: it must stop working.
   Reprint and replace that card.
7. Note the first-load time roughly (seconds until the menu is usable) on
   mobile data.

## Stage 2 — full order with SBI UAT (after SBI provides UAT)

Only on a non-Production deployment wired to SBI UAT
(`docs/sbi-upi-integration.md` §5), with its own database:

1. Order from a table → pay in the UPI app → the order is **PAID**, and only
   then does a KOT appear on the KDS.
2. Pay, then close the browser before it confirms: the payment-recovery
   scheduler (`docs/payment-safety.md` §3) must mark it PAID within ~3 minutes
   without anyone reopening the page.
3. Cancel in the UPI app / let the QR expire: the order is not sent to the kitchen.
4. Pay after the late-payment window (10 minutes proposed, owner decision
   pending): recorded as received, held for staff (`LATE_PAYMENT_HELD`), not
   sent to the kitchen.
5. Two phones at the same table, and two tables at once.

## Coverage matrix: automated vs. real device

Automated = runs in CI / locally on a browser or the server; it proves the logic,
**not** a real camera, phone browser, network or printer. "Real" = the step above
that only a person with the device can sign off.

| Case | Automated coverage | Real-device step |
| --- | --- | --- |
| Valid QR → right restaurant + table | `tests/domain/table-qr-token.test.ts` (each token resolves only its own table / outlet / organization), `e2e/qr-transaction.spec.ts` | Stage 1.1–1.2, every card |
| Invalid / malformed / unknown / rotated QR | `tests/domain/table-qr-token.test.ts`, `tests/domain/qr-transaction.test.ts` (one uniform message) | Stage 1.5–1.6 |
| Wrong outlet / table association | `tests/domain/table-qr-token.test.ts` (inconsistent table/outlet → not found), `tests/domain/qr-transaction.test.ts` (another tenant's dish / order) | Stage 1.2 (a wrong table is stop-ship) |
| Menu load, item selection, cart | `tests/api/guest-routes.test.ts`, `tests/ui/guest.test.tsx` | Stage 1.3, 1.7 |
| Order submission, duplicate submission | `tests/domain/qr-transaction.test.ts` (duplicate replays), `tests/db/guest-checkout-concurrency.test.ts` | Stage 2.1 (double-tap Place order once) |
| Payment initiation / failure / expiry | `tests/domain/qr-payment-gate.test.ts`, `tests/integrations/upi-direct-bank.test.ts` (emulator, not SBI) | Stage 2.1, 2.3 — **SBI UAT only** |
| Delayed confirmation, recovery | `tests/domain/payment-recovery.test.ts`, `tests/domain/qr-payment-gate.test.ts` (timeouts never settle) | Stage 2.2, 2.4 — needs the scheduler |
| Kitchen ticket exactly once after payment | `tests/domain/qr-payment-gate.test.ts` (one KOT per station, concurrent confirmations) | Stage 2.1 (KDS) |
| Receipt content, printer failure, retry, reprint | `tests/domain/bill-printing.test.ts`, `e2e/bill-print.spec.ts` | `docs/physical-printer-test.md` A.4–A.8 |

Environment for stage 2 (none exists yet): a non-Production deployment with its
own database, `PAYMENT_PROVIDER=sbi_upi` against SBI UAT, `CRON_SECRET` and a
scheduler calling `/api/cron/payments`, rotated cards printed for that host.
Never point it at Production's database, and never scan Production cards on
build `a80caa9` past the checkout screen (it creates real orders).

**Sign-off evidence** (all of it, filed with the go-live checklist): the Record
table below filled for every card on both phone types and both networks; a
photo of one card and the screen it opened (no token visible in the photo's
URL bar, or crop it); for stage 2, the payment's SBI UAT reference and the KOT
time, side by side; the printer record of `docs/physical-printer-test.md`.

## Record

| Date | Who | Phone + OS + browser / scanner | Network | Table | Step | Result |
| --- | --- | --- | --- | --- | --- | --- |
