-- 2026-10-07 core-gap pass (docs/master-feature-audit.md). Additive only; mirrors prisma/migrations/20261012100000_core_gaps.

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "statusReason" TEXT,
ADD COLUMN     "upiId" TEXT;

-- AlterTable
ALTER TABLE "Kot" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "readyAt" TIMESTAMP(3),
ADD COLUMN     "servedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Wastage" ADD COLUMN     "dishQty" DECIMAL(16,4),
ADD COLUMN     "menuItemId" TEXT;

-- CreateTable
CREATE TABLE "DishProduction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "departmentId" TEXT,
    "businessDate" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "preparedQty" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "wastedQty" DECIMAL(16,4) NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DishProduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DishProduction_organizationId_outletId_businessDate_idx" ON "DishProduction"("organizationId", "outletId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "DishProduction_outletId_businessDate_menuItemId_key" ON "DishProduction"("outletId", "businessDate", "menuItemId");

-- CreateIndex
CREATE INDEX "Vendor_organizationId_status_idx" ON "Vendor"("organizationId", "status");


-- Existing deactivated vendors keep their state under the new lifecycle.
UPDATE "Vendor" SET "status" = 'INACTIVE' WHERE "active" = false;
