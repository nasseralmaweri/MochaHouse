-- SC4f-3a rollback for migration 20261112090000_storefront_publishing.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4f-3a.
--
-- It REFUSES to run while any storefront address history exists or any
-- storefront.manage grant (active or revoked) exists: both are an audit
-- record of who could do or did what, which is not a rollback's decision to
-- discard. Nothing is changed when it refuses. One DO block, so it applies
-- atomically.

DO $storefront_publishing_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "StorefrontHostChange", "PlatformOperatorPermission"
    IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "StorefrontHostChange")
       + (SELECT count(*) FROM "PlatformOperatorPermission"
           WHERE "permission" = 'storefront.manage')
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4f-3a rollback refused: % storefront history or storefront.manage permission record(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "StorefrontHostChange";
  DROP FUNCTION "guard_storefront_host_change"();

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
END
$storefront_publishing_rollback$;
