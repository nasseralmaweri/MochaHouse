-- R1 / S4a (part 2) — validate the CHECK constraints that
-- 20261018090000_notification_reliability_foundation added NOT VALID.
--
-- Why a separate migration: the foundation migration holds an ACCESS EXCLUSIVE
-- lock on "OutboxEvent" and "NotificationDelivery" (from ADD COLUMN) until it
-- commits, so validating there would scan the tables under that lock. VALIDATE
-- CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock — reads AND writes
-- continue — so it runs here, in its own transaction.
--
-- Nothing changes in the data and no new rule is introduced: the constraints
-- were already enforced for every new and updated row; this proves the rows that
-- existed before them comply. It is idempotent (validating a valid constraint is
-- a no-op), one DO block (atomic), with lock_timeout 5s.
--
-- If it fails: nothing changed. Run `prisma migrate resolve --rolled-back
-- 20261018090100_notification_reliability_validate_checks`, then deploy again.
-- The rollback of the foundation migration drops the constraints whether or not
-- they were validated; nothing needs undoing here.

DO $notification_reliability_validate_checks$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."OutboxEvent"'::regclass
       AND conname IN ('OutboxEvent_attemptCount_check', 'OutboxEvent_lease_pair_check',
                       'OutboxEvent_lease_pending_check', 'OutboxEvent_leaseOwner_check', 'OutboxEvent_failedAt_check',
                       'OutboxEvent_lastError_check', 'OutboxEvent_lastErrorCode_check',
                       'OutboxEvent_expiresAt_check')
    HAVING count(*) = 8
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."NotificationDelivery"'::regclass
       AND conname = 'NotificationDelivery_possibleDuplicate_check'
  ) THEN
    RAISE EXCEPTION 'S4a validation requires the foundation migration (all notification reliability CHECK constraints). Nothing was changed.';
  END IF;

  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_attemptCount_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_lease_pair_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_lease_pending_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_leaseOwner_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_failedAt_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_lastError_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_lastErrorCode_check";
  ALTER TABLE "OutboxEvent" VALIDATE CONSTRAINT "OutboxEvent_expiresAt_check";
  ALTER TABLE "NotificationDelivery" VALIDATE CONSTRAINT "NotificationDelivery_possibleDuplicate_check";
END
$notification_reliability_validate_checks$;
