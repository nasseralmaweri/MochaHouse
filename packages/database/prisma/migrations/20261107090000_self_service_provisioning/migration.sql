-- SC4b — self-service business provisioning (owner decisions B1–B4):
--   * SubscriptionPlan.selfServiceAvailable: the plans business owners may
--     choose themselves (D3); never the Founding plan;
--   * OwnerRegistration: the ONE business its owner created (immutable,
--     unique; a plain value like TenantProvisioningOperation);
--   * TenantSubscriptionEventSource OWNER: history written by the owner's
--     own provisioning (never an operator);
--   * TenantSubscription_billed_check: a BILLED subscription may also be
--     PAYMENT SETUP PENDING before its billing-provider customer exists —
--     the owner chose a plan and a price, nothing is authorized or charged,
--     and payment setup is required (B1). Exactly that state and nothing
--     else; every other BILLED subscription still needs its provider
--     customer.
--
-- ADDITIVE / RELAXING ONLY: one column, two nullable columns, an enum value,
-- CHECK constraints and an updated guard function. No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261107090000_self_service_provisioning.down.sql.

ALTER TYPE "TenantSubscriptionEventSource" ADD VALUE 'OWNER';

-- Plans offered to business owners ------------------------------------------------
ALTER TABLE "SubscriptionPlan" ADD COLUMN "selfServiceAvailable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_self_service_check"
  CHECK (NOT ("selfServiceAvailable" AND "key" = 'founding'));

-- The business an owner registration created ----------------------------------------
ALTER TABLE "OwnerRegistration" ADD COLUMN "provisionedTenantId" TEXT,
ADD COLUMN "provisionedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "OwnerRegistration_provisionedTenantId_key" ON "OwnerRegistration"("provisionedTenantId");
ALTER TABLE "OwnerRegistration" ADD CONSTRAINT "OwnerRegistration_provisioned_check"
  CHECK (
    ("provisionedTenantId" IS NULL) = ("provisionedAt" IS NULL)
    AND ("provisionedTenantId" IS NULL OR "status" = 'VERIFIED')
  );

-- SC4a's guard, plus: the provisioned business, once recorded, never changes.
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
     OR (OLD."provisionedTenantId" IS NOT NULL AND (
           NEW."provisionedTenantId" IS DISTINCT FROM OLD."provisionedTenantId"
           OR NEW."provisionedAt" IS DISTINCT FROM OLD."provisionedAt"))
  THEN
    RAISE EXCEPTION 'An owner registration cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_owner_registration$;

-- BILLED: a provider customer and agreed price — or payment setup pending ---------
ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_billed_check";
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billed_check"
  CHECK (
    "billingMode" <> 'BILLED'
    OR (
      "planPriceId" IS NOT NULL
      AND (
        ("billingProvider" IS NOT NULL AND "externalCustomerId" IS NOT NULL)
        OR (
          -- payment setup pending: nothing at the provider, nothing
          -- authorized, started or owed yet
          "billingProvider" IS NULL
          AND "externalCustomerId" IS NULL
          AND "externalSubscriptionId" IS NULL
          AND "paymentSetupRequiredSince" IS NOT NULL
          AND "status" = 'ACTIVE'
          AND "recurringPaymentAuthorizedAt" IS NULL
          AND "trialStartedAt" IS NULL
          AND "currentPeriodStart" IS NULL
          AND "pastDueAt" IS NULL
          AND "canceledAt" IS NULL
          AND "pendingChangeKind" IS NULL
          AND NOT "cancelAtPeriodEnd"
        )
      )
    )
  );
