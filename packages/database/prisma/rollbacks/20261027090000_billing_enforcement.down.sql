-- SC3c-1 rollback for migration 20261027090000_billing_enforcement.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without billing enforcement (pre-SC3c).
--
-- It removes exactly what the migration added and restores the SC3b history
-- types and CHECK. It REFUSES to run while any enforcement data exists — a
-- subscription inside an expired-trial recovery window, or a history entry of
-- the new types — because dropping those would erase the record of a
-- business's billing suspension, which is not a rollback's decision. Nothing
-- is changed when it refuses. One DO block, so it applies atomically.

DO $billing_enforcement_rollback$
DECLARE
  in_recovery bigint;
  history_rows bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantSubscription", "TenantSubscriptionEvent", "BillingPolicy"
    IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO in_recovery FROM "TenantSubscription" WHERE "recoveryEndsAt" IS NOT NULL;
  SELECT count(*) INTO history_rows FROM "TenantSubscriptionEvent"
   WHERE "type"::text IN ('RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED');
  IF in_recovery > 0 OR history_rows > 0 THEN
    RAISE EXCEPTION 'SC3c-1 rollback refused: % subscription(s) in a trial recovery window, % enforcement history entr(ies). Nothing was changed.',
      in_recovery, history_rows;
  END IF;

  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3c";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
    'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
    'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
    'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED'
  );
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3c";
  ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
    CHECK (
      (
        ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
            AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
        OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                       'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED')
            AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
            AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      )
      AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
    );

  DROP INDEX "TenantSubscription_recovery_due_idx";
  DROP INDEX "TenantSubscription_grace_due_idx";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_recovery_check";
  ALTER TABLE "TenantSubscription" DROP COLUMN "recoveryEndsAt";
  ALTER TABLE "BillingPolicy" DROP CONSTRAINT "BillingPolicy_trialRecoveryDays_check";
  ALTER TABLE "BillingPolicy" DROP COLUMN "trialRecoveryDays";
END
$billing_enforcement_rollback$;
