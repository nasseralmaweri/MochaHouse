-- CreateEnum
CREATE TYPE "GiftCardPurchaseStatus" AS ENUM ('PENDING', 'ISSUED', 'RECONCILIATION_REQUIRED');

-- AlterTable
ALTER TABLE "GiftCardTransaction" ADD COLUMN     "giftCardPurchaseId" TEXT;

-- AlterTable
ALTER TABLE "PaymentAttempt" ALTER COLUMN "locationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "GiftCardPurchase" (
    "id" TEXT NOT NULL,
    "status" "GiftCardPurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "amountMinorUnits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "paymentAttemptId" TEXT NOT NULL,
    "giftCardId" TEXT,
    "customerId" TEXT,
    "purchaserEmail" TEXT NOT NULL,
    "purchaserName" TEXT,
    "codeCiphertext" BYTEA,
    "codeIv" BYTEA,
    "codeAuthTag" BYTEA,
    "codeRetrievableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCardPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardPurchase_paymentAttemptId_key" ON "GiftCardPurchase"("paymentAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardPurchase_giftCardId_key" ON "GiftCardPurchase"("giftCardId");

-- CreateIndex
CREATE INDEX "GiftCardPurchase_customerId_idx" ON "GiftCardPurchase"("customerId");

-- CreateIndex
CREATE INDEX "GiftCardPurchase_status_idx" ON "GiftCardPurchase"("status");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_giftCardPurchaseId_idx" ON "GiftCardTransaction"("giftCardPurchaseId");

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardPurchaseId_fkey" FOREIGN KEY ("giftCardPurchaseId") REFERENCES "GiftCardPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Milestone 7H — cross-table enforcement that a single PaymentAttempt backs
-- AT MOST ONE domain object: a food Order OR a gift-card purchase, never
-- both. Prisma cannot express a cross-table invariant, and a CHECK constraint
-- cannot see another table, so this is done with a pair of BEFORE INSERT
-- triggers. Each side's 1:1 uniqueness (Order.paymentAttemptId and
-- GiftCardPurchase.paymentAttemptId are both UNIQUE) already prevents two
-- rows of the SAME kind; these triggers add "not the other kind either".
CREATE OR REPLACE FUNCTION "assert_payment_attempt_single_domain"()
RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'Order' THEN
    IF EXISTS (
      SELECT 1 FROM "GiftCardPurchase" g
      WHERE g."paymentAttemptId" = NEW."paymentAttemptId"
    ) THEN
      RAISE EXCEPTION
        'PaymentAttempt % already backs a GiftCardPurchase and cannot also back an Order',
        NEW."paymentAttemptId" USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM "Order" o
      WHERE o."paymentAttemptId" = NEW."paymentAttemptId"
    ) THEN
      RAISE EXCEPTION
        'PaymentAttempt % already backs an Order and cannot also back a GiftCardPurchase',
        NEW."paymentAttemptId" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Order_single_payment_domain"
  BEFORE INSERT ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "assert_payment_attempt_single_domain"();

CREATE TRIGGER "GiftCardPurchase_single_payment_domain"
  BEFORE INSERT ON "GiftCardPurchase"
  FOR EACH ROW EXECUTE FUNCTION "assert_payment_attempt_single_domain"();
