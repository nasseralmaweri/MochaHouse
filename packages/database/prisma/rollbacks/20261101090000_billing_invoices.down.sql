-- SC3e-1 rollback for migration 20261101090000_billing_invoices.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3e-1.
--
-- It removes exactly what the migration added. The rows are a copy of what
-- the billing provider holds (the provider stays authoritative), so they can
-- be rebuilt by the reconciliation sweep — but erasing a business's billing
-- history is still not a rollback's decision: it REFUSES to run while any
-- invoice is recorded. Nothing is changed when it refuses. One DO block, so
-- it applies atomically.

DO $billing_invoices_rollback$
DECLARE
  invoices bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingInvoice" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO invoices FROM "BillingInvoice";
  IF invoices > 0 THEN
    RAISE EXCEPTION 'SC3e-1 rollback refused: % billing invoice(s) recorded. Nothing was changed.', invoices;
  END IF;

  DROP TABLE "BillingInvoice";
  DROP FUNCTION "guard_billing_invoice"();
END
$billing_invoices_rollback$;
