-- SC3c-3 — billing contact, grace extensions and platform billing
-- notifications (BILLING_NOTIFICATIONS_ENABLED and BILLING_ENFORCEMENT_ENABLED
-- both off by default).
--
-- Platform billing data, plus ONE tenant-owned table (the designated billing
-- contact, linked to a staff member of the SAME business by a composite
-- foreign key). The billing notification queue is SEPARATE from the
-- restaurant OutboxEvent / NotificationDelivery pipeline; nothing here
-- references restaurant orders, payments, refunds or gift cards.
--
-- ADDITIVE:
--   * InternalUser.verifiedEmail / emailVerifiedAt — the address the identity
--     provider last asserted as verified, and when;
--   * TenantSubscription.graceExceptionEndsAt — UNPAID only;
--   * TenantBillingContact (tenant-owned), BillingGraceExtension and
--     BillingNotification (platform), with CHECK constraints and triggers;
--   * TenantSubscriptionEventType + GRACE_EXTENDED, GRACE_EXCEPTION_GRANTED,
--     GRACE_EXCEPTION_EXPIRED (recreated, the SC3a pattern).
-- No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261029090000_billing_notifications.down.sql.

-- Columns -----------------------------------------------------------------------
ALTER TABLE "InternalUser" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN "verifiedEmail" TEXT;
ALTER TABLE "InternalUser" ADD CONSTRAINT "InternalUser_verified_email_check"
  CHECK (
    ("verifiedEmail" IS NULL) = ("emailVerifiedAt" IS NULL)
    AND ("verifiedEmail" IS NULL OR (length("verifiedEmail") BETWEEN 3 AND 320
         AND "verifiedEmail" = lower("verifiedEmail")))
  );

ALTER TABLE "TenantSubscription" ADD COLUMN "graceExceptionEndsAt" TIMESTAMP(3);
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_grace_exception_check"
  CHECK ("graceExceptionEndsAt" IS NULL OR "status" = 'UNPAID');

-- Tables ------------------------------------------------------------------------
CREATE TABLE "TenantBillingContact" (
    "id" TEXT NOT NULL,
    "internalUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "TenantBillingContact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingGraceExtension" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "episodeStartedAt" TIMESTAMP(3) NOT NULL,
    "days" INTEGER NOT NULL,
    "previousEndsAt" TIMESTAMP(3) NOT NULL,
    "newEndsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingGraceExtension_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillingNotification" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "sendStartedAt" TIMESTAMP(3),
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingNotification_pkey" PRIMARY KEY ("id")
);

-- Indexes -----------------------------------------------------------------------
CREATE UNIQUE INDEX "TenantBillingContact_tenantId_key" ON "TenantBillingContact"("tenantId");
CREATE UNIQUE INDEX "TenantBillingContact_tenantId_internalUserId_key" ON "TenantBillingContact"("tenantId", "internalUserId");
CREATE UNIQUE INDEX "TenantBillingContact_tenantId_id_key" ON "TenantBillingContact"("tenantId", "id");
CREATE INDEX "BillingGraceExtension_subscriptionId_episodeStartedAt_idx" ON "BillingGraceExtension"("subscriptionId", "episodeStartedAt");
CREATE INDEX "BillingGraceExtension_actorPlatformOperatorId_idx" ON "BillingGraceExtension"("actorPlatformOperatorId");
CREATE UNIQUE INDEX "BillingNotification_dedupeKey_key" ON "BillingNotification"("dedupeKey");
CREATE INDEX "BillingNotification_status_nextAttemptAt_idx" ON "BillingNotification"("status", "nextAttemptAt");
CREATE INDEX "BillingNotification_subscriptionId_idx" ON "BillingNotification"("subscriptionId");
-- The grace-exception sweep's lookup.
CREATE INDEX "TenantSubscription_grace_exception_due_idx"
  ON "TenantSubscription"("graceExceptionEndsAt") WHERE "graceExceptionEndsAt" IS NOT NULL;

