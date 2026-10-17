-- SC4a rollback for migration 20261106090000_owner_registration.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4a.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- owner registration exists (a recorded login marks a self-registered staff
-- login; erasing it would let that login be bound to staff rows by email).
-- Nothing is changed when it refuses. One DO block, so it applies atomically.

DO $owner_registration_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "OwnerRegistration" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "OwnerRegistration" INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4a rollback refused: % owner registration(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "OwnerRegistration";
  DROP FUNCTION "guard_owner_registration"();
  DROP TYPE "OwnerRegistrationStatus";
END
$owner_registration_rollback$;
