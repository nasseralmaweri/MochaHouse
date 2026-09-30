-- Milestone S0D-2C-1 — Order & payment core tenant ownership: guarded,
-- parent-derived backfill + NOT NULL for PaymentAttempt, Order, OrderLine
-- and OrderStatusHistory ONLY. Every other tenant-owned table (including
-- OutboxEvent and NotificationDelivery) stays as it is.
--
-- Applied as ONE atomic unit (no enum value additions), so a failed guard
-- or check rolls back everything. Adds NO default, changes NO unique
-- constraint (idempotencyKey / orderNumber / accessToken stay globally
-- unique — S0D-3), adds NO composite FK, index or trigger (S0D-4), and
-- leaves the existing "paymentAttemptId" single-payment-domain triggers
-- untouched (they fire only on UPDATE OF "paymentAttemptId").

/*
  Warnings:

  - Made the column `tenantId` on table `Order` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `OrderLine` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `OrderStatusHistory` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `PaymentAttempt` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2C-1): guards, parent-derived backfill, checks ----
-- Rows written between S0D-1 and this slice carry a NULL tenantId.
--   Order              <- its Location (Location.tenantId is NOT NULL)
--   OrderLine, History <- their Order
--   PaymentAttempt     <- in tiers: its Order; else the Location named by
--                         its (FK-less) locationId; else its GiftCardPurchase;
--                         else that purchase's Customer; else Tenant #1.
-- The final PaymentAttempt tier (an attempt with no Order, no resolvable
-- Location and no attributable purchase — e.g. an abandoned gift-card
-- intent) is justified ONLY by the single-tenant guard below, which is why
-- that guard runs first. Post-checks refuse to reach SET NOT NULL unless no
-- NULL remains and every Order agrees with its Location, PaymentAttempt,
-- Customer, lines and history.
DO $s0d2c1$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  updated_rows BIGINT;
  bad_rows BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % tenant(s) other than Tenant #1 exist; the conversion window assumes a single tenant.', other_tenants;
  END IF;

  -- Order <- Location
  UPDATE "Order" AS o
     SET "tenantId" = l."tenantId"
    FROM "Location" AS l
   WHERE o."locationId" = l."id" AND o."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: Order -> % row(s) from Location', updated_rows;

  -- OrderLine / OrderStatusHistory <- Order
  UPDATE "OrderLine" AS x
     SET "tenantId" = o."tenantId"
    FROM "Order" AS o
   WHERE x."orderId" = o."id" AND x."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: OrderLine -> % row(s) from Order', updated_rows;

  UPDATE "OrderStatusHistory" AS x
     SET "tenantId" = o."tenantId"
    FROM "Order" AS o
   WHERE x."orderId" = o."id" AND x."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: OrderStatusHistory -> % row(s) from Order', updated_rows;

  -- PaymentAttempt, tier 1 <- its Order
  UPDATE "PaymentAttempt" AS pa
     SET "tenantId" = o."tenantId"
    FROM "Order" AS o
   WHERE o."paymentAttemptId" = pa."id" AND pa."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: PaymentAttempt -> % row(s) from Order', updated_rows;

  -- tier 2 <- the Location named by its locationId (checkout attempts
  -- without an Order: declined, failed, or flagged for reconciliation)
  UPDATE "PaymentAttempt" AS pa
     SET "tenantId" = l."tenantId"
    FROM "Location" AS l
   WHERE pa."locationId" = l."id" AND pa."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: PaymentAttempt -> % row(s) from Location', updated_rows;

  -- tier 3 <- its GiftCardPurchase (where that purchase carries a tenant)
  UPDATE "PaymentAttempt" AS pa
     SET "tenantId" = g."tenantId"
    FROM "GiftCardPurchase" AS g
   WHERE g."paymentAttemptId" = pa."id" AND g."tenantId" IS NOT NULL
     AND pa."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: PaymentAttempt -> % row(s) from GiftCardPurchase', updated_rows;

  -- tier 4 <- that purchase's Customer
  UPDATE "PaymentAttempt" AS pa
     SET "tenantId" = c."tenantId"
    FROM "GiftCardPurchase" AS g
    JOIN "Customer" AS c ON c."id" = g."customerId"
   WHERE g."paymentAttemptId" = pa."id" AND pa."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: PaymentAttempt -> % row(s) from GiftCardPurchase customer', updated_rows;

  -- tier 5 <- Tenant #1, justified only by the single-tenant guard above
  UPDATE "PaymentAttempt" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-1 backfill: PaymentAttempt -> % unattributable row(s) assigned to Tenant #1 (single-tenant guard)', updated_rows;

  -- Check 1: no NULL tenantId remains.
  SELECT COUNT(*) INTO bad_rows FROM "Order" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: Order still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "OrderLine" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: OrderLine still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "OrderStatusHistory" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: OrderStatusHistory still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "PaymentAttempt" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: PaymentAttempt still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;

  -- Check 2: every Order agrees with its Location.
  SELECT COUNT(*) INTO bad_rows
    FROM "Order" AS o JOIN "Location" AS l ON l."id" = o."locationId"
   WHERE o."tenantId" <> l."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % Order row(s) do not match their Location''s tenant.', bad_rows;
  END IF;

  -- Check 3: every Order agrees with its PaymentAttempt.
  SELECT COUNT(*) INTO bad_rows
    FROM "Order" AS o JOIN "PaymentAttempt" AS pa ON pa."id" = o."paymentAttemptId"
   WHERE o."tenantId" <> pa."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % Order row(s) do not match their PaymentAttempt''s tenant.', bad_rows;
  END IF;

  -- Check 4: every signed-in Order agrees with its Customer.
  SELECT COUNT(*) INTO bad_rows
    FROM "Order" AS o JOIN "Customer" AS c ON c."id" = o."customerId"
   WHERE o."tenantId" <> c."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % Order row(s) do not match their Customer''s tenant.', bad_rows;
  END IF;

  -- Check 5: every line and history row agrees with its Order.
  SELECT COUNT(*) INTO bad_rows
    FROM "OrderLine" AS x JOIN "Order" AS o ON o."id" = x."orderId"
   WHERE x."tenantId" <> o."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % OrderLine row(s) do not match their Order''s tenant.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows
    FROM "OrderStatusHistory" AS x JOIN "Order" AS o ON o."id" = x."orderId"
   WHERE x."tenantId" <> o."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % OrderStatusHistory row(s) do not match their Order''s tenant.', bad_rows;
  END IF;

  -- Check 6: every attempt naming an existing Location agrees with it.
  SELECT COUNT(*) INTO bad_rows
    FROM "PaymentAttempt" AS pa JOIN "Location" AS l ON l."id" = pa."locationId"
   WHERE pa."tenantId" <> l."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-1 aborted: % PaymentAttempt row(s) do not match their Location''s tenant.', bad_rows;
  END IF;
END
$s0d2c1$;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderLine" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderStatusHistory" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PaymentAttempt" ALTER COLUMN "tenantId" SET NOT NULL;
