-- SC3e-4 — payment setup deadlines and billing recovery access (owner
-- decisions D1–D7):
--   * TenantSubscription: when a billed business started needing payment
--     setup (informational, recorded with enforcement on or off), and — only
--     while billing enforcement is ON — its 14-day setup window (start,
--     deadline) and when it expired;
--   * BillingEnforcementActivation: a persistent record of each period
--     billing enforcement has been running, so a (re)activation gives every
--     already-eligible business a FRESH window — never a deadline that ran
--     while enforcement was off;
--   * BillingGraceExtension: + PAYMENT_SETUP extensions (reason, operator),
--     never past 30 days from the window's start;
--   * history types for the setup window; two billing notice kinds.
--
-- ADDITIVE: four nullable columns, one table, enum values, CHECK constraints
-- (replaced with supersets) and a guard trigger. No existing row changes;
-- nothing is suspended by this migration.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261105090000_payment_setup_deadlines.down.sql.

-- TenantSubscriptionEventType: + payment setup history ------------------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3e3";
CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
  'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
  'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
  'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
  'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
  'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
  'SUBSCRIPTION_REPLACED',
  'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED',
  'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_STARTED', 'COMPLIMENTARY_WITHDRAWN',
  'COMPLIMENTARY_ENDED',
  'PAYMENT_SETUP_REQUIRED', 'PAYMENT_SETUP_WINDOW_STARTED', 'PAYMENT_SETUP_EXTENDED',
  'PAYMENT_SETUP_EXPIRED', 'PAYMENT_SETUP_COMPLETED'
);
ALTER TABLE "TenantSubscriptionEvent"
  ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
  USING ("type"::text::"TenantSubscriptionEventType");
DROP TYPE "TenantSubscriptionEventType_sc3e3";

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
                     'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_WITHDRAWN',
                     'PAYMENT_SETUP_REQUIRED', 'PAYMENT_SETUP_WINDOW_STARTED', 'PAYMENT_SETUP_EXTENDED',
                     'PAYMENT_SETUP_EXPIRED', 'PAYMENT_SETUP_COMPLETED')
          AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
          AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('COMPLIMENTARY_STARTED', 'COMPLIMENTARY_ENDED')
          AND "toStatus" IS NOT NULL AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
    )
    AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
  );

-- TenantSubscription: the payment setup window ---------------------------------------
ALTER TABLE "TenantSubscription" ADD COLUMN     "paymentSetupRequiredSince" TIMESTAMP(3),
ADD COLUMN     "paymentSetupWindowStartedAt" TIMESTAMP(3),
ADD COLUMN     "paymentSetupDueAt" TIMESTAMP(3),
ADD COLUMN     "paymentSetupExpiredAt" TIMESTAMP(3);

-- A window has a start and a deadline (14 days, extended to at most 30 days
-- from its start); it expires only once its deadline passed; it exists only
-- for a business that needs payment setup.
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_payment_setup_check"
  CHECK (
    ("paymentSetupWindowStartedAt" IS NULL) = ("paymentSetupDueAt" IS NULL)
    AND ("paymentSetupWindowStartedAt" IS NULL OR "paymentSetupRequiredSince" IS NOT NULL)
    AND ("paymentSetupDueAt" IS NULL OR (
      "paymentSetupDueAt" > "paymentSetupWindowStartedAt"
      AND "paymentSetupDueAt" <= "paymentSetupWindowStartedAt" + interval '30 days'))
    AND ("paymentSetupExpiredAt" IS NULL OR (
      "paymentSetupDueAt" IS NOT NULL AND "paymentSetupExpiredAt" >= "paymentSetupDueAt"))
    AND ("paymentSetupRequiredSince" IS NULL OR "billingMode" = 'BILLED')
  );

CREATE INDEX "TenantSubscription_paymentSetupDueAt_idx" ON "TenantSubscription"("paymentSetupDueAt");
CREATE INDEX "TenantSubscription_paymentSetupRequiredSince_idx" ON "TenantSubscription"("paymentSetupRequiredSince");

-- BillingEnforcementActivation: when billing enforcement has been running ------------
CREATE TABLE "BillingEnforcementActivation" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSweepAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEnforcementActivation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BillingEnforcementActivation_startedAt_idx" ON "BillingEnforcementActivation"("startedAt");

ALTER TABLE "BillingEnforcementActivation" ADD CONSTRAINT "BillingEnforcementActivation_shape_check"
  CHECK ("lastSweepAt" >= "startedAt");

-- An activation's start never changes; it is never deleted (the record of
-- when enforcement ran). Only its last sweep moves forward.
CREATE FUNCTION "guard_billing_enforcement_activation"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_enforcement_activation$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingEnforcementActivation rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."startedAt" <> OLD."startedAt"
     OR NEW."lastSweepAt" < OLD."lastSweepAt"
  THEN
    RAISE EXCEPTION 'A billing enforcement activation cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_enforcement_activation$;

CREATE TRIGGER "BillingEnforcementActivation_guard"
  BEFORE UPDATE OR DELETE ON "BillingEnforcementActivation"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_enforcement_activation"();
CREATE TRIGGER "BillingEnforcementActivation_no_truncate"
  BEFORE TRUNCATE ON "BillingEnforcementActivation"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_enforcement_activation"();

-- BillingGraceExtension: + payment setup extensions (never past 30 days from
-- the window's start, recorded as episodeStartedAt) -----------------------------------
ALTER TABLE "BillingGraceExtension" DROP CONSTRAINT "BillingGraceExtension_shape_check";
ALTER TABLE "BillingGraceExtension" ADD CONSTRAINT "BillingGraceExtension_shape_check"
  CHECK (
    "kind" IN ('GRACE_EXTENDED', 'GRACE_EXCEPTION', 'PAYMENT_SETUP')
    AND "days" BETWEEN 1 AND 14
    AND "newEndsAt" > "previousEndsAt"
    AND length(btrim("reason")) BETWEEN 10 AND 500
    AND ("kind" <> 'PAYMENT_SETUP' OR "newEndsAt" <= "episodeStartedAt" + interval '30 days')
  );

-- BillingNotification: + payment setup notices ----------------------------------------
ALTER TABLE "BillingNotification" DROP CONSTRAINT "BillingNotification_shape_check";
ALTER TABLE "BillingNotification" ADD CONSTRAINT "BillingNotification_shape_check"
  CHECK (
    "kind" IN ('PAYMENT_FAILED', 'GRACE_ENDING', 'BILLING_SUSPENDED', 'ACCESS_RESTORED',
               'TRIAL_EXPIRED', 'TRIAL_RECOVERY_ENDING', 'RESTART_CONFIRMED', 'RESTART_UNDER_REVIEW',
               'PAYMENT_SETUP_ENDING', 'PAYMENT_SETUP_EXPIRED')
    AND "status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')
    AND length("dedupeKey") BETWEEN 1 AND 255
    AND "attemptCount" BETWEEN 0 AND 2
    AND ("status" = 'PENDING') = ("finishedAt" IS NULL)
    AND ("status" = 'SENT') = ("sentAt" IS NOT NULL)
    AND (NOT "possibleDuplicate" OR "sendStartedAt" IS NOT NULL)
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  );
