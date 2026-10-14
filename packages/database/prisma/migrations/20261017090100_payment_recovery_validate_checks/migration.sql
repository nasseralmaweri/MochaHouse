-- ESP-03 PR 1 (part 2) — validate the two PaymentAttempt CHECK constraints that
-- 20261017090000_payment_recovery_foundation added NOT VALID.
--
-- Why a separate migration: the foundation migration holds an ACCESS EXCLUSIVE
-- lock on "PaymentAttempt" (from ADD COLUMN) until it commits, so validating
-- there would scan the whole table under that lock. VALIDATE CONSTRAINT takes
-- only a SHARE UPDATE EXCLUSIVE lock — reads AND writes continue — so it is run
-- here, in its own transaction, after the exclusive lock is gone.
--
-- Nothing changes in the data and no new rule is introduced: the constraints
-- were already enforced for every new and updated row; this only proves that the
-- rows that existed before them comply (they do: both columns are NULL or were
-- set by the foundation migration's backfill, which the constraints checked).
-- It is idempotent (validating a valid constraint is a no-op), one DO block
-- (atomic), with lock_timeout 5s so it fails rather than queue behind a
-- conflicting DDL lock.
--
-- If it fails: nothing changed. Run `prisma migrate resolve --rolled-back
-- 20261017090100_payment_recovery_validate_checks`, then deploy again. The
-- rollback of the foundation migration
-- (prisma/rollbacks/20261017090000_payment_recovery_foundation.down.sql) drops the
-- constraints whether or not they were validated; nothing needs undoing here.

DO $payment_recovery_validate_checks$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."PaymentAttempt"'::regclass
       AND conname IN ('PaymentAttempt_paymentState_check', 'PaymentAttempt_fulfilmentStatus_check')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'ESP-03 validation requires the foundation migration (both PaymentAttempt CHECK constraints). Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentAttempt" VALIDATE CONSTRAINT "PaymentAttempt_paymentState_check";
  ALTER TABLE "PaymentAttempt" VALIDATE CONSTRAINT "PaymentAttempt_fulfilmentStatus_check";
END
$payment_recovery_validate_checks$;
