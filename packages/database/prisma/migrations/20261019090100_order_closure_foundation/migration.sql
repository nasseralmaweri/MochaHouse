-- R1 / S5a (part 2 of 3) — order closure database foundation. ADDITIVE ONLY and
-- behaviour-neutral: nothing reads or writes any of this yet. The closure writer
-- (reject / cancel, benefit reversal, refund obligation) is S5b; no API reaches the
-- new statuses, so application behaviour is identical after this migration.
--
-- What it adds
--   "OrderClosure"            one immutable row per REJECTED / CANCELLED order
--   "OrderRefundObligation"   money owed back on the external (card) payment
--   "Order"                   a trigger freezing REJECTED / CANCELLED statuses
--   "GiftCardTransaction"     CHECK + partial unique index for REDEMPTION_REVERSAL
--   "MochaBeanLedgerEntry"    CHECK for the three loyalty reversal types
--   CHECK constraints on the two existing ledgers are added NOT VALID, validated by
--   the next migration (no table scan under the lock).
--
-- Financial safety (what the database itself refuses)
--   - A refund is never "settled" silently: REFUNDED needs a settlement method and
--     time, plus the staff member who recorded it (MANUAL_EXTERNAL) or the
--     processor's refund id (PROCESSOR); every other status must carry none of
--     them; REFUNDED is terminal and the obligation's identity (order, closure,
--     payment attempt, amount, currency, tenant) can never change; it cannot be
--     deleted.
--   - OrderClosure is append-only (no UPDATE, no DELETE, no TRUNCATE) and, checked at
--     COMMIT, an Order can only BECOME REJECTED / CANCELLED together with a closure
--     whose kind equals its status, and a refund obligation must exist exactly when
--     refundDueMinorUnits > 0 — belonging to that closure, to the Order's own payment
--     attempt and currency, for exactly that amount and never more than was charged.
--   - A refund obligation moves only DUE -> PROCESSING / REFUNDED, PROCESSING ->
--     REFUNDED / FAILED, FAILED -> PROCESSING / REFUNDED; never back to DUE.
--   - Gift-card value is restored at most once per order (partial unique index) and
--     only as a positive entry tied to an order and the acting staff member.
--   - Loyalty reversals are at most one per type per order (the existing
--     (type, orderId) unique key), tied to an order and an actor, with the sign
--     fixed per type. A loyalty recovery the customer's balance could not cover is
--     recorded as OrderClosure.loyaltyShortfallBeans, never as a silent mismatch.
--   - A closed Order can never change status again.
--   - Every new row is tenant-scoped; every relationship is a composite
--     (tenantId, id) foreign key, so the database refuses a cross-business link,
--     and tenantId is immutable (reject_tenant_reassignment).
--
-- Historical data — NOTHING is rewritten. No existing row is touched; there are no
-- REJECTED / CANCELLED orders and no closure, obligation or reversal rows. The
-- preflight proves that and aborts otherwise.
--
-- Compatibility with a running, older application
--   Only new tables, new CHECKs that no existing row can violate (they constrain
--   values nothing writes), and a trigger whose WHEN clause is false for every
--   existing and every currently writable status. INSERTs/UPDATEs written by the
--   current API and worker are unaffected.
--
-- Safety
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement, so the
--     migration applies completely or not at all.
--   - Read-only preflight first; any problem aborts with nothing changed.
--   - lock_timeout 5s (local to this transaction): it fails, atomically, rather than
--     queue application traffic behind a lock it cannot get. ADD CONSTRAINT ... NOT
--     VALID and CREATE TRIGGER are metadata-only; the one partial unique index is a
--     plain CREATE INDEX (CONCURRENTLY cannot run inside a Prisma migration) over a
--     table with no matching rows, so its build is instantaneous.
--   - Requires 20261019090000_order_closure_enum_values to be committed first.
--
-- If it fails: nothing changed. Fix the reported problem, run `prisma migrate
-- resolve --rolled-back 20261019090100_order_closure_foundation`, then deploy again.
-- Rollback (never automatic):
-- prisma/rollbacks/20261019090100_order_closure_foundation.down.sql.

