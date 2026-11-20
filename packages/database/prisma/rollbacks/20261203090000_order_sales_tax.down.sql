-- V1 Sales Tax PR 2 rollback for migration 20261203090000_order_sales_tax.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without V1 Sales Tax PR 2.
--
-- It REFUSES to run while any order was charged sales tax or has a tax
-- snapshot, or any saved checkout uses version 3: those are the record of
-- what customers were charged and an API without PR 2 could neither show
-- nor fulfil them. Nothing is changed when it refuses. One DO block, so it
-- applies atomically.

DO $order_sales_tax_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"OrderTaxSnapshot"') IS NULL THEN
    RAISE EXCEPTION 'Order sales tax rollback refused: table "OrderTaxSnapshot" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "Order", "OrderTaxSnapshot", "CheckoutSnapshot" IN SHARE ROW EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "OrderTaxSnapshot")
       + (SELECT count(*) FROM "Order" WHERE "taxMinorUnits" <> 0)
       + (SELECT count(*) FROM "CheckoutSnapshot" WHERE "version" = 3)
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Order sales tax rollback refused: % taxed order, tax snapshot or version-3 saved checkout record(s) exist. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_version_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_version_check" CHECK ("version" IN (1, 2));
  DROP TRIGGER "Order_tax_snapshot_required" ON "Order";
  DROP TRIGGER "Order_taxMinorUnits_frozen" ON "Order";
  DROP TABLE "OrderTaxSnapshot";
  DROP FUNCTION "order_tax_snapshot_required"();
  DROP FUNCTION "order_tax_snapshot_guard"();
  DROP FUNCTION "order_tax_amount_frozen"();
  ALTER TABLE "Order" DROP CONSTRAINT "Order_taxMinorUnits_check";
  ALTER TABLE "Order" DROP COLUMN "taxMinorUnits";
END
$order_sales_tax_rollback$;
