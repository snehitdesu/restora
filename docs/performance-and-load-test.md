# Performance and load test

## 2026-10-20 re-measurement (current)

_Local lab measurements only, on the same laptop (i3-1315U, 8 GB RAM, 0.5–1.1 GB
free throughout: an editor and a browser stayed open). Production build
(`next start`, `NODE_ENV=production`), one Node process, SQLite. The database was
a scratch copy of the investor demo database (Coders' Cafe: 64 items, 10 tables)
plus 300 synthetic QR tables and two synthetic staff users; neither `dev.db` nor
the investor baseline was opened for writing. Payments used the in-process mock
gateway (`ALLOW_MOCK_PROVIDERS=true`, refused in Production). These numbers are
not a Production capacity claim; the hosted demo and the packaged desktop app
were not load-tested._

Since 2026-10-13, guest QR orders are online-only: an order waits unpaid (no
kitchen ticket) until its payment is verified, so the guest load below is a full
cycle — quote → place order → status → start payment → **two simultaneous
confirmations** (double tap) → status.

### Guest website (Coders' Cafe storefront `/t/<token>`)

Phone emulation (390×844, DPR 2, touch) with 4× CPU throttling, headless
Chromium, 10 cold runs each (each in a fresh browser context); medians, max in
brackets.

| Metric | Before (build of 15:15) | After (fixes below) |
|---|---|---|
| TTFB | 38 ms (87) | 31 ms (45) |
| FCP | 272 ms (812) | 232 ms (1,256) |
| LCP | 1,144 ms (1,448) | 1,240 ms (1,432) |
| CLS | 0 | 0 |
| Total blocking time (4× CPU) | 409 ms (1,217) | 428 ms (1,257) |
| Requests / bytes on first load | 19 / 465 KB | 18 / 379 KB |
| Font bytes | 258 KB (3 files) | 171 KB (2 files) |
| Tap → next paint, first "Add" (Event Timing) | 104 ms (184) | 120 ms (136) |
| Tap → next paint, first item sheet | 136 ms (280) | 128 ms (176) |

Timing differences between the two columns are within run-to-run noise on
loopback; the measurable change is 86 KB less to download on every guest page
(and one fewer full-page relayout when that font arrived). Against the usual
reference targets (LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms) the lab results pass at
4× CPU on loopback; the first-sheet tap reached 280 ms once before the change.
With 1.6 Mbit/s and 150 ms latency emulated, LCP was 1.76 s median (2.0 s max).

Where the load time goes (Chromium trace, 4× CPU): about 0.8–1.0 s of layout per
load, of which a first layout of ~0.2–0.8 s also happens on the tiny `/login`
page in headless Chromium on this machine (environment, as noted on 2026-10-13);
script evaluation ~0.4 s; no long JavaScript handler on any tap (handlers
0–4 ms; the cost of a tap is style/layout/paint). The server answers the page in
~30 ms with 10 database queries (no N+1: one query per relation, constant in the
menu size). Polling is bounded: the menu refreshes every 60 s only while the tab
is visible, the order page every 5 s with no overlap, the UPI QR panel every 4 s.

Responsive and accessibility check at 360×800, 390×844, 768×1024, 1366×768 and
1440×900 (menu, item sheet, cart, checkout): no horizontal overflow, item sheet
fully inside the viewport, no console errors or failed requests, a visible focus
ring on the first 15 keyboard stops, axe-core (WCAG 2.2 AA tags) clean once
animations settle. Remaining axe notes are false positives: page text behind the
modal backdrop (contrast of the dimmed logo), and the 13 px payment radio, which
sits inside a full-width label card.

Findings fixed:

1. **₹ downloaded a whole font file.** The rupee sign is the only character on
   the guest pages outside Inter's preloaded latin subset, so every guest page
   fetched Inter's latin-ext file (86 KB) and re-laid out the menu when it
   arrived. A local-only `@font-face` ("SF Rupee", `unicode-range: U+20B9`,
   regular and bold faces, `local()` sources only) now draws ₹ from a font the
   phone already has; if none is installed, Inter draws it as before
   (`src/features/guest/storefront.css`, test `tests/ui/storefront-fonts.test.ts`).
2. **The UPI QR was re-encoded every second.** The payment panel's countdown
   re-renders it each second and the QR (Reed-Solomon + mask scoring, ~0.8 ms on
   this CPU, several ms on a slow phone) was recomputed each time; it is now
   memoized per checkout (`UpiQrPayment.tsx`, test
   `tests/ui/upi-qr-payment.test.tsx`, which fails on the old code).

Not changed: the framework attaches the marketing site's page chunk (11 KB) to
every page that uses `next/link` (a Next.js client-manifest quirk); the
first item-sheet open still pays a one-time display-font setup.

### Controlled load (closed loop, no think time, one IP per guest)

Harness: Node `fetch`, each virtual user (VU) sends its next request when the
previous answers; 10–60 s per stage; stages ramped and stopped below 250 MB free
RAM; target refused unless loopback. Percentiles: p95 with ≥ 20 samples, p99 with
≥ 100.

| Workload | 1 VU | 5 VU | 10 VU | 25 VU | 50 VU |
|---|---|---|---|---|---|
| Menu `GET /api/qr/t/:token` req/s (p95 ms) | 29 (43) | 107 (71) | 129 (129) | 127 (507) | 131 (670) |
| Guest cycle, paid orders/s (order p95 ms) | 3.3 (72) | 5.5 (244) | 6.1 (468) | 6.6 (872) | — |
| Kitchen board list + advance, req/s, **before fix** | 20 | 38 | **7.6, 503s, p95 5.9 s** | **7.7, 503s, p95 6.1 s** | — |
| Kitchen, **after fix** req/s (list p95 ms) | — | 74 (89) | 89 (107) | 117 (252) | — |
| POS open orders req/s (p95 ms) | 45 (32) | — | 149 (115) | 165 (508) | — |

Every stage above answered 100 % 2xx except the kitchen rows marked "before
fix". Sustained mixed workload after the fix, 25 VU × 61 s (45 % menu, 20 %
quote, 15 % guest cycles, 13 % kitchen, 7 % POS): 5,200 requests, **0 server
errors**, 374 paid orders; menu p95 122 ms, kitchen list p95 178 ms, order p95
665 ms, payment confirmation p50 2.6 s / p95 3.5 s (writes queue behind the single
SQLite writer). Right after: 1 VU menu p50 19 ms / p95 36 ms. Server working set
234 MB → 645 MB peak → 626 MB, CPU ≈ 1.8 cores at saturation. Single-request p99
outliers of ~0.4–0.6 s at the start of each stage come from Windows trimming the
idle server's memory on this RAM-starved machine (a 12 s steady run had no
request above 150 ms).

