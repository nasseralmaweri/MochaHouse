-- ESP-03 PR 8 rollback for migration 20261119090000_financial_holds.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-03 PR 8.
--
-- It REFUSES to run while any financial hold exists. An ACTIVE hold reserves
-- a promotion redemption, Mocha Beans or a gift-card amount for a payment that
-- may still be charged or completed; a settled one is the history of what a
-- payment reserved, consumed or released. Neither may be dropped silently: an
-- explicit, separately approved archival step must come first. Nothing is
-- changed when it refuses. One DO block, so it applies atomically.

DO $financial_holds_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"FinancialHold"') IS NULL THEN
    RAISE EXCEPTION 'Financial holds rollback refused: table "FinancialHold" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "FinancialHold" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "FinancialHold" INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Financial holds rollback refused: % financial hold record(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TRIGGER "PaymentAttempt_release_financial_holds" ON "PaymentAttempt";
  DROP FUNCTION "release_financial_holds_on_outcome"();
  DROP TABLE "FinancialHold";
  DROP FUNCTION "financial_hold_guard"();
END
$financial_holds_rollback$;
