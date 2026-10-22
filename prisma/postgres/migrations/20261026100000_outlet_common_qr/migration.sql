-- The restaurant's common QR: one random guest token per outlet, shared by every table
-- (docs/common-qr-ordering.md). Additive: a nullable column; no outlet gets a token until
-- staff issue one, so existing table QR codes and every other flow are unchanged.

-- AlterTable
ALTER TABLE "Outlet" ADD COLUMN     "guestQrToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_guestQrToken_key" ON "Outlet"("guestQrToken");
