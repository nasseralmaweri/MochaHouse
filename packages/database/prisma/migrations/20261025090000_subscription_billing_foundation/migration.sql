-- SC3a — CENTERIVO SaaS subscription-billing foundation.
--
-- Builds on the SC2a plan/subscription tables (no parallel subscription
-- model). Platform data (MODEL_TENANCY 'platform'), entirely separate from a
-- business's restaurant/customer payments: nothing here references
-- PaymentAttempt, orders, refunds or reconciliation, and nothing there
-- references these.
--
-- ADDITIVE: new enums, columns, tables, indexes, foreign keys, CHECK
-- constraints and triggers, plus the default billing-policy row. Two existing
-- enums gain values; they are rebuilt (create new type, convert the column,
-- drop the old type) instead of ALTER TYPE ... ADD VALUE, because the new
-- values are used by CHECK constraints in this same migration. No existing
-- row changes meaning:
--   * every existing subscription (Founding included, owner decision E3)
--     becomes billingMode COMPLIMENTARY through the column default, keeps its
--     plan, status and history, and is never billed;
--   * SC2a history rows keep their type and get source OPERATOR.
--
-- Nothing here calls a billing provider or charges anyone.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261025090000_subscription_billing_foundation.down.sql.

-- New enums -----------------------------------------------------------------
CREATE TYPE "TenantSubscriptionEventSource" AS ENUM ('OPERATOR', 'BILLING_PROVIDER', 'SYSTEM');
CREATE TYPE "TenantBillingMode" AS ENUM ('COMPLIMENTARY', 'BILLED');
CREATE TYPE "SubscriptionBillingInterval" AS ENUM ('MONTH', 'YEAR');
CREATE TYPE "SubscriptionPlanPriceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "TenantPlanChangeKind" AS ENUM ('UPGRADE', 'DOWNGRADE');
CREATE TYPE "BillingProviderEventStatus" AS ENUM ('RECEIVED', 'APPLIED', 'IGNORED', 'REJECTED', 'FAILED');

-- TenantSubscriptionStatus: + PAST_DUE, UNPAID, TRIAL_EXPIRED, CANCELED ------
ALTER TYPE "TenantSubscriptionStatus" RENAME TO "TenantSubscriptionStatus_sc2a";
CREATE TYPE "TenantSubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'UNPAID', 'TRIAL_EXPIRED', 'CANCELED');
ALTER TABLE "TenantSubscription" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "TenantSubscription"
  ALTER COLUMN "status" TYPE "TenantSubscriptionStatus"
  USING ("status"::text::"TenantSubscriptionStatus");
ALTER TABLE "TenantSubscription" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
DROP TYPE "TenantSubscriptionStatus_sc2a";

-- TenantSubscriptionEventType: + billing lifecycle types --------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc2a";
CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
  'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
  'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
  'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
  'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED'
);
ALTER TABLE "TenantSubscriptionEvent"
  ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
  USING ("type"::text::"TenantSubscriptionEventType");
DROP TYPE "TenantSubscriptionEventType_sc2a";

-- TenantSubscription: billing lifecycle columns ------------------------------
ALTER TABLE "TenantSubscription"
  ADD COLUMN "externalCustomerId" TEXT,
  ADD COLUMN "billingMode" "TenantBillingMode" NOT NULL DEFAULT 'COMPLIMENTARY',
  ADD COLUMN "planPriceId" TEXT,
  ADD COLUMN "recurringPaymentAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN "trialStartedAt" TIMESTAMP(3),
  ADD COLUMN "trialEndsAt" TIMESTAMP(3),
  ADD COLUMN "trialRequiresPaymentMethod" BOOLEAN,
  ADD COLUMN "currentPeriodStart" TIMESTAMP(3),
  ADD COLUMN "currentPeriodEnd" TIMESTAMP(3),
  ADD COLUMN "pastDueAt" TIMESTAMP(3),
  ADD COLUMN "graceEndsAt" TIMESTAMP(3),
  ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "canceledAt" TIMESTAMP(3),
  ADD COLUMN "pendingChangeKind" "TenantPlanChangeKind",
  ADD COLUMN "pendingPlanVersionId" TEXT,
  ADD COLUMN "pendingPlanPriceId" TEXT,
  ADD COLUMN "pendingChangeReference" TEXT,
  ADD COLUMN "pendingEffectiveAt" TIMESTAMP(3),
  ADD COLUMN "lastBillingEventAt" TIMESTAMP(3),
  ADD COLUMN "billingStateVersion" INTEGER NOT NULL DEFAULT 0;

