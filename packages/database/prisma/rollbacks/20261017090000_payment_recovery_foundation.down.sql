-- ESP-03 PR 1 rollback for migration 20261017090000_payment_recovery_foundation.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: remove the two models and the two
-- PaymentAttempt fields from schema.prisma and ship this SQL as a NEW forward
-- migration, so every environment's history stays linear.
--
-- It removes exactly what the migration added: the two reconciliation tables
-- (with their constraints, indexes and triggers), the append-only function, and
-- PaymentAttempt."paymentState" / "fulfilmentStatus" with their CHECKs. No
-- other table is touched; PaymentAttempt "status", "reconciliationRequired"
-- and every amount are exactly as they were.
--
-- What is lost: the backfilled classifications (a stuck payment marked UNKNOWN,
-- an unfulfilled success marked NEEDS_REVIEW) and the reconciliation cases and
-- events. Those are derived from data that remains (status, reconciliationRequired,
-- missing order / card), so a re-applied migration recreates them.
--
-- The follow-up migration 20261017090100_payment_recovery_validate_checks only
-- validates two constraints this script drops; it needs no rollback of its own,
-- and this script works whether or not those constraints were ever validated.
--
-- Code coupling: once this SQL has run, an application built from the new schema
-- (whose Prisma client selects the two dropped columns) fails on every
-- PaymentAttempt query. Ship the schema revert and this SQL together, as one
-- deployment; never run it under running new code.
--
-- It REFUSES to run when anyone has worked a case — an assignee, a status other
-- than OPEN, or any event other than the migration's own OPENED event — because
-- dropping the tables would destroy that human work and its audit trail. Export
-- or finish the cases first, or drop the tables deliberately by hand.
-- One DO block, so Prisma applies it atomically.

DO $payment_recovery_foundation_rollback$
DECLARE
  worked_cases bigint;
  other_events bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public."PaymentReconciliationCase"') IS NULL
     OR to_regclass('public."PaymentReconciliationEvent"') IS NULL THEN
    RAISE EXCEPTION 'ESP-03 rollback aborted: the PaymentReconciliation tables do not exist (migration not applied?). Nothing was changed.';
  END IF;

  SELECT count(*) INTO worked_cases
    FROM "PaymentReconciliationCase"
   WHERE "assigneeInternalUserId" IS NOT NULL OR "status" <> 'OPEN';
  SELECT count(*) INTO other_events
    FROM "PaymentReconciliationEvent"
   WHERE NOT ("actorKind" = 'SYSTEM' AND "action" = 'OPENED' AND "detail" ->> 'source' = 'migration');
  IF worked_cases > 0 OR other_events > 0 THEN
    RAISE EXCEPTION 'ESP-03 rollback refused: % case(s) have been assigned or progressed and % event(s) were recorded after the migration. Dropping the tables would destroy that work and its audit trail. Nothing was changed.',
      worked_cases, other_events;
  END IF;

  DROP TRIGGER "PaymentReconciliationEvent_append_only" ON "PaymentReconciliationEvent";
  DROP TABLE "PaymentReconciliationEvent";
  DROP TABLE "PaymentReconciliationCase";
  DROP FUNCTION "reject_payment_reconciliation_event_change"();

  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_paymentState_check";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_fulfilmentStatus_check";
  ALTER TABLE "PaymentAttempt" DROP COLUMN "paymentState";
  ALTER TABLE "PaymentAttempt" DROP COLUMN "fulfilmentStatus";
END
$payment_recovery_foundation_rollback$;
