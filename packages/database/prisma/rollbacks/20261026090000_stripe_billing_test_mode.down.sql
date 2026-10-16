-- SC3b rollback for migration 20261026090000_stripe_billing_test_mode.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without the Stripe billing integration (pre-SC3b).
--
-- It removes exactly what the migration added and restores the SC3a provider
-- id CHECK. It REFUSES to run while any Stripe billing data exists — a
-- Checkout session, a reconciliation case, a plan product id, or a
-- subscription with a provider customer but no provider subscription (which
-- the SC3a CHECK cannot hold) — because dropping those would destroy the
-- record of a business's billing setup, which is not a rollback's decision.
-- Nothing is changed when it refuses. One DO block, so it applies atomically.

DO $stripe_billing_test_mode_rollback$
DECLARE
  sessions bigint;
  cases bigint;
  products bigint;
  customer_only bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantSubscription", "SubscriptionPlan", "BillingCheckoutSession",
             "BillingReconciliationCase"
    IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO sessions FROM "BillingCheckoutSession";
  SELECT count(*) INTO cases FROM "BillingReconciliationCase";
  SELECT count(*) INTO products FROM "SubscriptionPlan" WHERE "externalProductId" IS NOT NULL;
  SELECT count(*) INTO customer_only FROM "TenantSubscription"
   WHERE "billingProvider" IS NOT NULL AND "externalSubscriptionId" IS NULL;
  IF sessions > 0 OR cases > 0 OR products > 0 OR customer_only > 0 THEN
    RAISE EXCEPTION 'SC3b rollback refused: % Checkout session(s), % reconciliation case(s), % plan product id(s), % subscription(s) awaiting setup. Nothing was changed.',
      sessions, cases, products, customer_only;
  END IF;

  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billed_check";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billing_check";
  ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billing_check"
    CHECK (
      ("billingProvider" IS NULL) = ("externalSubscriptionId" IS NULL)
      AND ("billingProvider" IS NOT NULL OR "externalCustomerId" IS NULL)
    );

  DROP TABLE "BillingReconciliationCase";
  DROP TABLE "BillingCheckoutSession";
  DROP TRIGGER "SubscriptionPlan_product_set_once" ON "SubscriptionPlan";
  ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT "SubscriptionPlan_externalProductId_check";
  DROP INDEX "SubscriptionPlan_externalProductId_key";
  ALTER TABLE "SubscriptionPlan" DROP COLUMN "externalProductId";
  DROP FUNCTION "guard_billing_reconciliation_case_change"();
  DROP FUNCTION "guard_billing_checkout_session_change"();
  DROP FUNCTION "guard_subscription_plan_product_change"();
  DROP TYPE "BillingReconciliationCaseStatus";
  DROP TYPE "BillingCheckoutSessionStatus";
END
$stripe_billing_test_mode_rollback$;
