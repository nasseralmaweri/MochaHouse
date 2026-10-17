-- SC4b rollback for migration 20261107090000_self_service_provisioning.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4b.
--
-- It REFUSES to run while any self-service business, payment-setup-pending
-- subscription, OWNER history entry or self-service plan exists. Nothing is
-- changed when it refuses. One DO block, so it applies atomically.
--
-- It removes what the migration added except the 'OWNER' value of
-- "TenantSubscriptionEventSource": PostgreSQL cannot drop an enum value in
-- place, no row may use it (checked above), and an unused value is inert.

DO $self_service_provisioning_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "OwnerRegistration", "SubscriptionPlan", "TenantSubscription",
    "TenantSubscriptionEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "OwnerRegistration" WHERE "provisionedTenantId" IS NOT NULL)
       + (SELECT count(*) FROM "SubscriptionPlan" WHERE "selfServiceAvailable")
       + (SELECT count(*) FROM "TenantSubscription"
           WHERE "billingMode" = 'BILLED' AND "externalCustomerId" IS NULL)
       + (SELECT count(*) FROM "TenantSubscriptionEvent" WHERE "source"::text = 'OWNER')
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4b rollback refused: % self-service record(s) exist. Nothing was changed.', remaining;
  END IF;

  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billed_check";
  ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billed_check"
    CHECK (
      "billingMode" <> 'BILLED'
      OR ("billingProvider" IS NOT NULL AND "externalCustomerId" IS NOT NULL AND "planPriceId" IS NOT NULL)
    );

  -- SC4a's guard, exactly (it must not refer to the columns removed below).
  CREATE OR REPLACE FUNCTION "guard_owner_registration"() RETURNS trigger
  LANGUAGE plpgsql AS $guard_owner_registration$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD."identitySubject" IS NOT NULL THEN
        RAISE EXCEPTION 'An owner registration with a login is never removed.'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW."id" <> OLD."id"
       OR NEW."email" <> OLD."email"
       OR NEW."identityProvider" <> OLD."identityProvider"
       OR NEW."initialPasswordNonce" <> OLD."initialPasswordNonce"
       OR NEW."createdAt" <> OLD."createdAt"
       OR (OLD."identitySubject" IS NOT NULL
           AND NEW."identitySubject" IS DISTINCT FROM OLD."identitySubject")
       OR (OLD."status" = 'PASSWORD_SETUP' AND NEW."status" = 'PENDING_VERIFICATION')
       OR (OLD."status" = 'VERIFIED' AND (
             NEW."status" <> 'VERIFIED'
             OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
             OR NEW."legalAcceptedAt" IS DISTINCT FROM OLD."legalAcceptedAt"
             OR NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion"
             OR NEW."privacyVersion" IS DISTINCT FROM OLD."privacyVersion"))
    THEN
      RAISE EXCEPTION 'An owner registration cannot be changed this way.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END
  $guard_owner_registration$;

  ALTER TABLE "OwnerRegistration" DROP CONSTRAINT "OwnerRegistration_provisioned_check";
  DROP INDEX "OwnerRegistration_provisionedTenantId_key";
  ALTER TABLE "OwnerRegistration" DROP COLUMN "provisionedTenantId", DROP COLUMN "provisionedAt";

  ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT "SubscriptionPlan_self_service_check";
  ALTER TABLE "SubscriptionPlan" DROP COLUMN "selfServiceAvailable";
END
$self_service_provisioning_rollback$;
