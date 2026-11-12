-- ESP-04 M5c — when a payment's refunds were last reconciled with Stripe.
--
-- Refund recovery (read-only towards Stripe) re-reads the refunds of a
-- payment that has a refund waiting for an answer, a refund that succeeded
-- recently (it could still come back), or a refund obligation still open.
-- This one timestamp is its schedule, so each payment is read at a bounded
-- rate (not on every sweep), across restarts and API instances. It is set by
-- the reconciliation only; it moves no money and is no evidence of anything.
--
-- ADDITIVE ONLY: one nullable column. No existing row changes. One DO block
-- (atomic), read-only preflight first, lock_timeout 5s.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261126090000_payment_refund_reconciliation.down.sql.

DO $payment_refund_reconciliation$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"PaymentRefund"') IS NULL THEN
    RAISE EXCEPTION 'Payment refund reconciliation refused: the M5a refund foundation is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'PaymentAttempt'
       AND column_name = 'refundsReconciledAt'
  ) THEN
    RAISE EXCEPTION 'Payment refund reconciliation refused: "PaymentAttempt"."refundsReconciledAt" already exists. Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentAttempt" ADD COLUMN "refundsReconciledAt" TIMESTAMP(3);
END
$payment_refund_reconciliation$;
