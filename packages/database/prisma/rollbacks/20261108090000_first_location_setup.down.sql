-- SC4d rollback for migration 20261108090000_first_location_setup.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4d.
--
-- It REFUSES to run while any opening hours or any location profile detail
-- exists — those are a business's own data, and discarding them is not a
-- rollback's decision. Nothing is changed when it refuses. One DO block, so
-- it applies atomically.
--
-- It removes everything the migration added, including the locations.create
-- grants (a key the pre-SC4d vocabulary does not have). In practice it can
-- run only before any location was created or given details through SC4d:
-- such a location always has profile details, so the rollback refuses.
-- Clearing a business's location details to force it is not a rollback's
-- decision.

DO $first_location_setup_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "Location", "LocationOpeningPeriod", "InternalRolePermission"
    IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "LocationOpeningPeriod")
       + (SELECT count(*) FROM "Location"
           WHERE "addressLine1" IS NOT NULL OR "addressLine2" IS NOT NULL
              OR "city" IS NOT NULL OR "region" IS NOT NULL
              OR "postalCode" IS NOT NULL OR "countryCode" IS NOT NULL
              OR "timeZone" IS NOT NULL OR "phone" IS NOT NULL
              OR "openingHoursSetAt" IS NOT NULL)
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4d rollback refused: % location profile or opening hours record(s) exist. Nothing was changed.', remaining;
  END IF;

  DELETE FROM "InternalRolePermission" WHERE "permissionKey" = 'locations.create';

  DROP TABLE "LocationOpeningPeriod";

  ALTER TABLE "Location" DROP CONSTRAINT "Location_profile_check";
  ALTER TABLE "Location" DROP COLUMN "addressLine1",
    DROP COLUMN "addressLine2",
    DROP COLUMN "city",
    DROP COLUMN "region",
    DROP COLUMN "postalCode",
    DROP COLUMN "countryCode",
    DROP COLUMN "timeZone",
    DROP COLUMN "phone",
    DROP COLUMN "openingHoursSetAt";
END
$first_location_setup_rollback$;
