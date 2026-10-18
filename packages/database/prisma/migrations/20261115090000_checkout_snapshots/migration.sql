-- ESP-03 PR 4 — resumable order fulfilment: CheckoutSnapshot.
--
-- The server-validated checkout a food-order payment pays for, committed in
-- the same transaction as its PaymentAttempt BEFORE the payment provider is
-- called. A charged payment's order can then always be created later from
-- this saved data (a crash, a failed write, a retry), never from a retried
-- request. One per payment attempt; tenant-owned like every business table.
--
-- Privacy: `payload` holds only what the order needs (location, cart lines
-- and choices, guest contact, customer id, reward / coupon / gift-card plan
-- by card id — never a card code, card data, credential or provider
-- secret). Rows are deleted when their order is created or their payment
-- definitively fails; a charged payment with no order keeps its row while
-- it awaits recovery or review.
--
-- ADDITIVE ONLY: one new table, its keys, two CHECK constraints and the
-- standard ownership guard. No existing row changes. A read-only preflight
-- refuses (changing nothing) if the ownership guard function is missing or
-- the table already exists.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261115090000_checkout_snapshots.down.sql.

DO $checkout_snapshots_preflight$
BEGIN
  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Checkout snapshots refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"CheckoutSnapshot"') IS NOT NULL THEN
    RAISE EXCEPTION 'Checkout snapshots refused: table "CheckoutSnapshot" already exists. Nothing was changed.';
  END IF;
END
$checkout_snapshots_preflight$;

-- CreateTable
CREATE TABLE "CheckoutSnapshot" (
    "id" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "CheckoutSnapshot_pkey" PRIMARY KEY ("id"),
    -- Only the format the application writes, as a JSON object of bounded
    -- size (a checkout is small; this is a backstop, not a quota).
    CONSTRAINT "CheckoutSnapshot_version_check" CHECK ("version" = 1),
    CONSTRAINT "CheckoutSnapshot_payload_check" CHECK (
      jsonb_typeof("payload") = 'object'
      AND octet_length("payload"::text) <= 65536
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSnapshot_paymentAttemptId_key" ON "CheckoutSnapshot"("paymentAttemptId");

-- CreateIndex
CREATE INDEX "CheckoutSnapshot_tenantId_idx" ON "CheckoutSnapshot"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSnapshot_tenantId_id_key" ON "CheckoutSnapshot"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutSnapshot_tenantId_paymentAttemptId_key" ON "CheckoutSnapshot"("tenantId", "paymentAttemptId");

-- The snapshot's payment attempt must belong to the same business
-- (composite key).
ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A business-owned row never moves to another business (the Security 4C
-- ownership guard every tenant-owned table carries).
CREATE TRIGGER "CheckoutSnapshot_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CheckoutSnapshot"
  FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION "reject_tenant_reassignment"();
