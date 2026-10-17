-- SC3e-3 — CENTERIVO subscription refunds and credits (owner decisions D1–D7):
--   * BillingAdjustment: a refund (to the original payment method) or a
--     credit (toward future invoices) on one of a business's paid invoices,
--     as a Stripe credit note — requested, approved by one or two OTHER
--     operators, executed, confirmed from Stripe; or an EXTERNAL one made
--     directly in Stripe, recorded for review;
--   * BillingAdjustmentDecision / BillingAdjustmentEvent: the append-only
--     approval and execution history;
--   * three more operator permissions and how each grant was made
--     (authenticated console grant, or the recorded bootstrap).
--
-- Platform billing data (no tenantId): a business is reached only through
-- TenantSubscription. Nothing here references restaurant orders, payments
-- or refunds (owner decision: completely separate).
--
-- ADDITIVE: three tables, five nullable / defaulted columns, CHECK
-- constraints, a partial unique index and guard triggers; the permission
-- CHECK and guard are replaced with supersets. No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261103090000_billing_adjustments.down.sql.

-- AlterTable
ALTER TABLE "PlatformOperatorPermission" ADD COLUMN     "approvalReference" TEXT,
ADD COLUMN     "executedBy" TEXT,
ADD COLUMN     "grantedByOperatorId" TEXT,
ADD COLUMN     "grantedVia" TEXT NOT NULL DEFAULT 'CLI',
ADD COLUMN     "revokedByOperatorId" TEXT;