-- TenantSubscriptionEvent: billing history columns ---------------------------
ALTER TABLE "TenantSubscriptionEvent"
  ADD COLUMN "source" "TenantSubscriptionEventSource" NOT NULL DEFAULT 'OPERATOR',
  ADD COLUMN "fromStatus" "TenantSubscriptionStatus",
  ADD COLUMN "toStatus" "TenantSubscriptionStatus",
  ADD COLUMN "planPriceId" TEXT,
  ADD COLUMN "billingProviderEventId" TEXT;

-- New tables -----------------------------------------------------------------
CREATE TABLE "SubscriptionPlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "interval" "SubscriptionBillingInterval" NOT NULL,
    "currency" TEXT NOT NULL,
    "amountMinorUnits" INTEGER NOT NULL,
    "status" "SubscriptionPlanPriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "externalPriceId" TEXT,
    "actorPlatformOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionPlanPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingPolicy" (
    "id" TEXT NOT NULL,
    "trialDays" INTEGER NOT NULL,
    "trialRequiresPaymentMethod" BOOLEAN NOT NULL,
    "gracePeriodDays" INTEGER NOT NULL,
    "actorPlatformOperatorId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingTrialClaim" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "claimKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingTrialClaim_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingProviderEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payloadDigest" TEXT NOT NULL,
    "externalSubscriptionId" TEXT,
    "externalCustomerId" TEXT,
    "subscriptionId" TEXT,
    "status" "BillingProviderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "outcome" TEXT,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillingProviderEvent_pkey" PRIMARY KEY ("id")
);

-- Indexes --------------------------------------------------------------------
CREATE UNIQUE INDEX "SubscriptionPlanPrice_externalPriceId_key" ON "SubscriptionPlanPrice"("externalPriceId");
CREATE INDEX "SubscriptionPlanPrice_planId_status_idx" ON "SubscriptionPlanPrice"("planId", "status");
-- At most one ACTIVE list price per plan, interval and currency.
CREATE UNIQUE INDEX "SubscriptionPlanPrice_one_active_key"
  ON "SubscriptionPlanPrice"("planId", "interval", "currency")
  WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "BillingTrialClaim_subscriptionId_key" ON "BillingTrialClaim"("subscriptionId");
CREATE UNIQUE INDEX "BillingTrialClaim_claimKey_key" ON "BillingTrialClaim"("claimKey");
CREATE INDEX "BillingProviderEvent_subscriptionId_occurredAt_idx" ON "BillingProviderEvent"("subscriptionId", "occurredAt");
CREATE INDEX "BillingProviderEvent_status_receivedAt_idx" ON "BillingProviderEvent"("status", "receivedAt");
CREATE UNIQUE INDEX "BillingProviderEvent_provider_externalEventId_key" ON "BillingProviderEvent"("provider", "externalEventId");
CREATE INDEX "TenantSubscription_planPriceId_idx" ON "TenantSubscription"("planPriceId");
CREATE INDEX "TenantSubscription_pendingPlanVersionId_idx" ON "TenantSubscription"("pendingPlanVersionId");
CREATE INDEX "TenantSubscription_pendingPlanPriceId_idx" ON "TenantSubscription"("pendingPlanPriceId");
CREATE UNIQUE INDEX "TenantSubscription_billingProvider_externalSubscriptionId_key" ON "TenantSubscription"("billingProvider", "externalSubscriptionId");
CREATE UNIQUE INDEX "TenantSubscription_billingProvider_externalCustomerId_key" ON "TenantSubscription"("billingProvider", "externalCustomerId");
CREATE INDEX "TenantSubscriptionEvent_planPriceId_idx" ON "TenantSubscriptionEvent"("planPriceId");
CREATE INDEX "TenantSubscriptionEvent_billingProviderEventId_idx" ON "TenantSubscriptionEvent"("billingProviderEventId");

