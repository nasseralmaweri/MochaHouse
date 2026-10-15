-- R1 / S5a rollback for migration 20261019090100_order_closure_foundation (and the
-- constraints 20261019090200_order_closure_validate_checks validates).
--
-- NOT a Prisma migration and never run automatically. To roll back an environment
-- that applied the migration: remove the new models and fields from schema.prisma and
-- ship this SQL as a NEW forward migration, so every environment's history stays
-- linear.
--
-- It removes exactly what the foundation added: OrderClosure, OrderRefundObligation,
-- their triggers and functions, the Order status-freeze trigger, the two ledger CHECK
-- constraints (validated or not) and the gift-card reversal partial unique index.
--
-- WHAT IT CANNOT REMOVE: the enum values from 20261019090000_order_closure_enum_values
-- (OrderStatus REJECTED / CANCELLED, GiftCardTransactionType REDEMPTION_REVERSAL,
-- MochaBeanEntryType REDEEM_REVERSAL / EARN_REVERSAL / BONUS_EARN_REVERSAL).
-- PostgreSQL has no ALTER TYPE ... DROP VALUE. They stay in the type, unused and
-- harmless; "rolling back" them means no code writes them. The Prisma schema must
-- keep listing them while the database has them (or `migrate diff` reports drift).
--
-- Code coupling: once this SQL has run, an application built from the new schema (whose
-- Prisma client selects these tables) fails on any query of them. Before S5b ships, no
-- code uses them, so reverting the schema alone is already safe. Ship the schema revert
-- and this SQL together, as one deployment; never run it under running new code.
--
-- It REFUSES to run when it would destroy data: any order already REJECTED / CANCELLED,
-- any closure, refund obligation or reversal ledger entry. Those are financial
-- records (an owed refund, restored card value, returned Beans); they must be resolved
-- and exported deliberately, never dropped with the schema. The tables are locked
-- (ACCESS EXCLUSIVE) BEFORE the check, so no write can land between the check and the
-- drops. One DO block, so Prisma applies it atomically.

DO $order_closure_foundation_rollback$
DECLARE
  closed_orders bigint := 0;
  closures bigint := 0;
  obligations bigint := 0;
  reversals bigint := 0;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  LOCK TABLE "Order", "GiftCardTransaction", "MochaBeanLedgerEntry" IN ACCESS EXCLUSIVE MODE;
  IF to_regclass('public."OrderClosure"') IS NOT NULL THEN
    LOCK TABLE "OrderClosure" IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public."OrderRefundObligation"') IS NOT NULL THEN
    LOCK TABLE "OrderRefundObligation" IN ACCESS EXCLUSIVE MODE;
  END IF;

  SELECT count(*) INTO closed_orders FROM "Order" WHERE "status"::text IN ('REJECTED', 'CANCELLED');
  IF to_regclass('public."OrderClosure"') IS NOT NULL THEN
    SELECT count(*) INTO closures FROM "OrderClosure";
  END IF;
  IF to_regclass('public."OrderRefundObligation"') IS NOT NULL THEN
    SELECT count(*) INTO obligations FROM "OrderRefundObligation";
  END IF;
  SELECT (SELECT count(*) FROM "GiftCardTransaction" WHERE "type"::text = 'REDEMPTION_REVERSAL')
       + (SELECT count(*) FROM "MochaBeanLedgerEntry"
           WHERE "type"::text IN ('REDEEM_REVERSAL', 'EARN_REVERSAL', 'BONUS_EARN_REVERSAL'))
    INTO reversals;

  IF closed_orders > 0 OR closures > 0 OR obligations > 0 OR reversals > 0 THEN
    RAISE EXCEPTION 'S5a rollback refused: % closed order(s), % closure(s), % refund obligation(s) and % reversal ledger entr(ies) exist. Nothing was changed.',
      closed_orders, closures, obligations, reversals;
  END IF;

  DROP INDEX IF EXISTS "GiftCardTransaction_orderId_redemption_reversal_key";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT IF EXISTS "GiftCardTransaction_redemption_reversal_check";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT IF EXISTS "MochaBeanLedgerEntry_reversal_check";

  DROP TRIGGER IF EXISTS "Order_closure_required" ON "Order";
  DROP TRIGGER IF EXISTS "Order_closed_status_frozen" ON "Order";
  DROP FUNCTION IF EXISTS "reject_closed_order_status_change"();

  -- Dropping the tables drops their triggers, indexes and constraints with them.
  DROP TABLE IF EXISTS "OrderRefundObligation";
  DROP TABLE IF EXISTS "OrderClosure";
  DROP FUNCTION IF EXISTS "assert_order_closure_consistent"();
  DROP FUNCTION IF EXISTS "guard_order_refund_obligation_change"();
  DROP FUNCTION IF EXISTS "reject_order_closure_change"();
  DROP FUNCTION IF EXISTS "reject_order_closure_truncate"();
END
$order_closure_foundation_rollback$;
