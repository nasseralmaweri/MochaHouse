-- SC2a — CENTERIVO SaaS subscription plans and module entitlements.
--
-- Platform data (MODEL_TENANCY 'platform'), entirely separate from a
-- business's customer payments: no table here is read or written by checkout,
-- payments or refunds.
--
-- ADDITIVE ONLY: three enums, five tables, their indexes and foreign keys,
-- CHECK constraints, two triggers (published plan versions are immutable;
-- subscription history is append-only), and the Founding plan backfill
-- below. No existing table, column or row is changed.
--
-- The ONLY link from this data to a business is
-- TenantSubscription."subscriberTenantId" -> "Tenant" (owner decision S3; a
-- reviewed exception to the tenancy guards). Add-on grants and history hang
-- off the subscription.
--
-- Founding plan (owner decision S4): every business that exists when this
-- migration runs keeps every module, through a published "founding" plan
-- version 1. The backfill is idempotent and never overwrites a subscription
-- that already exists. A business WITHOUT a subscription has core only.
--
-- Module keys are pinned in CHECK constraints: a new module is a deliberate
-- migration together with its catalog entry (SUBSCRIPTION_MODULES).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261024090000_subscription_plans_foundation.down.sql.

-- CreateEnum
CREATE TYPE "SubscriptionPlanVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "TenantSubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING');

-- CreateEnum
CREATE TYPE "TenantSubscriptionEventType" AS ENUM ('PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED');

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlanVersion" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SubscriptionPlanVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "moduleKeys" TEXT[],
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSubscription" (
    "id" TEXT NOT NULL,
    "subscriberTenantId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "status" "TenantSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "billingProvider" TEXT,
    "externalSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantModuleGrant" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantModuleGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSubscriptionEvent" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "type" "TenantSubscriptionEventType" NOT NULL,
    "fromPlanVersionId" TEXT,
    "toPlanVersionId" TEXT,
    "moduleKey" TEXT,
    "actorPlatformOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantSubscriptionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_key_key" ON "SubscriptionPlan"("key");