-- CreateTable
CREATE TABLE "BillingAdjustment" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "totalMinorUnits" INTEGER NOT NULL,
    "taxMinorUnits" INTEGER NOT NULL DEFAULT 0,
    "annualFullRefund" BOOLEAN NOT NULL DEFAULT false,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "requestedByOperatorId" TEXT,
    "lineSpec" JSONB,
    "expiresAt" TIMESTAMP(3),
    "executionStartedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "externalCreditNoteId" TEXT,
    "externalRefundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAdjustmentDecision" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAdjustmentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAdjustmentEvent" (
    "id" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "code" TEXT,
    "note" TEXT,
    "actorPlatformOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAdjustmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAdjustment_externalCreditNoteId_key" ON "BillingAdjustment"("externalCreditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAdjustment_externalRefundId_key" ON "BillingAdjustment"("externalRefundId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_subscriptionId_createdAt_idx" ON "BillingAdjustment"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingAdjustment_invoiceId_idx" ON "BillingAdjustment"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_status_expiresAt_idx" ON "BillingAdjustment"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BillingAdjustment_requestedByOperatorId_idx" ON "BillingAdjustment"("requestedByOperatorId");

-- CreateIndex
CREATE INDEX "BillingAdjustmentDecision_operatorId_idx" ON "BillingAdjustmentDecision"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAdjustmentDecision_adjustmentId_operatorId_key" ON "BillingAdjustmentDecision"("adjustmentId", "operatorId");

-- CreateIndex
CREATE INDEX "BillingAdjustmentEvent_adjustmentId_createdAt_idx" ON "BillingAdjustmentEvent"("adjustmentId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingAdjustmentEvent_actorPlatformOperatorId_idx" ON "BillingAdjustmentEvent"("actorPlatformOperatorId");

-- CreateIndex
CREATE INDEX "PlatformOperatorPermission_grantedByOperatorId_idx" ON "PlatformOperatorPermission"("grantedByOperatorId");

-- CreateIndex
CREATE INDEX "PlatformOperatorPermission_revokedByOperatorId_idx" ON "PlatformOperatorPermission"("revokedByOperatorId");

-- AddForeignKey
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_grantedByOperatorId_fkey" FOREIGN KEY ("grantedByOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_revokedByOperatorId_fkey" FOREIGN KEY ("revokedByOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_requestedByOperatorId_fkey" FOREIGN KEY ("requestedByOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustmentDecision" ADD CONSTRAINT "BillingAdjustmentDecision_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "BillingAdjustment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustmentDecision" ADD CONSTRAINT "BillingAdjustmentDecision_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustmentEvent" ADD CONSTRAINT "BillingAdjustmentEvent_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "BillingAdjustment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingAdjustmentEvent" ADD CONSTRAINT "BillingAdjustmentEvent_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Permissions -------------------------------------------------------------------

-- SC3e-3 — three more permissions (financial: billing.adjustments.request,
-- billing.adjustments.approve; and platform.permissions.manage, to grant
-- permissions through the authenticated console).
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
      'platform.permissions.manage'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );

-- How a grant was made (owner decision D7): a CONSOLE grant names the
-- authenticated operator who made it (never the holder); a CLI_BOOTSTRAP
-- grant records who ran it and the independent approval's reference; the
-- financial permissions are never granted by the plain CLI.
ALTER TABLE "PlatformOperatorPermission" ADD CONSTRAINT "PlatformOperatorPermission_grant_check"
  CHECK (
    "grantedVia" IN ('CLI', 'CLI_BOOTSTRAP', 'CONSOLE')
    AND (("grantedVia" = 'CONSOLE') = ("grantedByOperatorId" IS NOT NULL))
    AND ("grantedByOperatorId" IS NULL OR "grantedByOperatorId" <> "operatorId")
    AND (("grantedVia" = 'CLI_BOOTSTRAP') = ("approvalReference" IS NOT NULL))
    AND (("grantedVia" = 'CLI_BOOTSTRAP') = ("executedBy" IS NOT NULL))
    AND ("approvalReference" IS NULL OR length(btrim("approvalReference")) BETWEEN 3 AND 200)
    AND ("executedBy" IS NULL OR length(btrim("executedBy")) BETWEEN 1 AND 200)
    AND NOT ("grantedVia" = 'CLI' AND "permission" IN (
      'billing.adjustments.request', 'billing.adjustments.approve', 'platform.permissions.manage'))
    AND ("revokedByOperatorId" IS NULL OR "revokedAt" IS NOT NULL)
  );

-- The grant guard (SC3e-2), now also keeping who granted it and how; a
-- revocation may name the operator who revoked it.
CREATE OR REPLACE FUNCTION "guard_platform_operator_permission"() RETURNS trigger
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
     OR NEW."grantedVia" <> OLD."grantedVia"
     OR NEW."grantedByOperatorId" IS DISTINCT FROM OLD."grantedByOperatorId"
     OR NEW."approvalReference" IS DISTINCT FROM OLD."approvalReference"
     OR NEW."executedBy" IS DISTINCT FROM OLD."executedBy"
     OR OLD."revokedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'A platform operator permission cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_platform_operator_permission$;

-- Adjustments -------------------------------------------------------------------

ALTER TABLE "BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_shape_check"
  CHECK (
    "origin" IN ('CENTERIVO', 'EXTERNAL')
    AND "kind" IN ('REFUND', 'CREDIT', 'OUT_OF_BAND')
    AND "currency" ~ '^[a-z]{3}$'
    AND "totalMinorUnits" > 0
    AND "taxMinorUnits" >= 0
    AND "taxMinorUnits" <= "totalMinorUnits"
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("externalCreditNoteId" IS NULL OR length("externalCreditNoteId") BETWEEN 1 AND 255)
    AND ("externalRefundId" IS NULL OR length("externalRefundId") BETWEEN 1 AND 255)
    AND (
      -- CENTERIVO: requested by an operator, with a reason, an approval
      -- count fixed by the policy, the previewed lines and an expiry.
      ("origin" = 'CENTERIVO'
        AND "kind" IN ('REFUND', 'CREDIT')
        AND "scope" IN ('FULL', 'PARTIAL')
        AND "status" IN ('PENDING_APPROVAL', 'EXECUTING', 'SUBMITTED', 'SUCCEEDED',
                         'REJECTED', 'CANCELED', 'EXPIRED', 'FAILED', 'REVIEW')
        AND "requestedByOperatorId" IS NOT NULL
        AND "reason" IS NOT NULL AND length(btrim("reason")) BETWEEN 10 AND 500
        AND "requiredApprovals" IN (1, 2)
        AND "lineSpec" IS NOT NULL
        AND "expiresAt" IS NOT NULL
        AND (NOT "annualFullRefund" OR ("kind" = 'REFUND' AND "scope" = 'FULL' AND "requiredApprovals" = 2))
        AND (("status" IN ('EXECUTING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'REVIEW'))
             = ("executionStartedAt" IS NOT NULL) OR "status" = 'FAILED')
        AND ("status" NOT IN ('SUBMITTED', 'SUCCEEDED') OR "externalCreditNoteId" IS NOT NULL)
        AND (("status" IN ('SUCCEEDED', 'REJECTED', 'CANCELED', 'EXPIRED', 'FAILED')) = ("finishedAt" IS NOT NULL)))
      OR
      -- EXTERNAL: what Stripe holds, recorded; never approved here.
      ("origin" = 'EXTERNAL'
        AND "status" = 'RECORDED'
        AND "scope" IS NULL
        AND "requestedByOperatorId" IS NULL
        AND "requiredApprovals" = 0
        AND "lineSpec" IS NULL
        AND NOT "annualFullRefund"
        AND ("externalCreditNoteId" IS NOT NULL OR "externalRefundId" IS NOT NULL)
        AND "finishedAt" IS NOT NULL)
    )
  );

-- At most one open CENTERIVO adjustment per invoice.
CREATE UNIQUE INDEX "BillingAdjustment_one_open_key"
  ON "BillingAdjustment"("invoiceId")
  WHERE "origin" = 'CENTERIVO'
    AND "status" IN ('PENDING_APPROVAL', 'EXECUTING', 'SUBMITTED', 'REVIEW');

ALTER TABLE "BillingAdjustmentDecision" ADD CONSTRAINT "BillingAdjustmentDecision_shape_check"
  CHECK (
    "decision" IN ('APPROVED', 'REJECTED')
    AND length(btrim("note")) BETWEEN 10 AND 500
  );

ALTER TABLE "BillingAdjustmentEvent" ADD CONSTRAINT "BillingAdjustmentEvent_shape_check"
  CHECK (
    "type" ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND ("code" IS NULL OR "code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("note" IS NULL OR length(btrim("note")) BETWEEN 10 AND 500)
    -- A note is an operator's: never without one.
    AND ("note" IS NULL OR "actorPlatformOperatorId" IS NOT NULL)
  );

-- Triggers --------------------------------------------------------------------------

-- An adjustment is never deleted; what was requested (and by whom, for what
-- invoice, how much, of which kind) never changes; the provider's credit
-- note and refund ids are set once; its status only moves forward; a
-- finished adjustment is final; an external one never changes.
CREATE FUNCTION "guard_billing_adjustment"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_adjustment$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingAdjustment rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."origin" = 'EXTERNAL'
     OR OLD."status" IN ('SUCCEEDED', 'REJECTED', 'CANCELED', 'EXPIRED', 'FAILED')
     OR NEW."subscriptionId" <> OLD."subscriptionId"
     OR NEW."invoiceId" <> OLD."invoiceId"
     OR NEW."origin" <> OLD."origin"
     OR NEW."kind" <> OLD."kind"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."currency" <> OLD."currency"
     OR NEW."totalMinorUnits" <> OLD."totalMinorUnits"
     OR NEW."taxMinorUnits" <> OLD."taxMinorUnits"
     OR NEW."annualFullRefund" <> OLD."annualFullRefund"
     OR NEW."requiredApprovals" <> OLD."requiredApprovals"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."requestedByOperatorId" IS DISTINCT FROM OLD."requestedByOperatorId"
     OR NEW."lineSpec"::text IS DISTINCT FROM OLD."lineSpec"::text
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."executionStartedAt" IS NOT NULL AND NEW."executionStartedAt" IS DISTINCT FROM OLD."executionStartedAt")
     OR (OLD."externalCreditNoteId" IS NOT NULL AND NEW."externalCreditNoteId" IS DISTINCT FROM OLD."externalCreditNoteId")
     OR (OLD."externalRefundId" IS NOT NULL AND NEW."externalRefundId" IS DISTINCT FROM OLD."externalRefundId")
     OR (NEW."status" <> OLD."status" AND NOT (
          (OLD."status" = 'PENDING_APPROVAL' AND NEW."status" IN ('EXECUTING', 'REJECTED', 'CANCELED', 'EXPIRED'))
       OR (OLD."status" = 'EXECUTING' AND NEW."status" IN ('SUBMITTED', 'SUCCEEDED', 'FAILED', 'REVIEW'))
       OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('SUCCEEDED', 'REVIEW'))
       OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('SUBMITTED', 'SUCCEEDED', 'FAILED'))
     ))
  THEN
    RAISE EXCEPTION 'A billing adjustment cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Carried out only with the approvals the policy requires: distinct
  -- operators, never the requester, before the request expired.
  IF OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'EXECUTING' AND (
       OLD."expiresAt" IS NULL OR OLD."expiresAt" <= now()
       OR (SELECT count(DISTINCT d."operatorId") FROM "BillingAdjustmentDecision" d
             WHERE d."adjustmentId" = OLD."id" AND d."decision" = 'APPROVED'
               AND d."operatorId" IS DISTINCT FROM OLD."requestedByOperatorId")
          < OLD."requiredApprovals"
       OR EXISTS (SELECT 1 FROM "BillingAdjustmentDecision" d
             WHERE d."adjustmentId" = OLD."id" AND d."decision" = 'REJECTED'))
  THEN
    RAISE EXCEPTION 'A billing adjustment is carried out only with its required approvals, before it expires.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_adjustment$;

CREATE TRIGGER "BillingAdjustment_guard"
  BEFORE UPDATE OR DELETE ON "BillingAdjustment"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_adjustment"();
CREATE TRIGGER "BillingAdjustment_no_truncate"
  BEFORE TRUNCATE ON "BillingAdjustment"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_adjustment"();

-- Separation of duties, in the database too: a decision is never the
-- requester's own, and only on a CENTERIVO adjustment awaiting approval.
-- Decisions and events are append-only.
CREATE FUNCTION "guard_billing_adjustment_decision"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_adjustment_decision$
DECLARE
  adjustment RECORD;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'BillingAdjustmentDecision rows are append-only (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "origin", "status", "requestedByOperatorId", "expiresAt" INTO adjustment
    FROM "BillingAdjustment" WHERE "id" = NEW."adjustmentId";
  IF adjustment."origin" <> 'CENTERIVO'
     OR adjustment."status" <> 'PENDING_APPROVAL'
     OR adjustment."requestedByOperatorId" = NEW."operatorId"
     OR adjustment."expiresAt" IS NULL
     OR adjustment."expiresAt" <= now()
  THEN
    RAISE EXCEPTION 'This decision is not allowed (own request, or not awaiting approval).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_adjustment_decision$;

CREATE TRIGGER "BillingAdjustmentDecision_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "BillingAdjustmentDecision"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_adjustment_decision"();
CREATE TRIGGER "BillingAdjustmentDecision_no_truncate"
  BEFORE TRUNCATE ON "BillingAdjustmentDecision"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_adjustment_decision"();

CREATE FUNCTION "guard_billing_adjustment_event"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_adjustment_event$
BEGIN
  RAISE EXCEPTION 'BillingAdjustmentEvent rows are append-only (% refused).', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$guard_billing_adjustment_event$;

CREATE TRIGGER "BillingAdjustmentEvent_guard"
  BEFORE UPDATE OR DELETE ON "BillingAdjustmentEvent"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_adjustment_event"();
CREATE TRIGGER "BillingAdjustmentEvent_no_truncate"
  BEFORE TRUNCATE ON "BillingAdjustmentEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_adjustment_event"();
