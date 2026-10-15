-- R1 / S4a rollback for migration 20261018090000_notification_reliability_foundation.
--
-- NOT a Prisma migration and never run automatically. To roll back an environment
-- that applied the migration: remove the new fields from schema.prisma and ship this
-- SQL as a NEW forward migration, so every environment's history stays linear.
--
-- It removes exactly what the migration added: the two partial indexes, the CHECK
-- constraints (validated or not), and the OutboxEvent / NotificationDelivery columns.
-- No existing column, status or row is changed: event statuses, processedAt and
-- every delivery record are exactly as they were.
--
-- The follow-up migration 20261018090100_notification_reliability_validate_checks
-- only validates constraints this script drops; it needs no rollback of its own.
--
-- Code coupling: once this SQL has run, an application built from the new schema
-- (whose Prisma client selects these columns) fails on every OutboxEvent and
-- NotificationDelivery query. Ship the schema revert and this SQL together, as one
-- deployment; never run it under running new code. Before S4b ships, no code uses
-- the columns, so reverting the schema alone is already safe.
--
-- It REFUSES to run when any reliability data would be destroyed — an event with
-- attempts, a lease, a recorded error, a failure time or an expiry, or a delivery
-- with a send-start time or a possible-duplicate flag — because that data is
-- diagnostic history (and a dead-lettered event would silently become a plain
-- FAILED row). Export or finish them first, or clear the columns deliberately by
-- hand. The default values of an untouched foundation are not "data".
-- Note: a historical FAILED event given a backfilled failedAt by the migration also
-- makes this refuse, and "clear by hand" then needs the failedAt CHECK dropped
-- first (setting failedAt to NULL on a FAILED row violates it).
-- The tables are locked (ACCESS EXCLUSIVE) BEFORE the check, so no write can land
-- between the check and the drops.
-- One DO block, so Prisma applies it atomically.

DO $notification_reliability_foundation_rollback$
DECLARE
  used_events bigint;
  used_deliveries bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  LOCK TABLE "OutboxEvent", "NotificationDelivery" IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'OutboxEvent' AND column_name = 'attemptCount'
  ) THEN
    SELECT count(*) INTO used_events FROM "OutboxEvent"
     WHERE "attemptCount" > 0 OR "leaseOwner" IS NOT NULL OR "lastAttemptAt" IS NOT NULL
        OR "lastErrorCode" IS NOT NULL OR "lastError" IS NOT NULL
        OR "expiresAt" IS NOT NULL
        OR ("failedAt" IS NOT NULL AND status = 'FAILED');
    SELECT count(*) INTO used_deliveries FROM "NotificationDelivery"
     WHERE "sendStartedAt" IS NOT NULL OR "possibleDuplicate";
    IF used_events > 0 OR used_deliveries > 0 THEN
      RAISE EXCEPTION 'S4a rollback refused: % event(s) and % delivery record(s) hold reliability data. Nothing was changed.',
        used_events, used_deliveries;
    END IF;
  END IF;

  DROP INDEX IF EXISTS "OutboxEvent_pending_due_idx";
  DROP INDEX IF EXISTS "OutboxEvent_failed_idx";

  ALTER TABLE "NotificationDelivery" DROP CONSTRAINT IF EXISTS "NotificationDelivery_possibleDuplicate_check";
  ALTER TABLE "NotificationDelivery" DROP COLUMN IF EXISTS "sendStartedAt";
  ALTER TABLE "NotificationDelivery" DROP COLUMN IF EXISTS "possibleDuplicate";

  ALTER TABLE "OutboxEvent"
    DROP CONSTRAINT IF EXISTS "OutboxEvent_attemptCount_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_lease_pair_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_lease_pending_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_leaseOwner_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_failedAt_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_lastError_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_lastErrorCode_check",
    DROP CONSTRAINT IF EXISTS "OutboxEvent_expiresAt_check";
  ALTER TABLE "OutboxEvent"
    DROP COLUMN IF EXISTS "attemptCount",
    DROP COLUMN IF EXISTS "nextAttemptAt",
    DROP COLUMN IF EXISTS "lastAttemptAt",
    DROP COLUMN IF EXISTS "leaseOwner",
    DROP COLUMN IF EXISTS "leaseExpiresAt",
    DROP COLUMN IF EXISTS "expiresAt",
    DROP COLUMN IF EXISTS "lastErrorCode",
    DROP COLUMN IF EXISTS "lastError",
    DROP COLUMN IF EXISTS "failedAt";
END
$notification_reliability_foundation_rollback$;
