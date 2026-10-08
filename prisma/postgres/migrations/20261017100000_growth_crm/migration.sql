-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "anniversary" TIMESTAMP(3),
ADD COLUMN     "preferences" TEXT;

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "handledAt" TIMESTAMP(3),
ADD COLUMN     "handledById" TEXT,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "routedTo" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'STAFF',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'NEW';

-- CreateTable
CREATE TABLE "CustomerConsent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "transactional" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'STAFF',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthSettings" (
    "organizationId" TEXT NOT NULL,
    "referralEnabled" BOOLEAN NOT NULL DEFAULT false,
    "referrerPoints" INTEGER NOT NULL DEFAULT 100,
    "refereePoints" INTEGER NOT NULL DEFAULT 50,
    "referralMinOrderValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "LoyaltyTier" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSpend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "earnMultiplierPct" DECIMAL(7,4) NOT NULL DEFAULT 100,
    "perks" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "maxDiscount" DECIMAL(14,2),
    "minOrderValue" DECIMAL(14,2),
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "perCustomerLimit" INTEGER,
    "firstOrderOnly" BOOLEAN NOT NULL DEFAULT false,
    "minTier" TEXT,
    "channels" TEXT,
    "outletIds" TEXT,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'APPLIED',
    "reversedAt" TIMESTAMP(3),
    "reverseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "referrerCustomerId" TEXT NOT NULL,
    "referredCustomerId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT,
    "qualifyingOrderId" TEXT,
    "referrerPoints" INTEGER,
    "refereePoints" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rewardedAt" TIMESTAMP(3),

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT,
    "token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "feedbackId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'MANUAL',
    "audience" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "couponId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "skipReason" TEXT,
    "deliveryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

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

-- CreateIndex
CREATE INDEX "Feedback_organizationId_status_createdAt_idx" ON "Feedback"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_orderId_idx" ON "Feedback"("orderId");

-- AddForeignKey
ALTER TABLE "CustomerConsent" ADD CONSTRAINT "CustomerConsent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

