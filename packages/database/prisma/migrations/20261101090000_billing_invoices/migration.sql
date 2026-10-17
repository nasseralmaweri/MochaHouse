-- SC3e-1 — billing history: the business's CENTERIVO subscription invoices
-- as the billing provider last reported them (owner decision D1). Kept in
-- line from verified provider events and the reconciliation sweep, always
-- from a LIVE provider read. The provider stays authoritative for money:
-- nothing here charges, refunds or credits anyone. No document URL and no
-- payment-method detail is stored (owner decisions D2/D3).
--
-- Platform billing data (no tenantId): the business is reached only through
-- TenantSubscription. Nothing here references restaurant orders, payments,
-- refunds or gift cards (owner decision D5).
--
-- ADDITIVE: the BillingInvoice table, its CHECK constraint and a guard
-- trigger (never deleted; which invoice of which subscription is set once;
-- a paid or void invoice stays so; an older provider read never replaces a
-- newer one). No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261101090000_billing_invoices.down.sql.

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalInvoiceId" TEXT NOT NULL,
    "externalCustomerId" TEXT NOT NULL,
    "externalSubscriptionId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL,
    "billingReason" TEXT,
    "currency" TEXT NOT NULL,
    "totalMinorUnits" INTEGER NOT NULL,
    "amountDueMinorUnits" INTEGER NOT NULL,
    "amountPaidMinorUnits" INTEGER NOT NULL,
    "amountRemainingMinorUnits" INTEGER NOT NULL,
    "postPaymentCreditMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "prePaymentCreditMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "balanceAppliedMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingInvoice_subscriptionId_issuedAt_id_idx" ON "BillingInvoice"("subscriptionId", "issuedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_provider_externalInvoiceId_key" ON "BillingInvoice"("provider", "externalInvoiceId");

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Checks --------------------------------------------------------------------------
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_shape_check"
  CHECK (
    "status" IN ('draft', 'open', 'paid', 'void', 'uncollectible')
    AND "currency" ~ '^[a-z]{3}$'
    AND length("provider") BETWEEN 1 AND 40
    AND length("externalInvoiceId") BETWEEN 1 AND 255
    AND length("externalCustomerId") BETWEEN 1 AND 255
    AND length("externalSubscriptionId") BETWEEN 1 AND 255
    AND ("number" IS NULL OR length("number") BETWEEN 1 AND 100)
    AND ("billingReason" IS NULL OR length("billingReason") BETWEEN 1 AND 60)
    AND "amountDueMinorUnits" >= 0
    AND "amountPaidMinorUnits" >= 0
    AND "amountRemainingMinorUnits" >= 0
    AND "postPaymentCreditMinorUnits" >= 0
    AND "prePaymentCreditMinorUnits" >= 0
    AND "balanceAppliedMinorUnits" >= 0
    AND ("periodStart" IS NULL OR "periodEnd" IS NULL OR "periodEnd" >= "periodStart")
    AND (("status" = 'paid') = ("paidAt" IS NOT NULL))
  );

-- Triggers --------------------------------------------------------------------------

-- Never deleted; which provider invoice of which subscription and customer,
-- and when it was issued, never changes; its number is set once; a paid or
-- void invoice stays so; a provider read older than the stored one is never
-- written.
CREATE FUNCTION "guard_billing_invoice"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_invoice$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingInvoice rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."subscriptionId" <> OLD."subscriptionId"
     OR NEW."provider" <> OLD."provider"
     OR NEW."externalInvoiceId" <> OLD."externalInvoiceId"
     OR NEW."externalCustomerId" <> OLD."externalCustomerId"
     OR NEW."externalSubscriptionId" <> OLD."externalSubscriptionId"
     OR NEW."issuedAt" <> OLD."issuedAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."number" IS NOT NULL AND NEW."number" IS DISTINCT FROM OLD."number")
     OR (OLD."status" IN ('paid', 'void') AND NEW."status" <> OLD."status")
     OR NEW."syncedAt" < OLD."syncedAt"
  THEN
    RAISE EXCEPTION 'A billing invoice cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_invoice$;

CREATE TRIGGER "BillingInvoice_guard"
  BEFORE UPDATE OR DELETE ON "BillingInvoice"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_invoice"();

CREATE TRIGGER "BillingInvoice_no_truncate"
  BEFORE TRUNCATE ON "BillingInvoice"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_invoice"();
