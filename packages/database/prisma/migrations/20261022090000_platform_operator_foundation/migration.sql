-- SC1a — CENTERIVO platform operators: the people who administer the SaaS
-- platform itself, authenticated by a DEDICATED platform Cognito user pool
-- (separate from the customer and tenant-staff pools).
--
-- ADDITIVE ONLY: two new enums, two new tables, their indexes, one foreign
-- key between them, and the append-only trigger on the audit trail (one new
-- function). No existing table, column, row or constraint is
-- touched, so a running older application is unaffected, and no tenant data
-- is read or written.
--
-- Platform-plane data (MODEL_TENANCY 'platform'): no "tenantId", and no
-- reference to any business record — the only foreign key is audit event ->
-- operator.
--
-- Operators are created only by the provisioning CLI
-- (packages/database/prisma/scripts/platform-operator.ts); this migration
-- inserts nothing. "status" has no default: provisioning chooses it.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261022090000_platform_operator_foundation.down.sql.

-- CreateEnum
CREATE TYPE "PlatformOperatorStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PlatformAuditOutcome" AS ENUM ('SUCCEEDED', 'DENIED');

-- CreateTable
CREATE TABLE "PlatformOperator" (
    "id" TEXT NOT NULL,
    "externalProvider" TEXT NOT NULL,
    "externalSubject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "PlatformOperatorStatus" NOT NULL,
    "lastAuthenticatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformOperator_pkey" PRIMARY KEY ("id"),
    -- Only the two identity providers the platform boundary knows.
    CONSTRAINT "PlatformOperator_externalProvider_check"
        CHECK ("externalProvider" IN ('cognito-platform', 'platform-dev')),
    CONSTRAINT "PlatformOperator_externalSubject_check"
        CHECK (length(btrim("externalSubject")) > 0),
    -- Stored normalised so the unique index cannot be dodged by case.
    CONSTRAINT "PlatformOperator_email_check"
        CHECK ("email" = lower(btrim("email")) AND "email" LIKE '_%@_%')
);

-- CreateTable
CREATE TABLE "PlatformAuditEvent" (
    "id" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT,
    "action" TEXT NOT NULL,
    "outcome" "PlatformAuditOutcome" NOT NULL,
    "reasonCode" TEXT,
    "identityProvider" TEXT,
    "identitySubject" TEXT,
    "requestReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id"),
    -- Machine codes only (e.g. "platform.session.verified",
    -- "OPERATOR_DISABLED"); never free text from a request.
    CONSTRAINT "PlatformAuditEvent_action_check"
        CHECK ("action" ~ '^[a-z]+(\.[a-z_]+)+$'),
    CONSTRAINT "PlatformAuditEvent_reasonCode_check"
        CHECK ("reasonCode" IS NULL OR "reasonCode" ~ '^[A-Z][A-Z0-9_]*$')
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_email_key" ON "PlatformOperator"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformOperator_externalProvider_externalSubject_key" ON "PlatformOperator"("externalProvider", "externalSubject");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_actorPlatformOperatorId_idx" ON "PlatformAuditEvent"("actorPlatformOperatorId");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_action_createdAt_idx" ON "PlatformAuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_createdAt_idx" ON "PlatformAuditEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "PlatformAuditEvent" ADD CONSTRAINT "PlatformAuditEvent_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The platform security audit trail is APPEND-ONLY: a row, once written, is
-- never changed or removed — by the application or by a stray statement.
-- (Together with the RESTRICT foreign key above, an operator who appears in
-- the trail can never be deleted either; operators are DISABLED instead.)
-- Bypass (operational): a superuser's session_replication_role = replica or
-- a table owner's ALTER TABLE ... DISABLE TRIGGER; the application role
-- must be neither for this to be a guarantee rather than a convention.
CREATE FUNCTION "reject_platform_audit_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $reject_platform_audit_event_change$
BEGIN
  RAISE EXCEPTION 'PlatformAuditEvent is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$reject_platform_audit_event_change$;

CREATE TRIGGER "PlatformAuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION "reject_platform_audit_event_change"();

CREATE TRIGGER "PlatformAuditEvent_no_truncate"
  BEFORE TRUNCATE ON "PlatformAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_platform_audit_event_change"();
