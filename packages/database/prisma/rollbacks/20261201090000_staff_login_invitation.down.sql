-- V1 launch fix 2 rollback for migration 20261201090000_staff_login_invitation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration, only together with an API build without staff invitations. Staff
-- rows keep their status and access; INVITED rows simply cannot activate
-- until invited again. One DO block, so it applies atomically.

DO $staff_login_invitation_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'InternalUser'
       AND column_name = 'loginInvitedAt'
  ) THEN
    RAISE EXCEPTION 'Staff login invitation rollback refused: it is not applied. Nothing was changed.';
  END IF;
  ALTER TABLE "InternalUser" DROP COLUMN "loginInvitedAt";
END
$staff_login_invitation_rollback$;
