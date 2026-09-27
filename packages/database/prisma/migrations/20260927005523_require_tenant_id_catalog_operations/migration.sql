-- Milestone S0D-2A — explicit tenant writes + NOT NULL for the LOCATIONS /
-- CATALOG / MENU / PRICING / STORE OPERATIONS domain (16 tables, listed in
-- the guard below). Every other tenant-owned table stays NULLABLE.
--
-- Like S0D-1, this file must be applied as ONE atomic unit: it contains no
-- enum value additions, so Prisma sends it as a single query and a failed
-- guard rolls back everything (including any SET NOT NULL).
--
-- Adds NO default, changes NO unique constraint, adds NO composite FK or
-- trigger.

/*
  Warnings:

  - Made the column `tenantId` on table `Category` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ChecklistInstance` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ChecklistInstanceItem` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ChecklistTemplate` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ChecklistTemplateItem` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `Location` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `LocationMenu` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `LocationProductAvailabilityOverride` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `LocationProductPriceOverride` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `Menu` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `MenuProduct` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ModifierGroup` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ModifierOption` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `OperationsTask` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `Product` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `ProductModifierGroup` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2A): guarded re-backfill, then NOT NULL ---------
-- Rows created in these tables between S0D-1 and this slice may carry a
-- NULL tenantId (the nullable window). They are assigned to Tenant #1 under
-- exactly the S0D-1 guards — Tenant #1 exists, is ACTIVE, and is the ONLY
-- tenant — before any row is touched, and a post-check refuses to continue
-- to SET NOT NULL if any NULL remains.
DO $s0d2a$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  slice_tables CONSTANT TEXT[] := ARRAY[
    'Category',
    'ChecklistInstance',
    'ChecklistInstanceItem',
    'ChecklistTemplate',
    'ChecklistTemplateItem',
    'Location',
    'LocationMenu',
    'LocationProductAvailabilityOverride',
    'LocationProductPriceOverride',
    'Menu',
    'MenuProduct',
    'ModifierGroup',
    'ModifierOption',
    'OperationsTask',
    'Product',
    'ProductModifierGroup'
  ];
  table_name TEXT;
  updated_rows BIGINT;
  remaining_nulls BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2A aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2A aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2A aborted: % tenant(s) other than Tenant #1 exist; NULL tenantId rows cannot be safely attributed to Tenant #1.', other_tenants;
  END IF;

  IF array_length(slice_tables, 1) <> 16 THEN
    RAISE EXCEPTION 'S0D-2A aborted: expected 16 slice tables, got %.', array_length(slice_tables, 1);
  END IF;

  FOREACH table_name IN ARRAY slice_tables LOOP
    EXECUTE format('UPDATE %I SET "tenantId" = $1 WHERE "tenantId" IS NULL', table_name)
      USING tenant_one;
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    RAISE NOTICE 'S0D-2A backfill: % -> % row(s) assigned to Tenant #1', table_name, updated_rows;
  END LOOP;

  FOREACH table_name IN ARRAY slice_tables LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE "tenantId" IS NULL', table_name)
      INTO remaining_nulls;
    IF remaining_nulls <> 0 THEN
      RAISE EXCEPTION 'S0D-2A aborted: % still has % row(s) with NULL tenantId after backfill.', table_name, remaining_nulls;
    END IF;
  END LOOP;
END
$s0d2a$;

-- AlterTable
ALTER TABLE "Category" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChecklistInstance" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChecklistInstanceItem" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChecklistTemplate" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ChecklistTemplateItem" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LocationMenu" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LocationProductAvailabilityOverride" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LocationProductPriceOverride" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Menu" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MenuProduct" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ModifierGroup" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ModifierOption" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OperationsTask" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProductModifierGroup" ALTER COLUMN "tenantId" SET NOT NULL;
