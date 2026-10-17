-- SC3d-1 rollback for migration 20261030090000_plan_changes.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3d.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- plan change (including a preview) exists — those record what a business
-- was quoted or asked for, and erasing them is not a rollback's decision.
-- Nothing is changed when it refuses. One DO block, so it applies atomically.

DO $plan_changes_rollback$
DECLARE
  changes bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingPlanChange" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO changes FROM "BillingPlanChange";
  IF changes > 0 THEN
    RAISE EXCEPTION 'SC3d-1 rollback refused: % billing plan change(s) exist. Nothing was changed.', changes;
  END IF;

  DROP TABLE "BillingPlanChange";
  DROP FUNCTION "guard_billing_plan_change"();
END
$plan_changes_rollback$;
