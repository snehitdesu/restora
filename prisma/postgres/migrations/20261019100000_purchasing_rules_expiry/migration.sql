-- AlterTable
ALTER TABLE "GoodsReceiptLine" ADD COLUMN     "fssaiLot" TEXT;

-- AlterTable
ALTER TABLE "InventoryIssue" ADD COLUMN     "indentId" TEXT;

-- AlterTable
ALTER TABLE "InventoryLedger" ADD COLUMN     "fssaiLot" TEXT;

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "brand" TEXT;

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "cuisineTags" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "autoApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "firstApprovedAt" TIMESTAMP(3),
ADD COLUMN     "firstApprovedById" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "lineStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "requestedQty" DECIMAL(16,4);

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "category" TEXT,
ADD COLUMN     "natureOfSupply" TEXT;

-- CreateTable
CREATE TABLE "VendorContact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "autoApproveBelow" DECIMAL(14,2),
    "dualApprovalAtOrAbove" DECIMAL(14,2),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorContact_vendorId_idx" ON "VendorContact"("vendorId");

-- CreateIndex
CREATE INDEX "VendorContact_organizationId_idx" ON "VendorContact"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementSettings_organizationId_key" ON "ProcurementSettings"("organizationId");

-- CreateIndex
CREATE INDEX "InventoryIssue_indentId_idx" ON "InventoryIssue"("indentId");

-- AddForeignKey
ALTER TABLE "VendorContact" ADD CONSTRAINT "VendorContact_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

