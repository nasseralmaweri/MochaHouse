-- ESP-04 M5b rollback for migration 20261125090000_payment_refund_requests.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration, and only together with an API build without ESP-04 M5b.
--
-- It REFUSES to run while any CENTERIVO refund exists: its request identity is
-- what stops a repeated staff request from creating a second refund, and may
-- never be dropped silently. Nothing is changed when it refuses. One DO
-- block, so it applies atomically.

DO $payment_refund_requests_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regprocedure('payment_refund_request_identity_guard()') IS NULL THEN
    RAISE EXCEPTION 'Payment refund requests rollback refused: it is not applied. Nothing was changed.';
  END IF;
  LOCK TABLE "PaymentRefund" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO remaining FROM "PaymentRefund" WHERE origin = 'CENTERIVO';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Payment refund requests rollback refused: % CENTERIVO refund(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TRIGGER "PaymentRefund_stamp_first_sent" ON "PaymentRefund";
  DROP FUNCTION "payment_refund_stamp_first_sent"();
  DROP TRIGGER "PaymentRefund_request_identity_guard" ON "PaymentRefund";
  DROP FUNCTION "payment_refund_request_identity_guard"();
  DROP INDEX "PaymentRefund_tenantId_clientRequestId_key";
  ALTER TABLE "PaymentRefund" DROP CONSTRAINT "PaymentRefund_request_identity_check";
  ALTER TABLE "PaymentRefund" DROP CONSTRAINT "PaymentRefund_centerivo_key_required_check";
  ALTER TABLE "PaymentRefund" DROP CONSTRAINT "PaymentRefund_not_created_evidence_required_check";
  ALTER TABLE "PaymentRefund" DROP COLUMN "requestFingerprint", DROP COLUMN "clientRequestId";
END
$payment_refund_requests_rollback$;
