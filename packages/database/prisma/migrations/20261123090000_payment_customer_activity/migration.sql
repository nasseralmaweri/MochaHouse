-- ESP-04 M4b — the customer's verified activity on a two-step payment.
--
--   * PaymentAttempt."customerActiveAt" — the last time the customer's own
--     checkout page proved it was still open on this payment (an
--     authenticated heartbeat bound to the checkout session, written at most
--     once a minute, only while the payment waits for its customer). Abandoned
--     payment cleanup measures inactivity from the LATER of the payment's
--     creation and this time; sending the payment's client secret to a
--     browser is never counted as activity.
--   * A partial index for the abandonment scan: Stripe payments waiting for
--     their customer, oldest first.
--
-- Nothing here cancels or releases anything.
--
-- ADDITIVE ONLY: one nullable column and one partial index. No existing row
-- changes. One DO block (atomic), read-only preflight first, lock_timeout 5s
-- (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261123090000_payment_customer_activity.down.sql.

DO $payment_customer_activity$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"PaymentAttempt"') IS NULL THEN
    RAISE EXCEPTION 'Payment customer activity refused: "PaymentAttempt" is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'PaymentAttempt' AND column_name = 'customerActiveAt'
  ) OR to_regclass('"PaymentAttempt_stripe_awaiting_customer_idx"') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment customer activity refused: a column or index it creates already exists. Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentAttempt" ADD COLUMN "customerActiveAt" TIMESTAMP(3);

  CREATE INDEX "PaymentAttempt_stripe_awaiting_customer_idx"
    ON "PaymentAttempt"("createdAt", "id")
    WHERE "provider" = 'stripe'
      AND "status" = 'PENDING'
      AND "paymentState" = 'REQUIRES_CUSTOMER_ACTION';
END
$payment_customer_activity$;
