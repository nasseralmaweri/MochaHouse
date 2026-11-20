-- V1 Sales Tax PR 3 rollback for migration 20261204090000_order_tax_refunds.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without V1 Sales Tax PR 3.
--
-- It REFUSES to run while any tax refund is recorded: those are the record of
-- which tax a business returned to its customers. Order line positions are
-- configuration of the order only and are removed. Nothing is changed when it
-- refuses. One DO block, so it applies atomically.

DO $order_tax_refunds_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"OrderTaxRefund"') IS NULL THEN
    RAISE EXCEPTION 'Order tax refunds rollback refused: table "OrderTaxRefund" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "OrderTaxRefund", "OrderTaxRefundLine", "OrderTaxRefundComponent" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO remaining FROM "OrderTaxRefund";
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Order tax refunds rollback refused: % tax refund record(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "OrderTaxRefundComponent";
  DROP TABLE "OrderTaxRefundLine";
  DROP TABLE "OrderTaxRefund";
  DROP FUNCTION "order_tax_refund_consistent"();
  DROP FUNCTION "order_tax_refund_guard"();
  DROP FUNCTION "order_tax_refund_immutable"();
  DROP TRIGGER "OrderLine_lineIndex_frozen" ON "OrderLine";
  DROP FUNCTION "order_line_index_frozen"();
  DROP INDEX "OrderLine_orderId_lineIndex_key";
  ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_lineIndex_check";
  ALTER TABLE "OrderLine" DROP COLUMN "lineIndex";
END
$order_tax_refunds_rollback$;
