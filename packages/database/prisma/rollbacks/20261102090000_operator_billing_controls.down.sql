-- SC3e-2 rollback for migration 20261102090000_operator_billing_controls.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3e-2.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- operator permission, complimentary grant, review-case action, case
-- outcome or complimentary history entry exists — those record who could do
-- what, and what was granted to a business; erasing them is not a
-- rollback's decision. Nothing is changed when it refuses. One DO block, so
-- it applies atomically.

DO $operator_billing_controls_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "PlatformOperatorPermission", "BillingComplimentaryGrant",
    "BillingReconciliationCaseAction", "BillingReconciliationCase",
    "TenantSubscriptionEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "PlatformOperatorPermission")
       + (SELECT count(*) FROM "BillingComplimentaryGrant")
       + (SELECT count(*) FROM "BillingReconciliationCaseAction")
       + (SELECT count(*) FROM "BillingReconciliationCase" WHERE "resolutionOutcome" IS NOT NULL)
       + (SELECT count(*) FROM "TenantSubscriptionEvent"
           WHERE "type"::text IN ('COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_STARTED',
                                  'COMPLIMENTARY_WITHDRAWN', 'COMPLIMENTARY_ENDED'))
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC3e-2 rollback refused: % operator permission(s), complimentary grant(s), case action(s), case outcome(s) or complimentary history entr(ies) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "BillingReconciliationCaseAction";
  DROP TABLE "BillingComplimentaryGrant";
  DROP TABLE "PlatformOperatorPermission";
  DROP FUNCTION "guard_billing_reconciliation_case_action"();
  DROP FUNCTION "guard_billing_complimentary_grant"();
  DROP FUNCTION "guard_platform_operator_permission"();
  ALTER TABLE "BillingReconciliationCase" DROP CONSTRAINT "BillingReconciliationCase_resolution_check";
  ALTER TABLE "BillingReconciliationCase" DROP COLUMN "resolutionOutcome", DROP COLUMN "resolutionNote";

  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3e2";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
    'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
    'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
    'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
    'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
    'SUBSCRIPTION_REPLACED',
    'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED'
  );
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3e2";
  ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
    CHECK (
      (
        ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
            AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
        OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                       'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
                       'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
                       'SUBSCRIPTION_REPLACED',
                       'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED')
            AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
            AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      )
      AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
    );
END
$operator_billing_controls_rollback$;
