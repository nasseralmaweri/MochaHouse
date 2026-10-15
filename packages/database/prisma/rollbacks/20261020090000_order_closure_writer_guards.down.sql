-- R1 / S5b rollback for migration 20261020090000_order_closure_writer_guards.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear.
--
-- It removes exactly what the migration added: the Order INSERT guard, the
-- manual-refund evidence CHECK and the settler-is-not-the-closer trigger.
--
-- It REFUSES to run while order closure can still be written: any REJECTED /
-- CANCELLED order means the closure writer has been enabled, and removing the
-- INSERT guard under it would reopen Invariant 2. Disable ORDER_CLOSURE_ENABLED
-- and roll the application back first; if closed orders exist they stay valid
-- (S5a's guards remain), but this guard must then stay too. One DO block, so it
-- applies atomically.

DO $order_closure_writer_guards_rollback$
DECLARE
  closed_orders bigint;
  settled bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "Order" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "OrderRefundObligation" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO closed_orders FROM "Order" WHERE "status"::text IN ('REJECTED', 'CANCELLED');
  SELECT count(*) INTO settled FROM "OrderRefundObligation" WHERE "status" = 'REFUNDED';
  IF closed_orders > 0 OR settled > 0 THEN
    RAISE EXCEPTION 'S5b rollback refused: % order(s) are already REJECTED / CANCELLED and % refund(s) settled; the guards must stay. Nothing was changed.',
      closed_orders, settled;
  END IF;

  DROP TRIGGER IF EXISTS "Order_insert_not_closed" ON "Order";
  DROP FUNCTION IF EXISTS "reject_closed_order_insert"();
  DROP TRIGGER IF EXISTS "OrderRefundObligation_settler_not_closer" ON "OrderRefundObligation";
  DROP FUNCTION IF EXISTS "reject_self_settled_order_refund"();
  ALTER TABLE "OrderRefundObligation" DROP CONSTRAINT IF EXISTS "OrderRefundObligation_manual_evidence_check";
END
$order_closure_writer_guards_rollback$;
