-- SC3a rollback for migration 20261025090000_subscription_billing_foundation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build that has no subscription billing (pre-SC3a).
--
-- It removes exactly what the migration added and restores the SC2a enums.
-- It REFUSES to run while any billing data exists — a price, a BILLED
-- subscription, any billing status other than ACTIVE/TRIALING, a trial claim,
-- a recorded billing-provider event, or a billing history entry — because
-- dropping those would destroy the record of what a business agreed to pay or
-- was charged, which is not a rollback's decision. The default billing-policy
-- row is configuration and is dropped with its table. Nothing is changed when
-- it refuses. One DO block, so it applies atomically.

DO $subscription_billing_foundation_rollback$
DECLARE
  prices bigint;
  billed bigint;
  billing_statuses bigint;
  claims bigint;
  provider_events bigint;
  billing_history bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantSubscription", "TenantSubscriptionEvent", "SubscriptionPlanPrice",
             "BillingPolicy", "BillingTrialClaim", "BillingProviderEvent"
    IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO prices FROM "SubscriptionPlanPrice";
  SELECT count(*) INTO billed FROM "TenantSubscription" WHERE "billingMode" <> 'COMPLIMENTARY';
  SELECT count(*) INTO billing_statuses FROM "TenantSubscription"
   WHERE "status" NOT IN ('ACTIVE', 'TRIALING');
  SELECT count(*) INTO claims FROM "BillingTrialClaim";
  SELECT count(*) INTO provider_events FROM "BillingProviderEvent";
  SELECT count(*) INTO billing_history FROM "TenantSubscriptionEvent"
   WHERE "type"::text NOT IN ('PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED')
      OR "source" <> 'OPERATOR';
  IF prices > 0 OR billed > 0 OR billing_statuses > 0 OR claims > 0
     OR provider_events > 0 OR billing_history > 0 THEN
    RAISE EXCEPTION 'SC3a rollback refused: % price(s), % billed subscription(s), % subscription(s) in a billing status, % trial claim(s), % provider event(s), % billing history entr(ies). Nothing was changed.',
      prices, billed, billing_statuses, claims, provider_events, billing_history;
  END IF;

  -- Checks and columns on the SC2a tables.
  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_lifecycle_check";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_complimentary_check";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billing_check";
  ALTER TABLE "TenantSubscriptionEvent"
    DROP COLUMN "billingProviderEventId",
    DROP COLUMN "planPriceId",
    DROP COLUMN "toStatus",
    DROP COLUMN "fromStatus",
    DROP COLUMN "source";
  DROP INDEX "TenantSubscription_billingProvider_externalCustomerId_key";
  DROP INDEX "TenantSubscription_billingProvider_externalSubscriptionId_key";
  ALTER TABLE "TenantSubscription"
    DROP COLUMN "billingStateVersion",
    DROP COLUMN "lastBillingEventAt",
    DROP COLUMN "pendingEffectiveAt",
    DROP COLUMN "pendingChangeReference",
    DROP COLUMN "pendingPlanPriceId",
    DROP COLUMN "pendingPlanVersionId",
    DROP COLUMN "pendingChangeKind",
    DROP COLUMN "canceledAt",
    DROP COLUMN "cancelAtPeriodEnd",
    DROP COLUMN "graceEndsAt",
    DROP COLUMN "pastDueAt",
    DROP COLUMN "currentPeriodEnd",
    DROP COLUMN "currentPeriodStart",
    DROP COLUMN "trialRequiresPaymentMethod",
    DROP COLUMN "trialEndsAt",
    DROP COLUMN "trialStartedAt",
    DROP COLUMN "recurringPaymentAuthorizedAt",
    DROP COLUMN "planPriceId",
    DROP COLUMN "billingMode",
    DROP COLUMN "externalCustomerId";
  ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billing_check"
    CHECK (("billingProvider" IS NULL) = ("externalSubscriptionId" IS NULL));

  -- New tables (dropping a table drops its triggers).
  DROP TABLE "BillingProviderEvent";
  DROP TABLE "BillingTrialClaim";
  DROP TABLE "BillingPolicy";
  DROP TABLE "SubscriptionPlanPrice";
  DROP FUNCTION "guard_billing_provider_event_change"();
  DROP FUNCTION "reject_billing_trial_claim_change"();
  DROP FUNCTION "guard_subscription_plan_price_change"();

  -- Restore the SC2a enums (every remaining value exists in them).
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3a";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM ('PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED');
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3a";
  ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
    CHECK (
      ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
          AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
    );

  ALTER TYPE "TenantSubscriptionStatus" RENAME TO "TenantSubscriptionStatus_sc3a";
  CREATE TYPE "TenantSubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING');
  ALTER TABLE "TenantSubscription" ALTER COLUMN "status" DROP DEFAULT;
  ALTER TABLE "TenantSubscription"
    ALTER COLUMN "status" TYPE "TenantSubscriptionStatus"
    USING ("status"::text::"TenantSubscriptionStatus");
  ALTER TABLE "TenantSubscription" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
  DROP TYPE "TenantSubscriptionStatus_sc3a";

  DROP TYPE "BillingProviderEventStatus";
  DROP TYPE "TenantPlanChangeKind";
  DROP TYPE "SubscriptionPlanPriceStatus";
  DROP TYPE "SubscriptionBillingInterval";
  DROP TYPE "TenantBillingMode";
  DROP TYPE "TenantSubscriptionEventSource";
END
$subscription_billing_foundation_rollback$;
