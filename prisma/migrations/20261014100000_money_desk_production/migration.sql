-- Group 3: kitchen production, money desk, daily close (docs/group3-implementation-map.md). Additive only.

-- Batch-produced sub-recipes: dishes draw on the prepared stock.
ALTER TABLE "Recipe" ADD COLUMN "stocked" BOOLEAN NOT NULL DEFAULT false;
-- Recipes that were already produced in batches were being used that way.
UPDATE "Recipe" SET "stocked" = true
WHERE "outputType" = 'SUB_RECIPE' AND "outputMaterialId" IN (SELECT "outputMaterialId" FROM "ProductionBatch" WHERE "status" = 'COMPLETED');

-- Production batches belong to a department.
ALTER TABLE "ProductionBatch" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "ProductionBatch" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "ProductionBatch" ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "ProductionBatch_organizationId_idempotencyKey_key" ON "ProductionBatch"("organizationId", "idempotencyKey");

-- Wastage logged after the fact (worksheet for an earlier business day).
ALTER TABLE "Wastage" ADD COLUMN "occurredAt" DATETIME;

-- Bank deposit slips.
CREATE TABLE "BankDeposit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "depositedAt" DATETIME NOT NULL,
    "amount" DECIMAL NOT NULL,
    "reference" TEXT NOT NULL,
    "bankAccount" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "voidReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "requestHash" TEXT
);
CREATE UNIQUE INDEX "BankDeposit_organizationId_idempotencyKey_key" ON "BankDeposit"("organizationId", "idempotencyKey");
CREATE INDEX "BankDeposit_organizationId_outletId_businessDate_idx" ON "BankDeposit"("organizationId", "outletId", "businessDate");

-- Daily close revisions.
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "snapshot" TEXT NOT NULL,
    "notes" TEXT,
    "closedById" TEXT,
    "closedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedById" TEXT,
    "reopenedAt" DATETIME,
    "reopenReason" TEXT
);
CREATE UNIQUE INDEX "DayClose_outletId_businessDate_revision_key" ON "DayClose"("outletId", "businessDate", "revision");
CREATE INDEX "DayClose_organizationId_outletId_businessDate_idx" ON "DayClose"("organizationId", "outletId", "businessDate");
