-- 2026-10-07 core-gap pass (docs/master-feature-audit.md). Additive only.

-- Vendor approval lifecycle (MD-16). Existing vendors keep trading: ACTIVE,
-- or INACTIVE where they were already deactivated. New vendors start PENDING
-- (set by the service, not the column default).
ALTER TABLE "Vendor" ADD COLUMN "upiId" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Vendor" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "approvedAt" DATETIME;
UPDATE "Vendor" SET "status" = 'INACTIVE' WHERE "active" = false;
CREATE INDEX "Vendor_organizationId_status_idx" ON "Vendor"("organizationId", "status");

-- KOT lifecycle stamps for measured prep time (MB-07).
ALTER TABLE "Kot" ADD COLUMN "acceptedAt" DATETIME;
ALTER TABLE "Kot" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "Kot" ADD COLUMN "readyAt" DATETIME;
ALTER TABLE "Kot" ADD COLUMN "servedAt" DATETIME;

-- Dish-level wastage (IN-12).
ALTER TABLE "Wastage" ADD COLUMN "menuItemId" TEXT;
ALTER TABLE "Wastage" ADD COLUMN "dishQty" DECIMAL;

-- Dish production worksheet (KP-01).
CREATE TABLE "DishProduction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "departmentId" TEXT,
    "businessDate" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "preparedQty" DECIMAL NOT NULL DEFAULT 0,
    "wastedQty" DECIMAL NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "DishProduction_organizationId_outletId_businessDate_idx" ON "DishProduction"("organizationId", "outletId", "businessDate");
CREATE UNIQUE INDEX "DishProduction_outletId_businessDate_menuItemId_key" ON "DishProduction"("outletId", "businessDate", "menuItemId");
