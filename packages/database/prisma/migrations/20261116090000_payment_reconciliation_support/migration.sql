-- ESP-03 PR 5 — payment reconciliation support in the Platform Console:
--   * two operator permissions: payments.reconciliation.view (read the
--     restaurant payment reconciliation cases) and
--     payments.reconciliation.manage (trigger a safe recovery attempt and
--     record investigation notes). Granted only through the existing
--     audited grant flows; nobody receives them automatically;
--   * PaymentReconciliationNote: platform support's append-only
--     investigation notes on a case. Tenant-owned like its case (composite
--     key); the operator is a plain value, never a foreign key to platform
--     data. A database trigger refuses every UPDATE and DELETE.
--
-- ADDITIVE ONLY: one table, its checks and guards, and the permission CHECK
-- replaced with a superset. No existing row changes. A read-only preflight
-- refuses (changing nothing) if the ownership guard function is missing or
-- the table already exists.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261116090000_payment_reconciliation_support.down.sql.

DO $payment_reconciliation_support_preflight$
BEGIN
  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Payment reconciliation support refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"PaymentReconciliationNote"') IS NOT NULL THEN
    RAISE EXCEPTION 'Payment reconciliation support refused: table "PaymentReconciliationNote" already exists. Nothing was changed.';
  END IF;
END
$payment_reconciliation_support_preflight$;

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
        'storefront.manage',
        'payments.reconciliation.view',
        'payments.reconciliation.manage'
    )
    AND length(btrim("grantReason")) BETWEEN 10 AND 500
    AND ("revokedAt" IS NULL) = ("revokeReason" IS NULL)
    AND ("revokeReason" IS NULL OR length(btrim("revokeReason")) BETWEEN 10 AND 500)
    AND ("revokedAt" IS NULL OR "revokedAt" >= "grantedAt")
  );

-- Investigation notes --------------------------------------------------------------
CREATE TABLE "PaymentReconciliationNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorPlatformOperatorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "PaymentReconciliationNote_pkey" PRIMARY KEY ("id"),
    -- 1–1000 characters with at least one that is not whitespace (of any
    -- kind: spaces, tabs, line breaks).
    CONSTRAINT "PaymentReconciliationNote_body_check" CHECK (
      char_length("body") BETWEEN 1 AND 1000 AND "body" ~ '[^[:space:]]'
    ),
    CONSTRAINT "PaymentReconciliationNote_author_check" CHECK (
      char_length("authorPlatformOperatorId") BETWEEN 1 AND 64
    )
);

CREATE INDEX "PaymentReconciliationNote_tenantId_caseId_idx" ON "PaymentReconciliationNote"("tenantId", "caseId");

CREATE UNIQUE INDEX "PaymentReconciliationNote_tenantId_id_key" ON "PaymentReconciliationNote"("tenantId", "id");

-- The note's case must belong to the same business (composite key).
ALTER TABLE "PaymentReconciliationNote" ADD CONSTRAINT "PaymentReconciliationNote_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "PaymentReconciliationCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "PaymentReconciliationNote" ADD CONSTRAINT "PaymentReconciliationNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A business-owned row never moves to another business (the Security 4C
-- ownership guard every tenant-owned table carries).
CREATE TRIGGER "PaymentReconciliationNote_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PaymentReconciliationNote"
  FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION "reject_tenant_reassignment"();

-- Append-only: a note, once written, is history.
CREATE FUNCTION "reject_payment_reconciliation_note_change"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'PaymentReconciliationNote is append-only: % is not allowed.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$fn$;
CREATE TRIGGER "PaymentReconciliationNote_append_only" BEFORE UPDATE OR DELETE ON "PaymentReconciliationNote"
  FOR EACH ROW EXECUTE FUNCTION "reject_payment_reconciliation_note_change"();
