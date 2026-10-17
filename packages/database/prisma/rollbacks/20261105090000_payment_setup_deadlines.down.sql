-- SC3e-4 rollback for migration 20261105090000_payment_setup_deadlines.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3e-4.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- payment setup state, enforcement activation, payment setup extension,
-- history entry or notice exists (billing history is not a rollback's to
-- erase). Nothing is changed when it refuses. One DO block, so it applies
-- atomically.

DO $payment_setup_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantSubscription", "TenantSubscriptionEvent", "BillingGraceExtension",
    "BillingNotification", "BillingEnforcementActivation" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "TenantSubscription"
           WHERE "paymentSetupRequiredSince" IS NOT NULL OR "paymentSetupWindowStartedAt" IS NOT NULL
              OR "paymentSetupDueAt" IS NOT NULL OR "paymentSetupExpiredAt" IS NOT NULL)
       + (SELECT count(*) FROM "BillingEnforcementActivation")
       + (SELECT count(*) FROM "BillingGraceExtension" WHERE "kind" = 'PAYMENT_SETUP')
       + (SELECT count(*) FROM "TenantSubscriptionEvent" WHERE "type"::text LIKE 'PAYMENT_SETUP_%')
       + (SELECT count(*) FROM "BillingNotification" WHERE "kind" LIKE 'PAYMENT_SETUP_%')
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC3e-4 rollback refused: % payment setup record(s) exist. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "BillingNotification" DROP CONSTRAINT "BillingNotification_shape_check";
  ALTER TABLE "BillingNotification" ADD CONSTRAINT "BillingNotification_shape_check"
    CHECK (
      "kind" IN ('PAYMENT_FAILED', 'GRACE_ENDING', 'BILLING_SUSPENDED', 'ACCESS_RESTORED',
                 'TRIAL_EXPIRED', 'TRIAL_RECOVERY_ENDING', 'RESTART_CONFIRMED', 'RESTART_UNDER_REVIEW')
      AND "status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')
      AND length("dedupeKey") BETWEEN 1 AND 255
      AND "attemptCount" BETWEEN 0 AND 2
      AND ("status" = 'PENDING') = ("finishedAt" IS NULL)
      AND ("status" = 'SENT') = ("sentAt" IS NOT NULL)
      AND (NOT "possibleDuplicate" OR "sendStartedAt" IS NOT NULL)
      AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    );

  ALTER TABLE "BillingGraceExtension" DROP CONSTRAINT "BillingGraceExtension_shape_check";
  ALTER TABLE "BillingGraceExtension" ADD CONSTRAINT "BillingGraceExtension_shape_check"
    CHECK (
      "kind" IN ('GRACE_EXTENDED', 'GRACE_EXCEPTION')
      AND "days" BETWEEN 1 AND 14
      AND "newEndsAt" > "previousEndsAt"
      AND length(btrim("reason")) BETWEEN 10 AND 500
    );

  DROP TABLE "BillingEnforcementActivation";
  DROP FUNCTION "guard_billing_enforcement_activation"();

  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_payment_setup_check";
  DROP INDEX "TenantSubscription_paymentSetupDueAt_idx";
  DROP INDEX "TenantSubscription_paymentSetupRequiredSince_idx";
  ALTER TABLE "TenantSubscription"
    DROP COLUMN "paymentSetupRequiredSince", DROP COLUMN "paymentSetupWindowStartedAt",
    DROP COLUMN "paymentSetupDueAt", DROP COLUMN "paymentSetupExpiredAt";

  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3e4";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
    'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
    'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
    'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
    'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
    'SUBSCRIPTION_REPLACED',
    'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED',
    'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_STARTED', 'COMPLIMENTARY_WITHDRAWN',
    'COMPLIMENTARY_ENDED'
  );
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3e4";
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
                       'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED',
                       'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_WITHDRAWN')
            AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
            AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('COMPLIMENTARY_STARTED', 'COMPLIMENTARY_ENDED')
            AND "toStatus" IS NOT NULL AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      )
      AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
    );
END
$payment_setup_rollback$;
