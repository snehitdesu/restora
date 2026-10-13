# Performance and load test

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
