-- ESP-03 PR 5 rollback for migration
-- 20261116090000_payment_reconciliation_support.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-03 PR 5.
--
-- It REFUSES to run while any investigation note exists or any
-- payments.reconciliation.* grant (active or revoked) exists: both are an
-- audit record of who could do or did what, which is not a rollback's
-- decision to discard. Nothing is changed when it refuses. One DO block, so
-- it applies atomically.

DO $payment_reconciliation_support_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"PaymentReconciliationNote"') IS NULL THEN
    RAISE EXCEPTION 'Payment reconciliation support rollback refused: table "PaymentReconciliationNote" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "PaymentReconciliationNote", "PlatformOperatorPermission"
    IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "PaymentReconciliationNote")
       + (SELECT count(*) FROM "PlatformOperatorPermission"
           WHERE "permission" IN ('payments.reconciliation.view', 'payments.reconciliation.manage'))
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Payment reconciliation support rollback refused: % investigation note or payments.reconciliation permission record(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "PaymentReconciliationNote";
  DROP FUNCTION "reject_payment_reconciliation_note_change"();

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
          'billing.reports.view',
          'onboarding.view',
          'onboarding.manage',
          'storefront.manage'
      )
      AND length(btrim("grantReason")) BETWEEN 10 AND 500
      AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
      AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
      AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
    );
END
$payment_reconciliation_support_rollback$;
