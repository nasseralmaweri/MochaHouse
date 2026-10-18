-- ESP-03 PR 4 rollback for migration 20261115090000_checkout_snapshots.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-03 PR 4.
--
-- It REFUSES (changing nothing) while any snapshot remains: a remaining row
-- is a charged payment whose order has not been created yet, and its saved
-- checkout is the only way to create that order. Resolve those payments
-- first. One DO block, so it applies atomically.

DO $checkout_snapshots_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"CheckoutSnapshot"') IS NULL THEN
    RAISE EXCEPTION 'Checkout snapshots rollback refused: table "CheckoutSnapshot" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "CheckoutSnapshot" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "CheckoutSnapshot" INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Checkout snapshots rollback refused: % saved checkout(s) still back a payment awaiting its order. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "CheckoutSnapshot";
END
$checkout_snapshots_rollback$;
