# RESTORA release acceptance checklist (2026-10-22)

Status words: **PASS** (observed by a command / test / authoritative record),
**FAIL**, **BLOCKED** (needs access, credentials, equipment or a human
decision), **NOT RUN**, **CONDITIONAL** (only if that option is chosen).
A green local build or test run is not evidence about Production.

Current local evidence: `docs/final-engineering-completion-report.md`.
Open blockers with owners: `docs/final-release-blockers.md`.

## A. Release gates

| # | Gate | Status | Evidence required to pass | Who |
| --- | --- | --- | --- | --- |
| A1 | Production / Preview database isolation | BLOCKED | Hosting-console view (screenshot or export of env var **names and targets**, never values) showing Preview and Production `DATABASE_URL` point at different databases (host + database name, read by the owner), and that Production has a `DATABASE_URL` record. Last observed: 10-14 one record for Production+Preview; 10-19 no Production-targeted record (preview-only). | Owner / hosting admin |
| A2 | Production backup + restore drill | BLOCKED | `pg-backup.mjs --expect-migration <Production's newest>` on the real Production DB, restored with `pg-restore.mjs` into a scratch DB, `db-verify` "INTEGRITY OK", row counts match the manifest. Local drills only so far. | Owner + engineer |
| A3 | Production read-only schema audit | BLOCKED | Owner-issued read-only role; output of `scripts/ops/prod-readonly-audit.sql` (`docs/production-readonly-audit.md`) and `prisma migrate status`: applied / pending list, no failed migration, no rows that would break the pending migrations. | Owner + engineer |
| A4 | Migration approval | BLOCKED | Written go-ahead naming the window, after A1–A3, for `npm run db:pg:deploy` (pending includes `20261026100000_outlet_common_qr`, additive). App deploy only after it (readiness expects it). | Owner |
| A5 | SBI UPI acceptance | BLOCKED (external) | Official SBI spec + UAT credentials; real adapter; UAT of pay / decline / timeout / late + duplicate callback / refund; one UAT day reconciled against the bank MIS; bank + owner sign-off (`docs/sbi-upi-integration.md`). Until then SBI stays fail-closed (tested). | Owner + SBI |
| A6 | Café physical acceptance | NOT RUN | Section B below, on real phones, printer and café network. | Owner / staff |
| A7 | Recipe, ingredient and menu sign-off | BLOCKED (human) | `docs/recipe-ingredient-signoff.md`: chef / owner fill the sheets; no real recipe is approved by RESTORA. | Chef + owner |
| A8 | Staging load test | BLOCKED | A staging deployment with its own DB; run the plan in `docs/performance-and-load-test.md` (incl. common-QR bursts) against owner-confirmed pass criteria. Local measurements do not count. | Owner (provision) + engineer |
| A9 | Code review + commit of this tree | NOT RUN | Human review of `docs/diff-review-2026-10-22.md` and the diff; commit in reviewable pieces (feature / concurrency / ops / demo / lockfile). | Engineer + owner |
| A10 | CI on the committed branch | NOT RUN | Push (with approval) and a green `.github/workflows/ci.yml` run on that commit. Local runs are not CI. | Engineer |
| A11 | React #418 (intermittent, staff screens) | OPEN | Reproduced locally on 2026-10-22 (production build, slow client + busy server; `docs/hydration-418-investigation.md`); root cause not yet identified. Pass = the component identified and fixed with the harness at 0 failing loads, or the owner's written acceptance of the risk (React recovers on the client; no wrong data observed). | Engineering / owner |
| A12 | Desktop distribution | EXCLUDED (2026-10-22) | Desktop app is excluded from this release — nothing in the repo or acceptance docs establishes it as mandatory. If a future requirement makes it mandatory: version bump (rc.1 binary mismatch), `npm run desktop:dist`, `desktop:verify`, `desktop:e2e`, regenerate the download manifest. | Engineer |
| A13 | QR rotation before printing | BLOCKED | Production `qr:audit` after rotation shows no `legacy-derivable` / `nonstandard` live token (`docs/qr-token-rotation.md`), with a backup first. Then print. | Owner |
| A14 | Common-QR per-IP limit on café Wi-Fi | DECISION | Options, spoofing analysis and recommendation: `docs/cafe-wifi-rate-limit-decision.md`. Owner records the choice there after the staging burst test (A8), or uses table QRs on busy days. | Owner |

## B. Café acceptance plan

Run B1 on the demo, B2 on a staging copy of the café, B3 on Production only
after A1–A5 and A13. Record device, OS / browser version, network, time, result
and who tested. A row passes only when its expected result is observed.

