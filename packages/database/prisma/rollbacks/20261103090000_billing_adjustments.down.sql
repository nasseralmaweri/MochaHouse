-- SC3e-3 rollback for migration 20261103090000_billing_adjustments.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3e-3.
--
-- It removes exactly what the migration added. It REFUSES to run while any
-- billing adjustment, decision or event exists, or any permission granted
-- through the console or the bootstrap (or one of the three new
-- permissions) — those are financial records and the history of who could
-- move money; erasing them is not a rollback's decision. Nothing is changed
-- when it refuses. One DO block, so it applies atomically.

DO $billing_adjustments_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingAdjustment", "BillingAdjustmentDecision", "BillingAdjustmentEvent",
    "PlatformOperatorPermission" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "BillingAdjustment")
       + (SELECT count(*) FROM "BillingAdjustmentDecision")
       + (SELECT count(*) FROM "BillingAdjustmentEvent")
       + (SELECT count(*) FROM "PlatformOperatorPermission"
           WHERE "grantedVia" <> 'CLI' OR "revokedByOperatorId" IS NOT NULL
              OR "permission" IN ('billing.adjustments.request', 'billing.adjustments.approve',
                                  'platform.permissions.manage'))
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC3e-3 rollback refused: % adjustment record(s) or financial permission grant(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "BillingAdjustmentEvent";
  DROP TABLE "BillingAdjustmentDecision";
  DROP TABLE "BillingAdjustment";
  DROP FUNCTION "guard_billing_adjustment_event"();
  DROP FUNCTION "guard_billing_adjustment_decision"();
  DROP FUNCTION "guard_billing_adjustment"();

  ALTER TABLE "PlatformOperatorPermission" DROP CONSTRAINT "PlatformOperatorPermission_grant_check";
  ALTER TABLE "PlatformOperatorPermission" DROP CONSTRAINT "PlatformOperatorPermission_grantedByOperatorId_fkey";
  ALTER TABLE "PlatformOperatorPermission" DROP CONSTRAINT "PlatformOperatorPermission_revokedByOperatorId_fkey";
  DROP INDEX "PlatformOperatorPermission_grantedByOperatorId_idx";
  DROP INDEX "PlatformOperatorPermission_revokedByOperatorId_idx";
  ALTER TABLE "PlatformOperatorPermission"
    DROP COLUMN "grantedVia", DROP COLUMN "grantedByOperatorId", DROP COLUMN "approvalReference",
    DROP COLUMN "executedBy", DROP COLUMN "revokedByOperatorId";
  ALTER TABLE "PlatformOperatorPermission" DROP CONSTRAINT "PlatformOperatorPermission_shape_check";
  ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_shape_check"
    CHECK (
      "permission" IN (
        'billing.prices.manage',
        'billing.policy.manage',
        'billing.accounts.manage',
        'billing.reconciliation.run',
        'billing.cases.manage',
        'billing.schedules.release',
        'billing.complimentary.manage'
      )
      AND length(btrim("grantReason")) BETWEEN 10 AND 500
      AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
      AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
      AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
    );
  CREATE OR REPLACE FUNCTION "guard_platform_operator_permission"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'PlatformOperatorPermission rows are never removed (% refused).', TG_OP
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."operatorId" <> OLD."operatorId"
       OR NEW."permission" <> OLD."permission"
       OR NEW."grantReason" <> OLD."grantReason"
       OR NEW."grantedAt" <> OLD."grantedAt"
       OR OLD."revokedAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'A platform operator permission cannot be changed this way.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $guard$;
END
$billing_adjustments_rollback$;
