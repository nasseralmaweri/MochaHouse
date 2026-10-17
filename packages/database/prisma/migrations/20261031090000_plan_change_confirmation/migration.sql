-- SC3d-2 — confirming a plan change (paid upgrades and monthly -> annual).
--
-- ADDITIVE on BillingPlanChange (platform data):
--   * confirmedAt — when a business user (billing.manage) confirmed the change
--     and its charge. Operators never confirm a charge (owner decision D4);
--   * operatorReason — an operator preview's mandatory written reason;
--   * a CHECK tying them to the status and the actor, and the guard trigger
--     extended: the reason never changes, the confirmation time is set once.
-- No existing row changes (existing rows are previews: neither is set).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261031090000_plan_change_confirmation.down.sql.

ALTER TABLE "BillingPlanChange" ADD COLUMN "confirmedAt" TIMESTAMP(3),
ADD COLUMN "operatorReason" TEXT;

ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_confirmation_check"
  CHECK (
    ("status" <> 'PREVIEWED' OR "confirmedAt" IS NULL)
    AND ("status" NOT IN ('REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW', 'APPLIED')
         OR "confirmedAt" IS NOT NULL)
    AND ("confirmedAt" IS NULL OR "confirmedAt" >= "createdAt")
    AND ("operatorReason" IS NULL OR ("actorKind" = 'OPERATOR'
         AND length(btrim("operatorReason")) BETWEEN 10 AND 500))
  );

CREATE OR REPLACE FUNCTION "guard_billing_plan_change"() RETURNS trigger
LANGUAGE plpgsql AS $guard_billing_plan_change$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'BillingPlanChange rows are never removed (% refused).', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('APPLIED', 'CANCELED', 'EXPIRED', 'FAILED')
     OR NEW."subscriptionId" <> OLD."subscriptionId"
     OR NEW."timing" <> OLD."timing"
     OR NEW."fromPlanVersionId" <> OLD."fromPlanVersionId"
     OR NEW."fromPlanPriceId" <> OLD."fromPlanPriceId"
     OR NEW."toPlanVersionId" <> OLD."toPlanVersionId"
     OR NEW."toPlanPriceId" <> OLD."toPlanPriceId"
     OR NEW."currency" <> OLD."currency"
     OR NEW."previewAmountDueMinorUnits" IS DISTINCT FROM OLD."previewAmountDueMinorUnits"
     OR NEW."previewTotalMinorUnits" IS DISTINCT FROM OLD."previewTotalMinorUnits"
     OR NEW."previewTaxMinorUnits" IS DISTINCT FROM OLD."previewTaxMinorUnits"
     OR NEW."previewDiscountMinorUnits" IS DISTINCT FROM OLD."previewDiscountMinorUnits"
     OR NEW."previewProrationMinorUnits" IS DISTINCT FROM OLD."previewProrationMinorUnits"
     OR NEW."prorationDate" IS DISTINCT FROM OLD."prorationDate"
     OR NEW."externalItemId" IS DISTINCT FROM OLD."externalItemId"
     OR NEW."nextRecurringMinorUnits" <> OLD."nextRecurringMinorUnits"
     OR NEW."nextRecurringStartsAt" IS DISTINCT FROM OLD."nextRecurringStartsAt"
     OR NEW."previewExpiresAt" <> OLD."previewExpiresAt"
     OR NEW."actorKind" <> OLD."actorKind"
     OR NEW."actorPlatformOperatorId" IS DISTINCT FROM OLD."actorPlatformOperatorId"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."externalInvoiceId" IS NOT NULL AND NEW."externalInvoiceId" IS DISTINCT FROM OLD."externalInvoiceId")
     OR (OLD."externalScheduleId" IS NOT NULL AND NEW."externalScheduleId" IS DISTINCT FROM OLD."externalScheduleId")
     OR (OLD."amountPaidMinorUnits" IS NOT NULL AND NEW."amountPaidMinorUnits" IS DISTINCT FROM OLD."amountPaidMinorUnits")
     -- SC3d-2 — who previewed and why never changes; the confirmation time is
     -- set once.
     OR NEW."operatorReason" IS DISTINCT FROM OLD."operatorReason"
     OR (OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS DISTINCT FROM OLD."confirmedAt")
     -- Only forward moves: a preview is confirmed or expires; a request
     -- waits for payment or its schedule (or is reviewed), and then ends.
     OR (NEW."status" <> OLD."status" AND NOT (
          (OLD."status" = 'PREVIEWED' AND NEW."status" IN ('REQUESTED', 'EXPIRED'))
       OR (OLD."status" = 'REQUESTED' AND NEW."status" IN ('AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW', 'APPLIED', 'CANCELED', 'FAILED'))
       OR (OLD."status" = 'AWAITING_PAYMENT' AND NEW."status" IN ('REVIEW', 'APPLIED', 'CANCELED', 'EXPIRED', 'FAILED'))
       OR (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('REVIEW', 'APPLIED', 'CANCELED', 'FAILED'))
       OR (OLD."status" = 'REVIEW' AND NEW."status" IN ('APPLIED', 'CANCELED', 'FAILED'))
     ))
  THEN
    RAISE EXCEPTION 'A billing plan change cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_billing_plan_change$;
