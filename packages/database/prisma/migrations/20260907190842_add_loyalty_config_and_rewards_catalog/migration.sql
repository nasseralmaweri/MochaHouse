-- CreateEnum
CREATE TYPE "LoyaltyRewardType" AS ENUM ('FIXED_AMOUNT', 'FREE_ITEM');

-- CreateTable
CREATE TABLE "LoyaltyConfiguration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "earningRatePerDollar" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyReward" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "LoyaltyRewardType" NOT NULL,
    "beanCost" INTEGER NOT NULL,
    "fixedAmountMinorUnits" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyRewardProduct" (
    "rewardId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyRewardProduct_pkey" PRIMARY KEY ("rewardId","productId")
);

-- CreateTable
CREATE TABLE "LoyaltyRewardCategory" (
    "rewardId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyRewardCategory_pkey" PRIMARY KEY ("rewardId","categoryId")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfiguration_key_key" ON "LoyaltyConfiguration"("key");

-- CreateIndex
CREATE INDEX "LoyaltyReward_isActive_sortOrder_idx" ON "LoyaltyReward"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "LoyaltyRewardProduct_productId_idx" ON "LoyaltyRewardProduct"("productId");

-- CreateIndex
CREATE INDEX "LoyaltyRewardCategory_categoryId_idx" ON "LoyaltyRewardCategory"("categoryId");

-- AddForeignKey
ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "LoyaltyReward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "LoyaltyReward"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
