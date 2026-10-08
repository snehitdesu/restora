-- Group 2 reorder engine (docs/master-feature-audit.md PP-01..03). Additive only;
-- every new column is nullable, so existing rows need no backfill.

-- Order-up-to (par) level; empty means the reorder level is the par.
ALTER TABLE "Material" ADD COLUMN "parLevel" DECIMAL;

-- Provenance of documents raised from the reorder screen ("REORDER"; null = by hand).
ALTER TABLE "PurchaseOrder" ADD COLUMN "source" TEXT;
ALTER TABLE "PurchaseIndent" ADD COLUMN "source" TEXT;

-- Creation idempotency for indents (same contract as purchase orders).
ALTER TABLE "PurchaseIndent" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PurchaseIndent" ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "PurchaseIndent_organizationId_idempotencyKey_key" ON "PurchaseIndent"("organizationId", "idempotencyKey");
