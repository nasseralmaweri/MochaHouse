-- CreateEnum
CREATE TYPE "GiftCardStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "GiftCardTransactionType" AS ENUM ('ISSUANCE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "status" "GiftCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "originalValueMinorUnits" INTEGER NOT NULL,
    "balanceMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardTransaction" (
    "id" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "type" "GiftCardTransactionType" NOT NULL,
    "amountMinorUnits" INTEGER NOT NULL,
    "balanceAfterMinorUnits" INTEGER NOT NULL,
    "reason" TEXT,
    "actorInternalUserId" TEXT,
    "operationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftCardConfiguration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "presetAmountsMinorUnits" INTEGER[],
    "customAmountEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCardConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_codeHash_key" ON "GiftCard"("codeHash");

-- CreateIndex
CREATE INDEX "GiftCard_status_idx" ON "GiftCard"("status");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_giftCardId_createdAt_idx" ON "GiftCardTransaction"("giftCardId", "createdAt");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_actorInternalUserId_idx" ON "GiftCardTransaction"("actorInternalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardConfiguration_key_key" ON "GiftCardConfiguration"("key");

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique indexes (Prisma cannot express the WHERE predicate, so they
-- are declared here and documented on the GiftCardTransaction model).
-- Exactly one ISSUANCE entry per gift card:
CREATE UNIQUE INDEX "GiftCardTransaction_issuance_per_card_key"
    ON "GiftCardTransaction"("giftCardId")
    WHERE "type" = 'ISSUANCE';
-- A manual correction is idempotent on its caller-supplied operationKey:
CREATE UNIQUE INDEX "GiftCardTransaction_adjustment_operationKey_key"
    ON "GiftCardTransaction"("operationKey")
    WHERE "type" = 'ADJUSTMENT' AND "operationKey" IS NOT NULL;
