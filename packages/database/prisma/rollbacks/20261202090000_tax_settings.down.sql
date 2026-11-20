-- V1 Sales Tax PR 1 rollback for migration 20261202090000_tax_settings.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without V1 Sales Tax PR 1.
--
-- It REFUSES to run while any location tax version has ever been confirmed:
-- a confirmed version is the business's record of the tax rules it approved
-- and must never be forgotten silently (an explicit, separately approved
-- archival step must come first). Drafts, tax classes and category / product
-- classifications are configuration only and are removed. Nothing is changed
-- when it refuses. One DO block, so it applies atomically. The tax.manage
-- grants are removed from every role.

DO $tax_settings_rollback$
DECLARE
  confirmed bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"LocationTaxVersion"') IS NULL THEN
    RAISE EXCEPTION 'Tax settings rollback refused: table "LocationTaxVersion" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "LocationTaxVersion", "LocationTaxComponent", "LocationTaxComponentClass", "TaxClass"
    IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO confirmed FROM "LocationTaxVersion" WHERE "status" <> 'DRAFT';
  IF confirmed > 0 THEN
    RAISE EXCEPTION 'Tax settings rollback refused: % confirmed location tax version(s) exist. Nothing was changed.', confirmed;
  END IF;

  DELETE FROM "InternalRolePermission" WHERE "permissionKey" = 'tax.manage';
  DROP TABLE "LocationTaxComponentClass";
  DROP TABLE "LocationTaxComponent";
  DROP TABLE "LocationTaxVersion";
  DROP FUNCTION "location_tax_draft_only_guard"();
  DROP FUNCTION "location_tax_version_guard"();
  ALTER TABLE "Product" DROP CONSTRAINT "Product_tenantId_taxClassId_fkey";
  ALTER TABLE "Category" DROP CONSTRAINT "Category_tenantId_taxClassId_fkey";
  DROP INDEX "Product_tenantId_taxClassId_idx";
  DROP INDEX "Category_tenantId_taxClassId_idx";
  ALTER TABLE "Product" DROP COLUMN "taxClassId";
  ALTER TABLE "Category" DROP COLUMN "taxClassReviewedAt", DROP COLUMN "taxClassId";
  DROP TABLE "TaxClass";
END
$tax_settings_rollback$;
