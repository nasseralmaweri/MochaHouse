-- SC3b — CENTERIVO SaaS billing through Stripe (TEST MODE ONLY).
--
-- Builds on SC3a (TenantSubscription billing lifecycle, prices, the provider
-- event ledger). Platform data only (MODEL_TENANCY 'platform'); nothing here
-- references restaurant payments (PaymentAttempt, orders, refunds) and
-- nothing there references these.
--
-- ADDITIVE: two enums, two tables, one column, indexes, foreign keys, CHECK
-- constraints and triggers. One existing CHECK is replaced
-- (TenantSubscription_billing_check) so a business can have its provider
-- CUSTOMER before its provider SUBSCRIPTION exists (billing started by an
-- operator, Checkout not yet completed by the owner). No existing row
-- changes; every existing subscription is COMPLIMENTARY and unaffected.
--
-- One data backfill (idempotent): every tenant's built-in administrator
-- role (key 'platform-administrator', isSystem) receives the two new
-- permissions billing.view and billing.manage — the role is defined as
-- holding every permission, and new tenants get them at provisioning. No
-- other role is touched.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261026090000_stripe_billing_test_mode.down.sql.

CREATE TYPE "BillingCheckoutSessionStatus" AS ENUM ('OPEN', 'COMPLETED', 'EXPIRED');
CREATE TYPE "BillingReconciliationCaseStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "SubscriptionPlan" ADD COLUMN "externalProductId" TEXT;

CREATE TABLE "BillingCheckoutSession" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planPriceId" TEXT NOT NULL,
    "externalSessionId" TEXT,
    "status" "BillingCheckoutSessionStatus" NOT NULL DEFAULT 'OPEN',
    "trialDays" INTEGER NOT NULL,
    "requiresPaymentMethod" BOOLEAN NOT NULL,
    "trialClaimKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCheckoutSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingReconciliationCase" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "billingProviderEventId" TEXT,
    "detail" TEXT,
    "status" "BillingReconciliationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByPlatformOperatorId" TEXT,

    CONSTRAINT "BillingReconciliationCase_pkey" PRIMARY KEY ("id")
);

-- Indexes --------------------------------------------------------------------
CREATE UNIQUE INDEX "SubscriptionPlan_externalProductId_key" ON "SubscriptionPlan"("externalProductId");
CREATE UNIQUE INDEX "BillingCheckoutSession_externalSessionId_key" ON "BillingCheckoutSession"("externalSessionId");
CREATE INDEX "BillingCheckoutSession_subscriptionId_createdAt_idx" ON "BillingCheckoutSession"("subscriptionId", "createdAt");
CREATE INDEX "BillingCheckoutSession_planPriceId_idx" ON "BillingCheckoutSession"("planPriceId");
-- At most one OPEN Checkout per subscription: concurrent "open Checkout"
-- requests cannot create a second one.
CREATE UNIQUE INDEX "BillingCheckoutSession_one_open_key"
  ON "BillingCheckoutSession"("subscriptionId") WHERE "status" = 'OPEN';
-- At most one OPEN Checkout offering a trial per one-trial claim (owner
-- email): two businesses of one owner cannot both be offered the trial at
-- once. Only a HOLD — the claim itself (BillingTrialClaim) is recorded when
-- the provider has verifiably created the trial subscription.
CREATE UNIQUE INDEX "BillingCheckoutSession_one_open_trial_key"
  ON "BillingCheckoutSession"("trialClaimKey")
  WHERE "status" = 'OPEN' AND "trialClaimKey" IS NOT NULL;
CREATE INDEX "BillingReconciliationCase_status_createdAt_idx" ON "BillingReconciliationCase"("status", "createdAt");
CREATE INDEX "BillingReconciliationCase_subscriptionId_idx" ON "BillingReconciliationCase"("subscriptionId");
CREATE INDEX "BillingReconciliationCase_billingProviderEventId_idx" ON "BillingReconciliationCase"("billingProviderEventId");
CREATE INDEX "BillingReconciliationCase_resolvedByPlatformOperatorId_idx" ON "BillingReconciliationCase"("resolvedByPlatformOperatorId");
-- One OPEN case per subject and kind: a repeated sweep never piles up
-- duplicates.
CREATE UNIQUE INDEX "BillingReconciliationCase_open_subscription_key"
  ON "BillingReconciliationCase"("subscriptionId", "kind")
  WHERE "status" = 'OPEN' AND "subscriptionId" IS NOT NULL;
CREATE UNIQUE INDEX "BillingReconciliationCase_open_event_key"
  ON "BillingReconciliationCase"("billingProviderEventId", "kind")
  WHERE "status" = 'OPEN' AND "billingProviderEventId" IS NOT NULL;

