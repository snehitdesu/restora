-- Group 3: kitchen production, money desk, daily close. Additive only;
-- mirrors prisma/migrations/20261014100000_money_desk_production.

-- AlterTable
ALTER TABLE "Recipe" ADD COLUMN     "stocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProductionBatch" ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT;

-- AlterTable
ALTER TABLE "Wastage" ADD COLUMN     "occurredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BankDeposit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "depositedAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "bankAccount" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "voidReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "BankDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DayClose" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "snapshot" TEXT NOT NULL,
    "notes" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reopenedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT,

    CONSTRAINT "DayClose_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_organizationId_idempotencyKey_key" ON "ProductionBatch"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BankDeposit_organizationId_idempotencyKey_key" ON "BankDeposit"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BankDeposit_organizationId_outletId_businessDate_idx" ON "BankDeposit"("organizationId", "outletId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DayClose_outletId_businessDate_revision_key" ON "DayClose"("outletId", "businessDate", "revision");

-- CreateIndex
CREATE INDEX "DayClose_organizationId_outletId_businessDate_idx" ON "DayClose"("organizationId", "outletId", "businessDate");

-- Recipes that were already produced in batches were being used that way.
UPDATE "Recipe" SET "stocked" = true
WHERE "outputType" = 'SUB_RECIPE' AND "outputMaterialId" IN (SELECT "outputMaterialId" FROM "ProductionBatch" WHERE "status" = 'COMPLETED');
