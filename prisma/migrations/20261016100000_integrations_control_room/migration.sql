-- Group 5: accounting mapping, Google Sheets sync state, aggregator control room, scheduled job runs. Additive only.

CREATE TABLE "AccountingMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "ledgers" TEXT NOT NULL DEFAULT '{}',
    "parties" TEXT NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "AccountingMapping_organizationId_key" ON "AccountingMapping"("organizationId");

CREATE TABLE "SheetSyncRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "syncedHash" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SheetSyncRow_organizationId_dataset_rowKey_key" ON "SheetSyncRow"("organizationId", "dataset", "rowKey");

CREATE TABLE "SheetSyncConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "restoraValue" TEXT NOT NULL,
    "sheetValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME
);
CREATE INDEX "SheetSyncConflict_organizationId_status_idx" ON "SheetSyncConflict"("organizationId", "status");

CREATE TABLE "AggregatorStatementLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "statementRef" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "settledAt" DATETIME NOT NULL,
    "grossAmount" DECIMAL NOT NULL DEFAULT 0,
    "commission" DECIMAL NOT NULL DEFAULT 0,
    "penalty" DECIMAL NOT NULL DEFAULT 0,
    "adSpend" DECIMAL NOT NULL DEFAULT 0,
    "otherDeductions" DECIMAL NOT NULL DEFAULT 0,
    "netPayout" DECIMAL NOT NULL DEFAULT 0,
    "importedById" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AggregatorStatementLine_aggregatorId_statementRef_externalId_key" ON "AggregatorStatementLine"("aggregatorId", "statementRef", "externalId");
CREATE INDEX "AggregatorStatementLine_organizationId_outletId_settledAt_idx" ON "AggregatorStatementLine"("organizationId", "outletId", "settledAt");

CREATE TABLE "AggregatorCharge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "chargedOn" DATETIME NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidedById" TEXT,
    "voidReason" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT
);
CREATE UNIQUE INDEX "AggregatorCharge_organizationId_idempotencyKey_key" ON "AggregatorCharge"("organizationId", "idempotencyKey");
CREATE INDEX "AggregatorCharge_organizationId_outletId_chargedOn_idx" ON "AggregatorCharge"("organizationId", "outletId", "chargedOn");

CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "detail" TEXT
);
CREATE UNIQUE INDEX "JobRun_name_scopeKey_runDate_key" ON "JobRun"("name", "scopeKey", "runDate");
