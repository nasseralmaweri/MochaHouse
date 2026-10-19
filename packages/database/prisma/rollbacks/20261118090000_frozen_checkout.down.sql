-- ESP-03 PR 7 rollback for migration 20261118090000_frozen_checkout.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-03 PR 7.
--
-- It REFUSES to run while any version-2 (frozen) saved checkout exists: such
-- a checkout backs a payment still awaiting its order, and an API without
-- PR 7 could not read it. Nothing is changed when it refuses. One DO block,
-- so it applies atomically.

DO $frozen_checkout_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "CheckoutSnapshot" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "CheckoutSnapshot"
    WHERE "version" <> 1 OR octet_length("payload"::text) > 65536
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Frozen checkout rollback refused: % frozen (version 2) saved checkout(s) still back payments awaiting their order. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_payload_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 65536
  );
  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_version_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_version_check" CHECK ("version" = 1);
  DROP INDEX "PaymentAttempt_tenantId_idempotencyKey_key";
END
$frozen_checkout_rollback$;
