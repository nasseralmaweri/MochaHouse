-- SC4e — Platform Console onboarding oversight (owner decisions E1–E6):
--   * two operator permissions: onboarding.view (read-only registration and
--     onboarding reports) and onboarding.manage (pause / resume new owner
--     registrations). Granted only through the existing audited grant flows
--     (provisioning CLI or the console's permission management); nobody
--     receives them automatically;
--   * RegistrationControlChange: the append-only history of the emergency
--     pause of NEW owner registrations. The latest row is the current state.
--     The deployment flag SELF_SERVICE_REGISTRATION_ENABLED stays the master
--     control: a row here can only stop registration, never start it.
--
-- ADDITIVE ONLY: one platform table (no business data), its checks and
-- guard, and the permission CHECK replaced with a superset. No existing row
-- changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261109090000_onboarding_oversight.down.sql.

-- Operator permissions -------------------------------------------------------------
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
      'billing.complimentary.manage',
      'billing.adjustments.request',
      'billing.adjustments.approve',
      'platform.permissions.manage',
      'billing.reports.view',
      'onboarding.view',
      'onboarding.manage'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );

-- Registration pause history ---------------------------------------------------------
CREATE TABLE "RegistrationControlChange" (
    "id" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationControlChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RegistrationControlChange_reason_check"
      CHECK (length(btrim("reason")) BETWEEN 10 AND 500)
);

CREATE INDEX "RegistrationControlChange_createdAt_idx" ON "RegistrationControlChange"("createdAt");
CREATE INDEX "RegistrationControlChange_actorPlatformOperatorId_idx" ON "RegistrationControlChange"("actorPlatformOperatorId");

ALTER TABLE "RegistrationControlChange" ADD CONSTRAINT "RegistrationControlChange_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A pause or resume is history: never changed, never deleted.
CREATE FUNCTION "guard_registration_control_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_registration_control_change$
BEGIN
  RAISE EXCEPTION 'RegistrationControlChange is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$guard_registration_control_change$;

CREATE TRIGGER "RegistrationControlChange_append_only"
  BEFORE UPDATE OR DELETE ON "RegistrationControlChange"
  FOR EACH ROW EXECUTE FUNCTION "guard_registration_control_change"();
CREATE TRIGGER "RegistrationControlChange_no_truncate"
  BEFORE TRUNCATE ON "RegistrationControlChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_registration_control_change"();
