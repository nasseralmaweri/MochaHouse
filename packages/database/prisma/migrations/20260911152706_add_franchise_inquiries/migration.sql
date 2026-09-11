-- CreateEnum
CREATE TYPE "FranchiseInquiryStatus" AS ENUM ('NEW', 'REVIEWING', 'CONTACTED', 'QUALIFIED', 'CLOSED');

-- CreateTable
CREATE TABLE "FranchiseInquiry" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "preferredMarket" TEXT NOT NULL,
    "investmentRange" TEXT,
    "timeframe" TEXT,
    "businessExperience" TEXT,
    "message" TEXT,
    "consentAcknowledged" BOOLEAN NOT NULL,
    "status" "FranchiseInquiryStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseInquiryNote" (
    "id" TEXT NOT NULL,
    "franchiseInquiryId" TEXT NOT NULL,
    "authorInternalUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FranchiseInquiryNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FranchiseInquiry_status_idx" ON "FranchiseInquiry"("status");

-- CreateIndex
CREATE INDEX "FranchiseInquiry_createdAt_idx" ON "FranchiseInquiry"("createdAt");

-- CreateIndex
CREATE INDEX "FranchiseInquiryNote_franchiseInquiryId_createdAt_idx" ON "FranchiseInquiryNote"("franchiseInquiryId", "createdAt");

-- CreateIndex
CREATE INDEX "FranchiseInquiryNote_authorInternalUserId_idx" ON "FranchiseInquiryNote"("authorInternalUserId");

-- AddForeignKey
ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_franchiseInquiryId_fkey" FOREIGN KEY ("franchiseInquiryId") REFERENCES "FranchiseInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_authorInternalUserId_fkey" FOREIGN KEY ("authorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