-- Foreign keys --------------------------------------------------------------------
ALTER TABLE "TenantBillingContact" ADD CONSTRAINT "TenantBillingContact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The contact is a staff member of the SAME business (composite key).
ALTER TABLE "TenantBillingContact" ADD CONSTRAINT "TenantBillingContact_tenantId_internalUserId_fkey" FOREIGN KEY ("tenantId", "internalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A business-owned row never moves to another business (the Security 4C
-- ownership guard every tenant-owned table carries).
CREATE TRIGGER "TenantBillingContact_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "TenantBillingContact"
  FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION "reject_tenant_reassignment"();
ALTER TABLE "BillingGraceExtension" ADD CONSTRAINT "BillingGraceExtension_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingGraceExtension" ADD CONSTRAINT "BillingGraceExtension_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "BillingNotification" ADD CONSTRAINT "BillingNotification_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Checks --------------------------------------------------------------------------
ALTER TABLE "BillingGraceExtension" ADD CONSTRAINT "BillingGraceExtension_shape_check"
  CHECK (
    "kind" IN ('GRACE_EXTENDED', 'GRACE_EXCEPTION')
    AND "days" BETWEEN 1 AND 14
    AND "newEndsAt" > "previousEndsAt"
    AND length(btrim("reason")) BETWEEN 10 AND 500
  );

ALTER TABLE "BillingNotification" ADD CONSTRAINT "BillingNotification_shape_check"
  CHECK (
    "kind" IN ('PAYMENT_FAILED', 'GRACE_ENDING', 'BILLING_SUSPENDED', 'ACCESS_RESTORED',
               'TRIAL_EXPIRED', 'TRIAL_RECOVERY_ENDING', 'RESTART_CONFIRMED', 'RESTART_UNDER_REVIEW')
    AND "status" IN ('PENDING', 'SENT', 'SKIPPED', 'FAILED')
    AND length("dedupeKey") BETWEEN 1 AND 255
    AND "attemptCount" BETWEEN 0 AND 2
    AND ("status" = 'PENDING') = ("finishedAt" IS NULL)
    AND ("status" = 'SENT') = ("sentAt" IS NOT NULL)
    AND (NOT "possibleDuplicate" OR "sendStartedAt" IS NOT NULL)
    AND ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  );

-- Triggers --------------------------------------------------------------------------

-- A grace extension is history: never changed, never deleted.
CREATE FUNCTION "guard_billing_grace_extension_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_grace_extension_change$
BEGIN
  RAISE EXCEPTION 'BillingGraceExtension is append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$guard_billing_grace_extension_change$;

CREATE TRIGGER "BillingGraceExtension_append_only"
  BEFORE UPDATE OR DELETE ON "BillingGraceExtension"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_grace_extension_change"();
CREATE TRIGGER "BillingGraceExtension_no_truncate"
  BEFORE TRUNCATE ON "BillingGraceExtension"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_grace_extension_change"();

-- A billing notice is never deleted; what it is about never changes; a
-- finished notice (SENT, SKIPPED, FAILED) never changes again.
CREATE FUNCTION "guard_billing_notification_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_notification_change$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingNotification rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."subscriptionId" <> OLD."subscriptionId"
     OR NEW."kind" <> OLD."kind"
     OR NEW."dedupeKey" <> OLD."dedupeKey"
     OR NEW."payload" <> OLD."payload"
     OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."expiresAt" <> OLD."expiresAt"
     OR NEW."attemptCount" < OLD."attemptCount"
     OR OLD."status" <> 'PENDING'
  THEN
    RAISE EXCEPTION 'A billing notification cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_notification_change$;

CREATE TRIGGER "BillingNotification_guard"
  BEFORE UPDATE OR DELETE ON "BillingNotification"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_notification_change"();
CREATE TRIGGER "BillingNotification_no_truncate"
  BEFORE TRUNCATE ON "BillingNotification"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_notification_change"();

-- TenantSubscriptionEventType: + grace history -----------------------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3c2";
CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
  'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
  'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
  'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
  'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
  'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
  'SUBSCRIPTION_REPLACED',
  'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED'
);
ALTER TABLE "TenantSubscriptionEvent"
  ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
  USING ("type"::text::"TenantSubscriptionEventType");
DROP TYPE "TenantSubscriptionEventType_sc3c2";

ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
  CHECK (
    (
      ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
          AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
      OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                     'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
                     'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
                     'SUBSCRIPTION_REPLACED',
                     'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED')
          AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
          AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
    )
    AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
  );
