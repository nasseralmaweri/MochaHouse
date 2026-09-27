-- Milestone S0D-2B-1 — Customer tenant ownership: guarded re-backfill +
-- NOT NULL for the Customer table ONLY. CustomerPreferredLocation and
-- CustomerNote (S0D-2B-2) and every other tenant-owned table stay NULLABLE.
--
-- Applied as ONE atomic unit (no enum value additions), so a failed guard
-- rolls back everything. Adds NO default, changes NO unique constraint (the
-- global (externalProvider, externalSubject) key is untouched — S0D-3/S0G),
-- adds NO composite FK or trigger.

/*
  Warnings:

  - Made the column `tenantId` on table `Customer` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2B-1): guarded re-backfill, then NOT NULL ---------
-- Customers JIT-created between S0D-1 and this slice carry a NULL tenantId.
-- They are assigned to Tenant #1 under the S0D-1 guards (Tenant #1 exists,
-- is ACTIVE, and is the ONLY tenant) before any row is touched; a
-- post-check refuses to reach SET NOT NULL if any NULL remains.
DO $s0d2b1$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  updated_rows BIGINT;
  remaining_nulls BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2B-1 aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2B-1 aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2B-1 aborted: % tenant(s) other than Tenant #1 exist; NULL Customer tenantId rows cannot be safely attributed to Tenant #1.', other_tenants;
  END IF;

  UPDATE "Customer" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2B-1 backfill: Customer -> % row(s) assigned to Tenant #1', updated_rows;

  SELECT COUNT(*) INTO remaining_nulls FROM "Customer" WHERE "tenantId" IS NULL;
  IF remaining_nulls <> 0 THEN
    RAISE EXCEPTION 'S0D-2B-1 aborted: Customer still has % row(s) with NULL tenantId after backfill.', remaining_nulls;
  END IF;
END
$s0d2b1$;

-- AlterTable
ALTER TABLE "Customer" ALTER COLUMN "tenantId" SET NOT NULL;
