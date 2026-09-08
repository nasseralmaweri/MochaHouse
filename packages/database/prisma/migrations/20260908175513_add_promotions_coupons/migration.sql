-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('AUTOMATIC', 'COUPON');

-- CreateEnum
CREATE TYPE "PromotionDiscountType" AS ENUM ('PERCENTAGE_OFF', 'FIXED_AMOUNT', 'FREE_ITEM');

-- CreateEnum
CREATE TYPE "PromotionApplicability" AS ENUM ('ENTIRE_ORDER', 'SELECTED_PRODUCTS', 'SELECTED_CATEGORIES');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "promotionDiscountMinorUnits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "PromotionKind" NOT NULL,
    "code" TEXT,
    "discountType" "PromotionDiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "maxDiscountMinorUnits" INTEGER,
    "applicability" "PromotionApplicability" NOT NULL DEFAULT 'ENTIRE_ORDER',
    "minimumSubtotalMinorUnits" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "appliesToAllLocations" BOOLEAN NOT NULL DEFAULT false,
    "totalRedemptionLimit" INTEGER,
    "perCustomerRedemptionLimit" INTEGER,
    "redemptionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionProduct" (
    "promotionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionProduct_pkey" PRIMARY KEY ("promotionId","productId")
);

-- CreateTable
CREATE TABLE "PromotionCategory" (
    "promotionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionCategory_pkey" PRIMARY KEY ("promotionId","categoryId")
);

-- CreateTable
CREATE TABLE "PromotionLocation" (
    "promotionId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionLocation_pkey" PRIMARY KEY ("promotionId","locationId")
);

-- CreateTable
CREATE TABLE "PromotionCustomerUsage" (
    "promotionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionCustomerUsage_pkey" PRIMARY KEY ("promotionId","customerId")
);

-- CreateTable
CREATE TABLE "OrderPromotionRedemption" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourcePromotionId" TEXT,
    "promotionName" TEXT NOT NULL,
    "promotionKind" "PromotionKind" NOT NULL,
    "couponCode" TEXT,
    "discountType" "PromotionDiscountType" NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "discountMinorUnits" INTEGER NOT NULL,
    "freeItemProductId" TEXT,
    "freeItemProductName" TEXT,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderPromotionRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_code_key" ON "Promotion"("code");

-- CreateIndex
CREATE INDEX "Promotion_kind_isActive_idx" ON "Promotion"("kind", "isActive");

-- CreateIndex
CREATE INDEX "Promotion_isActive_idx" ON "Promotion"("isActive");

-- CreateIndex
CREATE INDEX "PromotionProduct_productId_idx" ON "PromotionProduct"("productId");

-- CreateIndex
CREATE INDEX "PromotionCategory_categoryId_idx" ON "PromotionCategory"("categoryId");

-- CreateIndex
CREATE INDEX "PromotionLocation_locationId_idx" ON "PromotionLocation"("locationId");

-- CreateIndex
CREATE INDEX "PromotionCustomerUsage_customerId_idx" ON "PromotionCustomerUsage"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderPromotionRedemption_orderId_key" ON "OrderPromotionRedemption"("orderId");

-- CreateIndex
CREATE INDEX "OrderPromotionRedemption_sourcePromotionId_idx" ON "OrderPromotionRedemption"("sourcePromotionId");

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderPromotionRedemption" ADD CONSTRAINT "OrderPromotionRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