DO $order_closure_foundation$
DECLARE
  closed_orders bigint;
  used_ledger bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'S5a requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;
  IF to_regclass('public."Order"') IS NULL OR to_regclass('public."PaymentAttempt"') IS NULL
     OR to_regclass('public."InternalUser"') IS NULL OR to_regclass('public."GiftCardTransaction"') IS NULL
     OR to_regclass('public."MochaBeanLedgerEntry"') IS NULL THEN
    RAISE EXCEPTION 'S5a requires Order, PaymentAttempt, InternalUser, GiftCardTransaction and MochaBeanLedgerEntry. Nothing was changed.';
  END IF;
  IF to_regclass('public."OrderClosure"') IS NOT NULL OR to_regclass('public."OrderRefundObligation"') IS NOT NULL THEN
    RAISE EXCEPTION 'S5a aborted: OrderClosure or OrderRefundObligation already exists. Nothing was changed.';
  END IF;
  IF (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE (t.typname = 'OrderStatus' AND e.enumlabel IN ('REJECTED', 'CANCELLED'))
          OR (t.typname = 'GiftCardTransactionType' AND e.enumlabel = 'REDEMPTION_REVERSAL')
          OR (t.typname = 'MochaBeanEntryType'
              AND e.enumlabel IN ('REDEEM_REVERSAL', 'EARN_REVERSAL', 'BONUS_EARN_REVERSAL'))) <> 6 THEN
    RAISE EXCEPTION 'S5a requires migration 20261019090000_order_closure_enum_values. Nothing was changed.';
  END IF;

  SELECT count(*) INTO closed_orders FROM "Order" WHERE "status"::text IN ('REJECTED', 'CANCELLED');
  SELECT (SELECT count(*) FROM "GiftCardTransaction" WHERE "type"::text = 'REDEMPTION_REVERSAL')
       + (SELECT count(*) FROM "MochaBeanLedgerEntry"
           WHERE "type"::text IN ('REDEEM_REVERSAL', 'EARN_REVERSAL', 'BONUS_EARN_REVERSAL'))
    INTO used_ledger;
  IF closed_orders > 0 OR used_ledger > 0 THEN
    RAISE EXCEPTION 'S5a aborted: % closed order(s) and % reversal ledger row(s) already exist. Nothing was changed.',
      closed_orders, used_ledger;
  END IF;

  -- OrderClosure (append-only). The tables are new and empty, so their CHECKs are
  -- validated at creation.
  CREATE TABLE "OrderClosure" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromStatus" "OrderStatus" NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "actorInternalUserId" TEXT NOT NULL,
    "refundDueMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "giftCardRestoredMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "loyaltyShortfallBeans" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "OrderClosure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderClosure_kind_check"
      CHECK ("kind" IN ('REJECTED', 'CANCELLED')),
    CONSTRAINT "OrderClosure_fromStatus_check"
      CHECK (("kind" = 'REJECTED' AND "fromStatus"::text = 'RECEIVED')
          OR ("kind" = 'CANCELLED' AND "fromStatus"::text IN ('ACCEPTED', 'PREPARING', 'READY'))),
    CONSTRAINT "OrderClosure_reasonCode_check"
      CHECK ("reasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "OrderClosure_note_check"
      CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
    CONSTRAINT "OrderClosure_amounts_check"
      CHECK ("refundDueMinorUnits" >= 0 AND "giftCardRestoredMinorUnits" >= 0 AND "loyaltyShortfallBeans" >= 0)
  );

  -- OrderRefundObligation (the one mutable row of a closure).
  CREATE TABLE "OrderRefundObligation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "closureId" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "amountMinorUnits" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "settlementMethod" TEXT,
    "settlementReference" TEXT,
    "processorRefundId" TEXT,
    "settledAt" TIMESTAMP(3),
    "settledByInternalUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "OrderRefundObligation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrderRefundObligation_amount_check"
      CHECK ("amountMinorUnits" > 0),
    CONSTRAINT "OrderRefundObligation_currency_check"
      CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "OrderRefundObligation_status_check"
      CHECK ("status" IN ('DUE', 'PROCESSING', 'REFUNDED', 'FAILED')),
    CONSTRAINT "OrderRefundObligation_settlementMethod_check"
      CHECK ("settlementMethod" IS NULL OR "settlementMethod" IN ('MANUAL_EXTERNAL', 'PROCESSOR')),
    -- REFUNDED states exactly who/what settled it and when; nothing else may carry
    -- settlement data (a refund cannot be implied by a stray field).
    CONSTRAINT "OrderRefundObligation_settled_consistency_check"
      CHECK (("status" = 'REFUNDED'
              AND "settlementMethod" IS NOT NULL AND "settledAt" IS NOT NULL
              AND (("settlementMethod" = 'MANUAL_EXTERNAL'
                    AND "settledByInternalUserId" IS NOT NULL AND "processorRefundId" IS NULL)
                OR ("settlementMethod" = 'PROCESSOR'
                    AND "processorRefundId" IS NOT NULL AND "settledByInternalUserId" IS NULL)))
          OR ("status" <> 'REFUNDED'
              AND "settlementMethod" IS NULL AND "settlementReference" IS NULL
              AND "settledAt" IS NULL AND "settledByInternalUserId" IS NULL)),
    CONSTRAINT "OrderRefundObligation_processorRefundId_check"
      CHECK ("processorRefundId" IS NULL
          OR ("status" <> 'DUE' AND char_length("processorRefundId") BETWEEN 1 AND 200)),
    CONSTRAINT "OrderRefundObligation_settlementReference_check"
      CHECK ("settlementReference" IS NULL OR char_length("settlementReference") BETWEEN 1 AND 200)
  );

  CREATE UNIQUE INDEX "OrderClosure_orderId_key" ON "OrderClosure"("orderId");
  CREATE UNIQUE INDEX "OrderClosure_tenantId_id_key" ON "OrderClosure"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderClosure_tenantId_orderId_key" ON "OrderClosure"("tenantId", "orderId");
  CREATE INDEX "OrderClosure_tenantId_createdAt_idx" ON "OrderClosure"("tenantId", "createdAt");
  CREATE INDEX "OrderClosure_actorInternalUserId_idx" ON "OrderClosure"("actorInternalUserId");

  CREATE UNIQUE INDEX "OrderRefundObligation_orderId_key" ON "OrderRefundObligation"("orderId");
  CREATE UNIQUE INDEX "OrderRefundObligation_closureId_key" ON "OrderRefundObligation"("closureId");
  CREATE UNIQUE INDEX "OrderRefundObligation_tenantId_id_key" ON "OrderRefundObligation"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderRefundObligation_tenantId_orderId_key" ON "OrderRefundObligation"("tenantId", "orderId");
  CREATE UNIQUE INDEX "OrderRefundObligation_tenantId_closureId_key" ON "OrderRefundObligation"("tenantId", "closureId");
  CREATE UNIQUE INDEX "OrderRefundObligation_tenantId_processorRefundId_key" ON "OrderRefundObligation"("tenantId", "processorRefundId");
  CREATE INDEX "OrderRefundObligation_tenantId_status_idx" ON "OrderRefundObligation"("tenantId", "status");
  CREATE INDEX "OrderRefundObligation_paymentAttemptId_idx" ON "OrderRefundObligation"("paymentAttemptId");
  CREATE INDEX "OrderRefundObligation_settledByInternalUserId_idx" ON "OrderRefundObligation"("settledByInternalUserId");

  ALTER TABLE "OrderClosure" ADD CONSTRAINT "OrderClosure_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderClosure" ADD CONSTRAINT "OrderClosure_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderClosure" ADD CONSTRAINT "OrderClosure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_tenantId_closureId_fkey" FOREIGN KEY ("tenantId", "closureId") REFERENCES "OrderClosure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_tenantId_settledByInternalUserId_fkey" FOREIGN KEY ("tenantId", "settledByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "OrderClosure_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderClosure"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderRefundObligation_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderRefundObligation"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- A closure is history: it can be added, never changed or removed.
  CREATE FUNCTION "reject_order_closure_change"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'OrderClosure is append-only: % is not allowed.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END;
  $fn$;
  CREATE TRIGGER "OrderClosure_append_only" BEFORE UPDATE OR DELETE ON "OrderClosure"
    FOR EACH ROW EXECUTE FUNCTION "reject_order_closure_change"();

  -- An obligation can move through its states but never change what it IS, a
  -- REFUNDED one is frozen, and none can be deleted.
  CREATE FUNCTION "guard_order_refund_obligation_change"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'OrderRefundObligation cannot be deleted.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'REFUNDED' THEN
      RAISE EXCEPTION 'OrderRefundObligation % is REFUNDED and cannot change.', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status"
       AND NOT ((OLD."status", NEW."status") IN (
         ('DUE', 'PROCESSING'), ('DUE', 'REFUNDED'),
         ('PROCESSING', 'REFUNDED'), ('PROCESSING', 'FAILED'),
         ('FAILED', 'PROCESSING'), ('FAILED', 'REFUNDED'))) THEN
      RAISE EXCEPTION 'OrderRefundObligation % cannot move from % to %.', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."orderId" IS DISTINCT FROM OLD."orderId"
       OR NEW."closureId" IS DISTINCT FROM OLD."closureId"
       OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
       OR NEW."amountMinorUnits" IS DISTINCT FROM OLD."amountMinorUnits"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
      RAISE EXCEPTION 'OrderRefundObligation % identity is immutable.', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER "OrderRefundObligation_guard" BEFORE UPDATE OR DELETE ON "OrderRefundObligation"
    FOR EACH ROW EXECUTE FUNCTION "guard_order_refund_obligation_change"();

  -- Checked at COMMIT (the closure, the status change and the obligation are written
  -- in one transaction, in any order): the closure kind equals the Order's status,
  -- and an obligation exists exactly when money is owed, for exactly that amount.
  -- Fired by three triggers: a closure insert, an obligation insert, and an Order
  -- becoming REJECTED / CANCELLED (so a status can never close without a closure).
  CREATE FUNCTION "assert_order_closure_consistent"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  DECLARE
    v_order_id text;
    c "OrderClosure"%ROWTYPE;
    o "Order"%ROWTYPE;
    ob "OrderRefundObligation"%ROWTYPE;
    attempt_amount integer;
  BEGIN
    IF TG_TABLE_NAME = 'Order' THEN
      v_order_id := NEW."id";
    ELSE
      v_order_id := NEW."orderId";
    END IF;
    SELECT * INTO o FROM "Order" WHERE "tenantId" = NEW."tenantId" AND "id" = v_order_id;
    SELECT * INTO c FROM "OrderClosure" WHERE "tenantId" = NEW."tenantId" AND "orderId" = v_order_id;
    IF NOT FOUND THEN
      -- Only reachable from the Order trigger (an obligation cannot exist without
      -- its closure: composite foreign key).
      RAISE EXCEPTION 'Order % became % without an OrderClosure.', v_order_id, o."status"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF o."status"::text IS DISTINCT FROM c."kind" THEN
      RAISE EXCEPTION 'Order % is % but its closure says %.', v_order_id, o."status", c."kind"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT * INTO ob FROM "OrderRefundObligation" WHERE "tenantId" = c."tenantId" AND "orderId" = v_order_id;
    IF NOT FOUND THEN
      IF c."refundDueMinorUnits" > 0 THEN
        RAISE EXCEPTION 'Order % closure owes % but has no refund obligation.', v_order_id, c."refundDueMinorUnits"
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NULL;
    END IF;
    IF c."refundDueMinorUnits" = 0 THEN
      RAISE EXCEPTION 'Order % closure owes nothing but has a refund obligation.', v_order_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF ob."amountMinorUnits" <> c."refundDueMinorUnits" THEN
      RAISE EXCEPTION 'Order % closure owes % but its refund obligation is %.',
        v_order_id, c."refundDueMinorUnits", ob."amountMinorUnits"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF ob."closureId" <> c."id" THEN
      RAISE EXCEPTION 'Order % refund obligation belongs to another closure.', v_order_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF ob."paymentAttemptId" <> o."paymentAttemptId" OR ob."currency" <> o."currency" THEN
      RAISE EXCEPTION 'Order % refund obligation does not match the order''s own payment attempt and currency.', v_order_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT "amount" INTO attempt_amount FROM "PaymentAttempt"
     WHERE "tenantId" = o."tenantId" AND "id" = o."paymentAttemptId";
    IF attempt_amount IS NULL OR ob."amountMinorUnits" > attempt_amount THEN
      RAISE EXCEPTION 'Order % refund obligation % exceeds what was charged (%).',
        v_order_id, ob."amountMinorUnits", attempt_amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
  END;
  $fn$;
  CREATE CONSTRAINT TRIGGER "OrderClosure_consistent" AFTER INSERT ON "OrderClosure"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "assert_order_closure_consistent"();
  CREATE CONSTRAINT TRIGGER "OrderRefundObligation_consistent" AFTER INSERT ON "OrderRefundObligation"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "assert_order_closure_consistent"();
  CREATE CONSTRAINT TRIGGER "Order_closure_required" AFTER UPDATE OF "status" ON "Order"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW."status"::text IN ('REJECTED', 'CANCELLED') AND OLD."status" IS DISTINCT FROM NEW."status")
    EXECUTE FUNCTION "assert_order_closure_consistent"();

  -- Neither table can be emptied in one statement.
  CREATE FUNCTION "reject_order_closure_truncate"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION '% is financial history and cannot be truncated.', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END;
  $fn$;
  CREATE TRIGGER "OrderClosure_no_truncate" BEFORE TRUNCATE ON "OrderClosure"
    FOR EACH STATEMENT EXECUTE FUNCTION "reject_order_closure_truncate"();
  CREATE TRIGGER "OrderRefundObligation_no_truncate" BEFORE TRUNCATE ON "OrderRefundObligation"
    FOR EACH STATEMENT EXECUTE FUNCTION "reject_order_closure_truncate"();

  -- A rejected or cancelled order never changes status again. Every currently
  -- writable status transition leaves this trigger's WHEN clause false.
  CREATE FUNCTION "reject_closed_order_status_change"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'Order % is % and its status cannot change.', OLD."id", OLD."status"
      USING ERRCODE = 'restrict_violation';
  END;
  $fn$;
  CREATE TRIGGER "Order_closed_status_frozen" BEFORE UPDATE OF "status" ON "Order"
    FOR EACH ROW WHEN (OLD."status"::text IN ('REJECTED', 'CANCELLED') AND NEW."status" IS DISTINCT FROM OLD."status")
    EXECUTE FUNCTION "reject_closed_order_status_change"();

  -- Ledger reversals. NOT VALID: enforced for every new row at once, validated
  -- without blocking writes by the next migration (no existing row has these types).
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_redemption_reversal_check"
    CHECK ("type"::text <> 'REDEMPTION_REVERSAL'
        OR ("amountMinorUnits" > 0 AND "orderId" IS NOT NULL AND "actorInternalUserId" IS NOT NULL
            AND "operationKey" IS NULL AND "giftCardPurchaseId" IS NULL AND "reason" IS NULL)) NOT VALID;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_reversal_check"
    CHECK ("type"::text NOT IN ('REDEEM_REVERSAL', 'EARN_REVERSAL', 'BONUS_EARN_REVERSAL')
        OR ("orderId" IS NOT NULL AND "actorInternalUserId" IS NOT NULL
            AND "operationKey" IS NULL AND "reason" IS NULL
            AND (("type"::text = 'REDEEM_REVERSAL' AND "amount" > 0)
              OR ("type"::text IN ('EARN_REVERSAL', 'BONUS_EARN_REVERSAL') AND "amount" < 0)))) NOT VALID;

  -- Exactly one restoration per order (the gift-card analogue of the existing
  -- (type, orderId) key on the loyalty ledger). Prisma cannot express the WHERE
  -- predicate, so it lives here and in the GiftCardTransaction model's comment.
  CREATE UNIQUE INDEX "GiftCardTransaction_orderId_redemption_reversal_key"
    ON "GiftCardTransaction"("orderId") WHERE "type" = 'REDEMPTION_REVERSAL';
END
$order_closure_foundation$;
