-- ESP-04 M4b rollback for migration 20261123090000_payment_customer_activity.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without ESP-04 M4b (so nothing reads the column
-- and nothing cancels abandoned payments).
--
-- It REFUSES to run while any Stripe payment waiting for its customer has
-- recorded activity in the last 24 hours: that customer may still be paying,
-- and losing their activity record could make a build that still cancels
-- abandoned payments treat an open checkout as abandoned. Nothing is changed
-- when it refuses. One DO block, so it applies atomically.

DO $payment_customer_activity_rollback$
DECLARE
  active bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "PaymentAttempt" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM "PaymentAttempt"
   WHERE "provider" = 'stripe'
     AND "status" = 'PENDING'
     AND "paymentState" = 'REQUIRES_CUSTOMER_ACTION'
     AND "customerActiveAt" > now() - interval '24 hours'
    INTO active;
  IF active > 0 THEN
    RAISE EXCEPTION 'Payment customer activity rollback refused: % payment(s) waiting for their customer were active in the last 24 hours. Nothing was changed.', active;
  END IF;

  DROP INDEX "PaymentAttempt_stripe_awaiting_customer_idx";
  ALTER TABLE "PaymentAttempt" DROP COLUMN "customerActiveAt";
END
$payment_customer_activity_rollback$;