-- Foreign keys ---------------------------------------------------------------
ALTER TABLE "BillingCheckoutSession" ADD CONSTRAINT "BillingCheckoutSession_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingCheckoutSession" ADD CONSTRAINT "BillingCheckoutSession_planPriceId_fkey" FOREIGN KEY ("planPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingReconciliationCase" ADD CONSTRAINT "BillingReconciliationCase_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingReconciliationCase" ADD CONSTRAINT "BillingReconciliationCase_billingProviderEventId_fkey" FOREIGN KEY ("billingProviderEventId") REFERENCES "BillingProviderEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingReconciliationCase" ADD CONSTRAINT "BillingReconciliationCase_resolvedByPlatformOperatorId_fkey" FOREIGN KEY ("resolvedByPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks ---------------------------------------------------------------------

-- Provider ids: a subscription id or a customer id only with a provider (a
-- customer may now exist before the provider subscription).
ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billing_check";
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billing_check"
  CHECK (
    ("externalSubscriptionId" IS NULL OR "billingProvider" IS NOT NULL)
    AND ("externalCustomerId" IS NULL OR "billingProvider" IS NOT NULL)
  );

-- A BILLED subscription always has its provider customer and agreed price.
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billed_check"
  CHECK (
    "billingMode" <> 'BILLED'
    OR ("billingProvider" IS NOT NULL AND "externalCustomerId" IS NOT NULL AND "planPriceId" IS NOT NULL)
  );

ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_externalProductId_check"
  CHECK ("externalProductId" IS NULL OR length("externalProductId") BETWEEN 1 AND 255);

ALTER TABLE "BillingCheckoutSession" ADD CONSTRAINT "BillingCheckoutSession_shape_check"
  CHECK (
    "trialDays" BETWEEN 0 AND 90
    AND (("trialDays" > 0) = ("trialClaimKey" IS NOT NULL))
    AND ("trialClaimKey" IS NULL OR "trialClaimKey" ~ '^[0-9a-f]{64}$')
    AND ("externalSessionId" IS NULL OR length("externalSessionId") BETWEEN 1 AND 255)
    AND ("status" = 'COMPLETED') = ("completedAt" IS NOT NULL)
    AND ("status" = 'OPEN' OR "externalSessionId" IS NOT NULL OR "status" = 'EXPIRED')
  );

ALTER TABLE "BillingReconciliationCase" ADD CONSTRAINT "BillingReconciliationCase_shape_check"
  CHECK (
    "kind" ~ '^[A-Z][A-Z_]{2,49}$'
    AND ("detail" IS NULL OR length("detail") <= 500)
    AND ("subscriptionId" IS NOT NULL OR "billingProviderEventId" IS NOT NULL)
    AND ("status" = 'RESOLVED') = ("resolvedAt" IS NOT NULL)
  );

-- Triggers -------------------------------------------------------------------

-- A plan's provider product id is recorded once and never changed.
CREATE FUNCTION "guard_subscription_plan_product_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_subscription_plan_product_change$
BEGIN
  IF OLD."externalProductId" IS NOT NULL
     AND NEW."externalProductId" IS DISTINCT FROM OLD."externalProductId" THEN
    RAISE EXCEPTION 'A plan''s billing-provider product id is never changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_subscription_plan_product_change$;

CREATE TRIGGER "SubscriptionPlan_product_set_once"
  BEFORE UPDATE ON "SubscriptionPlan"
  FOR EACH ROW EXECUTE FUNCTION "guard_subscription_plan_product_change"();

-- A Checkout session is never deleted; what it offered never changes; its
-- provider id is set once; OPEN may become COMPLETED or EXPIRED, then never
-- changes again.
CREATE FUNCTION "guard_billing_checkout_session_change"() RETURNS trigger
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

CREATE TRIGGER "BillingCheckoutSession_guard"
  BEFORE UPDATE OR DELETE ON "BillingCheckoutSession"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_checkout_session_change"();
CREATE TRIGGER "BillingCheckoutSession_no_truncate"
  BEFORE TRUNCATE ON "BillingCheckoutSession"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_checkout_session_change"();

-- A reconciliation case is never deleted and never changes what it is about;
-- it may only be resolved, once.
CREATE FUNCTION "guard_billing_reconciliation_case_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_reconciliation_case_change$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingReconciliationCase rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."kind" <> OLD."kind"
     OR NEW."subscriptionId" IS DISTINCT FROM OLD."subscriptionId"
     OR NEW."billingProviderEventId" IS DISTINCT FROM OLD."billingProviderEventId"
     OR NEW."detail" IS DISTINCT FROM OLD."detail"
     OR NEW."createdAt" <> OLD."createdAt"
     OR OLD."status" = 'RESOLVED'
  THEN
    RAISE EXCEPTION 'A billing reconciliation case can only be resolved, once.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_reconciliation_case_change$;

CREATE TRIGGER "BillingReconciliationCase_guard"
  BEFORE UPDATE OR DELETE ON "BillingReconciliationCase"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_reconciliation_case_change"();
CREATE TRIGGER "BillingReconciliationCase_no_truncate"
  BEFORE TRUNCATE ON "BillingReconciliationCase"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_reconciliation_case_change"();

-- Backfill ---------------------------------------------------------------------

-- The built-in administrator role of every existing tenant receives the new
-- billing permissions (idempotent: an existing grant is left as it is).
INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
SELECT r."id", k."permissionKey", r."tenantId", CURRENT_TIMESTAMP
  FROM "InternalRole" r
 CROSS JOIN (VALUES ('billing.view'), ('billing.manage')) AS k("permissionKey")
 WHERE r."key" = 'platform-administrator'
   AND r."isSystem" = true
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
