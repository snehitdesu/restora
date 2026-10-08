-- Group 2 reorder engine (docs/master-feature-audit.md PP-01..03). Additive only;
-- mirrors prisma/migrations/20261013100000_reorder_engine.

-- AlterTable
ALTER TABLE "Material" ADD COLUMN     "parLevel" DECIMAL(16,4);

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "PurchaseIndent" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseIndent_organizationId_idempotencyKey_key" ON "PurchaseIndent"("organizationId", "idempotencyKey");
