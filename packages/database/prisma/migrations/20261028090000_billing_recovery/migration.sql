-- SC3c-2 — CENTERIVO SaaS billing recovery (Stripe test mode).
--
-- Builds on SC3b/SC3c-1. Platform data only; nothing here references or
-- changes restaurant orders, payments, refunds or gift-card balances.
--
-- ADDITIVE:
--   * BillingCheckoutSession."replacesExternalSubscriptionId" — a Checkout
--     opened to RESTART an ended subscription (expired trial or canceled)
--     records the provider subscription it replaces. Such a Checkout never
--     offers a trial; the value is set at creation and never changes; at
--     most one COMPLETED replacement exists per replaced subscription. The
--     COMPLETED rows keep the chain of every provider subscription a
--     business has had.
--   * TenantSubscriptionEventType + SUBSCRIPTION_REPLACED (recreated, the
--     SC3a pattern, so the rollback can restore it exactly).
-- No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261028090000_billing_recovery.down.sql.

ALTER TABLE "BillingCheckoutSession" ADD COLUMN "replacesExternalSubscriptionId" TEXT;

ALTER TABLE "BillingCheckoutSession" ADD CONSTRAINT "BillingCheckoutSession_replacement_check"
  CHECK (
    "replacesExternalSubscriptionId" IS NULL
    OR (
      length("replacesExternalSubscriptionId") BETWEEN 1 AND 255
      AND "trialDays" = 0
      AND "trialClaimKey" IS NULL
      AND "requiresPaymentMethod"
    )
  );

-- One completed replacement per replaced provider subscription.
CREATE UNIQUE INDEX "BillingCheckoutSession_one_replacement_key"
  ON "BillingCheckoutSession"("replacesExternalSubscriptionId")
  WHERE "status" = 'COMPLETED' AND "replacesExternalSubscriptionId" IS NOT NULL;

-- The Checkout guard: what a session replaces never changes either.
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
     OR NEW."replacesExternalSubscriptionId" IS DISTINCT FROM OLD."replacesExternalSubscriptionId"
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

-- TenantSubscriptionEventType: + SUBSCRIPTION_REPLACED ----------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3c1";
CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
  'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
  'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
  'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
  'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
  'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
  'SUBSCRIPTION_REPLACED'
);
ALTER TABLE "TenantSubscriptionEvent"
  ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
  USING ("type"::text::"TenantSubscriptionEventType");
DROP TYPE "TenantSubscriptionEventType_sc3c1";

ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
  CHECK (
    (
      ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
          AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
      OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                     'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
                     'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
                     'SUBSCRIPTION_REPLACED')
          AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
          AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
    )
    AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
  );
