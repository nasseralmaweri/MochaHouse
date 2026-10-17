-- SC3e-2 — operator billing controls (owner decisions D1–D6):
--   * PlatformOperatorPermission: database-backed platform-operator
--     permissions, granted / revoked only by the provisioning CLI;
--   * BillingComplimentaryGrant: complimentary arrangements (indefinite or
--     time-limited, an explicit plan version), with what the business was
--     billed as before, so ending one restores it exactly;
--   * BillingReconciliationCaseAction: the append-only history of what
--     operators did on a billing review case, and the case's closing
--     outcome and note;
--   * four TenantSubscriptionEvent types for the complimentary history.
--
-- Platform billing data (no tenantId): a business is reached only through
-- TenantSubscription. Nothing here references restaurant orders, payments,
-- refunds or gift cards, and nothing here moves money.
--
-- ADDITIVE: three tables, two nullable columns, four enum values, CHECK
-- constraints, partial unique indexes and guard triggers. No existing row
-- changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261102090000_operator_billing_controls.down.sql.

-- TenantSubscriptionEventType: + complimentary history ----------------------------
ALTER TABLE "TenantSubscriptionEvent" DROP CONSTRAINT "TenantSubscriptionEvent_shape_check";
ALTER TYPE "TenantSubscriptionEventType" RENAME TO "TenantSubscriptionEventType_sc3e1";
CREATE TYPE "TenantSubscriptionEventType" AS ENUM (
  'PLAN_ASSIGNED', 'PLAN_CHANGED', 'ADDON_GRANTED', 'ADDON_REVOKED',
  'TRIAL_STARTED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED',
  'GRACE_EXPIRED', 'TRIAL_EXPIRED', 'CANCEL_SCHEDULED', 'CANCEL_UNDONE', 'CANCELED',
  'PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED',
  'RECOVERY_EXPIRED', 'BILLING_SUSPENDED', 'BILLING_SUSPENSION_LIFTED',
  'SUBSCRIPTION_REPLACED',
  'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED',
  'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_STARTED', 'COMPLIMENTARY_WITHDRAWN',
  'COMPLIMENTARY_ENDED'
);
ALTER TABLE "TenantSubscriptionEvent"
  ALTER COLUMN "type" TYPE "TenantSubscriptionEventType"
  USING ("type"::text::"TenantSubscriptionEventType");
DROP TYPE "TenantSubscriptionEventType_sc3e1";

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
                     'GRACE_EXTENDED', 'GRACE_EXCEPTION_GRANTED', 'GRACE_EXCEPTION_EXPIRED',
                     'COMPLIMENTARY_SCHEDULED', 'COMPLIMENTARY_WITHDRAWN')
          AND "toStatus" IS NOT NULL AND "moduleKey" IS NULL)
      OR ("type" IN ('PLAN_CHANGE_PENDING', 'PLAN_CHANGE_APPLIED', 'PLAN_CHANGE_ABANDONED')
          AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
      -- A complimentary start / end records the plan it moved to and the status.
      OR ("type" IN ('COMPLIMENTARY_STARTED', 'COMPLIMENTARY_ENDED')
          AND "toStatus" IS NOT NULL AND "toPlanVersionId" IS NOT NULL AND "moduleKey" IS NULL)
    )
    AND ("source" = 'BILLING_PROVIDER') = ("billingProviderEventId" IS NOT NULL)
  );

-- AlterTable
ALTER TABLE "BillingReconciliationCase" ADD COLUMN     "resolutionNote" TEXT,
ADD COLUMN     "resolutionOutcome" TEXT;

-- CreateTable
CREATE TABLE "PlatformOperatorPermission" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "grantReason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "PlatformOperatorPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingComplimentaryGrant" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "grantedByOperatorId" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "previousPlanVersionId" TEXT NOT NULL,
    "previousPlanPriceId" TEXT NOT NULL,
    "previousBillingProvider" TEXT NOT NULL,
    "previousExternalCustomerId" TEXT NOT NULL,
    "previousExternalSubscriptionId" TEXT,
    "previousTrialStartedAt" TIMESTAMP(3),
    "previousTrialEndsAt" TIMESTAMP(3),
    "previousTrialRequiresPaymentMethod" BOOLEAN,
    "effectiveAt" TIMESTAMP(3),
    "cancelVerifiedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "finishCode" TEXT,
    "finishReason" TEXT,
    "finishedByOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingComplimentaryGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReconciliationCaseAction" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "note" TEXT,
    "externalScheduleId" TEXT,
    "actorPlatformOperatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingReconciliationCaseAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatformOperatorPermission_operatorId_idx" ON "PlatformOperatorPermission"("operatorId");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_subscriptionId_createdAt_idx" ON "BillingComplimentaryGrant"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_status_endsAt_idx" ON "BillingComplimentaryGrant"("status", "endsAt");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_planVersionId_idx" ON "BillingComplimentaryGrant"("planVersionId");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_previousPlanVersionId_idx" ON "BillingComplimentaryGrant"("previousPlanVersionId");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_previousPlanPriceId_idx" ON "BillingComplimentaryGrant"("previousPlanPriceId");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_grantedByOperatorId_idx" ON "BillingComplimentaryGrant"("grantedByOperatorId");

