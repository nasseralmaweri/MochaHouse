-- AlterEnum
ALTER TYPE "GiftCardTransactionType" ADD VALUE 'REDEMPTION';

-- AlterTable
ALTER TABLE "GiftCardTransaction" ADD COLUMN     "orderId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "giftCardTenderMinorUnits" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OrderGiftCardRedemption" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sourceGiftCardId" TEXT,
    "last4" TEXT NOT NULL,
    "amountMinorUnits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderGiftCardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderGiftCardRedemption_orderId_key" ON "OrderGiftCardRedemption"("orderId");

-- CreateIndex
CREATE INDEX "OrderGiftCardRedemption_sourceGiftCardId_idx" ON "OrderGiftCardRedemption"("sourceGiftCardId");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_orderId_idx" ON "GiftCardTransaction"("orderId");

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderGiftCardRedemption" ADD CONSTRAINT "OrderGiftCardRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique index (Prisma cannot express the WHERE predicate, so it is
-- declared here and documented on the GiftCardTransaction model). Milestone
-- 7G: exactly one REDEMPTION entry per order — a checkout replay can never
-- spend the card twice.
CREATE UNIQUE INDEX "GiftCardTransaction_redemption_per_order_key"
    ON "GiftCardTransaction"("orderId")
    WHERE "type" = 'REDEMPTION';