Correctness under load:

- Recovery: 10 VU × 31 s with half the guests abandoning after starting payment
  (192 unpaid orders) while the payment-recovery cron ran every 2 s (15 runs,
  200; 15 unauthenticated tries, 401): the abandoned orders stayed OPEN with **no
  kitchen ticket**; the mock gateway's status check answers UNKNOWN, so nothing
  was settled without a confirmation.
- Duplicate submissions (same Idempotency-Key at once): ×2, ×10, ×25 → exactly
  one order each time (at ×25, 9 got 429 from the per-table limit).
- Abuse, 10 VU × 20 s: 1,650 unknown tokens → all 404; wrong password → 401 ×6
  then 429; one IP flooding the menu → exactly 600 per minute then 429; wrong
  order key → 404; the brute-force alert fired. No 5xx.
- Database afterwards: `integrity_check` ok; 1,134 QR orders, 0 acknowledged
  orders missing; 939 PAID, each with exactly one SUCCESS payment and its
  ticket(s) although every paid order received two concurrent confirmations; 195
  OPEN, all unpaid and none with a kitchen ticket; 0 duplicate KOT numbers,
  invoice numbers, idempotency keys or order items on two tickets.

Defect found by the load test, fixed:

3. **Kitchen screens stalled each other.** Every kitchen-board poll by a kitchen
   account ran `UPDATE Session … WHERE lastActivityAt <= now-60s` to keep the
   screen signed in. SQLite takes its single write lock for an UPDATE even when it
   matches no row, and these statements ran outside the queued write path
   (`runInTx`). With about ten concurrent kitchen clients, enough of them waited
   on the lock to stall the ticket-update transactions holding it until the 5 s
   busy timeout: throughput fell from 38 to 8 requests/s, ticket lists answered
   503, updates took 5–12 s, and the maintenance worker's own write timed out.
   Reproduced identically with the database in WAL mode (as the desktop app runs
   it) and in rollback-journal mode. Validation now reports the session's
   persisted activity time and `recordSessionActivity` skips the write while it
   is less than a minute old (`src/server/auth/session.ts`,
   `src/server/api/router.ts`, test `tests/auth/session-activity-writes.test.ts`);
   the idle-timeout behaviour is unchanged (existing
   `tests/auth/session-security.test.ts` kitchen-exemption tests pass).

