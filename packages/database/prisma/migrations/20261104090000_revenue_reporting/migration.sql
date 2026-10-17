-- SC3f — CENTERIVO SaaS revenue reporting (owner decisions D2, D5):
--   * BillingInvoice: the provider's own subtotal, discounts, taxes, total
--     excluding tax and payment attempt count, from verified Stripe reads
--     only. NULL means "not captured yet" (an invoice recorded before SC3f,
--     until reconciliation re-reads it) — never assumed to be zero. Once
--     captured, an amount is never cleared back to NULL;
--   * one more operator permission: billing.reports.view (read-only,
--     granted through the provisioning CLI like the other non-financial
--     permissions).
--
-- ADDITIVE: five nullable columns, CHECK constraints, the invoice guard and
-- the permission CHECK replaced with supersets. No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261104090000_revenue_reporting.down.sql.

-- AlterTable
ALTER TABLE "BillingInvoice" ADD COLUMN     "attemptCount" INTEGER,
ADD COLUMN     "discountMinorUnits" INTEGER,
ADD COLUMN     "subtotalMinorUnits" INTEGER,
ADD COLUMN     "taxMinorUnits" INTEGER,
ADD COLUMN     "totalExcludingTaxMinorUnits" INTEGER;

-- The provider amounts are captured together (all four, or none), never
-- negative where the provider never reports a negative.
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_amounts_check"
  CHECK (
    (("subtotalMinorUnits" IS NULL) = ("discountMinorUnits" IS NULL))
    AND (("subtotalMinorUnits" IS NULL) = ("taxMinorUnits" IS NULL))
    AND (("subtotalMinorUnits" IS NULL) = ("totalExcludingTaxMinorUnits" IS NULL))
    AND ("discountMinorUnits" IS NULL OR "discountMinorUnits" >= 0)
    AND ("taxMinorUnits" IS NULL OR "taxMinorUnits" >= 0)
    AND ("attemptCount" IS NULL OR "attemptCount" >= 0)
  );

-- The invoice guard (SC3e-1), now also keeping captured provider amounts:
-- once known, never cleared back to unknown.
CREATE OR REPLACE FUNCTION "guard_billing_invoice"() RETURNS trigger
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
     OR (OLD."subtotalMinorUnits" IS NOT NULL AND NEW."subtotalMinorUnits" IS NULL)
     OR (OLD."attemptCount" IS NOT NULL AND NEW."attemptCount" IS NULL)
  THEN
    RAISE EXCEPTION 'A billing invoice cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_invoice$;

-- SC3f — one more permission (read-only reporting).
ALTER TABLE "PlatformOperatorPermission" DROP CONSTRAINT "PlatformOperatorPermission_shape_check";
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_shape_check"
  CHECK (
    "permission" IN (
      'billing.prices.manage',
      'billing.policy.manage',
      'billing.accounts.manage',
      'billing.reconciliation.run',
      'billing.cases.manage',
      'billing.schedules.release',
      'billing.complimentary.manage',
      'billing.adjustments.request',
      'billing.adjustments.approve',
      'platform.permissions.manage',
      'billing.reports.view'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );
