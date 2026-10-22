-- RESTORA read-only Production audit (docs/production-readonly-audit.md).
--
--   psql -X -v ON_ERROR_STOP=1 [-v menu_ids='{id1,id2,...}'] \
--        -f scripts/ops/prod-readonly-audit.sql -d "$AUDIT_DATABASE_URL"
--
-- (Keep -d: psql on Windows ignores options written after a bare connection string.)
--
-- Read-only by construction: the session and the transaction are READ ONLY
-- and the script ends with ROLLBACK, so even a role that could write cannot
-- change anything through it. Prints counts and classes only: never a QR
-- token, payment reference, amount, customer field or credential. Written
-- for the schema of build a80caa9 (12 migrations) and every later one.
-- menu_ids (optional): the menu item ids the LIVE site serves (from the guest
-- menu JSON of a printed table card), to check this database holds them.

\set QUIET on
SET default_transaction_read_only = on;
BEGIN TRANSACTION READ ONLY;
\set QUIET off
\pset footer off

\echo '== 1. Session and server identity (no credentials)'
SELECT current_database() AS database, current_user AS role, inet_server_addr() AS server_addr,
       inet_server_port() AS server_port, current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only_tx,
       pg_postmaster_start_time() AS server_started, now() AS audited_at;

\echo '== 2. Role privileges (a read-only role shows false in every write column)'
SELECT r.rolname AS role, r.rolsuper AS superuser, r.rolcreaterole AS create_role, r.rolcreatedb AS create_db,
       has_table_privilege('"Order"', 'INSERT') AS can_insert_order,
       has_table_privilege('"RestaurantTable"', 'UPDATE') AS can_update_tables,
       has_table_privilege('"Payment"', 'UPDATE') AS can_update_payments,
       has_database_privilege(current_database(), 'CREATE') AS can_create_schema
FROM pg_roles r WHERE r.rolname = current_user;

\echo '== 3. Migration state (expected for a80caa9: 12 applied, newest 20261016100000_integrations_control_room)'
SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished_or_failed,
       count(*) FILTER (WHERE rolled_back_at IS NOT NULL) AS rolled_back,
       max(migration_name) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS newest_applied
FROM "_prisma_migrations";
SELECT migration_name AS not_finished FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY 1;

\echo '== 4. Organizations and outlets (names identify the business; check they are the real restaurant)'
SELECT g.name AS organization, g.active AS org_active, o.code AS outlet, o.name AS outlet_name, o.active AS outlet_active,
       (SELECT count(*) FROM "RestaurantTable" t WHERE t."outletId" = o.id) AS tables,
       (SELECT count(*) FROM "MenuItem" m WHERE m."organizationId" = g.id) AS menu_items_in_org
FROM "Organization" g JOIN "Outlet" o ON o."organizationId" = g.id ORDER BY g.name, o.code;

\echo '== 5. Live-menu identity check (only when -v menu_ids was given; N of N = this database holds the served menu)'
\if :{?menu_ids}
SELECT cardinality(:'menu_ids'::text[]) AS served_ids,
       (SELECT count(*) FROM "MenuItem" WHERE id = ANY (:'menu_ids'::text[])) AS found_here;
\else
\echo '(skipped: no menu_ids)'
\endif

\echo '== 6. QR token classes per outlet (same rules as npm run qr:audit; tokens never printed)'
WITH c AS (
  SELECT o.code AS outlet, t.code AS table_code,
    CASE
      WHEN t."qrToken" IS NULL THEN 'none'
      WHEN t."qrToken" = 'cc' || left(translate(rtrim(encode(sha256(convert_to('restora-demo:coders-cafe:table:' || t.code, 'UTF8')), 'base64'), '='), '+/', '-_'), 22) THEN 'legacy-derivable'
      WHEN t."qrToken" = o.code || '-' || t.code THEN 'legacy-derivable'
      WHEN t."qrToken" ~ '^[A-Za-z0-9_-]{24}$' THEN 'random'
      ELSE 'nonstandard'
    END AS class
  FROM "RestaurantTable" t JOIN "Outlet" o ON o.id = t."outletId"
)
SELECT outlet, class, count(*) AS tables, string_agg(table_code, ' ' ORDER BY table_code) AS table_codes
FROM c GROUP BY outlet, class ORDER BY outlet, class;

