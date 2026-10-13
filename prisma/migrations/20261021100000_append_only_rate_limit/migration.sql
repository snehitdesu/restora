-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL,
    "resetAt" BIGINT NOT NULL
);

-- CreateIndex
CREATE INDEX "RateLimitWindow_resetAt_idx" ON "RateLimitWindow"("resetAt");

-- Append-only: the database itself refuses to change or remove audit and stock-ledger rows (audit SE-08, IN-01).
-- A correction is a new row. Not part of the Prisma schema; src/server/db/appendOnly.ts holds the same statements and
-- the readiness check fails if one of these triggers is ever missing.
CREATE TRIGGER "AuditLog_append_only_update" BEFORE UPDATE ON "AuditLog" BEGIN SELECT RAISE(ABORT, 'AuditLog is append-only: a row cannot be changed'); END;

CREATE TRIGGER "AuditLog_append_only_delete" BEFORE DELETE ON "AuditLog" BEGIN SELECT RAISE(ABORT, 'AuditLog is append-only: a row cannot be removed'); END;

CREATE TRIGGER "InventoryLedger_append_only_update" BEFORE UPDATE ON "InventoryLedger" BEGIN SELECT RAISE(ABORT, 'InventoryLedger is append-only: a row cannot be changed'); END;

CREATE TRIGGER "InventoryLedger_append_only_delete" BEFORE DELETE ON "InventoryLedger" BEGIN SELECT RAISE(ABORT, 'InventoryLedger is append-only: a row cannot be removed'); END;
