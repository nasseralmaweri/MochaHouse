-- ESP-04 M5c rollback for migration 20261126090000_payment_refund_reconciliation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration, only together with an API build without ESP-04 M5c (refund
-- recovery off). The column is only a schedule: dropping it loses no money,
-- refund or evidence. One DO block, so it applies atomically.

DO $payment_refund_reconciliation_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'PaymentAttempt'
       AND column_name = 'refundsReconciledAt'
  ) THEN
    RAISE EXCEPTION 'Payment refund reconciliation rollback refused: it is not applied. Nothing was changed.';
  END IF;
  ALTER TABLE "PaymentAttempt" DROP COLUMN "refundsReconciledAt";
END
$payment_refund_reconciliation_rollback$;
