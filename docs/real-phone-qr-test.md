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

## Record

| Date | Who | Phone + OS + browser / scanner | Network | Table | Step | Result |
| --- | --- | --- | --- | --- | --- | --- |
