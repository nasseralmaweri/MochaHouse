-- Milestone S0D-2C-1B — GiftCardPurchase tenant ownership: guarded,
-- parent-derived backfill + NOT NULL for GiftCardPurchase ONLY. This closes
-- the payment core's second PaymentAttempt child (Order was converted in
-- S0D-2C-1); it is NOT general Gift Card domain tenancy work — GiftCard,
-- GiftCardTransaction, OrderGiftCardRedemption and GiftCardConfiguration
-- are untouched and stay nullable.
--
-- No single-tenant guard and no Tenant #1 fallback tier are used here,
-- unlike S0D-2C-1 / S0D-2D: every GiftCardPurchase row has a required,
-- unique paymentAttemptId, and PaymentAttempt.tenantId has been NOT NULL
-- since S0D-2C-1, so the backfill is unconditionally and fully derivable
-- from the parent alone — there is no orphan tier to justify with a
-- single-tenant assumption.
--
-- Applied as ONE atomic unit, so a failed guard or check rolls back
-- everything. Adds NO default, no unique constraint, no composite FK,
-- index or trigger (S0D-4). Preserves the existing paymentAttempt relation,
-- the paymentAttemptId unique constraint, the tenantId index, and every
-- other column/constraint untouched.

/*
  Warnings:

  - Made the column `tenantId` on table `GiftCardPurchase` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2C-1B): guard, parent-derived backfill, check -----
DO $s0d2c1b$
DECLARE
  bad_rows BIGINT;
  updated_rows BIGINT;
BEGIN
  -- Guard: any existing non-null GiftCardPurchase.tenantId must already
  -- agree with its PaymentAttempt's tenantId. No application code has ever
  -- written this column, so this is expected to pass vacuously — it exists
  -- only to catch an unknown/manual edit before it could be silently
  -- overwritten or masked by the backfill below.
  SELECT COUNT(*) INTO bad_rows
    FROM "GiftCardPurchase" AS g
    JOIN "PaymentAttempt" AS pa ON pa."id" = g."paymentAttemptId"
   WHERE g."tenantId" IS NOT NULL AND g."tenantId" <> pa."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1B aborted: % GiftCardPurchase row(s) have a non-null tenantId that disagrees with their PaymentAttempt''s tenant.', bad_rows;
  END IF;

  -- Backfill: GiftCardPurchase <- its PaymentAttempt (the only parent;
  -- paymentAttemptId is required and unique, and PaymentAttempt.tenantId
  -- has been NOT NULL since S0D-2C-1, so this covers every row).
  UPDATE "GiftCardPurchase" AS g
     SET "tenantId" = pa."tenantId"
    FROM "PaymentAttempt" AS pa
   WHERE pa."id" = g."paymentAttemptId" AND g."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1B backfill: GiftCardPurchase -> % row(s) from PaymentAttempt', updated_rows;

  -- Check: no NULL tenantId remains.
  SELECT COUNT(*) INTO bad_rows FROM "GiftCardPurchase" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1B aborted: GiftCardPurchase still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
END
$s0d2c1b$;

-- AlterTable
ALTER TABLE "GiftCardPurchase" ALTER COLUMN "tenantId" SET NOT NULL;
