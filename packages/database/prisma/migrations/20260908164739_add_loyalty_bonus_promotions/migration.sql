-- CreateEnum
CREATE TYPE "LoyaltyBonusPromotionType" AS ENUM ('EXTRA_BEANS', 'MULTIPLIER');

-- AlterEnum
ALTER TYPE "MochaBeanEntryType" ADD VALUE 'BONUS_EARN';

-- CreateTable
CREATE TABLE "LoyaltyBonusPromotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LoyaltyBonusPromotionType" NOT NULL,
    "bonusValue" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "appliesToAllLocations" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyBonusPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyBonusPromotionProduct" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyBonusPromotionProduct_pkey" PRIMARY KEY ("promotionId","productId")
);

-- CreateTable
CREATE TABLE "LoyaltyBonusPromotionLocation" (
    "promotionId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyBonusPromotionLocation_pkey" PRIMARY KEY ("promotionId","locationId")
);

-- CreateTable
CREATE TABLE "OrderLoyaltyBonus" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "totalBonusBeans" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLoyaltyBonus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLoyaltyBonusItem" (
    "id" TEXT NOT NULL,
    "orderLoyaltyBonusId" TEXT NOT NULL,
    "sourcePromotionId" TEXT,
    "promotionName" TEXT NOT NULL,
    "promotionType" "LoyaltyBonusPromotionType" NOT NULL,
    "bonusValue" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "qualifyingUnits" INTEGER NOT NULL,
    "qualifyingSpendMinorUnits" INTEGER NOT NULL,
    "standardBeansForItem" INTEGER NOT NULL,
    "bonusBeans" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLoyaltyBonusItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotion_isActive_idx" ON "LoyaltyBonusPromotion"("isActive");

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotionProduct_productId_idx" ON "LoyaltyBonusPromotionProduct"("productId");

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotionLocation_locationId_idx" ON "LoyaltyBonusPromotionLocation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLoyaltyBonus_orderId_key" ON "OrderLoyaltyBonus"("orderId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyBonusItem_orderLoyaltyBonusId_idx" ON "OrderLoyaltyBonusItem"("orderLoyaltyBonusId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyBonusItem_sourcePromotionId_idx" ON "OrderLoyaltyBonusItem"("sourcePromotionId");

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyBonusPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyBonusPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLoyaltyBonus" ADD CONSTRAINT "OrderLoyaltyBonus_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLoyaltyBonusItem" ADD CONSTRAINT "OrderLoyaltyBonusItem_orderLoyaltyBonusId_fkey" FOREIGN KEY ("orderLoyaltyBonusId") REFERENCES "OrderLoyaltyBonus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
