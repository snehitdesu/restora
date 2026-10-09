-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "holdLabel" TEXT;

-- AlterTable
ALTER TABLE "WaitlistEntry" ADD COLUMN     "notifiedAt" TIMESTAMP(3),
ADD COLUMN     "notifyCount" INTEGER NOT NULL DEFAULT 0;

