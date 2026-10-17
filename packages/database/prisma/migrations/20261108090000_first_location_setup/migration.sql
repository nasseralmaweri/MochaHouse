-- SC4d — first location setup and getting started (owner decisions D1–D7):
--   * Location profile: address, ISO country, IANA time zone, phone and when
--     opening hours were last saved. All NULLABLE, so every existing
--     location stays valid; the API requires the essentials for a location
--     an owner creates.
--   * LocationOpeningPeriod (tenant-owned): weekly opening hours, local to
--     the location's time zone. Saved and displayed only — nothing here
--     enforces ordering hours.
--   * locations.create: the built-in administrator role of every existing
--     business receives the new permission (the role is defined as holding
--     every permission; new businesses get it at provisioning).
--
-- ADDITIVE ONLY: nullable columns, one table, CHECK constraints, the
-- standard ownership guard and one idempotent permission backfill. No
-- existing row changes otherwise; no location's online ordering changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261108090000_first_location_setup.down.sql.

-- Location profile ------------------------------------------------------------------
ALTER TABLE "Location" ADD COLUMN "addressLine1" TEXT,
ADD COLUMN "addressLine2" TEXT,
ADD COLUMN "city" TEXT,
ADD COLUMN "region" TEXT,
ADD COLUMN "postalCode" TEXT,
ADD COLUMN "countryCode" TEXT,
ADD COLUMN "timeZone" TEXT,
ADD COLUMN "phone" TEXT,
ADD COLUMN "openingHoursSetAt" TIMESTAMP(3);

ALTER TABLE "Location" ADD CONSTRAINT "Location_profile_check"
  CHECK (
    ("countryCode" IS NULL OR "countryCode" ~ '^[A-Z]{2}$')
    AND ("timeZone" IS NULL OR char_length("timeZone") BETWEEN 1 AND 64)
    AND ("addressLine1" IS NULL OR char_length("addressLine1") BETWEEN 1 AND 200)
    AND ("addressLine2" IS NULL OR char_length("addressLine2") BETWEEN 1 AND 200)
    AND ("city" IS NULL OR char_length("city") BETWEEN 1 AND 100)
    AND ("region" IS NULL OR char_length("region") BETWEEN 1 AND 100)
    AND ("postalCode" IS NULL OR char_length("postalCode") BETWEEN 1 AND 20)
    AND ("phone" IS NULL OR char_length("phone") BETWEEN 1 AND 30)
  );

-- Opening hours ---------------------------------------------------------------------
CREATE TABLE "LocationOpeningPeriod" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensAtMinute" INTEGER NOT NULL,
    "closesAtMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "LocationOpeningPeriod_pkey" PRIMARY KEY ("id"),
    -- ISO weekday; minutes after local midnight. closes < opens runs past
    -- midnight; 1440 is 24:00. A zero-length period is meaningless.
    CONSTRAINT "LocationOpeningPeriod_times_check" CHECK (
      "dayOfWeek" BETWEEN 1 AND 7
      AND "opensAtMinute" BETWEEN 0 AND 1439
      AND "closesAtMinute" BETWEEN 1 AND 1440
      AND "opensAtMinute" <> "closesAtMinute"
    )
);

CREATE UNIQUE INDEX "LocationOpeningPeriod_locationId_dayOfWeek_opensAtMinute_key" ON "LocationOpeningPeriod"("locationId", "dayOfWeek", "opensAtMinute");
CREATE UNIQUE INDEX "LocationOpeningPeriod_tenantId_id_key" ON "LocationOpeningPeriod"("tenantId", "id");
CREATE INDEX "LocationOpeningPeriod_tenantId_locationId_idx" ON "LocationOpeningPeriod"("tenantId", "locationId");

ALTER TABLE "LocationOpeningPeriod" ADD CONSTRAINT "LocationOpeningPeriod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The period's location must belong to the same business (composite key).
ALTER TABLE "LocationOpeningPeriod" ADD CONSTRAINT "LocationOpeningPeriod_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A business-owned row never moves to another business (the Security 4C
-- ownership guard every tenant-owned table carries).
CREATE TRIGGER "LocationOpeningPeriod_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationOpeningPeriod"
  FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION "reject_tenant_reassignment"();

-- Backfill ---------------------------------------------------------------------
-- The built-in administrator role of every existing business receives
-- locations.create (idempotent: an existing grant is left as it is).
INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
SELECT r."id", 'locations.create', r."tenantId", CURRENT_TIMESTAMP
  FROM "InternalRole" r
 WHERE r."key" = 'platform-administrator'
   AND r."isSystem" = true
ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