-- CreateIndex
CREATE INDEX "BillingComplimentaryGrant_finishedByOperatorId_idx" ON "BillingComplimentaryGrant"("finishedByOperatorId");

-- CreateIndex
CREATE INDEX "BillingReconciliationCaseAction_caseId_createdAt_idx" ON "BillingReconciliationCaseAction"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingReconciliationCaseAction_actorPlatformOperatorId_idx" ON "BillingReconciliationCaseAction"("actorPlatformOperatorId");

-- AddForeignKey
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_previousPlanVersionId_fkey" FOREIGN KEY ("previousPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_previousPlanPriceId_fkey" FOREIGN KEY ("previousPlanPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_grantedByOperatorId_fkey" FOREIGN KEY ("grantedByOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_finishedByOperatorId_fkey" FOREIGN KEY ("finishedByOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingReconciliationCaseAction" ADD CONSTRAINT "BillingReconciliationCaseAction_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "BillingReconciliationCase"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingReconciliationCaseAction" ADD CONSTRAINT "BillingReconciliationCaseAction_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Checks --------------------------------------------------------------------------

-- The permissions an operator can hold (least privilege: one per kind of
-- billing action; reads need none). A reason of real length; a revocation
-- carries its reason.
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_shape_check"
  CHECK (
    "permission" IN (
      'billing.prices.manage',
      'billing.policy.manage',
      'billing.accounts.manage',
      'billing.reconciliation.run',
      'billing.cases.manage',
      'billing.schedules.release',
      'billing.complimentary.manage'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );

-- At most one live grant per operator and permission.
CREATE UNIQUE INDEX "PlatformOperatorPermission_one_live_key"
  ON "PlatformOperatorPermission"("operatorId", "permission")
  WHERE "revokedAt" IS NULL;

ALTER TABLE "BillingComplimentaryGrant" ADD CONSTRAINT "BillingComplimentaryGrant_shape_check"
  CHECK (
    "status" IN ('SCHEDULED', 'ACTIVE', 'WITHDRAWN', 'ENDED')
    AND length(btrim("reason")) BETWEEN 10 AND 500
    AND ("endsAt" IS NULL OR "endsAt" > "createdAt")
    AND "previousStatus" IN ('ACTIVE', 'TRIALING', 'PAST_DUE', 'UNPAID', 'TRIAL_EXPIRED', 'CANCELED')
    AND length("previousBillingProvider") BETWEEN 1 AND 40
    AND length("previousExternalCustomerId") BETWEEN 1 AND 255
    AND ("previousExternalSubscriptionId" IS NULL OR length("previousExternalSubscriptionId") BETWEEN 1 AND 255)
    AND ("previousTrialStartedAt" IS NULL) = ("previousTrialEndsAt" IS NULL)
    AND ("previousTrialStartedAt" IS NULL) = ("previousTrialRequiresPaymentMethod" IS NULL)
    -- A scheduled grant waits for the paid subscription's period end.
    AND ("status" <> 'SCHEDULED' OR ("effectiveAt" IS NOT NULL AND "previousExternalSubscriptionId" IS NOT NULL))
    AND ("cancelVerifiedAt" IS NULL OR "effectiveAt" IS NOT NULL)
    -- Started exactly when active (or ended after being active).
    AND (("status" IN ('ACTIVE', 'ENDED')) = ("startedAt" IS NOT NULL))
    AND (("status" IN ('WITHDRAWN', 'ENDED')) = ("finishedAt" IS NOT NULL))
    AND (("status" IN ('WITHDRAWN', 'ENDED')) = ("finishCode" IS NOT NULL))
    AND ("finishCode" IS NULL OR "finishCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("finishReason" IS NULL OR length(btrim("finishReason")) BETWEEN 10 AND 500)
    AND ("finishedByOperatorId" IS NULL OR "finishReason" IS NOT NULL)
  );

-- At most one SCHEDULED or ACTIVE grant per subscription.
CREATE UNIQUE INDEX "BillingComplimentaryGrant_one_open_key"
  ON "BillingComplimentaryGrant"("subscriptionId")
  WHERE "status" IN ('SCHEDULED', 'ACTIVE');

ALTER TABLE "BillingReconciliationCaseAction" ADD CONSTRAINT "BillingReconciliationCaseAction_shape_check"
  CHECK (
    "action" IN ('RECHECKED', 'SCHEDULE_RELEASED', 'CLOSED')
    AND "result" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND ("note" IS NULL OR length(btrim("note")) BETWEEN 1 AND 1000)
    AND (("action" = 'SCHEDULE_RELEASED') = ("externalScheduleId" IS NOT NULL))
    AND ("externalScheduleId" IS NULL OR length("externalScheduleId") BETWEEN 1 AND 255)
    -- A Stripe write or a closing always says why.
    AND ("action" = 'RECHECKED' OR "note" IS NOT NULL)
  );

-- A case's closing outcome (and note) only on a resolved case.
ALTER TABLE "BillingReconciliationCase" ADD CONSTRAINT "BillingReconciliationCase_resolution_check"
  CHECK (
    ("resolutionOutcome" IS NULL OR ("status" = 'RESOLVED' AND "resolutionOutcome" ~ '^[A-Z][A-Z0-9_]{0,63}$'))
    AND ("resolutionNote" IS NULL OR ("resolutionOutcome" IS NOT NULL AND length(btrim("resolutionNote")) BETWEEN 1 AND 1000))
  );

-- Triggers --------------------------------------------------------------------------

-- A permission grant is never deleted; who holds what, why and since when
-- never changes; it is revoked once, for a reason.
CREATE FUNCTION "guard_platform_operator_permission"() RETURNS trigger
LANGUAGE plpgsql AS $guard_platform_operator_permission$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'PlatformOperatorPermission rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."operatorId" <> OLD."operatorId"
     OR NEW."permission" <> OLD."permission"
     OR NEW."grantReason" <> OLD."grantReason"
     OR NEW."grantedAt" <> OLD."grantedAt"
     OR OLD."revokedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'A platform operator permission cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_platform_operator_permission$;

CREATE TRIGGER "PlatformOperatorPermission_guard"
  BEFORE UPDATE OR DELETE ON "PlatformOperatorPermission"
  FOR EACH ROW EXECUTE FUNCTION "guard_platform_operator_permission"();
CREATE TRIGGER "PlatformOperatorPermission_no_truncate"
  BEFORE TRUNCATE ON "PlatformOperatorPermission"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_platform_operator_permission"();

-- A complimentary grant is never deleted; what was granted (plan, end,
-- reason, by whom) and what it restores never change; it only moves
-- forward: SCHEDULED -> ACTIVE | WITHDRAWN, ACTIVE -> ENDED; a finished
-- grant is final; the verified cancellation and the start are set once.
CREATE FUNCTION "guard_billing_complimentary_grant"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_complimentary_grant$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingComplimentaryGrant rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('WITHDRAWN', 'ENDED')
     OR NEW."subscriptionId" <> OLD."subscriptionId"
     OR NEW."planVersionId" <> OLD."planVersionId"
     OR NEW."endsAt" IS DISTINCT FROM OLD."endsAt"
     OR NEW."reason" <> OLD."reason"
     OR NEW."grantedByOperatorId" <> OLD."grantedByOperatorId"
     OR NEW."previousStatus" <> OLD."previousStatus"
     OR NEW."previousPlanVersionId" <> OLD."previousPlanVersionId"
     OR NEW."previousPlanPriceId" <> OLD."previousPlanPriceId"
     OR NEW."previousBillingProvider" <> OLD."previousBillingProvider"
     OR NEW."previousExternalCustomerId" <> OLD."previousExternalCustomerId"
     OR NEW."previousExternalSubscriptionId" IS DISTINCT FROM OLD."previousExternalSubscriptionId"
     OR NEW."previousTrialStartedAt" IS DISTINCT FROM OLD."previousTrialStartedAt"
     OR NEW."previousTrialEndsAt" IS DISTINCT FROM OLD."previousTrialEndsAt"
     OR NEW."previousTrialRequiresPaymentMethod" IS DISTINCT FROM OLD."previousTrialRequiresPaymentMethod"
     OR NEW."effectiveAt" IS DISTINCT FROM OLD."effectiveAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."cancelVerifiedAt" IS NOT NULL AND NEW."cancelVerifiedAt" IS DISTINCT FROM OLD."cancelVerifiedAt")
     OR (OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt")
     OR (NEW."status" <> OLD."status" AND NOT (
          (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('ACTIVE', 'WITHDRAWN'))
       OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ENDED')
     ))
  THEN
    RAISE EXCEPTION 'A complimentary grant cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_complimentary_grant$;

CREATE TRIGGER "BillingComplimentaryGrant_guard"
  BEFORE UPDATE OR DELETE ON "BillingComplimentaryGrant"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_complimentary_grant"();
CREATE TRIGGER "BillingComplimentaryGrant_no_truncate"
  BEFORE TRUNCATE ON "BillingComplimentaryGrant"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_complimentary_grant"();

-- A review-case action is history: never changed or removed.
CREATE FUNCTION "guard_billing_reconciliation_case_action"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_reconciliation_case_action$
BEGIN
  RAISE EXCEPTION 'BillingReconciliationCaseAction rows are append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$guard_billing_reconciliation_case_action$;

CREATE TRIGGER "BillingReconciliationCaseAction_guard"
  BEFORE UPDATE OR DELETE ON "BillingReconciliationCaseAction"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_reconciliation_case_action"();
CREATE TRIGGER "BillingReconciliationCaseAction_no_truncate"
  BEFORE TRUNCATE ON "BillingReconciliationCaseAction"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_reconciliation_case_action"();
