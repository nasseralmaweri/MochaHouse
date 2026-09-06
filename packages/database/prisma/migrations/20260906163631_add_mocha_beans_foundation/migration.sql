-- CreateEnum
CREATE TYPE "MochaBeanEntryType" AS ENUM ('EARN', 'MANUAL_ADJUSTMENT');

-- CreateTable
CREATE TABLE "CustomerLoyaltyAccount" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerLoyaltyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MochaBeanLedgerEntry" (
    "id" TEXT NOT NULL,
    "loyaltyAccountId" TEXT NOT NULL,
    "type" "MochaBeanEntryType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT,
    "orderId" TEXT,
    "actorInternalUserId" TEXT,
    "operationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MochaBeanLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLoyaltyAccount_customerId_key" ON "CustomerLoyaltyAccount"("customerId");

-- CreateIndex
CREATE INDEX "MochaBeanLedgerEntry_loyaltyAccountId_createdAt_idx" ON "MochaBeanLedgerEntry"("loyaltyAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "MochaBeanLedgerEntry_orderId_idx" ON "MochaBeanLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "MochaBeanLedgerEntry_actorInternalUserId_idx" ON "MochaBeanLedgerEntry"("actorInternalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MochaBeanLedgerEntry_type_orderId_key" ON "MochaBeanLedgerEntry"("type", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MochaBeanLedgerEntry_type_operationKey_key" ON "MochaBeanLedgerEntry"("type", "operationKey");

-- AddForeignKey
ALTER TABLE "CustomerLoyaltyAccount" ADD CONSTRAINT "CustomerLoyaltyAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_loyaltyAccountId_fkey" FOREIGN KEY ("loyaltyAccountId") REFERENCES "CustomerLoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
