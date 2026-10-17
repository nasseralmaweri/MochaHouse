-- SC3d-2 rollback for migration 20261031090000_plan_change_confirmation.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC3d-2.
--
-- It restores the SC3d-1 shape. It REFUSES to run while any change was
-- confirmed or carries an operator's reason — those record a business's
-- consent to a charge and an operator's justification, and erasing them is not
-- a rollback's decision. Nothing is changed when it refuses. One DO block.

DO $plan_change_confirmation_rollback$
DECLARE
  recorded bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "BillingPlanChange" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO recorded FROM "BillingPlanChange"
   WHERE "confirmedAt" IS NOT NULL OR "operatorReason" IS NOT NULL;
  IF recorded > 0 THEN
    RAISE EXCEPTION 'SC3d-2 rollback refused: % plan change(s) were confirmed or carry an operator reason. Nothing was changed.', recorded;
  END IF;

  ALTER TABLE "BillingPlanChange" DROP CONSTRAINT "BillingPlanChange_confirmation_check";
  -- The SC3d-1 guard (it no longer mentions the dropped columns).
  EXECUTE $restore$
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
  $restore$;
  ALTER TABLE "BillingPlanChange" DROP COLUMN "confirmedAt";
  ALTER TABLE "BillingPlanChange" DROP COLUMN "operatorReason";
END
$plan_change_confirmation_rollback$;
