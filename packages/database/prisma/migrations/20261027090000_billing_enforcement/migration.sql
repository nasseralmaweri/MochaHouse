-- SC3c-1 — CENTERIVO SaaS billing enforcement (behind
-- BILLING_ENFORCEMENT_ENABLED, off by default).
--
-- Builds on SC3a/SC3b. Platform data only; nothing here references or
-- changes restaurant orders, payments, refunds or gift-card balances.
--
-- ADDITIVE: one policy column (the expired-trial recovery window, default
-- 3 days), one subscription column (when that window ends), three history
-- types (RECOVERY_EXPIRED, and the business's billing suspension being
-- applied or lifted). TenantSubscriptionEventType is recreated (the SC3a
-- pattern) rather than altered, so the rollback can restore it exactly. No
-- existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261027090000_billing_enforcement.down.sql.

-- BillingPolicy: the recovery window an expired (unauthorized) trial gets ----
ALTER TABLE "BillingPolicy" ADD COLUMN "trialRecoveryDays" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "BillingPolicy" ADD CONSTRAINT "BillingPolicy_trialRecoveryDays_check"
  CHECK ("trialRecoveryDays" BETWEEN 1 AND 14);

-- TenantSubscription: when an expired trial's recovery window ends ---------
ALTER TABLE "TenantSubscription" ADD COLUMN "recoveryEndsAt" TIMESTAMP(3);
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_recovery_check"
  CHECK ("recoveryEndsAt" IS NULL OR "status" = 'TRIAL_EXPIRED');
-- The enforcement sweep's lookups.
CREATE INDEX "TenantSubscription_grace_due_idx"
  ON "TenantSubscription"("graceEndsAt") WHERE "status" = 'PAST_DUE';
CREATE INDEX "TenantSubscription_recovery_due_idx"
  ON "TenantSubscription"("recoveryEndsAt") WHERE "recoveryEndsAt" IS NOT NULL;

-- TenantSubscriptionEventType: + enforcement history -------------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3b";
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
DROP TYPE "TenantSubscriptionEventType_sc3b";

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
