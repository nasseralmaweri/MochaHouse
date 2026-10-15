-- R1 / S5b — database guards that must exist BEFORE any application code may
-- write REJECTED / CANCELLED (the S5a "Invariant 2" gate) and before any refund
-- can be recorded as settled. ADDITIVE ONLY: no table, column or row changes; it
-- adds two triggers and one CHECK, all of which constrain values nothing writes
-- today, so a running older application is unaffected.
--
-- 1. Invariant 2 — an Order is never BORN closed.
--    The S5a commit-time check ("Order_closure_required") fires only on
--    UPDATE OF "status", so an INSERT of an already-REJECTED / CANCELLED order
--    would skip the closure workflow entirely (no closure, no reversal, no
--    refund obligation). "Order_insert_not_closed" is a BEFORE INSERT ... FOR
--    EACH ROW trigger, which PostgreSQL fires for every inserted row whatever the
--    statement:
--      - plain INSERT and INSERT ... SELECT;
--      - INSERT ... ON CONFLICT: the BEFORE INSERT row trigger fires for the
--        proposed row before the conflict check. The DO UPDATE branch is an
--        UPDATE, so S5a's UPDATE triggers cover it (a closed row is frozen; a
--        row becoming closed needs a closure at commit);
--      - COPY ... FROM: row-level BEFORE INSERT triggers fire for every copied
--        row.
--    A closed status is reachable ONLY by updating an existing order inside the
--    closure transaction.
--
-- 2. A manual refund is never recorded without evidence.
--    "OrderRefundObligation_manual_evidence_check": a REFUNDED obligation settled
--    MANUAL_EXTERNAL must carry settlementReference (the processor / terminal
--    refund reference the staff member saw). S5a already requires the settling
--    staff member; PROCESSOR settlement already requires processorRefundId.
--    "OrderRefundObligation_settler_not_closer": the staff member who records a
--    manual refund must not be the one who closed the order (two people for a
--    card refund). S5b itself never settles anything — obligations stay DUE.
--
-- Trigger bypass (operational, see docs/operations/order-closure.md): a
-- superuser can SET session_replication_role = replica, and a table OWNER can
-- ALTER TABLE ... DISABLE TRIGGER. The application role must be neither for
-- these guards to be guarantees rather than conventions.
--
-- Safety: one DO block (atomic), read-only preflight first, lock_timeout 5s.
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on "Order" briefly (metadata only).
-- The CHECK is added and validated in the same statement block: ADD CONSTRAINT
-- already holds an exclusive lock, and the preflight proves no REFUNDED row exists.
--
-- If it fails: nothing changed. Fix the reported problem, run `prisma migrate
-- resolve --rolled-back 20261020090000_order_closure_writer_guards`, then deploy
-- again. Rollback (never automatic):
-- prisma/rollbacks/20261020090000_order_closure_writer_guards.down.sql.

DO $order_closure_writer_guards$
DECLARE
  closed_orders bigint;
  settled bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public."OrderClosure"') IS NULL
     OR to_regclass('public."OrderRefundObligation"') IS NULL
     OR to_regprocedure('public.assert_order_closure_consistent()') IS NULL THEN
    RAISE EXCEPTION 'S5b requires the S5a order closure foundation (20261019090100). Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'public."Order"'::regclass AND tgname = 'Order_insert_not_closed') THEN
    RAISE EXCEPTION 'S5b aborted: trigger Order_insert_not_closed already exists. Nothing was changed.';
  END IF;

  -- Every closed order must already have its closure (S5a guaranteed this for
  -- updates; an order INSERTED closed before this guard would not).
  SELECT count(*) INTO closed_orders
    FROM "Order" o
   WHERE o."status"::text IN ('REJECTED', 'CANCELLED')
     AND NOT EXISTS (SELECT 1 FROM "OrderClosure" c
                      WHERE c."tenantId" = o."tenantId" AND c."orderId" = o."id"
                        AND c."kind" = o."status"::text);
  SELECT count(*) INTO settled FROM "OrderRefundObligation" WHERE "status" = 'REFUNDED';
  IF closed_orders > 0 OR settled > 0 THEN
    RAISE EXCEPTION 'S5b aborted: % closed order(s) without a matching closure and % settled refund obligation(s) exist. Nothing was changed.',
      closed_orders, settled;
  END IF;

  CREATE FUNCTION "reject_closed_order_insert"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
  BEGIN
    RAISE EXCEPTION 'Order % cannot be created %: an order is closed only by the rejection / cancellation workflow.',
      NEW."id", NEW."status"
      USING ERRCODE = 'restrict_violation';
  END;
  $fn$;
  CREATE TRIGGER "Order_insert_not_closed" BEFORE INSERT ON "Order"
    FOR EACH ROW WHEN (NEW."status"::text IN ('REJECTED', 'CANCELLED'))
    EXECUTE FUNCTION "reject_closed_order_insert"();

  ALTER TABLE "OrderRefundObligation" ADD CONSTRAINT "OrderRefundObligation_manual_evidence_check"
    CHECK ("status" <> 'REFUNDED' OR "settlementMethod" IS DISTINCT FROM 'MANUAL_EXTERNAL'
           OR btrim(coalesce("settlementReference", '')) <> '');

  CREATE FUNCTION "reject_self_settled_order_refund"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
  DECLARE
    closer text;
  BEGIN
    SELECT "actorInternalUserId" INTO closer FROM "OrderClosure"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."closureId";
    IF closer IS NOT NULL AND closer = NEW."settledByInternalUserId" THEN
      RAISE EXCEPTION 'OrderRefundObligation % must be settled by someone other than the staff member who closed the order.', NEW."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END;
  $fn$;
  CREATE TRIGGER "OrderRefundObligation_settler_not_closer" BEFORE UPDATE ON "OrderRefundObligation"
    FOR EACH ROW WHEN (NEW."status" = 'REFUNDED' AND NEW."settlementMethod" = 'MANUAL_EXTERNAL'
                       AND OLD."status" IS DISTINCT FROM 'REFUNDED')
    EXECUTE FUNCTION "reject_self_settled_order_refund"();
END
$order_closure_writer_guards$;
