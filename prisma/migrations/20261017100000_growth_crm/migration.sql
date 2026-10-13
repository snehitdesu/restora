-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "anniversary" DATETIME;
ALTER TABLE "Customer" ADD COLUMN "preferences" TEXT;

-- CreateTable
CREATE TABLE "CustomerConsent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "transactional" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CustomerConsent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GrowthSettings" (
    "organizationId" TEXT NOT NULL PRIMARY KEY,
    "referralEnabled" BOOLEAN NOT NULL DEFAULT false,
    "referrerPoints" INTEGER NOT NULL DEFAULT 100,
    "refereePoints" INTEGER NOT NULL DEFAULT 50,
    "referralMinOrderValue" DECIMAL NOT NULL DEFAULT 0,
    "referralMonthlyCap" INTEGER NOT NULL DEFAULT 20,
    "birthdayCouponId" TEXT,
    "anniversaryCouponId" TEXT,
    "winbackCouponId" TEXT,
    "winbackAfterDays" INTEGER NOT NULL DEFAULT 45,
    "winbackCooldownDays" INTEGER NOT NULL DEFAULT 90,
    "feedbackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "feedbackDelayMinutes" INTEGER NOT NULL DEFAULT 120,
    "googleReviewUrl" TEXT,
    "lowRatingMax" INTEGER NOT NULL DEFAULT 3,
    "quietHoursStart" INTEGER NOT NULL DEFAULT 21,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 9,
    "marketingWeeklyCap" INTEGER NOT NULL DEFAULT 2,
    "bookingMessagesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "bookingReminderHours" INTEGER NOT NULL DEFAULT 2,
    "digestEnabled" BOOLEAN NOT NULL DEFAULT false,
    "digestHour" INTEGER NOT NULL DEFAULT 9,
    "digestPhone" TEXT,
    "updatedById" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LoyaltyTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSpend" DECIMAL NOT NULL DEFAULT 0,
    "earnMultiplierPct" DECIMAL NOT NULL DEFAULT 100,
    "perks" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "value" DECIMAL NOT NULL,
    "maxDiscount" DECIMAL,
    "minOrderValue" DECIMAL,
    "validFrom" DATETIME,
    "validTo" DATETIME,
    "usageLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "minTier" TEXT,
    "channels" TEXT,
    "outletIds" TEXT,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "reversedAt" DATETIME,
    "reverseReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "referredCustomerId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "qualifyingOrderId" TEXT,
    "referrerPoints" INTEGER,
    "refereePoints" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardedAt" DATETIME
);

-- CreateTable
CREATE TABLE "FeedbackRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "dueAt" DATETIME NOT NULL,
    "sentAt" DATETIME,
    "answeredAt" DATETIME,
    "feedbackId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "audience" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "couponId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "skipReason" TEXT,
    "deliveryId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "customerId" TEXT,
    "orderId" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 5,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "routedTo" TEXT,
    "handledById" TEXT,
    "handledAt" DATETIME,
    "resolution" TEXT,
    CONSTRAINT "Feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Feedback" ("comment", "createdAt", "customerId", "id", "orderId", "organizationId", "outletId", "rating") SELECT "comment", "createdAt", "customerId", "id", "orderId", "organizationId", "outletId", "rating" FROM "Feedback";
DROP TABLE "Feedback";
ALTER TABLE "new_Feedback" RENAME TO "Feedback";
CREATE INDEX "Feedback_organizationId_idx" ON "Feedback"("organizationId");
CREATE INDEX "Feedback_customerId_idx" ON "Feedback"("customerId");
CREATE INDEX "Feedback_organizationId_status_createdAt_idx" ON "Feedback"("organizationId", "status", "createdAt");
CREATE INDEX "Feedback_orderId_idx" ON "Feedback"("orderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CustomerConsent_organizationId_channel_marketing_idx" ON "CustomerConsent"("organizationId", "channel", "marketing");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerConsent_customerId_channel_key" ON "CustomerConsent"("customerId", "channel");

-- CreateIndex
CREATE INDEX "LoyaltyTier_organizationId_active_idx" ON "LoyaltyTier"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTier_organizationId_code_key" ON "LoyaltyTier"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Coupon_organizationId_active_idx" ON "Coupon"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_organizationId_code_key" ON "Coupon"("organizationId", "code");

-- CreateIndex
CREATE INDEX "CouponRedemption_couponId_status_idx" ON "CouponRedemption"("couponId", "status");

-- CreateIndex
CREATE INDEX "CouponRedemption_organizationId_customerId_idx" ON "CouponRedemption"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CouponRedemption_orderId_couponId_key" ON "CouponRedemption"("orderId", "couponId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_organizationId_customerId_key" ON "ReferralCode"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_organizationId_code_key" ON "ReferralCode"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Referral_organizationId_referrerCustomerId_status_idx" ON "Referral"("organizationId", "referrerCustomerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_organizationId_referredCustomerId_key" ON "Referral"("organizationId", "referredCustomerId");

-- CreateIndex
CREATE INDEX "FeedbackRequest_organizationId_status_dueAt_idx" ON "FeedbackRequest"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_orderId_key" ON "FeedbackRequest"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "FeedbackRequest_token_key" ON "FeedbackRequest"("token");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_status_scheduledAt_idx" ON "Campaign"("organizationId", "status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_organizationId_customerId_idx" ON "CampaignRecipient"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_customerId_key" ON "CampaignRecipient"("campaignId", "customerId");

