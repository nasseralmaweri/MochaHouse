-- R1 / S4a — notification reliability database foundation. ADDITIVE ONLY: no
-- code reads or writes any of this yet (the live worker is unchanged), so
-- application behaviour is identical after this migration.
--
-- What it adds
--   "OutboxEvent"          attemptCount, nextAttemptAt, lastAttemptAt,
--                          leaseOwner, leaseExpiresAt, expiresAt,
--                          lastErrorCode, lastError, failedAt
--   "NotificationDelivery" sendStartedAt, possibleDuplicate
--   CHECK constraints (added NOT VALID, validated by the next migration)
--   two partial indexes (due pending events; dead letters)
--
-- Meaning (the worker that uses it arrives in S4b)
--   OutboxEvent.status   PENDING   = not finished: awaiting its first attempt or a
--                                    retry; "in progress" while leaseExpiresAt is
--                                    in the future
--                        PROCESSED = handled successfully — the email provider
--                                    ACCEPTED the message (or the event type has no
--                                    handler). NOT a guarantee of inbox delivery.
--                        FAILED    = permanent failure or exhausted retries
--   Retry state lives on the event; the send intent (sendStartedAt, written before
--   the provider call) lives on the per-channel delivery. A delivery with
--   sendStartedAt set, sentAt null and an expired lease is an AMBIGUOUS outcome;
--   retrying it sets possibleDuplicate.
--
-- Historical data — NOTHING is rewritten, discarded or resent
--   - Every existing row keeps its status, processedAt and delivery record. The new
--     columns take their defaults: attemptCount 0, no lease, no error, no expiry,
--     possibleDuplicate false. PROCESSED events (all of them, including events whose
--     delivery crashed or failed under the old flow) stay PROCESSED, so a future
--     worker that only claims PENDING rows never touches them: no historical
--     notification is ever re-sent by this foundation.
--   - There is no global age cut-off. "expiresAt" is NULL for every row; S4b chooses
--     staleness per event type (and may set it when the event is written).
--   - Existing PENDING rows (normally none: the live worker claims within seconds)
--     get nextAttemptAt = the moment of this migration and are still handled by the
--     live worker exactly as before. Their count is reported with a NOTICE.
--   - Existing FAILED events (the status is unused today, so normally none) get
--     failedAt = COALESCE(processedAt, createdAt) so the new rule "failedAt is set
--     exactly when status is FAILED" holds.
--
-- Time: every timestamp here is "timestamp without time zone" holding UTC (Prisma
-- writes UTC). The nextAttemptAt default is timezone('utc', now()) — a bare
-- now()/CURRENT_TIMESTAMP default would store the session's local time. S4b must
-- compare and write with timezone('utc', now()), never with a bare now().
--
-- Compatibility with a running, older application
--   Every column is nullable or has a constant/stable default, so INSERTs and
--   UPDATEs written by the current API and worker (which know none of these columns)
--   keep working unchanged. Their writes also satisfy every new CHECK: the live
--   worker only sets status PROCESSED + processedAt on a row that holds no lease.
--   MIXED FLEET IS NOT SAFE once S4b exists, and the constraints are NOT the
--   protection: a legacy worker flips ANY row it finds PENDING to PROCESSED and
--   sends, with no regard for nextAttemptAt. A LEASED row makes that UPDATE fail
--   ("only PENDING rows hold a lease"), which aborts the legacy batch and leaves
--   that row at the head of its queue; a row merely waiting out a retry BACKOFF
--   (no lease) is silently consumed — marked PROCESSED and sent early, never
--   retried. S4b must therefore be deployed by stopping the legacy worker first
--   (no mixed fleet, single cut-over); see the S4a PR notes.
--
-- Safety
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement, so the
--     migration applies completely or not at all.
--   - Read-only preflight first; any problem aborts with nothing changed.
--   - lock_timeout 5s (local to this transaction): it fails, atomically, rather than
--     queue application traffic behind a lock it cannot get. ADD COLUMN with a NULL,
--     constant or stable default is metadata-only on PostgreSQL 11+ (no rewrite,
--     no scan). The CHECKs are NOT VALID, so no table scan runs under the lock; the
--     next migration validates them with only a SHARE UPDATE EXCLUSIVE lock. The two
--     small partial indexes are built with a plain CREATE INDEX (CONCURRENTLY cannot
--     run inside a Prisma migration); the tables are small and the build is brief.
--
-- If it fails: nothing changed. Fix the reported problem, run `prisma migrate
-- resolve --rolled-back 20261018090000_notification_reliability_foundation`, then
-- deploy again.
-- Rollback (never automatic):
-- prisma/rollbacks/20261018090000_notification_reliability_foundation.down.sql.

