-- SC0.5b rollback for migration
-- 20261021090000_tenant_giftcard_adjustment_operation_key.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build whose correction lookups are global again (pre-SC0.5b).
--
-- It restores the global ADJUSTMENT operationKey index and removes the
-- per-business one. It REFUSES to run once two businesses have used the same
-- key (legitimate since SC0.5b): the global index could not be built, and
-- deciding which business's correction "owns" the key is not a rollback's job.
-- Nothing is changed in that case. Ledger rows, balances and audit history
-- are never touched. One DO block, so it applies atomically.

DO $tenant_giftcard_adjustment_operation_key_rollback$
DECLARE
  shared_keys bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public."GiftCardTransaction_adjustment_tenantId_operationKey_key"') IS NULL THEN
    RAISE EXCEPTION 'SC0.5b rollback: the per-business index is not present. Nothing was changed.';
  END IF;

  LOCK TABLE "GiftCardTransaction" IN SHARE MODE;

  SELECT count(*) INTO shared_keys FROM (
    SELECT 1 FROM "GiftCardTransaction"
     WHERE "type" = 'ADJUSTMENT' AND "operationKey" IS NOT NULL
     GROUP BY "operationKey"
    HAVING count(*) > 1) d;
  IF shared_keys > 0 THEN
    RAISE EXCEPTION 'SC0.5b rollback refused: % operationKey value(s) are used by more than one business. Nothing was changed.',
      shared_keys;
  END IF;

  CREATE UNIQUE INDEX "GiftCardTransaction_adjustment_operationKey_key"
      ON "GiftCardTransaction"("operationKey")
      WHERE "type" = 'ADJUSTMENT' AND "operationKey" IS NOT NULL;

  DROP INDEX "GiftCardTransaction_adjustment_tenantId_operationKey_key";
END
$tenant_giftcard_adjustment_operation_key_rollback$;
