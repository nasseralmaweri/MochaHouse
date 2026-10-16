-- SC1d — CENTERIVO business provisioning by a platform operator.
--
-- ADDITIVE ONLY: two nullable columns on the platform audit trail, one new
-- platform table with its indexes, one foreign key (to the operator), and
-- an append-only trigger on the new table (one new function). No existing
-- row, constraint or business table is touched, so a running older
-- application is unaffected. Adding a nullable column without a default
-- rewrites nothing and is not an UPDATE, so the audit trail's append-only
-- trigger is untouched.
--
-- Platform-plane data (MODEL_TENANCY 'platform'): no "tenantId" column and
-- no foreign key to any business record. The business a row is about is a
-- plain, format-checked value ("targetId", "provisionedTenantId"), written in
-- the same transaction as the business itself.
--
-- This migration inserts nothing.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261023090000_tenant_provisioning_foundation.down.sql.

-- AlterTable
ALTER TABLE "PlatformAuditEvent" ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" TEXT;

-- What an audit event is about: both or neither; machine values only.
ALTER TABLE "PlatformAuditEvent" ADD CONSTRAINT "PlatformAuditEvent_target_check"
  CHECK (
    ("targetType" IS NULL) = ("targetId" IS NULL)
    AND ("targetType" IS NULL OR "targetType" ~ '^[a-z][a-z_]*$')
    AND ("targetId" IS NULL OR "targetId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

-- CreateTable
CREATE TABLE "TenantProvisioningOperation" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "provisionedTenantId" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantProvisioningOperation_pkey" PRIMARY KEY ("id"),
    -- A client-generated UUID, lowercase.
    CONSTRAINT "TenantProvisioningOperation_idempotencyKey_check"
        CHECK ("idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- SHA-256 hex of the normalised request; never the request itself.
    CONSTRAINT "TenantProvisioningOperation_requestHash_check"
        CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "TenantProvisioningOperation_provisionedTenantId_check"
        CHECK ("provisionedTenantId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantProvisioningOperation_idempotencyKey_key" ON "TenantProvisioningOperation"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TenantProvisioningOperation_provisionedTenantId_key" ON "TenantProvisioningOperation"("provisionedTenantId");

-- CreateIndex
CREATE INDEX "TenantProvisioningOperation_actorPlatformOperatorId_idx" ON "TenantProvisioningOperation"("actorPlatformOperatorId");

-- AddForeignKey
ALTER TABLE "TenantProvisioningOperation" ADD CONSTRAINT "TenantProvisioningOperation_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A provisioning record is APPEND-ONLY, like the audit trail it accompanies:
-- once written it is never changed or removed (a replay must always find
-- exactly what was created). Same operational bypass caveat as the
-- PlatformAuditEvent trigger.
CREATE FUNCTION "reject_tenant_provisioning_operation_change"() RETURNS trigger
LANGUAGE plpgsql AS $reject_tenant_provisioning_operation_change$
BEGIN
  RAISE EXCEPTION 'TenantProvisioningOperation is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$reject_tenant_provisioning_operation_change$;

CREATE TRIGGER "TenantProvisioningOperation_append_only"
  BEFORE UPDATE OR DELETE ON "TenantProvisioningOperation"
  FOR EACH ROW EXECUTE FUNCTION "reject_tenant_provisioning_operation_change"();

CREATE TRIGGER "TenantProvisioningOperation_no_truncate"
  BEFORE TRUNCATE ON "TenantProvisioningOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_tenant_provisioning_operation_change"();