-- Foreign keys ---------------------------------------------------------------
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_planPriceId_fkey" FOREIGN KEY ("planPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_pendingPlanVersionId_fkey" FOREIGN KEY ("pendingPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_pendingPlanPriceId_fkey" FOREIGN KEY ("pendingPlanPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SubscriptionPlanPrice" ADD CONSTRAINT "SubscriptionPlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SubscriptionPlanPrice" ADD CONSTRAINT "SubscriptionPlanPrice_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingPolicy" ADD CONSTRAINT "BillingPolicy_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingTrialClaim" ADD CONSTRAINT "BillingTrialClaim_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingProviderEvent" ADD CONSTRAINT "BillingProviderEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_planPriceId_fkey" FOREIGN KEY ("planPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_billingProviderEventId_fkey" FOREIGN KEY ("billingProviderEventId") REFERENCES "BillingProviderEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks ---------------------------------------------------------------------
ALTER TABLE "SubscriptionPlanPrice" ADD CONSTRAINT "SubscriptionPlanPrice_shape_check"
  CHECK (
    "currency" ~ '^[A-Z]{3}$'
    AND "amountMinorUnits" BETWEEN 1 AND 100000000
    AND ("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL)
    AND ("externalPriceId" IS NULL OR length("externalPriceId") BETWEEN 1 AND 255)
  );

ALTER TABLE "BillingPolicy" ADD CONSTRAINT "BillingPolicy_shape_check"
  CHECK (
    "id" = 'default'
    AND "trialDays" BETWEEN 0 AND 90
    AND "gracePeriodDays" BETWEEN 1 AND 60
  );

ALTER TABLE "BillingTrialClaim" ADD CONSTRAINT "BillingTrialClaim_claimKey_check"
  CHECK ("claimKey" ~ '^[0-9a-f]{64}$');

ALTER TABLE "BillingProviderEvent" ADD CONSTRAINT "BillingProviderEvent_shape_check"
  CHECK (
    "provider" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("provider") <= 30
    AND length("externalEventId") BETWEEN 1 AND 255
    AND length("type") BETWEEN 1 AND 100
    AND "payloadDigest" ~ '^[0-9a-f]{64}$'
    AND "attempts" >= 0
    AND ("outcome" IS NULL OR length("outcome") <= 500)
    AND ("status" = 'RECEIVED') = ("processedAt" IS NULL)
  );

-- Provider ids come together; a customer id only with a provider.
ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billing_check";
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billing_check"
  CHECK (
    ("billingProvider" IS NULL) = ("externalSubscriptionId" IS NULL)
    AND ("billingProvider" IS NOT NULL OR "externalCustomerId" IS NULL)
  );

-- A COMPLIMENTARY subscription carries no billing state at all (it may keep
-- the SC2a informational TRIALING status).
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_complimentary_check"
  CHECK (
    "billingMode" <> 'COMPLIMENTARY'
    OR (
      "billingProvider" IS NULL
      AND "planPriceId" IS NULL
      AND "recurringPaymentAuthorizedAt" IS NULL
      AND "trialStartedAt" IS NULL
      AND "currentPeriodStart" IS NULL
      AND "pastDueAt" IS NULL
      AND "canceledAt" IS NULL
      AND "pendingChangeKind" IS NULL
      AND NOT "cancelAtPeriodEnd"
      AND "status" IN ('ACTIVE', 'TRIALING')
    )
  );

ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_lifecycle_check"
  CHECK (
    "billingStateVersion" >= 0
    -- a trial's start, end and card rule come together
    AND ("trialStartedAt" IS NULL) = ("trialEndsAt" IS NULL)
    AND ("trialStartedAt" IS NULL) = ("trialRequiresPaymentMethod" IS NULL)
    AND ("trialEndsAt" IS NULL OR "trialEndsAt" > "trialStartedAt")
    AND ("billingMode" <> 'BILLED' OR "status" NOT IN ('TRIALING', 'TRIAL_EXPIRED') OR "trialEndsAt" IS NOT NULL)
    -- a billing period has both ends
    AND ("currentPeriodStart" IS NULL) = ("currentPeriodEnd" IS NULL)
    AND ("currentPeriodEnd" IS NULL OR "currentPeriodEnd" > "currentPeriodStart")
    -- delinquency: first failure and grace end come together
    AND ("pastDueAt" IS NULL) = ("graceEndsAt" IS NULL)
    AND ("graceEndsAt" IS NULL OR "graceEndsAt" > "pastDueAt")
    AND ("status" NOT IN ('PAST_DUE', 'UNPAID') OR "pastDueAt" IS NOT NULL)
    -- canceled exactly when it says so
    AND ("status" = 'CANCELED') = ("canceledAt" IS NOT NULL)
    -- a pending plan change is complete for its kind
    AND ("pendingChangeKind" IS NULL) = ("pendingPlanVersionId" IS NULL)
    AND ("pendingChangeKind" IS NOT NULL OR (
      "pendingPlanPriceId" IS NULL AND "pendingChangeReference" IS NULL AND "pendingEffectiveAt" IS NULL))
    AND ("pendingChangeKind" IS DISTINCT FROM 'UPGRADE' OR "pendingChangeReference" IS NOT NULL)
    AND ("pendingChangeKind" IS DISTINCT FROM 'DOWNGRADE' OR "pendingEffectiveAt" IS NOT NULL)
  );

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

-- Triggers -------------------------------------------------------------------

-- A price never changes amount, interval, currency or plan, and is never
-- deleted. It may only be ARCHIVED (once), and have its provider price id
-- recorded once.
CREATE FUNCTION "guard_subscription_plan_price_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_subscription_plan_price_change$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A subscription price is never deleted (archive it instead).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."planId" <> OLD."planId"
     OR NEW."interval" <> OLD."interval"
     OR NEW."currency" <> OLD."currency"
     OR NEW."amountMinorUnits" <> OLD."amountMinorUnits"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."actorPlatformOperatorId" IS DISTINCT FROM OLD."actorPlatformOperatorId"
     OR (OLD."externalPriceId" IS NOT NULL AND NEW."externalPriceId" IS DISTINCT FROM OLD."externalPriceId")
     OR NOT (
       NEW."status" = OLD."status"
       OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED')
     )
     OR (OLD."status" = 'ARCHIVED' AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt")
  THEN
    RAISE EXCEPTION 'A subscription price is immutable (it may only be archived).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_subscription_plan_price_change$;

CREATE TRIGGER "SubscriptionPlanPrice_immutable"
  BEFORE UPDATE OR DELETE ON "SubscriptionPlanPrice"
  FOR EACH ROW EXECUTE FUNCTION "guard_subscription_plan_price_change"();

-- Trial claims are append-only.
CREATE FUNCTION "reject_billing_trial_claim_change"() RETURNS trigger
LANGUAGE plpgsql AS $reject_billing_trial_claim_change$
BEGIN
  RAISE EXCEPTION 'BillingTrialClaim is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$reject_billing_trial_claim_change$;

CREATE TRIGGER "BillingTrialClaim_append_only"
  BEFORE UPDATE OR DELETE ON "BillingTrialClaim"
  FOR EACH ROW EXECUTE FUNCTION "reject_billing_trial_claim_change"();
CREATE TRIGGER "BillingTrialClaim_no_truncate"
  BEFORE TRUNCATE ON "BillingTrialClaim"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_billing_trial_claim_change"();

-- A recorded provider event is never deleted and never changes identity;
-- only its processing outcome moves, and a final outcome (APPLIED, IGNORED,
-- REJECTED) is never revisited. A FAILED event may be retried.
CREATE FUNCTION "guard_billing_provider_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_provider_event_change$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingProviderEvent rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."provider" <> OLD."provider"
     OR NEW."externalEventId" <> OLD."externalEventId"
     OR NEW."type" <> OLD."type"
     OR NEW."livemode" <> OLD."livemode"
     OR NEW."occurredAt" <> OLD."occurredAt"
     OR NEW."receivedAt" <> OLD."receivedAt"
     OR NEW."payloadDigest" <> OLD."payloadDigest"
     OR NEW."externalSubscriptionId" IS DISTINCT FROM OLD."externalSubscriptionId"
     OR NEW."externalCustomerId" IS DISTINCT FROM OLD."externalCustomerId"
     OR (OLD."subscriptionId" IS NOT NULL AND NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId")
     OR NEW."attempts" < OLD."attempts"
     OR OLD."status" IN ('APPLIED', 'IGNORED', 'REJECTED')
  THEN
    RAISE EXCEPTION 'A recorded billing-provider event cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_provider_event_change$;

CREATE TRIGGER "BillingProviderEvent_guard"
  BEFORE UPDATE OR DELETE ON "BillingProviderEvent"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_provider_event_change"();
CREATE TRIGGER "BillingProviderEvent_no_truncate"
  BEFORE TRUNCATE ON "BillingProviderEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_provider_event_change"();

-- Default billing policy (owner decisions E5/E6; configurable later) ---------
-- 14-day trial requiring a payment method, 14-day grace period.
INSERT INTO "BillingPolicy" ("id", "trialDays", "trialRequiresPaymentMethod", "gracePeriodDays", "updatedAt")
VALUES ('default', 14, true, 14, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