-- CreateIndex
CREATE INDEX "SubscriptionPlanVersion_status_idx" ON "SubscriptionPlanVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlanVersion_planId_version_key" ON "SubscriptionPlanVersion"("planId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSubscription_subscriberTenantId_key" ON "TenantSubscription"("subscriberTenantId");

-- CreateIndex
CREATE INDEX "TenantSubscription_planVersionId_idx" ON "TenantSubscription"("planVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantModuleGrant_subscriptionId_moduleKey_key" ON "TenantModuleGrant"("subscriptionId", "moduleKey");

-- CreateIndex
CREATE INDEX "TenantSubscriptionEvent_subscriptionId_createdAt_idx" ON "TenantSubscriptionEvent"("subscriptionId", "createdAt");

-- AddForeignKey
ALTER TABLE "SubscriptionPlanVersion" ADD CONSTRAINT "SubscriptionPlanVersion_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_subscriberTenantId_fkey" FOREIGN KEY ("subscriberTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantModuleGrant" ADD CONSTRAINT "TenantModuleGrant_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantModuleGrant" ADD CONSTRAINT "TenantModuleGrant_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_fromPlanVersionId_fkey" FOREIGN KEY ("fromPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_toPlanVersionId_fkey" FOREIGN KEY ("toPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Checks ------------------------------------------------------------------
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_key_check"
  CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("key") <= 50);
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "SubscriptionPlan_name_check"
  CHECK (length(btrim("name")) BETWEEN 2 AND 80);

ALTER TABLE "SubscriptionPlanVersion" ADD CONSTRAINT "SubscriptionPlanVersion_version_check"
  CHECK ("version" >= 1);
ALTER TABLE "SubscriptionPlanVersion" ADD CONSTRAINT "SubscriptionPlanVersion_moduleKeys_check"
  CHECK (
    "moduleKeys" IS NOT NULL
    AND "moduleKeys" <@ ARRAY['operations','loyalty','promotions','giftcards','crm','careers','franchising','cms','marketing']::text[]
  );
ALTER TABLE "SubscriptionPlanVersion" ADD CONSTRAINT "SubscriptionPlanVersion_status_dates_check"
  CHECK (
    ("status" = 'DRAFT') = ("publishedAt" IS NULL)
    AND ("status" = 'RETIRED') = ("retiredAt" IS NOT NULL)
  );

ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_billing_check"
  CHECK (("billingProvider" IS NULL) = ("externalSubscriptionId" IS NULL));

ALTER TABLE "TenantModuleGrant" ADD CONSTRAINT "TenantModuleGrant_moduleKey_check"
  CHECK ("moduleKey" IN ('operations','loyalty','promotions','giftcards','crm','careers','franchising','cms','marketing'));

ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
  CHECK (
    ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
    OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
        AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
  );

-- A PUBLISHED plan version is immutable: it may only become RETIRED. A
-- RETIRED one never changes. Neither may be deleted (a DRAFT may).
CREATE FUNCTION "guard_subscription_plan_version_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_subscription_plan_version_change$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A % plan version cannot be deleted.', OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF NEW."planId" <> OLD."planId"
     OR NEW."version" <> OLD."version"
     OR NEW."moduleKeys" IS DISTINCT FROM OLD."moduleKeys"
     OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
     OR NOT (
       NEW."status" = OLD."status"
       OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED')
     )
     OR (OLD."status" = 'RETIRED' AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
  THEN
    RAISE EXCEPTION 'A % plan version is immutable (it may only be retired).', OLD."status"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_subscription_plan_version_change$;

CREATE TRIGGER "SubscriptionPlanVersion_immutable"
  BEFORE UPDATE OR DELETE ON "SubscriptionPlanVersion"
  FOR EACH ROW EXECUTE FUNCTION "guard_subscription_plan_version_change"();

-- Subscription history is append-only.
CREATE FUNCTION "reject_tenant_subscription_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $reject_tenant_subscription_event_change$
BEGIN
  RAISE EXCEPTION 'TenantSubscriptionEvent is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$reject_tenant_subscription_event_change$;

CREATE TRIGGER "TenantSubscriptionEvent_append_only"
  BEFORE UPDATE OR DELETE ON "TenantSubscriptionEvent"
  FOR EACH ROW EXECUTE FUNCTION "reject_tenant_subscription_event_change"();

CREATE TRIGGER "TenantSubscriptionEvent_no_truncate"
  BEFORE TRUNCATE ON "TenantSubscriptionEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_tenant_subscription_event_change"();

-- Founding plan backfill (idempotent; never overwrites) ----------------------
INSERT INTO "SubscriptionPlan" ("id", "key", "name", "description", "updatedAt")
VALUES (
  '01a0db02-f800-7000-8000-00000000f001',
  'founding',
  'Founding',
  'Every module, exactly as before plans existed. Assigned to the businesses that were on CENTERIVO when plans were introduced.',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "SubscriptionPlanVersion"
  ("id", "planId", "version", "status", "moduleKeys", "publishedAt", "updatedAt")
SELECT
  '01a0db02-f800-7000-8000-00000000f002',
  p."id",
  1,
  'PUBLISHED',
  ARRAY['operations','loyalty','promotions','giftcards','crm','careers','franchising','cms','marketing']::text[],
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "SubscriptionPlan" p
WHERE p."key" = 'founding'
ON CONFLICT ("planId", "version") DO NOTHING;

INSERT INTO "TenantSubscription"
  ("id", "subscriberTenantId", "planVersionId", "status", "startedAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", v."id", 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
CROSS JOIN "SubscriptionPlanVersion" v
JOIN "SubscriptionPlan" p ON p."id" = v."planId" AND p."key" = 'founding' AND v."version" = 1
WHERE NOT EXISTS (
  SELECT 1 FROM "TenantSubscription" s WHERE s."subscriberTenantId" = t."id"
)
ON CONFLICT ("subscriberTenantId") DO NOTHING;

INSERT INTO "TenantSubscriptionEvent"
  ("id", "subscriptionId", "type", "toPlanVersionId")
SELECT gen_random_uuid()::text, s."id", 'PLAN_ASSIGNED', s."planVersionId"
FROM "TenantSubscription" s
WHERE NOT EXISTS (
  SELECT 1 FROM "TenantSubscriptionEvent" e WHERE e."subscriptionId" = s."id"
);