Keep the four kinds of evidence apart and label every result with one of them:
**local automated** (tests on a laptop), **staging acceptance** (B1 / B2 on a
non-production deployment), **physical café** (real phones, printer, Wi-Fi,
staff), **Production** (B3). One never stands in for another. Use the mock /
emulator provider until SBI UAT access exists; never print live QR cards or
rotate live codes during these tests.

### B1. Demo environment (Demo Café, mock / emulator payments)

| Scenario | Expected result |
| --- | --- |
| Seed the demo twice | Second run: "already exists … nothing changed" |
| Scan a demo table QR on Android (Chrome) and iPhone (Safari) | Menu opens, "Table D0x", 10 categories, veg marks, prices before GST |
| Issue the restaurant QR (Tables) and scan it | "Sit anywhere"; checkout explains staff bring the order |
| Order with modifiers (Large Café Latte + extra shot; Veg Burger + extra cheese) | Cart and bill show each modifier and its price; GST 5 % on the total |
| Pay with the emulator | Order PAID, one KOT per station (BAR / KITCHEN), "No table yet" on the common-QR ticket |
| Assign the table from POS → Open orders → QR tables | KOT shows the table; audit row has the staff member |
| Assign a 4th waiting order to a table | "over its guest limits" dialog with numbers; Cancel sends nothing; Assign anyway succeeds and is audited |
| Stock after a paid order | Ingredients fall by exactly the recipe (× 1.5 for Large); nothing before payment |
| Recipe costing | Recipes show a cost and margin per dish |

### B2. Café staging (own database, café menu, mock or SBI UAT payments)

| Scenario | Expected result |
| --- | --- |
| Android + iPhone, café Wi-Fi and mobile data, slow network (throttled / far from router) | Menu loads; a lost response on submit does not create a second order (same order shown on retry) |
| Guests at three tables order at the same moment (table QRs) | Three orders, each on its table, three sets of KOTs after payment |
| Five phones order through the restaurant QR together | Five orders "no table yet"; staff assign each; none lost |
| Same guest taps "Place order" twice | One order |
| Payment success / failure / guest closes the browser mid-payment | Success: PAID + KOT; failure: no KOT, guest can retry; closed: PENDING until the callback / recheck settles it, never a second KOT |
| Duplicate payment callback | No second KOT, no double payment |
| Cancel an unpaid order; refund a paid one (with re-auth) | Cancel: no KOT, stock untouched; refund: recorded, audited, stock policy as configured |
| Printer: KOT and bill on the real printer (`docs/physical-printer-test.md`) | Correct items, modifiers, table, totals, GST; readable layout on the paper width |
| Kitchen workflow on the KDS device | Tickets move NEW → PREPARING → READY → SERVED; late timers sensible |
| Restart the server / drop Wi-Fi for a minute during service | Open orders and KOTs intact after restart; POS and guests recover without duplicates |
| Inventory after the session | Ledger matches the paid orders' recipes; unmapped sales listed for items without recipes |
| *(added 2026-10-22)* Two staff on two devices assign the same restaurant-QR order to different tables at the same moment | One succeeds; the other sees "just changed by someone else; reload" and nothing moves silently |
| A staff member working from a screen opened before a colleague seated the order | Conflict + reload, never a silent move |
| Table marked for cleaning, then an order assigned to it | Refused ("being cleaned"); after cleaning, assignment works and the table shows occupied |
| Cancelled / refunded order: try to assign or change its table | Refused |
| Payment timeout, then the guest retries | No second order; the original either settles or stays pending; one KOT set at most |
| Reprint a KOT and a bill; print on the narrowest paper in use | Reprint identical to the first print (the bill is rendered from the stored order each time); nothing clipped at the paper edge. Whether a reprint should be labelled "copy" is an owner question — it is not labelled today |
| Many guests on the café Wi-Fi ordering through the restaurant QR in a rush (count them) | Record how many orders in 10 min were accepted vs refused ("Too many requests"); feeds `docs/cafe-wifi-rate-limit-decision.md` |
| A request with a forged `X-Forwarded-For` header against the staging deployment | Limits still apply to the real client address |
| Cashier / kitchen accounts try manager actions (QR rotation, guest-limit override, refunds) | Refused; the manager's actions appear in the audit log with their name |
| Old / slow phones (Android Go-class, iPhone SE-class) on a weak signal | Menu usable; checkout completes or says clearly that it could not |

### B3. Production (after A1–A5, A13)

| Scenario | Expected result |
| --- | --- |
| `/api/health/ready` | 200, migration = expected |
| One real low-value order per payment method in use, paid and refunded | Bank / gateway records match RESTORA (reconciliation) |
| Printed table and restaurant QR cards scanned on two phones | Open the café's own menu; old tokens dead (`qr:audit` clean) |
| First service with staff | No 5xx in logs; KOTs printed; end-of-day totals match payments |
