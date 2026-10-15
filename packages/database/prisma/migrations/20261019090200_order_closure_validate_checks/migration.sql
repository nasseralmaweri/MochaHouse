-- R1 / S5a (part 3 of 3) — validate the CHECK constraints that
-- 20261019090100_order_closure_foundation added NOT VALID to the two existing ledger
-- tables.
--
-- Why a separate migration: the foundation migration holds locks on those tables until
-- it commits. VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock — reads AND
-- writes continue — so it runs here, in its own transaction.
--
-- Nothing changes in the data and no new rule is introduced: the constraints were
-- already enforced for every new and updated row; this proves the rows that existed
-- before them comply (none has a reversal type, so it cannot fail on real data). It is
-- idempotent, one DO block (atomic), with lock_timeout 5s.
--
-- If it fails: nothing changed. Run `prisma migrate resolve --rolled-back
-- 20261019090200_order_closure_validate_checks`, then deploy again. The rollback of the
-- foundation migration drops these constraints whether or not they were validated.

DO $order_closure_validate_checks$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."GiftCardTransaction"'::regclass
       AND conname = 'GiftCardTransaction_redemption_reversal_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public."MochaBeanLedgerEntry"'::regclass
       AND conname = 'MochaBeanLedgerEntry_reversal_check'
  ) THEN
    RAISE EXCEPTION 'S5a validation requires the foundation migration (the ledger reversal CHECK constraints). Nothing was changed.';
  END IF;

  ALTER TABLE "GiftCardTransaction" VALIDATE CONSTRAINT "GiftCardTransaction_redemption_reversal_check";
  ALTER TABLE "MochaBeanLedgerEntry" VALIDATE CONSTRAINT "MochaBeanLedgerEntry_reversal_check";
END
$order_closure_validate_checks$;
