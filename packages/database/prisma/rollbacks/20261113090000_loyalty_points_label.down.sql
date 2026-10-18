-- SC4f-3b rollback for migration 20261113090000_loyalty_points_label.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4f-3b.
--
-- It REFUSES to run while any business has chosen a points name: that is the
-- business's own setting, and discarding it is not a rollback's decision.
-- Nothing is changed when it refuses. One DO block, so it applies atomically.

DO $loyalty_points_label_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "LoyaltyConfiguration" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM "LoyaltyConfiguration" WHERE "pointsLabel" IS NOT NULL
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4f-3b rollback refused: % business(es) have chosen a loyalty points name. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "LoyaltyConfiguration" DROP CONSTRAINT "LoyaltyConfiguration_pointsLabel_check";
  ALTER TABLE "LoyaltyConfiguration" DROP COLUMN "pointsLabel";
END
$loyalty_points_label_rollback$;
