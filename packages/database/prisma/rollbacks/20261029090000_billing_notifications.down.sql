-- SC3c-3 rollback for migration 20261029090000_billing_notifications.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API/worker build without SC3c-3.
--
-- It removes exactly what the migration added and restores the SC3c-2 history
-- types and CHECK. It REFUSES to run while any SC3c-3 data exists — a billing
-- contact, a grace extension, a billing notice, an active grace exception or a
-- grace history entry — because dropping those would erase operator decisions
-- and what businesses were told, which is not a rollback's decision. The
-- verified-email stamps are observational and are simply dropped. Nothing is
-- changed when it refuses. One DO block, so it applies atomically.

DO $billing_notifications_rollback$
DECLARE
  contacts bigint;
  extensions bigint;
  notices bigint;
  exceptions bigint;
  history_rows bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "TenantBillingContact", "BillingGraceExtension", "BillingNotification",
             "TenantSubscription", "TenantSubscriptionEvent", "InternalUser"
    IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO contacts FROM "TenantBillingContact";
  SELECT count(*) INTO extensions FROM "BillingGraceExtension";
  SELECT count(*) INTO notices FROM "BillingNotification";
  SELECT count(*) INTO exceptions FROM "TenantSubscription" WHERE "graceExceptionEndsAt" IS NOT NULL;
  SELECT count(*) INTO history_rows FROM "TenantSubscriptionEvent"
   WHERE "type"::text IN ('GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED');
  IF contacts > 0 OR extensions > 0 OR notices > 0 OR exceptions > 0 OR history_rows > 0 THEN
    RAISE EXCEPTION 'SC3c-3 rollback refused: % billing contact(s), % grace extension(s), % billing notice(s), % grace exception(s), % grace history entr(ies). Nothing was changed.',
      contacts, extensions, notices, exceptions, history_rows;
  END IF;

  ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
  ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3c3";
  CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
    'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
    'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
    'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
    'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
    'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
    'SUBSCRIPTION_REPLACED'
  );
  ALTER TABLE "TenantSubscriptionEvent"
    ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
    USING ("type"::text::"TenantSubscriptionEventType");
  DROP TYPE "TenantSubscriptionEventType_sc3c3";
  ALTER TABLE "TenantSubscriptionEvent" ADD CONSTRAINT "TenantSubscriptionEvent_shape_check"
    CHECK (
      (
        ("type" IN ('PLAN_ASSIGNED', 'PLAN_CHANGED') AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('ADDON_GRANTED', 'ADDON_REVOKED') AND "moduleKey" IS NOT NULL
            AND "fromPlanVersionId" IS NULL AND "toPlanVersionId" IS NULL)
        OR ("type" IN ('TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
                       'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
                       'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
                       'SUBSCRIPTION_REPLACED')
            AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
        OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
            AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      )
      AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
    );

  DROP TABLE "BillingNotification";
  DROP TABLE "BillingGraceExtension";
  DROP TABLE "TenantBillingContact";
  DROP FUNCTION "guard_billing_notification_change"();
  DROP FUNCTION "guard_billing_grace_extension_change"();
  DROP INDEX "TenantSubscription_grace_exception_due_idx";
  ALTER TABLE "TenantSubscription" DROP CONSTRAINT "TenantSubscription_grace_exception_check";
  ALTER TABLE "TenantSubscription" DROP COLUMN "graceExceptionEndsAt";
  ALTER TABLE "InternalUser" DROP CONSTRAINT "InternalUser_verified_email_check";
  ALTER TABLE "InternalUser" DROP COLUMN "verifiedEmail";
  ALTER TABLE "InternalUser" DROP COLUMN "emailVerifiedAt";
END
$billing_notifications_rollback$;
