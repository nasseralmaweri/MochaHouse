-- V1 Sales Tax PR 1 — tax settings and configuration.
--
-- Built-in, per-location sales tax rules that a business's authorized
-- administrator configures and confirms. NOTHING here changes an order total,
-- a payment, a refund or a report: tax calculation arrives in a later,
-- separately approved change.
--
--   * TaxClass — the business's own tax classes ("Prepared Food", ...).
--     Names are unique per business, ignoring case. systemKey PREPARED_FOOD
--     marks the business's default class (created on first use, one per
--     business).
--   * Category.taxClassId / taxClassReviewedAt — a category's class (null =
--     the default, Prepared Food) and when an administrator explicitly
--     reviewed it. Existing categories start unreviewed.
--   * Product.taxClassId — an optional product-level override.
--   * LocationTaxVersion — versions of a location's tax settings: at most
--     one DRAFT and one CONFIRMED per location. A confirmed version is never
--     edited; confirming a new one marks the previous one SUPERSEDED, and
--     every version is kept. Built-in rules only (source BUILT_IN) and
--     tax-exclusive prices only (pricesIncludeTax false) in V1.
--   * LocationTaxComponent / LocationTaxComponentClass — the taxes in a
--     version (state, county, city, special district), each an exact
--     integer rate in parts per million (6.25% = 62500), and the tax classes
--     each applies to. Only a DRAFT version's taxes can be added or removed
--     (trigger); they are never updated in place.
--   * The new permission tax.manage is granted to every business's built-in
--     administrator role (the role holds every permission; new businesses get
--     it at provisioning). No other role is touched: Store Managers cannot
--     manage taxes.
--
-- ADDITIVE ONLY: four tables, three nullable columns, their indexes,
-- constraints and trigger guards, plus the role-permission backfill. One DO
-- block (atomic), read-only preflight first, lock_timeout 5s (local to this
-- transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261202090000_tax_settings.down.sql.

DO $tax_settings$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Tax settings refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"TaxClass"') IS NOT NULL
     OR to_regclass('"LocationTaxVersion"') IS NOT NULL
     OR to_regclass('"LocationTaxComponent"') IS NOT NULL
     OR to_regclass('"LocationTaxComponentClass"') IS NOT NULL
     OR to_regprocedure('location_tax_version_guard()') IS NOT NULL
     OR to_regprocedure('location_tax_draft_only_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'Tax settings refused: a table or function it creates already exists. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND ((table_name = 'Category' AND column_name IN ('taxClassId', 'taxClassReviewedAt'))
         OR (table_name = 'Product' AND column_name = 'taxClassId'))
  ) THEN
    RAISE EXCEPTION 'Tax settings refused: a column it adds already exists. Nothing was changed.';
  END IF;

  -- --- tax classes ------------------------------------------------------------

  CREATE TABLE "TaxClass" (
      "id" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "systemKey" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "TaxClass_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "TaxClass_name_check"
        CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 60),
      CONSTRAINT "TaxClass_systemKey_check"
        CHECK ("systemKey" IS NULL OR "systemKey" IN ('PREPARED_FOOD'))
  );

  CREATE INDEX "TaxClass_tenantId_idx" ON "TaxClass"("tenantId");
  CREATE UNIQUE INDEX "TaxClass_tenantId_id_key" ON "TaxClass"("tenantId", "id");
  CREATE UNIQUE INDEX "TaxClass_tenantId_systemKey_key" ON "TaxClass"("tenantId", "systemKey");
  -- One name per business, ignoring case ("Prepared food" = "PREPARED FOOD").
  CREATE UNIQUE INDEX "TaxClass_tenantId_name_ci_key" ON "TaxClass"("tenantId", lower("name"));

  ALTER TABLE "TaxClass" ADD CONSTRAINT "TaxClass_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  CREATE TRIGGER "TaxClass_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "TaxClass"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- --- category and product classification ------------------------------------

  ALTER TABLE "Category" ADD COLUMN "taxClassId" TEXT,
                         ADD COLUMN "taxClassReviewedAt" TIMESTAMP(3);
  ALTER TABLE "Product" ADD COLUMN "taxClassId" TEXT;

  CREATE INDEX "Category_tenantId_taxClassId_idx" ON "Category"("tenantId", "taxClassId");
  CREATE INDEX "Product_tenantId_taxClassId_idx" ON "Product"("tenantId", "taxClassId");

  ALTER TABLE "Category" ADD CONSTRAINT "Category_tenantId_taxClassId_fkey" FOREIGN KEY ("tenantId", "taxClassId") REFERENCES "TaxClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_taxClassId_fkey" FOREIGN KEY ("tenantId", "taxClassId") REFERENCES "TaxClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  -- --- location tax versions --------------------------------------------------

  CREATE TABLE "LocationTaxVersion" (
      "id" TEXT NOT NULL,
      "locationId" TEXT NOT NULL,
      "version" INTEGER NOT NULL,
      "status" TEXT NOT NULL,
      "source" TEXT NOT NULL DEFAULT 'BUILT_IN',
      "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
      "confirmedAt" TIMESTAMP(3),
      "confirmedByInternalUserId" TEXT,
      "supersededAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "LocationTaxVersion_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LocationTaxVersion_version_check" CHECK ("version" >= 1),
      CONSTRAINT "LocationTaxVersion_status_check"
        CHECK ("status" IN ('DRAFT', 'CONFIRMED', 'SUPERSEDED')),
      -- V1: built-in rules only; a future tax provider is a new value.
      CONSTRAINT "LocationTaxVersion_source_check" CHECK ("source" IN ('BUILT_IN')),
      -- V1: menu prices exclude tax.
      CONSTRAINT "LocationTaxVersion_tax_exclusive_check" CHECK (NOT "pricesIncludeTax"),
      -- A draft was never confirmed; anything else was confirmed by someone.
      CONSTRAINT "LocationTaxVersion_confirmation_check" CHECK (
        ("status" = 'DRAFT' AND "confirmedAt" IS NULL AND "confirmedByInternalUserId" IS NULL)
        OR ("status" <> 'DRAFT' AND "confirmedAt" IS NOT NULL AND "confirmedByInternalUserId" IS NOT NULL)
      ),
      CONSTRAINT "LocationTaxVersion_superseded_check" CHECK (
        ("status" = 'SUPERSEDED') = ("supersededAt" IS NOT NULL)
      )
  );

  CREATE INDEX "LocationTaxVersion_tenantId_idx" ON "LocationTaxVersion"("tenantId");
  CREATE UNIQUE INDEX "LocationTaxVersion_tenantId_id_key" ON "LocationTaxVersion"("tenantId", "id");
  CREATE UNIQUE INDEX "LocationTaxVersion_tenantId_locationId_version_key" ON "LocationTaxVersion"("tenantId", "locationId", "version");
  -- At most one draft and one confirmed version per location.
  CREATE UNIQUE INDEX "LocationTaxVersion_one_draft_per_location"
    ON "LocationTaxVersion"("tenantId", "locationId") WHERE "status" = 'DRAFT';
  CREATE UNIQUE INDEX "LocationTaxVersion_one_confirmed_per_location"
    ON "LocationTaxVersion"("tenantId", "locationId") WHERE "status" = 'CONFIRMED';

  ALTER TABLE "LocationTaxVersion" ADD CONSTRAINT "LocationTaxVersion_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationTaxVersion" ADD CONSTRAINT "LocationTaxVersion_tenantId_confirmedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "confirmedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationTaxVersion" ADD CONSTRAINT "LocationTaxVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  CREATE TRIGGER "LocationTaxVersion_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationTaxVersion"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- A version's identity never changes. The only status changes are DRAFT ->
  -- CONFIRMED and CONFIRMED -> SUPERSEDED; once confirmed, nothing else about
  -- it changes. Only a DRAFT may be deleted (an administrator discarding it):
  -- confirmed and superseded versions are history and are kept.
  CREATE FUNCTION "location_tax_version_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'A confirmed location tax version is never deleted (%).', OLD.id;
      END IF;
      RETURN OLD;
    END IF;
    IF NEW."locationId" IS DISTINCT FROM OLD."locationId"
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW."pricesIncludeTax" IS DISTINCT FROM OLD."pricesIncludeTax"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'A location tax version''s identity never changes (%).', OLD.id;
    END IF;
    IF OLD.status = 'DRAFT' THEN
      IF NEW.status NOT IN ('DRAFT', 'CONFIRMED') THEN
        RAISE EXCEPTION 'A draft location tax version can only be confirmed (%).', OLD.id;
      END IF;
    ELSIF OLD.status = 'CONFIRMED' THEN
      IF NEW.status <> 'SUPERSEDED'
         OR NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt"
         OR NEW."confirmedByInternalUserId" IS DISTINCT FROM OLD."confirmedByInternalUserId" THEN
        RAISE EXCEPTION 'A confirmed location tax version never changes; it can only be superseded (%).', OLD.id;
      END IF;
    ELSE
      RAISE EXCEPTION 'A superseded location tax version never changes (%).', OLD.id;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "LocationTaxVersion_guard" BEFORE UPDATE OR DELETE ON "LocationTaxVersion"
    FOR EACH ROW EXECUTE FUNCTION "location_tax_version_guard"();

  -- --- tax components ---------------------------------------------------------

  CREATE TABLE "LocationTaxComponent" (
      "id" TEXT NOT NULL,
      "versionId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "jurisdiction" TEXT NOT NULL,
      "ratePpm" INTEGER NOT NULL,
      "displayOrder" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "LocationTaxComponent_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LocationTaxComponent_name_check"
        CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80),
      CONSTRAINT "LocationTaxComponent_jurisdiction_check"
        CHECK ("jurisdiction" IN ('STATE', 'COUNTY', 'CITY', 'SPECIAL')),
      -- Parts per million of the price: 0.0001% to 25%.
      CONSTRAINT "LocationTaxComponent_ratePpm_check" CHECK ("ratePpm" BETWEEN 1 AND 250000),
      CONSTRAINT "LocationTaxComponent_displayOrder_check" CHECK ("displayOrder" BETWEEN 0 AND 99)
  );

  CREATE INDEX "LocationTaxComponent_tenantId_idx" ON "LocationTaxComponent"("tenantId");
  CREATE UNIQUE INDEX "LocationTaxComponent_tenantId_id_key" ON "LocationTaxComponent"("tenantId", "id");
  CREATE UNIQUE INDEX "LocationTaxComponent_tenantId_versionId_displayOrder_key" ON "LocationTaxComponent"("tenantId", "versionId", "displayOrder");

  ALTER TABLE "LocationTaxComponent" ADD CONSTRAINT "LocationTaxComponent_tenantId_versionId_fkey" FOREIGN KEY ("tenantId", "versionId") REFERENCES "LocationTaxVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationTaxComponent" ADD CONSTRAINT "LocationTaxComponent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  CREATE TRIGGER "LocationTaxComponent_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationTaxComponent"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  CREATE TABLE "LocationTaxComponentClass" (
      "componentId" TEXT NOT NULL,
      "taxClassId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "LocationTaxComponentClass_pkey" PRIMARY KEY ("componentId", "taxClassId")
  );

  CREATE INDEX "LocationTaxComponentClass_tenantId_taxClassId_idx" ON "LocationTaxComponentClass"("tenantId", "taxClassId");
  CREATE INDEX "LocationTaxComponentClass_tenantId_idx" ON "LocationTaxComponentClass"("tenantId");

  ALTER TABLE "LocationTaxComponentClass" ADD CONSTRAINT "LocationTaxComponentClass_tenantId_componentId_fkey" FOREIGN KEY ("tenantId", "componentId") REFERENCES "LocationTaxComponent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationTaxComponentClass" ADD CONSTRAINT "LocationTaxComponentClass_tenantId_taxClassId_fkey" FOREIGN KEY ("tenantId", "taxClassId") REFERENCES "TaxClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationTaxComponentClass" ADD CONSTRAINT "LocationTaxComponentClass_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  CREATE TRIGGER "LocationTaxComponentClass_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationTaxComponentClass"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- A version's taxes are added or removed only while it is a DRAFT, and are
  -- never updated in place: a confirmed version's rates can never change.
  CREATE FUNCTION "location_tax_draft_only_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  DECLARE
    row_component TEXT;
    row_tenant TEXT;
    version_status TEXT;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'A location tax is never changed in place; replace the draft instead (%).', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
      row_tenant := OLD."tenantId";
    ELSE
      row_tenant := NEW."tenantId";
    END IF;
    IF TG_TABLE_NAME = 'LocationTaxComponent' THEN
      SELECT v.status INTO version_status
        FROM "LocationTaxVersion" v
       WHERE v."tenantId" = row_tenant
         AND v.id = CASE WHEN TG_OP = 'DELETE' THEN OLD."versionId" ELSE NEW."versionId" END;
    ELSE
      IF TG_OP = 'DELETE' THEN
        row_component := OLD."componentId";
      ELSE
        row_component := NEW."componentId";
      END IF;
      SELECT v.status INTO version_status
        FROM "LocationTaxComponent" c
        JOIN "LocationTaxVersion" v ON v."tenantId" = c."tenantId" AND v.id = c."versionId"
       WHERE c."tenantId" = row_tenant AND c.id = row_component;
    END IF;
    -- A missing parent is left to the foreign key to refuse.
    IF version_status IS NOT NULL AND version_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'A confirmed location tax version''s taxes never change (%).', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "LocationTaxComponent_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "LocationTaxComponent"
    FOR EACH ROW EXECUTE FUNCTION "location_tax_draft_only_guard"();
  CREATE TRIGGER "LocationTaxComponentClass_draft_only" BEFORE INSERT OR UPDATE OR DELETE ON "LocationTaxComponentClass"
    FOR EACH ROW EXECUTE FUNCTION "location_tax_draft_only_guard"();

  -- --- permission -------------------------------------------------------------

  -- tax.manage for every business's built-in administrator role
  -- (idempotent: an existing grant is left as it is).
  INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
  SELECT r."id", 'tax.manage', r."tenantId", CURRENT_TIMESTAMP
    FROM "InternalRole" r
   WHERE r."key" = 'platform-administrator'
     AND r."isSystem" = true
  ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
END
$tax_settings$;
