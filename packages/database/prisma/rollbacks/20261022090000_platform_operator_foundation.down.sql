-- SC1a rollback for migration 20261022090000_platform_operator_foundation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build that has no platform-operator boundary (pre-SC1a).
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- platform operator or platform audit event exists: dropping them would
-- destroy the platform's security audit trail and every operator's
-- provisioning, which is not a rollback's decision. Nothing is changed in
-- that case. One DO block, so it applies atomically.

DO $platform_operator_foundation_rollback$
DECLARE
  operators bigint;
  events bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "PlatformOperator", "PlatformAuditEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO operators FROM "PlatformOperator";
  SELECT count(*) INTO events FROM "PlatformAuditEvent";
  IF operators > 0 OR events > 0 THEN
    RAISE EXCEPTION 'SC1a rollback refused: % platform operator(s) and % platform audit event(s) exist. Nothing was changed.',
      operators, events;
  END IF;

  -- Dropping the table drops its append-only triggers with it.
  DROP TABLE "PlatformAuditEvent";
  DROP FUNCTION "reject_platform_audit_event_change"();
  DROP TABLE "PlatformOperator";
  DROP TYPE "PlatformAuditOutcome";
  DROP TYPE "PlatformOperatorStatus";
END
$platform_operator_foundation_rollback$;
