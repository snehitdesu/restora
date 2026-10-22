# Café Wi-Fi and the restaurant-QR order limit — owner decision (2026-10-22)

Status: **DECIDED (2026-10-22).** Owner direction: keep Option A — the
shared café QR limit stays at 20 orders per 10 minutes — until the staging
burst test (`docs/performance-and-load-test.md`, "Common restaurant QR")
provides evidence for a change. No code change. This matches the
recommendation already in this document. Read from the code on 2026-10-22
(`src/server/api/rateLimit.ts`, `src/server/api/guestRouter.ts`,
`src/server/services/guestOrdering.ts`).

## What limits a guest order today

| Limit | Key | Value | Where | Spoofable from the request? |
| --- | --- | --- | --- | --- |
| Guest write limit | client IP | 60 guest POSTs / min (order, payment start, feedback…; cart pricing has its own 240 / min) | `guestRouter` | Only where no trusted proxy sets the IP (see below) |
| Order limit, **table QR** | the table's token | 20 orders / 10 min | `placeGuestOrder` | No (token comes from the URL; invalid tokens are refused before counting) |
| Order limit, **restaurant (common) QR** | the restaurant code **+ client IP** | 20 orders / 10 min | `placeGuestOrder` | As the IP |
| Unpaid common-QR orders per outlet | outlet (database count, in the order's transaction under a lock) | 30 unpaid placed in the last 15 min | `placeGuestOrder` → `lockCommonQrCap` | **No** — counted in the database |
| Per-table guest caps | table (database count, in-transaction) | 3 waiting for payment / 6 unsettled | `placeGuestOrder` → `lockTableQrCaps` | No |

So the per-IP common-QR limit is **per outlet code and per IP**, not global per
IP and not per outlet. Every hit counts: a refused attempt and a client retry
after an unanswered request each use one of the 20.

## The problem

Guests on the café's Wi-Fi leave through one public IP (NAT). On the restaurant
QR they therefore **share one 20-orders-per-10-minutes allowance**: the 21st
Wi-Fi order in a 10-minute window gets "Too many requests" (429) until the
window rolls over. Guests on mobile data have their own (carrier) IP and are not
affected. Table QRs are not affected (their limit is per table).

20 / 10 min is 2 orders a minute through the restaurant QR on Wi-Fi. A small café
is unlikely to hit it; a busy lunch rush where most guests use the café Wi-Fi
and the restaurant QR could.

## Spoofed `X-Forwarded-For`

`clientIp()` takes the address `TRUSTED_PROXY_HOPS` entries from the **right**
of `X-Forwarded-For` (default 1). A forged prefix sent by the client does not
change it (tested: `tests/api/security.test.ts`, "clientIp").

- **Behind Vercel (the supported web deployment, `TRUSTED_PROXY_HOPS=1`)**: the
  platform sets the header from the connecting address, so the IP is the real
  one. *Not yet observed on our own deployment*: confirm on staging by sending a
  request with a forged `X-Forwarded-For` and checking the limit still trips
  (acceptance checklist B2).
- **Without a proxy** (`next start` exposed directly to a network): the client
  writes the whole header, so per-IP limits (this one and the guest write limit)
  can be bypassed by sending a different value each time. The database-counted
  limits (30 unpaid per outlet, per-table caps) still hold. The desktop app
  binds to `127.0.0.1` only and is not affected. **Never expose `next start`
  directly for guest ordering**; put it behind a proxy that sets the header.
- Multi-instance hosting needs `RATE_LIMIT_STORE=database`; with the default
  memory store each instance counts separately (limits become looser, never
  stricter). Production's value is not known here (environment not readable).

## Options

| Option | Effect on a busy café | Abuse protection | Work |
| --- | --- | --- | --- |
| **A. Keep 20 / 10 min per (code, IP)** | Wi-Fi guests may be refused at peak; they can switch to mobile data or use the table QR | Unchanged | None |
| **B. Raise the per-(code, IP) limit** (e.g. 60 / 10 min) | Wi-Fi peak of up to 6 orders / min | The outlet-wide 30-unpaid cap (database-counted, not spoofable) remains the real bound on unpaid pile-up; paid orders are revenue, not abuse | One constant + tests |
| **C. Make it a per-outlet setting** (owner sets it for their peak, bounded e.g. 10–200) | Fits each café | Same as B | Setting, validation, UI, migration-free env or settings row, tests |
| **D. Add a per-device cookie key** | Fairness between phones on one Wi-Fi | **None against abuse** (the client deletes the cookie), so only as an *extra* key next to the IP, never instead of it | Moderate |

## Recommendation

1. Until the staging burst test (`docs/performance-and-load-test.md`, "Common
   restaurant QR"): **keep A**, and on busy days point guests at the table QRs.
2. If the owner expects more than ~2 restaurant-QR orders a minute from the
   café Wi-Fi at peak, choose **B with 60 / 10 min** (or C if several outlets
   differ). The outlet cap of 30 unpaid orders per 15 minutes is what bounds
   abuse; it is untouched by either option.
3. Independently of the choice: confirm `RATE_LIMIT_STORE=database` on any
   multi-instance deployment and run the forged-header check on staging.

## Decision record

| Question | Owner's answer | Date | Name |
| --- | --- | --- | --- |
| Expected peak restaurant-QR orders per 10 min on café Wi-Fi | Not yet estimated; keep A until the staging burst test gives real numbers | 2026-10-22 | — |
| Option chosen (A / B with value / C) | **A — keep 20 / 10 min per (code, IP)**, revisit only on staging burst-test evidence | 2026-10-22 | — |
| Staging burst test result (orders accepted / refused) | Pending (blocker #8 / A8 — staging not yet provisioned) | | |
