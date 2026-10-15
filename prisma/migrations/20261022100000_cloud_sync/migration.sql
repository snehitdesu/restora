-- Cloud side (also present on SQLite so tests can exercise both worlds in one disposable database):
-- SyncOpReceipt, DevicePairing, CloudDevice.
-- Desktop side (SQLite only in production): CloudLink, CloudRecordMap, SyncOperation.

-- CreateTable
CREATE TABLE "SyncOpReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "opId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DevicePairing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CloudDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "enrolledById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CloudLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "cloudOutletId" TEXT NOT NULL,
    "cloudOutletCode" TEXT NOT NULL,
    "localOutletId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "tokenCipher" TEXT,
    "status" TEXT NOT NULL DEFAULT 'LINKED',
    "cursor" TEXT,
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CloudRecordMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "cloudId" TEXT NOT NULL,
    "localId" TEXT NOT NULL,
    "revision" TEXT,
    "issues" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "localOrderId" TEXT NOT NULL,
    "cloudOrderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT,
    "lastError" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
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

-- CreateIndex
CREATE UNIQUE INDEX "CloudLink_organizationId_key" ON "CloudLink"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudRecordMap_organizationId_kind_cloudId_key" ON "CloudRecordMap"("organizationId", "kind", "cloudId");

-- CreateIndex
CREATE UNIQUE INDEX "CloudRecordMap_organizationId_kind_localId_key" ON "CloudRecordMap"("organizationId", "kind", "localId");

-- CreateIndex
CREATE INDEX "SyncOperation_organizationId_status_nextAttemptAt_idx" ON "SyncOperation"("organizationId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "SyncOperation_localOrderId_idx" ON "SyncOperation"("localOrderId");