\echo '== 6b. Restaurant (common) QR per outlet — only on a schema that has it (release after a80caa9)'
SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Outlet' AND column_name = 'guestQrToken') AS has_common_qr \gset
\if :has_common_qr
SELECT o.code AS outlet,
  CASE
    WHEN o."guestQrToken" IS NULL THEN 'none'
    WHEN o."guestQrToken" ~ '^[A-Za-z0-9_-]{24}$' THEN 'random'
    ELSE 'nonstandard'
  END AS common_qr_class
FROM "Outlet" o ORDER BY o.code;
\else
\echo '(no common QR column: schema before 20261026100000_outlet_common_qr)'
\endif

\echo '== 7. Orders that a rotation or migration window would interrupt'
SELECT o.source, o.status, count(*) AS orders, max(o."createdAt") AS newest
FROM "Order" o WHERE o.status IN ('OPEN', 'SENT', 'PREPARING', 'READY', 'SERVED', 'BILLED') OR o."createdAt" > now() - interval '24 hours'
GROUP BY o.source, o.status ORDER BY o.source, o.status;
SELECT p.provider, p.method, p.status, count(*) AS payments, max(p."createdAt") AS newest
FROM "Payment" p WHERE p.status = 'PENDING' GROUP BY p.provider, p.method, p.status ORDER BY 1, 2, 3;

\echo '== 8. Legacy Razorpay (docs/payments-razorpay.md "Outstanding obligations")'
SELECT count(*) AS razorpay_pending FROM "Payment" WHERE provider = 'razorpay' AND status = 'PENDING';
SELECT count(*) AS razorpay_captured, max("createdAt") AS newest_captured FROM "Payment" WHERE provider = 'razorpay' AND status IN ('SUCCESS', 'PARTIAL');
SELECT count(*) AS razorpay_open_anomalies FROM "Anomaly" a JOIN "Payment" p ON p.id = a."entityId"
  WHERE a."entityType" = 'Payment' AND p.provider = 'razorpay' AND a.status IN ('OPEN', 'ACKNOWLEDGED');
SELECT count(*) AS razorpay_refunds_without_ref FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId"
  WHERE p.provider = 'razorpay' AND r."providerRef" IS NULL;
SELECT status, count(*) AS razorpay_webhooks_unprocessed FROM "WebhookEvent"
  WHERE provider = 'razorpay' AND status IN ('RECEIVED', 'FAILED') GROUP BY status;

\echo '== 9. Inconsistencies that make a migration or rotation unsafe (all should be 0)'
SELECT
  (SELECT count(*) FROM "RestaurantTable" t JOIN "Outlet" o ON o.id = t."outletId" WHERE o."organizationId" <> t."organizationId") AS tables_outlet_org_mismatch,
  (SELECT count(*) FROM pg_constraint WHERE NOT convalidated AND connamespace = 'public'::regnamespace) AS unvalidated_constraints,
  (SELECT count(*) FROM "Payment" p JOIN (SELECT "paymentId", sum(amount) s FROM "Refund" GROUP BY 1) r ON r."paymentId" = p.id WHERE r.s > p.amount) AS refunds_beyond_payment,
  (SELECT count(*) FROM "Order" o JOIN (SELECT "orderId", sum(amount) s FROM "Payment" WHERE status IN ('SUCCESS','PARTIAL','REFUNDED') GROUP BY 1) p ON p."orderId" = o.id WHERE p.s > o.total) AS overpaid_orders,
  (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished_migrations;

\echo '== 10. Size (for the backup / window estimate)'
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
  (SELECT count(*) FROM "Order") AS orders, (SELECT count(*) FROM "Payment") AS payments,
  (SELECT count(*) FROM "AuditLog") AS audit_rows, (SELECT count(*) FROM "InventoryLedger") AS ledger_rows;

ROLLBACK;
\echo '== done (read-only; rolled back)'
