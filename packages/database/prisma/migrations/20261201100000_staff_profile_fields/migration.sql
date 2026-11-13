-- V1 launch fix 2 — an employee's optional phone number and job title, entered
-- when an administrator adds them.
--
-- Both are plain descriptive text. A job title NEVER grants anything: access
-- comes only from role assignments. Lengths and characters are checked by the
-- API, and bounded here as a backstop.
--
-- ADDITIVE ONLY: two nullable columns with length CHECKs (NULL passes). No
-- existing row changes. One DO block (atomic), read-only preflight first,
-- lock_timeout 5s.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261201100000_staff_profile_fields.down.sql.

DO $staff_profile_fields$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"InternalUser"') IS NULL THEN
    RAISE EXCEPTION 'Staff profile fields refused: "InternalUser" is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'InternalUser'
       AND column_name IN ('phone', 'jobTitle')
  ) THEN
    RAISE EXCEPTION 'Staff profile fields refused: "InternalUser"."phone" or "jobTitle" already exists. Nothing was changed.';
  END IF;

  ALTER TABLE "InternalUser" ADD COLUMN "phone" TEXT;
  ALTER TABLE "InternalUser" ADD COLUMN "jobTitle" TEXT;
  ALTER TABLE "InternalUser"
    ADD CONSTRAINT "InternalUser_phone_length_check"
      CHECK ("phone" IS NULL OR char_length("phone") BETWEEN 1 AND 32),
    ADD CONSTRAINT "InternalUser_jobTitle_length_check"
      CHECK ("jobTitle" IS NULL OR char_length("jobTitle") BETWEEN 1 AND 80);
END
$staff_profile_fields$;
