-- SC4f-3a — storefront publishing in the Platform Console (owner decisions
-- H1–H3):
--   * one operator permission, storefront.manage (assign an approved address
--     to a business, publish and unpublish it). Granted only through the
--     existing audited grant flows; nobody receives it automatically;
--   * StorefrontHostChange: the append-only history of every assignment,
--     publication and unpublication — which address, which operator, why.
--     It reaches the business only through its StorefrontHost (platform data,
--     no tenantId).
--
-- Publishing a registry row does NOT make a storefront public by itself: the
-- deployment switch STOREFRONT_HOST_ROUTING_ENABLED (off) stays the master
-- control.
--
-- ADDITIVE ONLY: one platform table, its checks and guard, and the permission
-- CHECK replaced with a superset. No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261112090000_storefront_publishing.down.sql.

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
        'onboarding.manage',
        'storefront.manage'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );

-- Storefront address history ---------------------------------------------------------
CREATE TABLE "StorefrontHostChange" (
    "id" TEXT NOT NULL,
    "storefrontHostId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorefrontHostChange_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorefrontHostChange_shape_check" CHECK (
      "action" IN ('ASSIGNED', 'PUBLISHED', 'UNPUBLISHED')
      AND length(btrim("reason")) BETWEEN 10 AND 500
    )
);

CREATE INDEX "StorefrontHostChange_storefrontHostId_createdAt_idx" ON "StorefrontHostChange"("storefrontHostId", "createdAt");
CREATE INDEX "StorefrontHostChange_actorPlatformOperatorId_idx" ON "StorefrontHostChange"("actorPlatformOperatorId");

ALTER TABLE "StorefrontHostChange" ADD CONSTRAINT "StorefrontHostChange_storefrontHostId_fkey" FOREIGN KEY ("storefrontHostId") REFERENCES "StorefrontHost"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StorefrontHostChange" ADD CONSTRAINT "StorefrontHostChange_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An assignment, publication or unpublication is history: never changed,
-- never deleted.
CREATE FUNCTION "guard_storefront_host_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_storefront_host_change$
BEGIN
  RAISE EXCEPTION 'StorefrontHostChange is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$guard_storefront_host_change$;

CREATE TRIGGER "StorefrontHostChange_append_only"
  BEFORE UPDATE OR DELETE ON "StorefrontHostChange"
  FOR EACH ROW EXECUTE FUNCTION "guard_storefront_host_change"();
CREATE TRIGGER "StorefrontHostChange_no_truncate"
  BEFORE TRUNCATE ON "StorefrontHostChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_storefront_host_change"();
