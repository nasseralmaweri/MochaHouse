-- SC0.5b — gift-card ADJUSTMENT idempotency keys become per business.
--
-- Before: "GiftCardTransaction_adjustment_operationKey_key" made a manual
-- correction's caller-supplied operationKey unique across ALL businesses
-- (migration 20260908201508_add_gift_card_foundation; deliberately kept
-- global by 20261010120000_tenant_isolation_phase_2). The API looked keys up
-- the same way, so a business reusing a key another business had already
-- used got "already used for a different gift card" for its own card — one
-- business could block, and detect, another business's key.
--
-- After: the same idempotency guarantee, scoped to the owning business:
--   UNIQUE ("tenantId", "operationKey") WHERE "type" = 'ADJUSTMENT'
--                                         AND "operationKey" IS NOT NULL
-- A retry inside one business is still a replay; two businesses may use the
-- same key independently. The API's lookups are scoped the same way (same
-- release), so lookup and index can never disagree.
--
-- Existing data: compatible by construction. Every existing ADJUSTMENT key is
-- already unique globally, hence unique per business; the preflight proves it
-- anyway (and that tenantId is NOT NULL, which phase 2 established) and
-- refuses with nothing changed otherwise. No row is read for update, written
-- or deleted: balances, ledger entries and audit history are untouched.
--
-- Ordering: requires 20261010120000_tenant_isolation_phase_2 (NOT NULL
-- "GiftCardTransaction"."tenantId"); independent of every later migration.
--
-- Safety: one DO block (atomic), lock_timeout 5s. The new index is built
-- BEFORE the old one is dropped, so a uniqueness guarantee exists at every
-- instant. CREATE INDEX holds a SHARE lock on "GiftCardTransaction" while it
-- builds: gift-card writes (redemption at checkout, HQ issuance/correction)
-- wait for that moment; the table holds one row per balance change, so the
-- build is short. Not CONCURRENTLY: that cannot run inside a transaction.
--
-- If it fails: nothing changed. Fix the reported problem, run `prisma migrate
-- resolve --rolled-back 20261021090000_tenant_giftcard_adjustment_operation_key`,
-- then deploy again. Rollback (never automatic):
-- prisma/rollbacks/20261021090000_tenant_giftcard_adjustment_operation_key.down.sql.

DO $tenant_giftcard_adjustment_operation_key$
DECLARE
  null_tenants bigint;
  duplicates bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('public."GiftCardTransaction_adjustment_operationKey_key"') IS NULL THEN
    RAISE EXCEPTION 'SC0.5b expects the global index "GiftCardTransaction_adjustment_operationKey_key" (20260908201508). Nothing was changed.';
  END IF;
  IF to_regclass('public."GiftCardTransaction_adjustment_tenantId_operationKey_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'SC0.5b: "GiftCardTransaction_adjustment_tenantId_operationKey_key" already exists. Nothing was changed.';
  END IF;

  -- Blocks concurrent ledger writes for the rest of this transaction, so the
  -- checks below stay true until the index swap is committed.
  LOCK TABLE "GiftCardTransaction" IN SHARE MODE;

  SELECT count(*) INTO null_tenants
    FROM "GiftCardTransaction" WHERE "tenantId" IS NULL;
  IF null_tenants > 0 THEN
    RAISE EXCEPTION 'SC0.5b requires tenant isolation phase 2 (20261010120000): % gift-card ledger row(s) have no tenant. Nothing was changed.',
      null_tenants;
  END IF;

  SELECT count(*) INTO duplicates FROM (
    SELECT 1 FROM "GiftCardTransaction"
     WHERE "type" = 'ADJUSTMENT' AND "operationKey" IS NOT NULL
     GROUP BY "tenantId", "operationKey"
    HAVING count(*) > 1) d;
  IF duplicates > 0 THEN
    RAISE EXCEPTION 'SC0.5b: % (tenant, operationKey) pair(s) already repeat among ADJUSTMENT entries. Nothing was changed.',
      duplicates;
  END IF;

  CREATE UNIQUE INDEX "GiftCardTransaction_adjustment_tenantId_operationKey_key"
      ON "GiftCardTransaction"("tenantId", "operationKey")
      WHERE "type" = 'ADJUSTMENT' AND "operationKey" IS NOT NULL;

  DROP INDEX "GiftCardTransaction_adjustment_operationKey_key";
END
$tenant_giftcard_adjustment_operation_key$;
