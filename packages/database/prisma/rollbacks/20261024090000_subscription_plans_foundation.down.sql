-- SC2a rollback for migration 20261024090000_subscription_plans_foundation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build that has no subscription plans or entitlements (pre-SC2a)
-- — such a build gives every business every module, as before.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- plan other than the Founding plan exists, any business is on another plan,
-- any add-on was granted, or any subscription change was made by an
-- operator: dropping those would destroy the record of what each business
-- was sold or given, which is not a rollback's decision. Nothing is changed
-- in that case. One DO block, so it applies atomically.

DO $subscription_plans_foundation_rollback$
DECLARE
  other_plans bigint;
  non_founding bigint;
  grants bigint;
  operator_events bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "SubscriptionPlan", "SubscriptionPlanVersion", "TenantSubscription",
             "TenantModuleGrant", "TenantSubscriptionEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO other_plans FROM "SubscriptionPlan" WHERE "key" <> 'founding';
  SELECT count(*) INTO non_founding
    FROM "TenantSubscription" s
    JOIN "SubscriptionPlanVersion" v ON v."id" = s."planVersionId"
    JOIN "SubscriptionPlan" p ON p."id" = v."planId"
   WHERE p."key" <> 'founding';
  SELECT count(*) INTO grants FROM "TenantModuleGrant";
  SELECT count(*) INTO operator_events FROM "TenantSubscriptionEvent"
   WHERE "actorPlatformOperatorId" IS NOT NULL;
  IF other_plans > 0 OR non_founding > 0 OR grants > 0 OR operator_events > 0 THEN
    RAISE EXCEPTION 'SC2a rollback refused: % other plan(s), % business(es) on another plan, % add-on grant(s), % operator change(s). Nothing was changed.',
      other_plans, non_founding, grants, operator_events;
  END IF;

  -- Dropping a table drops its triggers. The history's append-only trigger
  -- does not fire on DROP TABLE.
  DROP TABLE "TenantSubscriptionEvent";
  DROP TABLE "TenantModuleGrant";
  DROP TABLE "TenantSubscription";
  DROP TABLE "SubscriptionPlanVersion";
  DROP TABLE "SubscriptionPlan";
  DROP FUNCTION "reject_tenant_subscription_event_change"();
  DROP FUNCTION "guard_subscription_plan_version_change"();
  DROP TYPE "TenantSubscriptionEventType";
  DROP TYPE "TenantSubscriptionStatus";
  DROP TYPE "SubscriptionPlanVersionStatus";
END
$subscription_plans_foundation_rollback$;