DO $notification_reliability_foundation$
DECLARE
  legacy_pending bigint;
  legacy_failed bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public."OutboxEvent"') IS NULL
     OR to_regclass('public."NotificationDelivery"') IS NULL THEN
    RAISE EXCEPTION 'S4a requires OutboxEvent and NotificationDelivery. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'OutboxEvent'
       AND column_name IN ('attemptCount', 'nextAttemptAt', 'lastAttemptAt', 'leaseOwner',
                           'leaseExpiresAt', 'expiresAt', 'lastErrorCode', 'lastError', 'failedAt')
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'NotificationDelivery'
       AND column_name IN ('sendStartedAt', 'possibleDuplicate')
  ) THEN
    RAISE EXCEPTION 'S4a aborted: one of the notification reliability columns already exists. Nothing was changed.';
  END IF;

  SELECT count(*) INTO legacy_pending FROM "OutboxEvent" WHERE status = 'PENDING';
  SELECT count(*) INTO legacy_failed  FROM "OutboxEvent" WHERE status = 'FAILED';

  -- OutboxEvent: retry, lease and failure metadata.
  ALTER TABLE "OutboxEvent"
    ADD COLUMN "attemptCount"   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "nextAttemptAt"  TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    ADD COLUMN "lastAttemptAt"  TIMESTAMP(3),
    ADD COLUMN "leaseOwner"     TEXT,
    ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "expiresAt"      TIMESTAMP(3),
    ADD COLUMN "lastErrorCode"  TEXT,
    ADD COLUMN "lastError"      TEXT,
    ADD COLUMN "failedAt"       TIMESTAMP(3);

  -- Historical FAILED events (normally none) must satisfy the failedAt rule below.
  UPDATE "OutboxEvent"
     SET "failedAt" = COALESCE("processedAt", "createdAt")
   WHERE status = 'FAILED' AND "failedAt" IS NULL;

  -- NOT VALID: enforced for every new and updated row at once, validated without
  -- blocking writes by the next migration.
  ALTER TABLE "OutboxEvent"
    ADD CONSTRAINT "OutboxEvent_attemptCount_check"
      CHECK ("attemptCount" >= 0) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_lease_pair_check"
      CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_leaseOwner_check"
      CHECK ("leaseOwner" IS NULL OR char_length("leaseOwner") BETWEEN 1 AND 200) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_lease_pending_check"
      CHECK (status = 'PENDING' OR "leaseOwner" IS NULL) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_failedAt_check"
      CHECK ((status = 'FAILED') = ("failedAt" IS NOT NULL)) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_lastError_check"
      CHECK ("lastError" IS NULL OR char_length("lastError") <= 2000) NOT VALID,
    ADD CONSTRAINT "OutboxEvent_lastErrorCode_check"
      CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$') NOT VALID,
    ADD CONSTRAINT "OutboxEvent_expiresAt_check"
      CHECK ("expiresAt" IS NULL OR "expiresAt" >= "createdAt") NOT VALID;

  -- NotificationDelivery: durable send intent.
  ALTER TABLE "NotificationDelivery"
    ADD COLUMN "sendStartedAt"     TIMESTAMP(3),
    ADD COLUMN "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE "NotificationDelivery"
    ADD CONSTRAINT "NotificationDelivery_possibleDuplicate_check"
      CHECK (NOT "possibleDuplicate" OR "sendStartedAt" IS NOT NULL) NOT VALID;

  -- The worker's claim query: due, unfinished events in retry order. Partial, so
  -- the (large, eventually) PROCESSED history is not in it.
  CREATE INDEX "OutboxEvent_pending_due_idx"
    ON "OutboxEvent" ("nextAttemptAt", "createdAt")
    WHERE status = 'PENDING';
  -- Operations: dead letters, newest first per business.
  CREATE INDEX "OutboxEvent_failed_idx"
    ON "OutboxEvent" ("tenantId", "failedAt")
    WHERE status = 'FAILED';

  RAISE NOTICE 'S4a: notification reliability columns added. Legacy PENDING events left as they were: %; legacy FAILED events given failedAt: %.',
    legacy_pending, legacy_failed;
END
$notification_reliability_foundation$;
