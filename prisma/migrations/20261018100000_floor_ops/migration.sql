-- Held bills (the counter's named hold list) and waitlist notification stamps.
-- Plain ADD COLUMN statements: SQLite adds a column with a constant default in place, so no table is rebuilt.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "heldAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "holdLabel" TEXT;

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN "notifiedAt" DATETIME;
ALTER TABLE "WaitlistEntry" ADD COLUMN "notifyCount" INTEGER NOT NULL DEFAULT 0;
