-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" BIGINT NOT NULL,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "RateLimitWindow_resetAt_idx" ON "RateLimitWindow"("resetAt");

-- Append-only: the database itself refuses to change or remove audit and stock-ledger rows (audit SE-08, IN-01), whoever
-- sends the statement. A correction is a new row. Not part of the Prisma schema; src/server/db/appendOnly.ts names the
-- same triggers and the readiness check fails if one is ever missing.
CREATE OR REPLACE FUNCTION restora_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION restora_refuse_change();

CREATE TRIGGER "AuditLog_append_only_truncate" BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION restora_refuse_change();

CREATE TRIGGER "InventoryLedger_append_only" BEFORE UPDATE OR DELETE ON "InventoryLedger" FOR EACH ROW EXECUTE FUNCTION restora_refuse_change();

CREATE TRIGGER "InventoryLedger_append_only_truncate" BEFORE TRUNCATE ON "InventoryLedger" FOR EACH STATEMENT EXECUTE FUNCTION restora_refuse_change();
