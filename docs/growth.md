# Growth: guests, consent, loyalty, coupons, referrals, feedback, campaigns (Group 6)

Proposal section 05 p. 17 (growth, guests) and p. 15 (QR offers). Audit rows: CR-01..06, CM-03..06, CP-07, RV-01..03,
QR-10 in `docs/master-feature-audit.md`. Everything here sits on the existing services (orders, payment, outbox,
worker); there is no second order, payment or messaging engine.

## What a guest message has to pass

Every message that is not an order receipt goes through one function, `queueCustomerMessage` (`svc/messaging.ts`):

1. a messaging provider that carries the channel is connected (Twilio: SMS / WhatsApp; Resend: e-mail; MOCK where allowed);
2. the guest has an address on that channel;
3. consent (`CustomerConsent`, one row per guest per channel): **offers need an explicit yes** (default no); order and
   booking messages are allowed until the guest opts out;
4. offers only: outside quiet hours in the organization's time zone (default 21:00-09:00; a campaign waits for the
   morning), and under the weekly cap per guest (default 2);
5. an idempotency key (`camp:<id>:<guest>`, `life:BIRTHDAY:<guest>:<year>`, `fbreq:<request>:<channel>`,
   `resv:<booking>:CONFIRM|REMIND`) so the same event never sends twice, and the outbox stores a **masked** target;
6. offers carry a one-click unsubscribe link (`/u/<token>`, HMAC over guest + channel keyed from `AUTH_SECRET`; it can
   only turn offers OFF for that guest on that channel). **Offers are refused when `PUBLIC_BASE_URL` is not set.**

Where consent comes from: staff on the customer page ("Offers & referrals", audited with who changed it), the guest's own
tick at checkout ("Send me offers", never pre-ticked, needs a phone number), the unsubscribe link, and a spam complaint
from the e-mail provider (offers on e-mail are withdrawn at once).

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Growth settings | Customers > Growth settings, `GET/PATCH /api/growth/settings` | `growth.view` / `growth.manage`; everything defaults to off; review link must be https on Google, Zomato, Swiggy, TripAdvisor or Justdial |
| Loyalty tiers | Customers > Loyalty & referrals | tier = last 365 days of net spend; the earn multiplier uses the tier held *before* the order; nightly refresh; changes audited |
| Coupons | Customers > Coupons; POS discount dialog; guest cart | priced by the server through `Order.discount`; one redemption per order (unique), reversed when the order is cancelled or fully refunded; percent / fixed, cap, minimum, validity, usage limits, first order, tier, order types, stackable |
| Referrals | profile card, `/r/<code>`, checkout field | `RF` + 6 characters; reward on the friend's first PAID order only; monthly cap; minimum order; clawback on full refund |
| Feedback | order page, `/f/<token>`, Customers > Feedback | one answer per order (the first stands); happy guests get the review link, unhappy ones stay private and raise `LOW_RATING`; follow-up workflow; trends by dish / time of day / server |
| Campaigns | Customers > Campaigns | audience evaluated at send time from live data; resumable batches of 200 per worker pass; cancel; per-recipient outcome with the reason a guest was skipped |
| Automations | worker (`svc/lifecycle.ts`) | birthday, anniversary, win-back, booking confirmation / reminder, feedback requests, nightly tier refresh, 9 AM summary; daily jobs claim a `JobRun` per organization per local day |
| E-mail | `ResendEmailProvider`, `POST /api/webhooks/messaging/resend` | Svix-signed delivery webhooks, tenant bound through the outbox row; never run against a live account here |

## Operating it

1. Connect messaging under Settings > Integrations (owner; password re-confirmation). Twilio for SMS / WhatsApp, Resend for
   e-mail (its `whsec_` signing secret goes in the same form). Without a provider nothing is sent and the screens say so.
2. Set `PUBLIC_BASE_URL` (the address guests' phones open). Offers, feedback links and invite links need it.
3. In Growth settings choose the offer coupons and switch on feedback, booking messages and the summary as wanted.
4. Production refuses the MOCK provider unless `ALLOW_MOCK_PROVIDERS=true`; the MOCK provider only records.

## Verified here, and what is not

Verified by automated tests on SQLite and PostgreSQL 16: consent rules, the message gate, coupon pricing and limits,
referral rewards and clawback, feedback routing, campaign sending (idempotent, resumable, concurrent workers), the daily
jobs (once per day per organization), the Resend request / webhook contract, the staff and guest APIs over HTTP (roles,
tenants, same-origin), the screens in a DOM, and six browser flows (`e2e/growth.spec.ts`).

**Not verified:** delivery through a real Twilio or Resend account (emulators and the MOCK provider only), Meta template
approval for WhatsApp, e-mail deliverability (SPF / DKIM / DMARC are the sender's domain setup). Treat the messaging rows
as NOT EXTERNALLY VERIFIED until one real message of each kind has been sent and received.
