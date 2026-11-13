-- V1 launch fix 2 — when the identity provider confirmed a staff member's
-- login invitation (an administrator added them in Administration → Users).
--
-- An INVITED staff row may become ACTIVE only when its own person first signs
-- in with a provider-VERIFIED email AND this is set: the provider confirmed
-- the login it invited them to use (or that a login already exists for the
-- address). Rows created before this column, or whose invitation the provider
-- never confirmed, stay exactly as they are — never activated.
--
-- ADDITIVE ONLY: one nullable column. No existing row changes. One DO block
-- (atomic), read-only preflight first, lock_timeout 5s.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261201090000_staff_login_invitation.down.sql.

DO $staff_login_invitation$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"InternalUser"') IS NULL THEN
    RAISE EXCEPTION 'Staff login invitation refused: "InternalUser" is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'InternalUser'
       AND column_name = 'loginInvitedAt'
  ) THEN
    RAISE EXCEPTION 'Staff login invitation refused: "InternalUser"."loginInvitedAt" already exists. Nothing was changed.';
  END IF;

  ALTER TABLE "InternalUser" ADD COLUMN "loginInvitedAt" TIMESTAMP(3);
END
$staff_login_invitation$;
