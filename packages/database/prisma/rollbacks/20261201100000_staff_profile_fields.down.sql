-- V1 launch fix 2 rollback for migration 20261201100000_staff_profile_fields.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration, only together with an API build that no longer reads or writes
-- these fields. Dropping them loses only the descriptive phone / job title;
-- no access depends on them. One DO block, so it applies atomically.

DO $staff_profile_fields_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'InternalUser'
       AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION 'Staff profile fields rollback refused: it is not applied. Nothing was changed.';
  END IF;
  ALTER TABLE "InternalUser"
    DROP CONSTRAINT IF EXISTS "InternalUser_phone_length_check",
    DROP CONSTRAINT IF EXISTS "InternalUser_jobTitle_length_check";
  ALTER TABLE "InternalUser" DROP COLUMN "jobTitle";
  ALTER TABLE "InternalUser" DROP COLUMN "phone";
END
$staff_profile_fields_rollback$;
