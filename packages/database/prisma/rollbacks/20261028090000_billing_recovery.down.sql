-- SC3c-2 rollback for migration 20261028090000_billing_recovery.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without billing recovery (pre-SC3c-2).
--
-- It removes exactly what the migration added and restores the SC3c-1
-- Checkout guard and history types. It REFUSES to run while any recovery
-- data exists — a replacement Checkout, or a SUBSCRIPTION_REPLACED history
-- entry — because dropping those would erase which provider subscriptions a
-- business has had, which is not a rollback's decision. Nothing is changed
-- when it refuses. One DO block, so it applies atomically.

DO $billing_recovery_rollback$
DECLARE
  replacements bigint;
  history_rows bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingCheckoutSession", "TenantSubscriptionEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO replacements FROM "BillingCheckoutSession"
   WHERE "replacesExternalSubscriptionId" IS NOT NULL;
  SELECT count(*) INTO history_rows FROM "TenantSubscriptionEvent"
   WHERE "type"::text = 'SUBSCRIPTION_REPLACED';
  IF replacements > 0 OR history_rows > 0 THEN
    RAISE EXCEPTION 'SC3c-2 rollback refused: % replacement Checkout(s), % replacement history entr(ies). Nothing was changed.',
      replacements, history_rows;
  END IF;

  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3c2";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
    'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
    'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
    'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
    'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED'
  );
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3c2";
  ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
    CHECK (
      (
        ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
            AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
        OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                       'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
                       'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED')
            AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
            AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      )
      AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
    );

  -- The SC3b/SC3c-1 Checkout guard.
  CREATE OR REPLACE FUNCTION "guard_billing_checkout_session_change"() RETURNS trigger
  LANGUAGE plpgsql AS $guard_billing_checkout_session_change$
  BEGIN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'BillingCheckoutSession rows are never removed (% refused).', TG_OP
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."subscriptionId" <> OLD."subscriptionId"
       OR NEW."planPriceId" <> OLD."planPriceId"
       OR NEW."trialDays" <> OLD."trialDays"
       OR NEW."requiresPaymentMethod" <> OLD."requiresPaymentMethod"
       OR NEW."trialClaimKey" IS DISTINCT FROM OLD."trialClaimKey"
       OR NEW."createdAt" <> OLD."createdAt"
       OR (OLD."externalSessionId" IS NOT NULL AND NEW."externalSessionId" IS DISTINCT FROM OLD."externalSessionId")
       OR (OLD."status" <> 'OPEN' AND (NEW."status" <> OLD."status"
            OR NEW."completedAt" IS DISTINCT FROM OLD."completedAt"
            OR NEW."externalSessionId" IS DISTINCT FROM OLD."externalSessionId"))
    THEN
      RAISE EXCEPTION 'A billing Checkout session cannot be changed this way.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $guard_billing_checkout_session_change$;

  DROP INDEX "BillingCheckoutSession_one_replacement_key";
  ALTER TABLE "BillingCheckoutSession" DROP CONSTRAINT "BillingCheckoutSession_replacement_check";
  ALTER TABLE "BillingCheckoutSession" DROP COLUMN "replacesExternalSubscriptionId";
END
$billing_recovery_rollback$;
