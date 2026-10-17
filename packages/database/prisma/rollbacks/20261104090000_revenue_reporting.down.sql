-- SC3f rollback for migration 20261104090000_revenue_reporting.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3f.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- billing.reports.view grant exists (the history of who could read
-- CENTERIVO-wide revenue is not a rollback's to erase). The captured invoice
-- amounts are copies of the provider's records (re-read by reconciliation)
-- and are dropped with their columns. Nothing is changed when it refuses.
-- One DO block, so it applies atomically.

DO $revenue_reporting_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingInvoice", "PlatformOperatorPermission" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "PlatformOperatorPermission"
    WHERE "permission" = 'billing.reports.view'
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC3f rollback refused: % billing.reports.view grant(s) exist. Nothing was changed.', remaining;
  END IF;

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
        'platform.permissions.manage'
      )
      AND length(btrim("grantReason")) BETWEEN 10 AND 500
      AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
      AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
      AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
    );

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
    THEN
      RAISE EXCEPTION 'A billing invoice cannot be changed this way.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $guard_billing_invoice$;

  ALTER TABLE "BillingInvoice" DROP CONSTRAINT "BillingInvoice_amounts_check";
  ALTER TABLE "BillingInvoice"
    DROP COLUMN "attemptCount", DROP COLUMN "discountMinorUnits", DROP COLUMN "subtotalMinorUnits",
    DROP COLUMN "taxMinorUnits", DROP COLUMN "totalExcludingTaxMinorUnits";
END
$revenue_reporting_rollback$;
