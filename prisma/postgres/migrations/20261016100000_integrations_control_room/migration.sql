-- Group 5: accounting mapping, Google Sheets sync state, aggregator control room, scheduled job runs.
-- Additive only; mirrors prisma/migrations/20261016100000_integrations_control_room.

-- CreateTable
CREATE TABLE "AccountingMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ledgers" TEXT NOT NULL DEFAULT '{}',
    "parties" TEXT NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetSyncRow" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "syncedHash" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SheetSyncRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SheetSyncConflict" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "restoraValue" TEXT NOT NULL,
    "sheetValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SheetSyncConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorStatementLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "statementRef" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "grossAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "commission" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "penalty" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "adSpend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "netPayout" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AggregatorStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatorCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "chargedOn" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "AggregatorCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "detail" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingMapping_organizationId_key" ON "AccountingMapping"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SheetSyncRow_organizationId_dataset_rowKey_key" ON "SheetSyncRow"("organizationId", "dataset", "rowKey");

-- CreateIndex
CREATE INDEX "SheetSyncConflict_organizationId_status_idx" ON "SheetSyncConflict"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AggregatorStatementLine_organizationId_outletId_settledAt_idx" ON "AggregatorStatementLine"("organizationId", "outletId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorStatementLine_aggregatorId_statementRef_externalI_key" ON "AggregatorStatementLine"("aggregatorId", "statementRef", "externalId");

-- CreateIndex
CREATE INDEX "AggregatorCharge_organizationId_outletId_chargedOn_idx" ON "AggregatorCharge"("organizationId", "outletId", "chargedOn");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorCharge_organizationId_idempotencyKey_key" ON "AggregatorCharge"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_name_scopeKey_runDate_key" ON "JobRun"("name", "scopeKey", "runDate");
