-- ESP-03 PR 7 — business-scoped payment keys and frozen checkout prices.
--
--   * PaymentAttempt: payment keys are unique per business as well
--     ("tenantId", "idempotencyKey"). The existing global unique key is
--     kept (owner decision D1), so no key can ever name two businesses'
--     payments and every existing row stays valid.
--   * CheckoutSnapshot: version 2 — the complete server-validated checkout
--     frozen before the charge (item and modifier details, item prices,
--     totals, discounts, reward, loyalty earnings and bonuses, gift-card
--     tender, the amount charged). The order is created from it exactly,
--     never re-priced. Version 1 (saved checkouts of payments still in
--     flight) stays readable. A frozen checkout is larger, so the payload
--     backstop rises from 64 KB to 256 KB.
--
-- ADDITIVE ONLY: one index, and two CHECKs replaced with supersets. No
-- existing row changes. A read-only preflight refuses (changing nothing) if
-- the index already exists.
--
-- Safety: one DO block (atomic), read-only preflight first, lock_timeout 5s
-- (local to this transaction): it fails, atomically, rather than queue
-- behind a long transaction. While the index builds, writes to
-- PaymentAttempt wait; reads continue.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261118090000_frozen_checkout.down.sql.

DO $frozen_checkout$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"PaymentAttempt_tenantId_idempotencyKey_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'Frozen checkout refused: index "PaymentAttempt_tenantId_idempotencyKey_key" already exists. Nothing was changed.';
  END IF;
  IF to_regclass('"CheckoutSnapshot"') IS NULL THEN
    RAISE EXCEPTION 'Frozen checkout refused: table "CheckoutSnapshot" (ESP-03 PR 4) is missing. Nothing was changed.';
  END IF;

  -- Business-scoped payment keys (alongside the global unique key).
  CREATE UNIQUE INDEX "PaymentAttempt_tenantId_idempotencyKey_key" ON "PaymentAttempt"("tenantId", "idempotencyKey");

  -- Saved checkout versions 1 and 2, with a 256 KB backstop.
  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_version_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_version_check" CHECK ("version" IN (1, 2));
  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_payload_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_payload_check" CHECK (
    jsonb_typeof("payload") = 'object'
    AND octet_length("payload"::text) <= 262144
  );
END
$frozen_checkout$;
