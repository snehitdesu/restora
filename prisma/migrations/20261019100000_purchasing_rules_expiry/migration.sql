-- Purchasing approval rules, line-level review, expiry lots, brand, vendor contacts, issue-to-indent link.
-- AlterTable
ALTER TABLE "GoodsReceiptLine" ADD COLUMN "fssaiLot" TEXT;

-- AlterTable
ALTER TABLE "InventoryIssue" ADD COLUMN "indentId" TEXT;

-- AlterTable
ALTER TABLE "InventoryLedger" ADD COLUMN "fssaiLot" TEXT;

-- AlterTable
ALTER TABLE "Material" ADD COLUMN "brand" TEXT;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN "cuisineTags" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN "category" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "natureOfSupply" TEXT;

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcurementSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "autoApproveBelow" DECIMAL,
    "dualApprovalAtOrAbove" DECIMAL,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable (plain ADD COLUMN: SQLite adds a column with a constant default in place, so no table is rebuilt)
ALTER TABLE "PurchaseOrder" ADD COLUMN "autoApproved" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PurchaseOrder" ADD COLUMN "firstApprovedAt" DATETIME;
ALTER TABLE "PurchaseOrder" ADD COLUMN "firstApprovedById" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "lineStatus" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "PurchaseOrderLine" ADD COLUMN "requestedQty" DECIMAL;

-- CreateIndex
CREATE INDEX "VendorContact_vendorId_idx" ON "VendorContact"("vendorId");

-- CreateIndex
CREATE INDEX "VendorContact_organizationId_idx" ON "VendorContact"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementSettings_organizationId_key" ON "ProcurementSettings"("organizationId");

-- CreateIndex
CREATE INDEX "InventoryIssue_indentId_idx" ON "InventoryIssue"("indentId");

