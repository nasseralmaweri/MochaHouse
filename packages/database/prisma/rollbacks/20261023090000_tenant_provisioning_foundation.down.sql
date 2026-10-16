-- SC1d rollback for migration 20261023090000_tenant_provisioning_foundation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build that has no business provisioning (pre-SC1d).
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- provisioning record exists, or while any platform audit event carries a
-- target: dropping them would destroy the record of which operator created
-- which business, which is not a rollback's decision. Nothing is changed in
-- that case. One DO block, so it applies atomically.

DO $tenant_provisioning_foundation_rollback$
DECLARE
  operations bigint;
  targeted bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantProvisioningOperation", "PlatformAuditEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO operations FROM "TenantProvisioningOperation";
  SELECT count(*) INTO targeted FROM "PlatformAuditEvent" WHERE "targetType" IS NOT NULL;
  IF operations > 0 OR targeted > 0 THEN
    RAISE EXCEPTION 'SC1d rollback refused: % provisioning record(s) and % targeted platform audit event(s) exist. Nothing was changed.',
      operations, targeted;
  END IF;

  -- Dropping the table drops its append-only triggers with it.
  DROP TABLE "TenantProvisioningOperation";
  DROP FUNCTION "reject_tenant_provisioning_operation_change"();

  -- Dropping columns is not an UPDATE: the audit trail's append-only
  -- trigger does not fire.
  ALTER TABLE "PlatformAuditEvent" DROP CONSTRAINT "PlatformAuditEvent_target_check";
  ALTER TABLE "PlatformAuditEvent" DROP COLUMN "targetType";
  ALTER TABLE "PlatformAuditEvent" DROP COLUMN "targetId";
END
$tenant_provisioning_foundation_rollback$;
