-- Cloud PostgreSQL only: idempotent operation receipts and revocable desktop device identity.
-- Desktop-only tables (CloudLink, CloudRecordMap, SyncOperation) stay on the installed app's SQLite database.

-- CreateTable
CREATE TABLE "SyncOpReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOpReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePairing" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DevicePairing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloudDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "enrolledById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncOpReceipt_orderId_idx" ON "SyncOpReceipt"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncOpReceipt_organizationId_opId_key" ON "SyncOpReceipt"("organizationId", "opId");

-- CreateIndex
CREATE UNIQUE INDEX "DevicePairing_codeHash_key" ON "DevicePairing"("codeHash");

-- CreateIndex
CREATE INDEX "DevicePairing_organizationId_expiresAt_idx" ON "DevicePairing"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CloudDevice_tokenHash_key" ON "CloudDevice"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "CloudDevice_organizationId_installId_key" ON "CloudDevice"("organizationId", "installId");

-- CreateIndex
CREATE INDEX "CloudDevice_organizationId_status_idx" ON "CloudDevice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "CloudDevice_expiresAt_idx" ON "CloudDevice"("expiresAt");
