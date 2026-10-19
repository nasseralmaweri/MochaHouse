-- ESP-04 M2 rollback for migration 20261121090000_payment_customer_action.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without ESP-04 M2.
--
-- It REFUSES to run while any payment attempt is REQUIRES_CUSTOMER_ACTION: such
-- a payment may still be completed by its customer at the provider, and an
-- API without M2 could neither read it nor ever learn its outcome. Nothing is
-- changed when it refuses. One DO block, so it applies atomically.

DO $payment_customer_action_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "PaymentAttempt" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM "PaymentAttempt"
   WHERE "paymentState" = 'REQUIRES_CUSTOMER_ACTION'
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Customer-action payments rollback refused: % payment(s) are waiting for their customer. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_customer_action_check";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_paymentState_check";
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentState_check"
    CHECK ("paymentState" IS NULL OR "paymentState" IN
      ('NOT_SENT', 'CHARGING', 'AWAITING_CONFIRMATION', 'UNKNOWN', 'SUCCEEDED', 'DECLINED', 'FAILED', 'ABANDONED'));
END
$payment_customer_action_rollback$;