### Highest tested level

On this laptop, one Node process on SQLite: 25 concurrent closed-loop VUs on
every workload and 50 on menu reads, with 0 server errors after the fixes. Read
throughput saturates at ~130–165 requests/s and complete paid guest orders at
~6.6/s; beyond that, latency grows by queueing. Untested: PostgreSQL in this
pass, the packaged desktop app, the hosted deployment, real phones on Wi-Fi, more
than one server instance.

---

_The sections below are the 2026-10-13 measurement (historical: cash checkout,
since removed for QR orders)._

_2026-10-13. Local measurements only (SQLite, and a local PostgreSQL 16 in §5).
Nothing here was measured on the hosted demo or on the packaged desktop app;
those are listed as unmeasured at the end._

## 1. Setup

| Item | Value |
|---|---|
| Machine | Windows 11 laptop, Intel i3-1315U (8 logical CPUs), 8 GB RAM; the user's `next dev` (≈ 0.9 GB) kept running throughout; ≈ 0.6–1.1 GB RAM free |
| Server | production build (`next build` + `next start`), one Node process, `NODE_ENV=production`, `LOG_LEVEL=warn` |
| Database | disposable SQLite file in the session scratchpad: 23 migrations + `db:seed:cafe` (Coders' Cafe: 64 items, 10 tables) + 150 extra QR tables. Never the user's `dev.db`. |
| Harness | `scratchpad/vtools/load.mjs` (Node `fetch`, closed loop, **no think time**): each virtual user (VU) sends its next request as soon as the previous answer arrives, from its own client IP (`X-Forwarded-For`, as distinct phones behind a proxy). A VU is therefore much busier than a real guest. Percentiles: p95 only with ≥ 20 samples, p99 only with ≥ 100. |
| Payment | simulated gateway (`ALLOW_MOCK_PROVIDERS=true`); cash orders for checkout load |
| Limit overrides | `GUEST_MAX_UNPAID_ORDERS_PER_TABLE=50` (so the unpaid-cash cap does not stop a load test); every other rate limit at its production value |

## 2. Results (after the fixes in §3)

Guest menu `GET /api/qr/t/:token` (10 s per stage, fresh client IPs per stage):

| VUs | requests | req/s | 2xx | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| 1 | 352 | 35 | 100 % | 29 | 39 | 45 |
| 10 | 1,646 | 164 | 100 % | 59 | 81 | 104 |
| 50 | 1,746 | 172 | 100 % | 286 | 338 | 380 |
| 100 | 1,786 | 173 | 100 % | 573 | 660 | 693 |

Cart quote `POST …/quote`: 10 VUs 175 req/s p95 79 ms; 50 VUs 183 req/s p95 319 ms; 100 % 2xx.

Cash checkout `POST …/orders` (creates the order, its lines and its KOT in one transaction), each request a different table and phone:

| VUs | orders | orders/s | 2xx | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|
| 1 | 135 | 13.4 | 100 % | 73 | 96 | 118 |
| 5 | 208 | 20.4 | 100 % | 234 | 313 | 424 |
| 10 | 221 | 21.2 | 100 % | 455 | 519 | 735 |
| 25 | 235 | 21.2 | 100 % | 1,162 | 1,227 | 1,246 |
| 50 | 252 | 20.9 | 100 % | 2,352 | 2,488 | 2,533 |

Duplicate submissions (same Idempotency-Key fired at once): ×2, ×10, ×25, ×50 → exactly **one** order each time; every 2xx carried the same order id (at ×25/×50 the rest got 429 from the per-table limit).

Kitchen (chef session: list tickets + advance one): 1–25 VUs, list 100 % 2xx (p95 72 → 258 ms); updates 97–100 % 2xx, the rest 422 when two "chefs" race to move the same ticket (the state machine refuses the second; never a 500).

POS (open orders + dashboard page), 1–10 VUs: 100 % 2xx; dashboard p95 61 → 253 ms.

Sustained mixed workload, 25 VUs for 61 s (45 % menu, 25 % quote, 12 % checkout, 12 % kitchen, 6 % POS): 5,134 requests, **0 server errors**; only 9 checkout 429s (per-table limit). Menu p95 90 ms, quote p95 86 ms, KDS list p95 150 ms; writes queue behind the single SQLite writer (checkout p50 1.2 s, ticket update p50 1.1 s). Recovery right after: 1 VU menu p50 30 ms / p95 39 ms (baseline). Server working set 225 MB → 383 MB over the run.

Database after every scenario (`PRAGMA integrity_check` ok): 1,584 QR orders = 1,580 acknowledged by checkouts + 4 from the duplicate test; **0 acknowledged orders missing**; 1,584 guest audit rows and 1,584 staff alerts; 0 orders without a KOT, 0 with two; 0 duplicate idempotency keys or KOT numbers; 0 payments (cash stays unpaid).

## 3. Defects found by the load test, and fixed

1. **Guest checkout answered 500 for orders that had been placed.** The audit row and the staff "New QR order" alert were written in a second transaction after the order (and its KOT) committed, outside the queued SQLite write path. At 25–50 concurrent checkouts it lost the write-lock wait (Prisma `P1008`): 4 HTTP 500s; the database then had 241 orders but only 237 audit rows / alerts — 4 orders in the kitchen that staff were never alerted to while the guest was told it failed. Fix: `placeOrder(…, { afterCreate })` writes both inside the order's transaction (`src/server/services/orders.ts`, `guestOrdering.ts`). Regression: `tests/db/guest-checkout-concurrency.test.ts` (30 simultaneous checkouts) failed on the old code with exactly `P1008 Socket timeout` (2 of 5 runs) and passed 6 of 6 after.
2. **SQLite lock waits surfaced as 500.** `P1008`, `P2028` "unable to start a transaction" and "database is locked" now answer 503 Busy + Retry-After (the transaction rolled back; the API client retries idempotent requests). Other services that still open `$transaction` directly (exports, printing, accounting/aggregator sync, reports) get the same treatment. `tests/db/conflict-classification.test.ts`.

Before the fix the same checkout stages showed 4 × 500 and p99 up to 10 s; after: 0 errors, p99 ≤ 2.5 s at 50 simultaneous checkouts.

## 4. What this means

- One café on SQLite (the desktop app, or one web instance): about **21 orders per second** of write capacity on this laptop — far beyond what one restaurant's tables produce. 50 guests pressing "Place order" in the same instant all succeed within ≈ 2.6 s.
- Reads scale to ≈ 170 requests per second on one Node process here; latency then grows by queueing, not by errors.
- The per-table (20 orders / 10 min) and per-IP limits engaged as designed; they are abuse limits, not capacity limits.
- These are tested stages on this hardware, not a capacity guarantee.

## 5. PostgreSQL path (same laptop, same harness)

Production build with the PostgreSQL client against a disposable local PostgreSQL 16.14 database (`connection_limit=10`), seeded with the demo dataset (`prisma/seed.ts` on a fresh database) plus 150 QR tables; the demo outlet's opening hours were cleared on that disposable copy (at 03:15 IST its 11:00–23:00 hours correctly refused every order with 422). The project's own `scripts/ops/load-test.mjs` could not run here: it needs the `psql` client, which this PostgreSQL bundle lacks (tooling gap, not a product result).

| Scenario | Result |
|---|---|
| Menu, 1 / 10 / 50 VUs | 100 % 2xx; 33 / 171 / 183 req/s; p95 38 / 75 / 312 ms |
| Cash checkout, 1 / 5 / 10 / 25 / 50 VUs | 100 % 2xx; 12 / 54 / 63 / 63 / 62 orders/s; p95 101 / 133 / 186 / 471 / 993 ms |
| Duplicate submissions ×2 / ×10 / ×25 | exactly one order each (the rest 429 per-table) |
| Mixed, 25 VUs × 60 s | 0 server errors; 6 per-table 429s; menu p95 242 ms, checkout p95 1.56 s, dashboard p95 1.65 s |

Invariants afterwards: 3,146 QR orders = 3,143 acknowledged + 3 duplicate-test orders; 0 acknowledged orders missing; 3,146 guest audit rows and staff alerts; 0 orders without a KOT; 0 duplicate KOT numbers or idempotency keys. Write capacity on PostgreSQL here is ≈ 3× SQLite (concurrent transactions instead of one writer); reads are the same (Node-bound).

## 6. Not measured

- PostgreSQL with the project's `scripts/ops/load-test.mjs` (needs `psql`), connection-pool exhaustion and database restarts under load in this pass.
- The hosted Vercel demo (no URL or credentials in the repository; no traffic was sent to it).
- The packaged desktop app under load.
- Multi-instance web deployments.
