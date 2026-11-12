-- ESP-04 M5b — request-level idempotency for refunds CENTERIVO asks for.
--
-- Every CENTERIVO refund operation already has its own Stripe idempotency
-- key (M5a). This adds the identity of the STAFF REQUEST that created it, so
-- a duplicate HTTP submission (a double click, a retried request) finds the
-- operation it already created instead of creating a second one:
--   "clientRequestId"     a UUID the staff page generates once per refund
--                         form submission; unique per business;
--   "requestFingerprint"  SHA-256 (hex) of what was asked (order, location,
--                         staff member, amount, currency, reason, note),
--                         computed by the server: the same request id with
--                         anything else is a conflict, never a second refund.
-- Both are required on every CENTERIVO refund, absent on one made outside
-- CENTERIVO, and never change.
--
-- It also makes two M5a CHECKs NULL-safe (a CHECK whose expression is NULL
-- passes): a CENTERIVO refund always has its own idempotency key, and
-- NOT_CREATED always carries its evidence.
--
-- ADDITIVE ONLY: two columns, one unique index, three CHECKs and one trigger.
-- No existing row changes. One DO block (atomic), read-only preflight first,
-- lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261125090000_payment_refund_requests.down.sql.

DO $payment_refund_requests$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"PaymentRefund"') IS NULL THEN
    RAISE EXCEPTION 'Payment refund requests refused: the M5a refund foundation is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'PaymentRefund'
       AND column_name IN ('clientRequestId', 'requestFingerprint')
  ) OR to_regprocedure('payment_refund_request_identity_guard()') IS NOT NULL
    OR to_regprocedure('payment_refund_stamp_first_sent()') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment refund requests refused: a column or function it creates already exists. Nothing was changed.';
  END IF;
  -- No CENTERIVO refund can exist yet (M5a had no way to create one); one
  -- that did would have no request identity.
  IF EXISTS (SELECT 1 FROM "PaymentRefund" WHERE origin = 'CENTERIVO') THEN
    RAISE EXCEPTION 'Payment refund requests refused: a CENTERIVO refund already exists without a request identity. Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentRefund"
    ADD COLUMN "clientRequestId" TEXT,
    ADD COLUMN "requestFingerprint" TEXT;

  -- Every comparison is NULL-safe: a CHECK whose expression is NULL passes.
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_request_identity_check" CHECK (
    ("origin" = 'CENTERIVO'
      AND "clientRequestId" IS NOT NULL AND "requestFingerprint" IS NOT NULL
      AND "clientRequestId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND "requestFingerprint" ~ '^[0-9a-f]{64}$')
    OR ("origin" = 'EXTERNAL' AND "clientRequestId" IS NULL AND "requestFingerprint" IS NULL)
  );

  -- Two M5a CHECKs, made NULL-safe (additive: the M5a constraints stay; the
  -- M5a guard trigger already refused a NOT_CREATED without evidence, the
  -- key had no such second line):
  --   * a CENTERIVO refund always has its own idempotency key;
  --   * NOT_CREATED always carries its evidence.
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_centerivo_key_required_check" CHECK (
    "origin" <> 'CENTERIVO'
    OR ("idempotencyKey" IS NOT NULL AND "idempotencyKey" = 'centerivo-refund:' || "id")
  );
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_not_created_evidence_required_check" CHECK (
    "status" <> 'NOT_CREATED'
    OR ("notCreatedEvidence" IS NOT NULL AND "notCreatedRecordedAt" IS NOT NULL)
  );

  -- One refund operation per staff request, per business.
  CREATE UNIQUE INDEX "PaymentRefund_tenantId_clientRequestId_key"
    ON "PaymentRefund"("tenantId", "clientRequestId");

  CREATE FUNCTION "payment_refund_request_identity_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $request_guard$
  BEGIN
    IF NEW."clientRequestId" IS DISTINCT FROM OLD."clientRequestId"
       OR NEW."requestFingerprint" IS DISTINCT FROM OLD."requestFingerprint" THEN
      RAISE EXCEPTION 'A refund''s request identity never changes (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $request_guard$;

  CREATE TRIGGER "PaymentRefund_request_identity_guard" BEFORE UPDATE ON "PaymentRefund"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_request_identity_guard"();

  -- When a refund was first sent is the database's time (UTC), never the
  -- application's: the 24-hour rule for "never created" is measured from
  -- it. Runs after the M5a guard (trigger names sort), which still refuses
  -- an application value in the future or a second write.
  CREATE FUNCTION "payment_refund_stamp_first_sent"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $stamp_first_sent$
  BEGIN
    IF OLD."firstSentAt" IS NULL AND NEW."firstSentAt" IS NOT NULL THEN
      NEW."firstSentAt" := now() AT TIME ZONE 'UTC';
    END IF;
    RETURN NEW;
  END
  $stamp_first_sent$;

  CREATE TRIGGER "PaymentRefund_stamp_first_sent" BEFORE UPDATE OF "firstSentAt" ON "PaymentRefund"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_stamp_first_sent"();
END
$payment_refund_requests$;
