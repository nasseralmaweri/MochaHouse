-- Milestone S0D-2B-2 — Customer child tenant ownership: guarded,
-- parent-derived backfill + NOT NULL for CustomerPreferredLocation and
-- CustomerNote ONLY. Every other tenant-owned table stays as it is.
--
-- Applied as ONE atomic unit (no enum value additions), so a failed guard
-- or check rolls back everything. Adds NO default, changes NO unique
-- constraint (@@unique([customerId, locationId]) is untouched), adds NO
-- composite FK, trigger or index (same-tenant enforcement in the database
-- is S0D-4).

/*
  Warnings:

  - Made the column `tenantId` on table `CustomerNote` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `CustomerPreferredLocation` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2B-2): guards, parent-derived backfill, checks ----
-- Child rows written between S0D-1 and this slice carry a NULL tenantId.
-- Each one inherits its parent Customer's tenantId (Customer.tenantId is
-- NOT NULL since S0D-2B-1) — never a blanket assignment. The S0D-1 guards
-- (Tenant #1 exists, is ACTIVE, and is the ONLY tenant) still run first,
-- because this is the temporary single-tenant conversion window. Post-
-- checks refuse to reach SET NOT NULL unless no NULL remains, every child
-- matches its Customer's tenant, and every preferred-location row joins a
-- Customer and a Location of the SAME tenant.
DO $s0d2b2$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  updated_rows BIGINT;
  bad_rows BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: % tenant(s) other than Tenant #1 exist; the conversion window assumes a single tenant.', other_tenants;
  END IF;

  -- Backfill: each child inherits its parent Customer's tenant.
  UPDATE "CustomerPreferredLocation" AS cpl
     SET "tenantId" = c."tenantId"
    FROM "Customer" AS c
   WHERE cpl."customerId" = c."id" AND cpl."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2B-2 backfill: CustomerPreferredLocation -> % row(s) from parent Customer', updated_rows;

  UPDATE "CustomerNote" AS n
     SET "tenantId" = c."tenantId"
    FROM "Customer" AS c
   WHERE n."customerId" = c."id" AND n."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2B-2 backfill: CustomerNote -> % row(s) from parent Customer', updated_rows;

  -- Check 1: no NULL tenantId remains.
  SELECT COUNT(*) INTO bad_rows FROM "CustomerPreferredLocation" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: CustomerPreferredLocation still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "CustomerNote" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: CustomerNote still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;

  -- Check 2: every child's tenant matches its parent Customer's tenant
  -- (including rows that already carried a tenantId before this slice).
  SELECT COUNT(*) INTO bad_rows
    FROM "CustomerPreferredLocation" AS cpl
    JOIN "Customer" AS c ON c."id" = cpl."customerId"
   WHERE cpl."tenantId" <> c."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: % CustomerPreferredLocation row(s) do not match their Customer''s tenant.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows
    FROM "CustomerNote" AS n
    JOIN "Customer" AS c ON c."id" = n."customerId"
   WHERE n."tenantId" <> c."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: % CustomerNote row(s) do not match their Customer''s tenant.', bad_rows;
  END IF;

  -- Check 3: no preferred-location row joins a Customer and a Location of
  -- different tenants.
  SELECT COUNT(*) INTO bad_rows
    FROM "CustomerPreferredLocation" AS cpl
    JOIN "Customer" AS c ON c."id" = cpl."customerId"
    JOIN "Location" AS l ON l."id" = cpl."locationId"
   WHERE l."tenantId" <> c."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-2 aborted: % CustomerPreferredLocation row(s) join a Customer and a Location of different tenants.', bad_rows;
  END IF;
END
$s0d2b2$;

-- AlterTable
ALTER TABLE "CustomerNote" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerPreferredLocation" ALTER COLUMN "tenantId" SET NOT NULL;
