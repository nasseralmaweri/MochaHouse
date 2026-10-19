-- ESP-03 PR 6 rollback for migration 20261117090000_checkout_sessions.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without ESP-03 PR 6.
--
-- It REFUSES to run while any checkout session exists, any payment attempt
-- names a session, or any attempt is ABANDONED: those are payment records a
-- rollback must not orphan or reinterpret. Nothing is changed when it refuses.
-- One DO block, so it applies atomically.

DO $checkout_sessions_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"CheckoutSession"') IS NULL THEN
    RAISE EXCEPTION 'Checkout sessions rollback refused: table "CheckoutSession" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "CheckoutSession", "PaymentAttempt" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "CheckoutSession")
       + (SELECT count(*) FROM "PaymentAttempt"
           WHERE "checkoutSessionId" IS NOT NULL OR "paymentState" = 'ABANDONED')
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Checkout sessions rollback refused: % checkout session or session payment record(s) exist. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_abandoned_check";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_paymentState_check";
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentState_check"
    CHECK ("paymentState" IS NULL OR "paymentState" IN
      ('NOT_SENT', 'CHARGING', 'AWAITING_CONFIRMATION', 'UNKNOWN', 'SUCCEEDED', 'DECLINED', 'FAILED'));
  DROP INDEX "PaymentAttempt_live_per_checkout_session";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_tenantId_checkoutSessionId_fkey";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_checkout_session_check";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_requestFingerprint_check";
  ALTER TABLE "PaymentAttempt" DROP COLUMN "checkoutSessionId", DROP COLUMN "requestFingerprint";
  DROP TABLE "CheckoutSession";
END
$checkout_sessions_rollback$;
