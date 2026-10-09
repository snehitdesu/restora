-- AlterTable
ALTER TABLE "Task" ADD COLUMN "runDate" TEXT;
ALTER TABLE "Task" ADD COLUMN "templateItemId" TEXT;

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShiftAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChecklistTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OPENING',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ChecklistTemplateItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ChecklistTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShiftAssignment_organizationId_outletId_date_idx" ON "ShiftAssignment"("organizationId", "outletId", "date");

-- CreateIndex
CREATE INDEX "ShiftAssignment_userId_date_idx" ON "ShiftAssignment"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_shiftId_userId_date_key" ON "ShiftAssignment"("shiftId", "userId", "date");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_organizationId_outletId_idx" ON "ChecklistTemplate"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_outletId_name_key" ON "ChecklistTemplate"("outletId", "name");

-- CreateIndex
CREATE INDEX "ChecklistTemplateItem_templateId_idx" ON "ChecklistTemplateItem"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_templateItemId_runDate_key" ON "Task"("templateItemId", "runDate");

