-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "reconciliationDetectedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationReason" TEXT,
ADD COLUMN     "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "PaymentAttempt_reconciliationRequired_idx" ON "PaymentAttempt"("reconciliationRequired");
