-- AlterEnum
ALTER TYPE "MochaBeanEntryType" ADD VALUE 'REDEEM';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "rewardDiscountMinorUnits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderLoyaltyRewardRedemption" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceRewardId" TEXT,
    "rewardName" TEXT NOT NULL,
    "rewardType" "LoyaltyRewardType" NOT NULL,
    "beanCost" INTEGER NOT NULL,
    "discountMinorUnits" INTEGER NOT NULL,
    "freeItemProductId" TEXT,
    "freeItemProductName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLoyaltyRewardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderLoyaltyRewardRedemption_orderId_key" ON "OrderLoyaltyRewardRedemption"("orderId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyRewardRedemption_sourceRewardId_idx" ON "OrderLoyaltyRewardRedemption"("sourceRewardId");

-- AddForeignKey
ALTER TABLE "OrderLoyaltyRewardRedemption" ADD CONSTRAINT "OrderLoyaltyRewardRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
