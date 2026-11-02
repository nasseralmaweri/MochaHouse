-- ESP-04 M2 — two-step food-order payments: REQUIRES_CUSTOMER_ACTION.
--
-- A payment taken in two steps (a provider payment intent the customer then
-- confirms in the browser) waits between "sent" and "succeeded" in a new
-- payment state, REQUIRES_CUSTOMER_ACTION:
--   * it is LIVE (status PENDING): its checkout session's one-live-payment
--     index keeps it the session's only payment, so a reload or retry
--     resumes the same intent and never creates another;
--   * it is NOT a held / unknown outcome (CHARGING, AWAITING_CONFIRMATION,
--     UNKNOWN): the customer simply has not finished paying;
--   * it always names the provider's intent (providerReference), so the
--     outcome can be read back from the provider at any time;
--   * its financial holds stay reserved (the hold guard and the release
--     trigger only act on DECLINED / FAILED).
--
-- ADDITIVE ONLY: the paymentState CHECK is replaced by a superset and one
-- CHECK is added. No existing row changes. One DO block (atomic), read-only
-- preflight first, lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261121090000_payment_customer_action.down.sql.

DO $payment_customer_action$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAttempt_paymentState_check'
  ) THEN
    RAISE EXCEPTION 'Customer-action payments refused: constraint "PaymentAttempt_paymentState_check" is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PaymentAttempt_customer_action_check'
  ) THEN
    RAISE EXCEPTION 'Customer-action payments refused: constraint "PaymentAttempt_customer_action_check" already exists. Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_paymentState_check";
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentState_check"
    CHECK ("paymentState" IS NULL OR "paymentState" IN
      ('NOT_SENT', 'CHARGING', 'REQUIRES_CUSTOMER_ACTION', 'AWAITING_CONFIRMATION', 'UNKNOWN', 'SUCCEEDED', 'DECLINED', 'FAILED', 'ABANDONED'));

  -- Waiting for the customer: still live (PENDING), and always naming the
  -- provider's intent.
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_customer_action_check"
    CHECK ("paymentState" IS DISTINCT FROM 'REQUIRES_CUSTOMER_ACTION'
      OR ("status" = 'PENDING' AND "providerReference" IS NOT NULL));
END
$payment_customer_action$;
