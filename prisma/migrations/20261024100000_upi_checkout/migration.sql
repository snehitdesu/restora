-- Direct-bank UPI checkout: the QR the guest's screen shows (public data + expiry) and the
-- pending-payment recovery job's durable throttle / claim. Additive: three nullable columns and
-- one index. Existing rows are untouched (all NULL).

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "checkoutData" TEXT;
ALTER TABLE "Payment" ADD COLUMN "checkoutExpiresAt" DATETIME;
ALTER TABLE "Payment" ADD COLUMN "recheckedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
