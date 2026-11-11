-- ESP-04 M5a — the refund foundation for restaurant card payments.
--
-- A refund returns money on the ORIGINAL Stripe payment of an order (a
-- direct charge on the restaurant's connected account). Nothing here moves
-- money and nothing calls Stripe: it is the record and the rules every later
-- refund path (M5b execution, M5c webhooks / recovery / Dashboard refunds)
-- must go through.
--
--   "PaymentRefund"       one row per refund OPERATION: a refund CENTERIVO
--                         asks Stripe for (origin CENTERIVO, saved BEFORE
--                         Stripe is called, with its own server-generated
--                         idempotency key), or one made outside CENTERIVO, in
--                         the restaurant's Stripe Dashboard (origin EXTERNAL).
--   "PaymentRefundEvent"  its append-only history. Creation and every status
--                         change are written by the database itself, so the
--                         history can never be skipped.
--
-- The rules the database enforces:
--   * Every refund belongs, with its order, payment and staff member, to one
--     business (composite foreign keys). It is only ever for a CONFIRMED
--     Stripe payment of that order (SUCCEEDED, intent stored), on the
--     connected account the payment was made on, in its currency.
--   * Capacity. A refund CENTERIVO asks for is refused if it would take the
--     refunds of the payment over what was charged. REQUESTED, PENDING,
--     UNKNOWN and SUCCEEDED refunds all count, including EXTERNAL ones; only
--     a refund proven not to have happened (FAILED, CANCELED, NOT_CREATED) or
--     whose money came back (FAILED_AFTER_SUCCESS) gives its amount back.
--     The payment row is locked first, so two concurrent requests are
--     serialised and can never both take the last of it.
--   * Identity never changes: business, order, payment, account, origin,
--     amount, currency, reason, note, requester and idempotency key. The
--     Stripe refund id is written once and is unique. A refund is never
--     deleted.
--   * Status moves only forward:
--       REQUESTED -> PENDING | SUCCEEDED | FAILED | CANCELED | UNKNOWN | NOT_CREATED
--       UNKNOWN   -> PENDING | SUCCEEDED | FAILED | CANCELED | NOT_CREATED
--       PENDING   -> SUCCEEDED | FAILED | CANCELED
--       SUCCEEDED -> FAILED_AFTER_SUCCESS   (Stripe returned the money later)
--     The success and late-failure times are stamped by the database, never
--     taken from the application.
--   * A CENTERIVO refund is only for a COMPLETED order, or a REJECTED /
--     CANCELLED one (its refund obligation): an order in progress is
--     cancelled instead. Refunds are written at READ COMMITTED (the default)
--     only, so the capacity count is never stale. Every refund status change
--     and every obligation settlement takes the payment's lock.
--   * "Never created" (NOT_CREATED) gives the amount back, so it is allowed
--     only for a request never sent, or first sent more than 24 hours ago
--     (past Stripe's idempotency window) — never inferred from a timeout.
--   * Times are UTC from the database clock; every function pins its
--     search_path; history entries the database writes cannot be forged by
--     an application insert.
--   * A refund whose money came back (FAILED_AFTER_SUCCESS) blocks any new
--     CENTERIVO refund of that payment until a staff member has recorded a
--     review of it (written once, audited in the history).
--
-- Refund obligations (R1 / S5a / S5b), additive guards only — every existing
-- guard on "OrderRefundObligation" still applies, unchanged:
--   * Every refund of an order's payment counts towards that order's
--     obligation, whenever and however it was made (an obligation is always
--     for the whole card-paid amount), so what is still owed is the
--     obligation minus those refunds.
--   * A PROCESSOR settlement (REFUNDED) is allowed only when the refunds of
--     the payment that SUCCEEDED cover the whole obligation, none is still in
--     flight, no returned refund is unreviewed, its refund id is one of them,
--     and each succeeded at least 30 days ago (Stripe can return a card
--     refund up to 30 days after it succeeded). An obligation is never marked
--     satisfied while it is only partly paid, or while a refund could still
--     come back. A refund returned even after that is recorded, flagged in
--     its history (obligationAlreadySettled), and owed again: what is owed
--     always comes from the refunds, never from the obligation's status.
--   * A MANUAL_EXTERNAL settlement (S5c) is refused for a Stripe payment:
--     its refund goes back to the original card, through Stripe.
--   * An order cannot be closed while a refund of its payment is still in
--     flight (REQUESTED, PENDING, UNKNOWN): its outcome must be known first.
--
-- Permissions: the new tenant permission orders.refund is granted to every
-- business's built-in administrator role (the business owner), and a new
-- built-in access level "Refund Manager" (orders.view + orders.refund) is
-- created for every business, for the owner to assign per location. No other
-- role is touched; CENTERIVO platform operators are not business staff and
-- gain nothing.
--
-- ADDITIVE ONLY: two tables, their indexes, constraints, functions and
-- triggers, two triggers on existing tables, and the role backfill. No
-- existing row changes. One DO block (atomic), read-only preflight first,
-- lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261124090000_payment_refunds.down.sql.

DO $payment_refunds$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Payment refunds refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"OrderRefundObligation"') IS NULL OR to_regclass('"OrderClosure"') IS NULL THEN
    RAISE EXCEPTION 'Payment refunds refused: the order closure foundation (R1 / S5a) is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"PaymentRefund"') IS NOT NULL OR to_regclass('"PaymentRefundEvent"') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment refunds refused: table "PaymentRefund" or "PaymentRefundEvent" already exists. Nothing was changed.';
  END IF;
  IF to_regprocedure('payment_refund_guard()') IS NOT NULL
     OR to_regprocedure('payment_refund_history()') IS NOT NULL
     OR to_regprocedure('payment_refund_event_guard()') IS NOT NULL
     OR to_regprocedure('payment_refund_event_insert_guard()') IS NOT NULL
     OR to_regprocedure('order_refund_obligation_refund_evidence()') IS NOT NULL
     OR to_regprocedure('order_closure_refund_in_flight()') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment refunds refused: a payment refund function already exists. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "InternalRole" WHERE "key" = 'refund-manager') THEN
    RAISE EXCEPTION 'Payment refunds refused: a "refund-manager" role already exists. Nothing was changed.';
  END IF;

  CREATE TABLE "PaymentRefund" (
      "id" TEXT NOT NULL,
      "orderId" TEXT NOT NULL,
      "paymentAttemptId" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "providerAccountId" TEXT NOT NULL,
      "origin" TEXT NOT NULL,
      "amountMinorUnits" INTEGER NOT NULL,
      "currency" TEXT NOT NULL,
      "reasonCode" TEXT,
      "note" TEXT,
      "requestedByInternalUserId" TEXT,
      "idempotencyKey" TEXT,
      "status" TEXT NOT NULL,
      "providerRefundId" TEXT,
      "providerFailureReason" TEXT,
      "firstSentAt" TIMESTAMP(3),
      "succeededAt" TIMESTAMP(3),
      "failedAfterSuccessAt" TIMESTAMP(3),
      "lateFailureReviewedAt" TIMESTAMP(3),
      "lateFailureReviewedByInternalUserId" TEXT,
      "lateFailureReviewNote" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "PaymentRefund_provider_check" CHECK ("provider" = 'stripe'),
      CONSTRAINT "PaymentRefund_providerAccountId_check"
        CHECK ("providerAccountId" ~ '^acct_[A-Za-z0-9]{1,100}$'),
      CONSTRAINT "PaymentRefund_amount_check" CHECK ("amountMinorUnits" > 0),
      CONSTRAINT "PaymentRefund_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
      CONSTRAINT "PaymentRefund_status_check" CHECK ("status" IN (
        'REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'UNKNOWN',
        'NOT_CREATED', 'FAILED_AFTER_SUCCESS')),
      CONSTRAINT "PaymentRefund_providerRefundId_check"
        CHECK ("providerRefundId" IS NULL OR "providerRefundId" ~ '^re_[A-Za-z0-9]{1,100}$'),
      CONSTRAINT "PaymentRefund_providerFailureReason_check"
        CHECK ("providerFailureReason" IS NULL
          OR ("providerFailureReason" ~ '^[a-z][a-z0-9_]{0,63}$'
              AND "status" IN ('FAILED', 'CANCELED', 'FAILED_AFTER_SUCCESS'))),
      -- Who asked, and why: a CENTERIVO refund always names its staff member,
      -- reason and key; one made outside CENTERIVO names none of them, and is
      -- only ever recorded from what Stripe reports (its id is known).
      CONSTRAINT "PaymentRefund_origin_check" CHECK (
        ("origin" = 'CENTERIVO'
          AND "requestedByInternalUserId" IS NOT NULL
          AND "reasonCode" IS NOT NULL AND "reasonCode" ~ '^[A-Z][A-Z0-9_]{1,63}$'
          -- One key per operation, derived from its own id.
          AND "idempotencyKey" = 'centerivo-refund:' || "id")
        OR ("origin" = 'EXTERNAL'
          AND "requestedByInternalUserId" IS NULL AND "reasonCode" IS NULL
          AND "note" IS NULL AND "idempotencyKey" IS NULL AND "firstSentAt" IS NULL
          AND "providerRefundId" IS NOT NULL
          AND "status" NOT IN ('REQUESTED', 'UNKNOWN', 'NOT_CREATED'))
      ),
      -- Internal note: 1-500 characters, no control characters.
      CONSTRAINT "PaymentRefund_note_check"
        CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" !~ '[[:cntrl:]]')),
      -- A status Stripe reported carries Stripe's refund id; "never created"
      -- carries none.
      CONSTRAINT "PaymentRefund_status_evidence_check" CHECK (
        ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'FAILED_AFTER_SUCCESS')
          AND "providerRefundId" IS NOT NULL)
        OR ("status" = 'NOT_CREATED' AND "providerRefundId" IS NULL)
        OR "status" IN ('REQUESTED', 'UNKNOWN')
      ),
      CONSTRAINT "PaymentRefund_success_times_check" CHECK (
        ("status" = 'SUCCEEDED' AND "succeededAt" IS NOT NULL AND "failedAfterSuccessAt" IS NULL)
        OR ("status" = 'FAILED_AFTER_SUCCESS' AND "succeededAt" IS NOT NULL AND "failedAfterSuccessAt" IS NOT NULL)
        OR ("status" NOT IN ('SUCCEEDED', 'FAILED_AFTER_SUCCESS')
          AND "succeededAt" IS NULL AND "failedAfterSuccessAt" IS NULL)
      ),
      -- A review is recorded only for a refund whose money came back, all of
      -- it at once.
      CONSTRAINT "PaymentRefund_late_failure_review_check" CHECK (
        ("lateFailureReviewedAt" IS NULL AND "lateFailureReviewedByInternalUserId" IS NULL
          AND "lateFailureReviewNote" IS NULL)
        OR ("status" = 'FAILED_AFTER_SUCCESS'
          AND "lateFailureReviewedAt" IS NOT NULL AND "lateFailureReviewedByInternalUserId" IS NOT NULL
          AND "lateFailureReviewNote" IS NOT NULL
          AND char_length("lateFailureReviewNote") BETWEEN 1 AND 500
          AND "lateFailureReviewNote" !~ '[[:cntrl:]]')
      )
  );

  CREATE UNIQUE INDEX "PaymentRefund_tenantId_id_key" ON "PaymentRefund"("tenantId", "id");
  CREATE UNIQUE INDEX "PaymentRefund_idempotencyKey_key" ON "PaymentRefund"("idempotencyKey");
  -- One Stripe refund is recorded at most once, anywhere.
  CREATE UNIQUE INDEX "PaymentRefund_providerRefundId_key" ON "PaymentRefund"("providerRefundId");
  CREATE INDEX "PaymentRefund_tenantId_idx" ON "PaymentRefund"("tenantId");
  CREATE INDEX "PaymentRefund_paymentAttemptId_idx" ON "PaymentRefund"("paymentAttemptId");
  CREATE INDEX "PaymentRefund_orderId_idx" ON "PaymentRefund"("orderId");
  CREATE INDEX "PaymentRefund_requestedByInternalUserId_idx" ON "PaymentRefund"("requestedByInternalUserId");
  CREATE INDEX "PaymentRefund_lateFailureReviewedByInternalUserId_idx" ON "PaymentRefund"("lateFailureReviewedByInternalUserId");
  -- What still needs an answer or a person (M5c recovery, support).
  CREATE INDEX "PaymentRefund_unsettled_idx" ON "PaymentRefund"("tenantId", "createdAt")
    WHERE "status" IN ('REQUESTED', 'PENDING', 'UNKNOWN', 'FAILED_AFTER_SUCCESS');

  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_requestedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "requestedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_lateFailureReviewedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "lateFailureReviewedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "PaymentRefund_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PaymentRefund"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  CREATE TABLE "PaymentRefundEvent" (
      "id" TEXT NOT NULL,
      "refundId" TEXT NOT NULL,
      "action" TEXT NOT NULL,
      "fromStatus" TEXT,
      "toStatus" TEXT,
      "actorKind" TEXT NOT NULL,
      "actorInternalUserId" TEXT,
      "actorPlatformOperatorId" TEXT,
      "detail" JSONB,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "PaymentRefundEvent_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "PaymentRefundEvent_action_check" CHECK ("action" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
      -- A staff member is a business user; a platform operator is CENTERIVO
      -- support (an id from the platform plane, never a foreign key); the
      -- system is neither.
      CONSTRAINT "PaymentRefundEvent_actor_check" CHECK (
        ("actorKind" = 'SYSTEM' AND "actorInternalUserId" IS NULL AND "actorPlatformOperatorId" IS NULL)
        OR ("actorKind" = 'STAFF' AND "actorInternalUserId" IS NOT NULL AND "actorPlatformOperatorId" IS NULL)
        OR ("actorKind" = 'PLATFORM' AND "actorInternalUserId" IS NULL
          AND "actorPlatformOperatorId" IS NOT NULL AND char_length("actorPlatformOperatorId") BETWEEN 1 AND 100)
      ),
      -- A small machine-readable note (codes, amounts): never a free-text or
      -- personal field.
      CONSTRAINT "PaymentRefundEvent_detail_check"
        CHECK ("detail" IS NULL OR (jsonb_typeof("detail") = 'object' AND octet_length("detail"::text) <= 2000))
  );

  CREATE UNIQUE INDEX "PaymentRefundEvent_tenantId_id_key" ON "PaymentRefundEvent"("tenantId", "id");
  CREATE INDEX "PaymentRefundEvent_refundId_createdAt_idx" ON "PaymentRefundEvent"("refundId", "createdAt");
  CREATE INDEX "PaymentRefundEvent_tenantId_idx" ON "PaymentRefundEvent"("tenantId");
  CREATE INDEX "PaymentRefundEvent_actorInternalUserId_idx" ON "PaymentRefundEvent"("actorInternalUserId");

  ALTER TABLE "PaymentRefundEvent" ADD CONSTRAINT "PaymentRefundEvent_tenantId_refundId_fkey" FOREIGN KEY ("tenantId", "refundId") REFERENCES "PaymentRefund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefundEvent" ADD CONSTRAINT "PaymentRefundEvent_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentRefundEvent" ADD CONSTRAINT "PaymentRefundEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  -- The refund rules (see the header). BEFORE INSERT OR UPDATE OR DELETE.
  CREATE FUNCTION "payment_refund_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $guard$
  DECLARE
    attempt record;
    order_attempt text;
    order_status text;
    reserved bigint;
    proven bigint;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'A payment refund is never deleted (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- The capacity checks below lock the payment row and then count what
    -- was committed before them. That is only sound when each statement sees
    -- the latest committed data: READ COMMITTED, the default. REPEATABLE READ
    -- and SERIALIZABLE count from the transaction's snapshot (a row lock alone
    -- raises no serialisation conflict against a READ COMMITTED writer), so
    -- both are refused.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'Payment refunds are written only at READ COMMITTED isolation.'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF TG_OP = 'INSERT' THEN
      -- The payment row is locked FIRST: concurrent refunds of one payment
      -- are serialised here, and each sees every refund committed before it.
      SELECT pa.provider, pa.status::text AS status, pa."paymentState", pa."providerReference",
             pa."providerAccountId", pa.amount, upper(pa.currency) AS currency,
             pa."reconciliationRequired"
        INTO attempt
        FROM "PaymentAttempt" pa
       WHERE pa.id = NEW."paymentAttemptId" AND pa."tenantId" = NEW."tenantId"
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'A payment refund needs its payment (refund %).', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT o."paymentAttemptId", o.status::text INTO order_attempt, order_status
        FROM "Order" o WHERE o.id = NEW."orderId" AND o."tenantId" = NEW."tenantId";
      IF order_attempt IS DISTINCT FROM NEW."paymentAttemptId" THEN
        RAISE EXCEPTION 'A payment refund must be for the order''s own payment (refund %).', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- Only a CONFIRMED Stripe payment, on the account it was made on, in
      -- its currency.
      IF attempt.provider <> 'stripe'
         OR attempt.status <> 'SUCCEEDED'
         OR (attempt."paymentState" IS NOT NULL AND attempt."paymentState" <> 'SUCCEEDED')
         OR attempt."providerReference" IS NULL
         OR attempt."providerReference" !~ '^pi_[A-Za-z0-9]{1,100}$' THEN
        RAISE EXCEPTION 'A payment refund needs a confirmed Stripe payment (refund %).', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF attempt."providerAccountId" IS DISTINCT FROM NEW."providerAccountId" THEN
        RAISE EXCEPTION 'A payment refund is made only on the account the payment was made on (refund %).', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF attempt.currency IS DISTINCT FROM NEW.currency THEN
        RAISE EXCEPTION 'A payment refund is in the payment''s own currency (refund %).', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- Times are UTC from the database clock, whatever the session's
      -- time zone.
      NEW."createdAt" := now() AT TIME ZONE 'UTC';

      IF NEW.origin = 'CENTERIVO' THEN
        IF NEW.status <> 'REQUESTED' OR NEW."providerRefundId" IS NOT NULL OR NEW."firstSentAt" IS NOT NULL THEN
          RAISE EXCEPTION 'A CENTERIVO refund is recorded REQUESTED, before Stripe is asked (refund %).', NEW.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        -- A completed order (a refund of what was served), or a closed one
        -- (its refund obligation). An order still in progress is cancelled
        -- instead, so a refund and a closure can never race.
        IF order_status NOT IN ('COMPLETED', 'REJECTED', 'CANCELLED') THEN
          RAISE EXCEPTION 'Only a completed, rejected or cancelled order is refunded (refund %).', NEW.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF attempt."reconciliationRequired" THEN
          RAISE EXCEPTION 'A payment that needs reconciliation is not refunded (refund %).', NEW.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF EXISTS (
          SELECT 1 FROM "PaymentRefund" r
           WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
             AND r.status = 'FAILED_AFTER_SUCCESS' AND r."lateFailureReviewedAt" IS NULL
        ) THEN
          RAISE EXCEPTION 'A refund of this payment came back and must be reviewed before another is made (refund %).', NEW.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        SELECT COALESCE(sum(r."amountMinorUnits"), 0) INTO reserved
          FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status IN ('REQUESTED', 'PENDING', 'UNKNOWN', 'SUCCEEDED');
        IF reserved + NEW."amountMinorUnits" > attempt.amount THEN
          RAISE EXCEPTION 'A payment refund may not exceed what is left to refund (refund %: % requested, % of % already refunded or in progress).',
            NEW.id, NEW."amountMinorUnits", reserved, attempt.amount
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        -- Made outside CENTERIVO: recorded as Stripe reports it. Only what
        -- Stripe has accepted counts here (a CENTERIVO request still waiting
        -- for its answer may turn out never to have happened); Stripe itself
        -- never lets refunds exceed the charge. It starts in a state Stripe
        -- reported (never already returned, never already reviewed); its
        -- success time is the database's.
        IF NEW.status NOT IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED')
           OR NEW."failedAfterSuccessAt" IS NOT NULL
           OR NEW."lateFailureReviewedAt" IS NOT NULL
           OR NEW."lateFailureReviewedByInternalUserId" IS NOT NULL
           OR NEW."lateFailureReviewNote" IS NOT NULL THEN
          RAISE EXCEPTION 'A refund made outside CENTERIVO is recorded PENDING, SUCCEEDED, FAILED or CANCELED, as Stripe reports it (refund %).', NEW.id
            USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.status = 'SUCCEEDED' THEN
          NEW."succeededAt" := now() AT TIME ZONE 'UTC';
        ELSE
          NEW."succeededAt" := NULL;
        END IF;
        SELECT COALESCE(sum(r."amountMinorUnits"), 0) INTO proven
          FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status IN ('PENDING', 'SUCCEEDED');
        IF NEW.status IN ('PENDING', 'SUCCEEDED') AND proven + NEW."amountMinorUnits" > attempt.amount THEN
          RAISE EXCEPTION 'Recorded refunds of a payment cannot exceed what was charged (refund %).', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END IF;

    -- UPDATE: identity never changes.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
       OR NEW.provider IS DISTINCT FROM OLD.provider
       OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
       OR NEW.origin IS DISTINCT FROM OLD.origin
       OR NEW."amountMinorUnits" IS DISTINCT FROM OLD."amountMinorUnits"
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode"
       OR NEW.note IS DISTINCT FROM OLD.note
       OR NEW."requestedByInternalUserId" IS DISTINCT FROM OLD."requestedByInternalUserId"
       OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'A payment refund''s identity never changes (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Written once.
    IF OLD."providerRefundId" IS NOT NULL AND NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId" THEN
      RAISE EXCEPTION 'A payment refund''s Stripe refund id cannot change once recorded (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."firstSentAt" IS NOT NULL AND NEW."firstSentAt" IS DISTINCT FROM OLD."firstSentAt" THEN
      RAISE EXCEPTION 'When a refund was first sent to Stripe cannot change (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."firstSentAt" IS NOT NULL AND OLD."firstSentAt" IS NULL
       -- (a minute's tolerance for the application's clock and the column's
       -- millisecond rounding)
       AND (OLD.origin <> 'CENTERIVO'
            OR NEW."firstSentAt" > (now() AT TIME ZONE 'UTC') + interval '1 minute') THEN
      RAISE EXCEPTION 'A refund''s first sending is recorded by CENTERIVO, never in the future (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."lateFailureReviewedAt" IS NOT NULL AND (
         NEW."lateFailureReviewedAt" IS DISTINCT FROM OLD."lateFailureReviewedAt"
         OR NEW."lateFailureReviewedByInternalUserId" IS DISTINCT FROM OLD."lateFailureReviewedByInternalUserId"
         OR NEW."lateFailureReviewNote" IS DISTINCT FROM OLD."lateFailureReviewNote") THEN
      RAISE EXCEPTION 'A late refund failure is reviewed only once (refund %).', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."lateFailureReviewedAt" IS NOT NULL AND OLD."lateFailureReviewedAt" IS NULL THEN
      NEW."lateFailureReviewedAt" := now() AT TIME ZONE 'UTC';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      -- Every status change takes the payment's lock: it is serialised with
      -- new refunds of the payment and with the settlement of its obligation
      -- (order_refund_obligation_refund_evidence takes the same lock), so an
      -- obligation can never be settled on a refund whose money is coming
      -- back at that moment.
      PERFORM 1 FROM "PaymentAttempt" pa
        WHERE pa.id = NEW."paymentAttemptId" AND pa."tenantId" = NEW."tenantId" FOR UPDATE;
      IF NOT ((OLD.status, NEW.status) IN (
           ('REQUESTED', 'PENDING'), ('REQUESTED', 'SUCCEEDED'), ('REQUESTED', 'FAILED'),
           ('REQUESTED', 'CANCELED'), ('REQUESTED', 'UNKNOWN'), ('REQUESTED', 'NOT_CREATED'),
           ('UNKNOWN', 'PENDING'), ('UNKNOWN', 'SUCCEEDED'), ('UNKNOWN', 'FAILED'),
           ('UNKNOWN', 'CANCELED'), ('UNKNOWN', 'NOT_CREATED'),
           ('PENDING', 'SUCCEEDED'), ('PENDING', 'FAILED'), ('PENDING', 'CANCELED'),
           ('SUCCEEDED', 'FAILED_AFTER_SUCCESS'))) THEN
        RAISE EXCEPTION 'A payment refund cannot move from % to % (refund %).', OLD.status, NEW.status, OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW.status = 'NOT_CREATED' AND OLD."providerRefundId" IS NOT NULL THEN
        RAISE EXCEPTION 'A refund Stripe gave an id to was created (refund %).', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- "Never created" gives the amount back, so it is never inferred from a
      -- timeout: only for a request never sent, or one first sent more than
      -- 24 hours ago (past Stripe's idempotency window, when the same key can
      -- no longer bring the refund back and a read-back of the payment's
      -- refunds is final).
      IF NEW.status = 'NOT_CREATED' AND OLD."firstSentAt" IS NOT NULL
         AND OLD."firstSentAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours' THEN
        RAISE EXCEPTION 'A refund sent to Stripe less than 24 hours ago cannot be recorded as never created (refund %).', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- The database's own clock, never the application's.
      IF NEW.status = 'SUCCEEDED' THEN
        NEW."succeededAt" := now() AT TIME ZONE 'UTC';
      ELSIF NEW.status = 'FAILED_AFTER_SUCCESS' THEN
        NEW."succeededAt" := OLD."succeededAt";
        NEW."failedAfterSuccessAt" := now() AT TIME ZONE 'UTC';
      END IF;
      -- What Stripe accepted can never exceed what was charged.
      IF NEW.status IN ('PENDING', 'SUCCEEDED') AND OLD.status NOT IN ('PENDING', 'SUCCEEDED') THEN
        SELECT COALESCE(sum(r."amountMinorUnits"), 0) INTO proven
          FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status IN ('PENDING', 'SUCCEEDED') AND r.id <> NEW.id;
        IF proven + NEW."amountMinorUnits" > (
             SELECT pa.amount FROM "PaymentAttempt" pa
              WHERE pa.id = NEW."paymentAttemptId" AND pa."tenantId" = NEW."tenantId") THEN
          RAISE EXCEPTION 'Recorded refunds of a payment cannot exceed what was charged (refund %).', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSE
      -- No status change: the times stay as they are.
      IF NEW."succeededAt" IS DISTINCT FROM OLD."succeededAt"
         OR NEW."failedAfterSuccessAt" IS DISTINCT FROM OLD."failedAfterSuccessAt" THEN
        RAISE EXCEPTION 'A refund''s success and failure times are set only by its status (refund %).', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELED', 'NOT_CREATED', 'FAILED_AFTER_SUCCESS')
         AND (NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId"
              OR NEW."providerFailureReason" IS DISTINCT FROM OLD."providerFailureReason") THEN
        RAISE EXCEPTION 'A settled payment refund never changes (refund %).', OLD.id
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "PaymentRefund_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaymentRefund"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_guard"();

  -- The history the database writes itself: creation, every status change
  -- and a late-failure review.
  CREATE FUNCTION "payment_refund_history"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $history$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO "PaymentRefundEvent"
        ("id", "tenantId", "refundId", "action", "fromStatus", "toStatus", "actorKind", "actorInternalUserId", "detail", "createdAt")
      VALUES (gen_random_uuid()::text, NEW."tenantId", NEW.id, 'CREATED', NULL, NEW.status,
              CASE WHEN NEW.origin = 'CENTERIVO' THEN 'STAFF' ELSE 'SYSTEM' END,
              NEW."requestedByInternalUserId",
              jsonb_build_object('origin', NEW.origin, 'amountMinorUnits', NEW."amountMinorUnits", 'currency', NEW.currency),
              clock_timestamp() AT TIME ZONE 'UTC');
      RETURN NULL;
    END IF;
    IF NEW."providerRefundId" IS NOT NULL AND OLD."providerRefundId" IS NULL
       AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      INSERT INTO "PaymentRefundEvent"
        ("id", "tenantId", "refundId", "action", "fromStatus", "toStatus", "actorKind", "createdAt")
      VALUES (gen_random_uuid()::text, NEW."tenantId", NEW.id, 'PROVIDER_REFUND_ID_RECORDED', NULL, NULL, 'SYSTEM',
              clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO "PaymentRefundEvent"
        ("id", "tenantId", "refundId", "action", "fromStatus", "toStatus", "actorKind", "detail", "createdAt")
      VALUES (gen_random_uuid()::text, NEW."tenantId", NEW.id, 'STATUS_CHANGED', OLD.status, NEW.status, 'SYSTEM',
              NULLIF(jsonb_strip_nulls(jsonb_build_object(
                'failureReason', NEW."providerFailureReason",
                -- A refund whose money came back after its order's obligation
                -- was already recorded settled: what is owed again comes from
                -- the refunds (the settled obligation cannot change), and
                -- people must look.
                'obligationAlreadySettled', CASE WHEN NEW.status = 'FAILED_AFTER_SUCCESS' AND EXISTS (
                    SELECT 1 FROM "OrderRefundObligation" ob
                     WHERE ob."tenantId" = NEW."tenantId" AND ob."paymentAttemptId" = NEW."paymentAttemptId"
                       AND ob.status = 'REFUNDED') THEN true END)), '{}'::jsonb),
              clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    IF NEW."lateFailureReviewedAt" IS NOT NULL AND OLD."lateFailureReviewedAt" IS NULL THEN
      INSERT INTO "PaymentRefundEvent"
        ("id", "tenantId", "refundId", "action", "fromStatus", "toStatus", "actorKind", "actorInternalUserId", "createdAt")
      VALUES (gen_random_uuid()::text, NEW."tenantId", NEW.id, 'LATE_FAILURE_REVIEWED', NEW.status, NEW.status, 'STAFF',
              NEW."lateFailureReviewedByInternalUserId", clock_timestamp() AT TIME ZONE 'UTC');
    END IF;
    RETURN NULL;
  END
  $history$;

  CREATE TRIGGER "PaymentRefund_history" AFTER INSERT OR UPDATE ON "PaymentRefund"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_history"();

  -- The history is append-only.
  CREATE FUNCTION "payment_refund_event_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $event_guard$
  BEGIN
    RAISE EXCEPTION 'Payment refund history is append-only.'
      USING ERRCODE = 'restrict_violation';
  END
  $event_guard$;

  CREATE TRIGGER "PaymentRefundEvent_append_only" BEFORE UPDATE OR DELETE ON "PaymentRefundEvent"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_event_guard"();

  -- The entries the database writes (creation, status changes, a review)
  -- come ONLY from payment_refund_history: an attributed entry the
  -- application adds can never pose as one, and never names a status.
  CREATE FUNCTION "payment_refund_event_insert_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $event_insert$
  BEGIN
    IF pg_trigger_depth() < 2 AND (
         NEW.action IN ('CREATED', 'STATUS_CHANGED', 'LATE_FAILURE_REVIEWED', 'PROVIDER_REFUND_ID_RECORDED')
         OR NEW."fromStatus" IS NOT NULL OR NEW."toStatus" IS NOT NULL) THEN
      RAISE EXCEPTION 'Payment refund history entry % is written only by the database.', NEW.action
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $event_insert$;

  CREATE TRIGGER "PaymentRefundEvent_insert_guard" BEFORE INSERT ON "PaymentRefundEvent"
    FOR EACH ROW EXECUTE FUNCTION "payment_refund_event_insert_guard"();
  CREATE TRIGGER "PaymentRefundEvent_no_truncate" BEFORE TRUNCATE ON "PaymentRefundEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION "payment_refund_event_guard"();
  CREATE TRIGGER "PaymentRefund_no_truncate" BEFORE TRUNCATE ON "PaymentRefund"
    FOR EACH STATEMENT EXECUTE FUNCTION "payment_refund_event_guard"();

  -- Refund obligations (additive; the S5a / S5b guards are unchanged).
  CREATE FUNCTION "order_refund_obligation_refund_evidence"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $evidence$
  DECLARE
    attempt_provider text;
    covered bigint;
  BEGIN
    -- The payment's lock, the same one every refund status change takes: no
    -- refund of it can change (a late failure arriving) while this
    -- settlement is checked, and the checks below see the latest refunds.
    SELECT pa.provider INTO attempt_provider FROM "PaymentAttempt" pa
     WHERE pa.id = NEW."paymentAttemptId" AND pa."tenantId" = NEW."tenantId"
     FOR UPDATE;
    IF NEW."settlementMethod" = 'MANUAL_EXTERNAL' AND attempt_provider = 'stripe' THEN
      RAISE EXCEPTION 'OrderRefundObligation % is for a Stripe payment: it is refunded to the original card through Stripe, never settled manually.', NEW.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."settlementMethod" = 'PROCESSOR' THEN
      IF NOT EXISTS (
        SELECT 1 FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r."providerRefundId" = NEW."processorRefundId" AND r.status = 'SUCCEEDED'
      ) THEN
        RAISE EXCEPTION 'OrderRefundObligation % can be settled only with a succeeded refund of its own payment.', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status IN ('REQUESTED', 'PENDING', 'UNKNOWN')
      ) THEN
        RAISE EXCEPTION 'OrderRefundObligation % cannot be settled while a refund of its payment is still in progress.', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      SELECT COALESCE(sum(r."amountMinorUnits"), 0) INTO covered
        FROM "PaymentRefund" r
       WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
         AND r.status = 'SUCCEEDED';
      IF covered < NEW."amountMinorUnits" THEN
        RAISE EXCEPTION 'OrderRefundObligation % is only partly refunded (% of %): it is not settled.',
          NEW.id, covered, NEW."amountMinorUnits"
          USING ERRCODE = 'restrict_violation';
      END IF;
      IF EXISTS (
        SELECT 1 FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status = 'SUCCEEDED'
           AND r."succeededAt" > (now() AT TIME ZONE 'UTC') - interval '30 days'
      ) THEN
        RAISE EXCEPTION 'OrderRefundObligation % cannot be settled yet: a refund of its payment succeeded less than 30 days ago and could still come back.', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
      -- A refund whose money came back must be reviewed first.
      IF EXISTS (
        SELECT 1 FROM "PaymentRefund" r
         WHERE r."tenantId" = NEW."tenantId" AND r."paymentAttemptId" = NEW."paymentAttemptId"
           AND r.status = 'FAILED_AFTER_SUCCESS' AND r."lateFailureReviewedAt" IS NULL
      ) THEN
        RAISE EXCEPTION 'OrderRefundObligation % cannot be settled while a returned refund of its payment is unreviewed.', NEW.id
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    RETURN NEW;
  END
  $evidence$;

  CREATE TRIGGER "OrderRefundObligation_refund_evidence" BEFORE UPDATE ON "OrderRefundObligation"
    FOR EACH ROW WHEN (NEW."status" = 'REFUNDED' AND OLD."status" IS DISTINCT FROM 'REFUNDED')
    EXECUTE FUNCTION "order_refund_obligation_refund_evidence"();

  -- An order is not closed while a refund of its payment is still in flight.
  CREATE FUNCTION "order_closure_refund_in_flight"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $in_flight$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM "PaymentRefund" r
        JOIN "Order" o ON o."tenantId" = r."tenantId" AND o."paymentAttemptId" = r."paymentAttemptId"
       WHERE o.id = NEW."orderId" AND o."tenantId" = NEW."tenantId"
         AND r.status IN ('REQUESTED', 'PENDING', 'UNKNOWN')
    ) THEN
      RAISE EXCEPTION 'Order % has a card refund still in progress: it cannot be closed until its outcome is known.', NEW."orderId"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $in_flight$;

  CREATE TRIGGER "OrderClosure_refund_in_flight" BEFORE INSERT ON "OrderClosure"
    FOR EACH ROW EXECUTE FUNCTION "order_closure_refund_in_flight"();

  -- Permissions. orders.refund for every business's built-in administrator
  -- role (idempotent: an existing grant is left as it is).
  INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
  SELECT r."id", 'orders.refund', r."tenantId", CURRENT_TIMESTAMP
    FROM "InternalRole" r
   WHERE r."key" = 'platform-administrator'
     AND r."isSystem" = true
  ON CONFLICT ("roleId", "permissionKey") DO NOTHING;

  -- The built-in "Refund Manager" access level for every business (the same
  -- definition as @mocha-house/contracts REFUND_MANAGER_ROLE).
  INSERT INTO "InternalRole" ("id", "key", "displayName", "description", "isSystem", "createdAt", "updatedAt", "tenantId")
  SELECT gen_random_uuid()::text, 'refund-manager', 'Refund Manager',
         'Issues card refunds for orders at assigned locations. Refunds go back to the original card only.',
         true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, t."id"
    FROM "Tenant" t;
  INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
  SELECT r."id", k.key, r."tenantId", CURRENT_TIMESTAMP
    FROM "InternalRole" r
   CROSS JOIN (VALUES ('orders.view'), ('orders.refund')) AS k(key)
   WHERE r."key" = 'refund-manager'
  ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
END
$payment_refunds$;
