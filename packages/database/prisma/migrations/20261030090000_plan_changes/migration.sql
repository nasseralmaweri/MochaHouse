-- SC3d-1 — the foundation for plan changes (upgrades, downgrades, monthly <->
-- annual, the plan a trial becomes). Nothing here charges, changes a
-- subscription or grants a module: SC3d-1 only PREVIEWS a change with the
-- billing provider's own calculation and records that preview.
--
-- Platform billing data (no tenantId): the business is reached only through
-- TenantSubscription. Nothing here references restaurant orders, payments,
-- refunds or gift cards.
--
-- ADDITIVE: the BillingPlanChange table, its CHECK constraint, a partial
-- unique index (at most ONE open change per subscription) and a guard
-- trigger (never deleted; what was previewed never changes; a finished change
-- is final). No existing row changes.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261030090000_plan_changes.down.sql.

-- CreateTable
CREATE TABLE "BillingPlanChange" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "timing" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREVIEWED',
    "fromPlanVersionId" TEXT NOT NULL,
    "fromPlanPriceId" TEXT NOT NULL,
    "toPlanVersionId" TEXT NOT NULL,
    "toPlanPriceId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "previewAmountDueMinorUnits" INTEGER,
    "previewTotalMinorUnits" INTEGER,
    "previewTaxMinorUnits" INTEGER,
    "previewDiscountMinorUnits" INTEGER,
    "previewProrationMinorUnits" INTEGER,
    "prorationDate" TIMESTAMP(3),
    "externalItemId" TEXT,
    "nextRecurringMinorUnits" INTEGER NOT NULL,
    "nextRecurringStartsAt" TIMESTAMP(3),
    "previewExpiresAt" TIMESTAMP(3) NOT NULL,
    "externalInvoiceId" TEXT,
    "externalScheduleId" TEXT,
    "amountPaidMinorUnits" INTEGER,
    "failureCode" TEXT,
    "actorKind" TEXT NOT NULL,
    "actorPlatformOperatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BillingPlanChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingPlanChange_subscriptionId_status_idx" ON "BillingPlanChange"("subscriptionId", "status");

-- CreateIndex
CREATE INDEX "BillingPlanChange_fromPlanVersionId_idx" ON "BillingPlanChange"("fromPlanVersionId");

-- CreateIndex
CREATE INDEX "BillingPlanChange_toPlanVersionId_idx" ON "BillingPlanChange"("toPlanVersionId");

-- CreateIndex
CREATE INDEX "BillingPlanChange_fromPlanPriceId_idx" ON "BillingPlanChange"("fromPlanPriceId");

-- CreateIndex
CREATE INDEX "BillingPlanChange_toPlanPriceId_idx" ON "BillingPlanChange"("toPlanPriceId");

-- CreateIndex
CREATE INDEX "BillingPlanChange_actorPlatformOperatorId_idx" ON "BillingPlanChange"("actorPlatformOperatorId");

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_fromPlanVersionId_fkey" FOREIGN KEY ("fromPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_toPlanVersionId_fkey" FOREIGN KEY ("toPlanVersionId") REFERENCES "SubscriptionPlanVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_fromPlanPriceId_fkey" FOREIGN KEY ("fromPlanPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_toPlanPriceId_fkey" FOREIGN KEY ("toPlanPriceId") REFERENCES "SubscriptionPlanPrice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_actorPlatformOperatorId_fkey" FOREIGN KEY ("actorPlatformOperatorId") REFERENCES "PlatformOperator"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Checks --------------------------------------------------------------------------
ALTER TABLE "BillingPlanChange" ADD CONSTRAINT "BillingPlanChange_shape_check"
  CHECK (
    "timing" IN ('IMMEDIATE', 'PERIOD_END', 'TRIAL_END')
    AND "status" IN ('PREVIEWED', 'REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED',
                     'REVIEW', 'APPLIED', 'CANCELED', 'EXPIRED', 'FAILED')
    AND "currency" ~ '^[A-Z]{3}$'
    AND "fromPlanPriceId" <> "toPlanPriceId"
    AND "previewExpiresAt" > "createdAt"
    AND "nextRecurringMinorUnits" >= 0
    -- An immediate change carries the provider's preview of the charge and
    -- the proration date it was computed for; the others charge nothing now.
    AND (("timing" = 'IMMEDIATE') = ("previewAmountDueMinorUnits" IS NOT NULL))
    AND (("timing" = 'IMMEDIATE') = ("prorationDate" IS NOT NULL))
    AND (("timing" = 'IMMEDIATE') = ("externalItemId" IS NOT NULL))
    AND ("timing" = 'IMMEDIATE' OR ("previewTotalMinorUnits" IS NULL
         AND "previewTaxMinorUnits" IS NULL AND "previewDiscountMinorUnits" IS NULL
         AND "previewProrationMinorUnits" IS NULL))
    AND ("previewAmountDueMinorUnits" IS NULL OR "previewAmountDueMinorUnits" >= 0)
    AND ("previewTaxMinorUnits" IS NULL OR "previewTaxMinorUnits" >= 0)
    AND ("previewDiscountMinorUnits" IS NULL OR "previewDiscountMinorUnits" >= 0)
    AND ("amountPaidMinorUnits" IS NULL OR "amountPaidMinorUnits" >= 0)
    AND "actorKind" IN ('STAFF', 'OPERATOR')
    AND (("actorKind" = 'OPERATOR') = ("actorPlatformOperatorId" IS NOT NULL))
    AND (("status" IN ('APPLIED', 'CANCELED', 'EXPIRED', 'FAILED')) = ("finishedAt" IS NOT NULL))
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("externalItemId" IS NULL OR length("externalItemId") BETWEEN 1 AND 255)
    AND ("externalInvoiceId" IS NULL OR length("externalInvoiceId") BETWEEN 1 AND 255)
    AND ("externalScheduleId" IS NULL OR length("externalScheduleId") BETWEEN 1 AND 255)
  );

-- At most ONE open change per subscription (a preview is not a change).
CREATE UNIQUE INDEX "BillingPlanChange_one_open_key"
  ON "BillingPlanChange"("subscriptionId")
  WHERE "status" IN ('REQUESTED', 'AWAITING_PAYMENT', 'SCHEDULED', 'REVIEW');

-- Triggers --------------------------------------------------------------------------

-- Never deleted; what was previewed (and for whom, by whom) never changes;
-- the provider's invoice / schedule ids are set once; a finished change never
-- changes again.
CREATE FUNCTION "guard_billing_plan_change"() RETURNS trigger
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

CREATE TRIGGER "BillingPlanChange_guard"
  BEFORE UPDATE OR DELETE ON "BillingPlanChange"
  FOR EACH ROW EXECUTE FUNCTION "guard_billing_plan_change"();
CREATE TRIGGER "BillingPlanChange_no_truncate"
  BEFORE TRUNCATE ON "BillingPlanChange"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_billing_plan_change"();
