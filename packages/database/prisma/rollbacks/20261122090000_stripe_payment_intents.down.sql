-- ESP-04 M3 rollback for migration 20261122090000_stripe_payment_intents.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-04 M3.
--
-- It REFUSES to run while any Stripe payment attempt or any payment event
-- record exists: an API without M3 could neither read such a payment's intent
-- (it would not know the account it lives on) nor finish such an event.
-- Nothing is changed when it refuses. One DO block, so it applies atomically.

DO $stripe_payment_intents_rollback$
DECLARE
  payments bigint;
  events bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "PaymentAttempt" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "RestaurantPaymentProviderEvent" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM "PaymentAttempt"
   WHERE provider = 'stripe' OR "providerAccountId" IS NOT NULL
    INTO payments;
  SELECT count(*) FROM "RestaurantPaymentProviderEvent"
   WHERE "externalObjectId" IS NOT NULL OR status = 'UNMATCHED'
    INTO events;
  IF payments > 0 OR events > 0 THEN
    RAISE EXCEPTION 'Stripe payment intents rollback refused: % Stripe payment(s) and % payment event(s) exist. Nothing was changed.', payments, events;
  END IF;

  DROP INDEX "RestaurantPaymentProviderEvent_status_receivedAt_idx";
  ALTER TABLE "RestaurantPaymentProviderEvent" DROP CONSTRAINT "RestaurantPaymentProviderEvent_status_check";
  ALTER TABLE "RestaurantPaymentProviderEvent" ADD CONSTRAINT "RestaurantPaymentProviderEvent_status_check"
    CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'));
  ALTER TABLE "RestaurantPaymentProviderEvent" DROP CONSTRAINT "RestaurantPaymentProviderEvent_externalObjectId_check";
  ALTER TABLE "RestaurantPaymentProviderEvent" DROP COLUMN "lastAttemptAt";
  ALTER TABLE "RestaurantPaymentProviderEvent" DROP COLUMN "externalObjectId";

  DROP TRIGGER "PaymentAttempt_stripe_guard" ON "PaymentAttempt";
  DROP FUNCTION "stripe_payment_attempt_guard"();
  DROP INDEX "PaymentAttempt_stripe_providerReference_key";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_stripe_account_check";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_providerAccountId_check";
  ALTER TABLE "PaymentAttempt" DROP COLUMN "providerAccountId";
END
$stripe_payment_intents_rollback$;
