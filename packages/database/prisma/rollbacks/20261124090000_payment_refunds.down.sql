-- ESP-04 M5a rollback for migration 20261124090000_payment_refunds.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without ESP-04 M5a.
--
-- It REFUSES to run while any payment refund or refund history exists: a
-- refund is money returned (or on its way back) to a customer's card, and its
-- record may never be dropped silently (an explicit, separately approved
-- archival step must come first). It also refuses while anyone is assigned
-- the "Refund Manager" access level: the owner removes those assignments
-- first. Nothing is changed when it refuses. One DO block, so it applies
-- atomically. The orders.refund grants and the built-in "Refund Manager"
-- roles are removed.

DO $payment_refunds_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"PaymentRefund"') IS NULL OR to_regclass('"PaymentRefundEvent"') IS NULL THEN
    RAISE EXCEPTION 'Payment refunds rollback refused: table "PaymentRefund" or "PaymentRefundEvent" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "PaymentRefund", "PaymentRefundEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "PaymentRefund") + (SELECT count(*) FROM "PaymentRefundEvent") INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Payment refunds rollback refused: % payment refund record(s) exist. Nothing was changed.', remaining;
  END IF;
  SELECT count(*) INTO remaining
    FROM "InternalUserRoleAssignment" a
    JOIN "InternalRole" r ON r.id = a."roleId"
   WHERE r."key" = 'refund-manager';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Payment refunds rollback refused: % "Refund Manager" assignment(s) exist. Remove them first. Nothing was changed.', remaining;
  END IF;

  DROP TRIGGER "OrderClosure_refund_in_flight" ON "OrderClosure";
  DROP FUNCTION "order_closure_refund_in_flight"();
  DROP TRIGGER "OrderRefundObligation_refund_evidence" ON "OrderRefundObligation";
  DROP FUNCTION "order_refund_obligation_refund_evidence"();

  DROP TABLE "PaymentRefundEvent";
  DROP TABLE "PaymentRefund";
  DROP FUNCTION "payment_refund_history"();
  DROP FUNCTION "payment_refund_guard"();
  DROP FUNCTION "payment_refund_event_guard"();
  DROP FUNCTION "payment_refund_event_insert_guard"();

  DELETE FROM "InternalRolePermission"
   WHERE "roleId" IN (SELECT id FROM "InternalRole" WHERE "key" = 'refund-manager');
  DELETE FROM "InternalRole" WHERE "key" = 'refund-manager';
  DELETE FROM "InternalRolePermission" WHERE "permissionKey" = 'orders.refund';
END
$payment_refunds_rollback$;
