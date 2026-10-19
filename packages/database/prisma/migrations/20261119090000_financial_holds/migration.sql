-- ESP-03 PR 8 — pre-charge financial holds.
--
-- Before a restaurant payment is sent to the provider, the checkout reserves
-- what the order will spend, in the SAME transaction that creates the payment
-- attempt and its frozen checkout:
--   * PROMOTION_REDEMPTION — one redemption of the order's promotion or
--     coupon, with the signed-in customer (null for a guest) so a
--     per-customer limit, including one set later, counts it;
--   * LOYALTY_REDEMPTION   — the Mocha Beans of the chosen reward;
--   * GIFT_CARD_TENDER     — the gift-card amount (minor units).
-- What is available is the balance or limit minus every ACTIVE hold, so two
-- checkouts can never both be charged for the last of anything.
--
-- A hold is CONSUMED exactly once, when the order is created, or RELEASED
-- only once the payment is definitively DECLINED or FAILED (including
-- ABANDONED, never sent). It is kept while the payment is charging, awaiting
-- confirmation, unknown, or paid but not yet fulfilled. The database enforces
-- all of this:
--   * one hold per kind per payment attempt;
--   * every hold belongs, with its attempt and source, to one business
--     (composite foreign keys);
--   * holds are never deleted and change only ACTIVE -> CONSUMED (payment
--     SUCCEEDED) or ACTIVE -> RELEASED (payment DECLINED or FAILED);
--   * whatever records a payment as DECLINED or FAILED releases its ACTIVE
--     holds in the same statement (a trigger on PaymentAttempt), so no
--     present or future path can leave them reserved;
--   * nothing but ids, kinds, amounts and timestamps is stored (no customer
--     contact details, codes or payment credentials).
--
-- ADDITIVE ONLY: one table, its indexes and constraints, two trigger
-- functions and their triggers. No existing row changes. One DO block (atomic), read-only
-- preflight first, lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261119090000_financial_holds.down.sql.

DO $financial_holds$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Financial holds refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"FinancialHold"') IS NOT NULL THEN
    RAISE EXCEPTION 'Financial holds refused: table "FinancialHold" already exists. Nothing was changed.';
  END IF;
  IF to_regprocedure('financial_hold_guard()') IS NOT NULL
     OR to_regprocedure('release_financial_holds_on_outcome()') IS NOT NULL THEN
    RAISE EXCEPTION 'Financial holds refused: a financial hold trigger function already exists. Nothing was changed.';
  END IF;

  CREATE TABLE "FinancialHold" (
      "id" TEXT NOT NULL,
      "paymentAttemptId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "amount" INTEGER NOT NULL,
      "promotionId" TEXT,
      "customerId" TEXT,
      "loyaltyAccountId" TEXT,
      "giftCardId" TEXT,
      "releaseReason" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "consumedAt" TIMESTAMP(3),
      "releasedAt" TIMESTAMP(3),
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "FinancialHold_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "FinancialHold_amount_check" CHECK ("amount" > 0),
      -- Exactly the source its kind needs. A promotion hold is one
      -- redemption; its customer only when the limit is per customer.
      CONSTRAINT "FinancialHold_source_check" CHECK (
        ("kind" = 'PROMOTION_REDEMPTION' AND "promotionId" IS NOT NULL AND "amount" = 1
          AND "loyaltyAccountId" IS NULL AND "giftCardId" IS NULL)
        OR ("kind" = 'LOYALTY_REDEMPTION' AND "loyaltyAccountId" IS NOT NULL
          AND "promotionId" IS NULL AND "customerId" IS NULL AND "giftCardId" IS NULL)
        OR ("kind" = 'GIFT_CARD_TENDER' AND "giftCardId" IS NOT NULL
          AND "promotionId" IS NULL AND "customerId" IS NULL AND "loyaltyAccountId" IS NULL)
      ),
      CONSTRAINT "FinancialHold_status_check" CHECK (
        ("status" = 'ACTIVE' AND "consumedAt" IS NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
        OR ("status" = 'CONSUMED' AND "consumedAt" IS NOT NULL AND "releasedAt" IS NULL AND "releaseReason" IS NULL)
        OR ("status" = 'RELEASED' AND "releasedAt" IS NOT NULL AND "consumedAt" IS NULL
          AND "releaseReason" IN ('DECLINED', 'FAILED', 'ABANDONED'))
      )
  );

  CREATE UNIQUE INDEX "FinancialHold_tenantId_id_key" ON "FinancialHold"("tenantId", "id");
  -- One hold per kind per payment attempt.
  CREATE UNIQUE INDEX "FinancialHold_paymentAttemptId_kind_key" ON "FinancialHold"("paymentAttemptId", "kind");
  CREATE INDEX "FinancialHold_tenantId_idx" ON "FinancialHold"("tenantId");
  -- What is held right now, per source.
  CREATE INDEX "FinancialHold_active_promotion_idx" ON "FinancialHold"("promotionId", "customerId") WHERE "status" = 'ACTIVE';
  CREATE INDEX "FinancialHold_active_loyalty_idx" ON "FinancialHold"("loyaltyAccountId") WHERE "status" = 'ACTIVE';
  CREATE INDEX "FinancialHold_active_gift_card_idx" ON "FinancialHold"("giftCardId") WHERE "status" = 'ACTIVE';

  -- A hold, its payment attempt and its source all belong to one business.
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_loyaltyAccountId_fkey" FOREIGN KEY ("tenantId", "loyaltyAccountId") REFERENCES "CustomerLoyaltyAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_giftCardId_fkey" FOREIGN KEY ("tenantId", "giftCardId") REFERENCES "GiftCard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FinancialHold" ADD CONSTRAINT "FinancialHold_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "FinancialHold_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "FinancialHold"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- A hold is created only for a payment that may still be charged or has
  -- succeeded; it changes only from ACTIVE, to CONSUMED while its payment has
  -- SUCCEEDED or to RELEASED while its payment is DECLINED or FAILED; nothing
  -- else about it ever changes, and it is never deleted.
  CREATE FUNCTION "financial_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  DECLARE
    attempt_status text;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'A financial hold is never deleted (hold %).', OLD.id;
    END IF;
    SELECT status::text INTO attempt_status FROM "PaymentAttempt"
      WHERE id = NEW."paymentAttemptId" AND "tenantId" = NEW."tenantId";
    IF TG_OP = 'INSERT' THEN
      IF NEW.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'A financial hold is created ACTIVE (hold %).', NEW.id;
      END IF;
      IF attempt_status IS NULL OR attempt_status NOT IN ('PENDING', 'SUCCEEDED') THEN
        RAISE EXCEPTION 'A financial hold needs a payment that may still be charged or has succeeded (hold %).', NEW.id;
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW."paymentAttemptId" IS DISTINCT FROM OLD."paymentAttemptId"
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW."promotionId" IS DISTINCT FROM OLD."promotionId"
       OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
       OR NEW."loyaltyAccountId" IS DISTINCT FROM OLD."loyaltyAccountId"
       OR NEW."giftCardId" IS DISTINCT FROM OLD."giftCardId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'A financial hold''s source and amount never change (hold %).', OLD.id;
    END IF;
    IF NEW.status = OLD.status THEN
      IF NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'A settled financial hold never changes (hold %).', OLD.id;
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A financial hold is settled only once (hold %).', OLD.id;
    END IF;
    IF NEW.status = 'CONSUMED' AND attempt_status IS DISTINCT FROM 'SUCCEEDED' THEN
      RAISE EXCEPTION 'A financial hold is consumed only for a successful payment (hold %).', OLD.id;
    END IF;
    IF NEW.status = 'RELEASED' AND (attempt_status IS NULL OR attempt_status NOT IN ('DECLINED', 'FAILED')) THEN
      RAISE EXCEPTION 'A financial hold is released only once its payment definitively did not go through (hold %).', OLD.id;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "FinancialHold_guard" BEFORE INSERT OR UPDATE OR DELETE ON "FinancialHold"
    FOR EACH ROW EXECUTE FUNCTION "financial_hold_guard"();

  -- A payment recorded as DECLINED or FAILED (ABANDONED: never sent) by ANY
  -- path releases its ACTIVE holds in the same statement. Nothing else ever
  -- releases them.
  CREATE FUNCTION "release_financial_holds_on_outcome"() RETURNS trigger
  LANGUAGE plpgsql AS $release$
  BEGIN
    UPDATE "FinancialHold"
       SET status = 'RELEASED',
           "releasedAt" = CURRENT_TIMESTAMP,
           "releaseReason" = CASE
             WHEN NEW."paymentState" = 'ABANDONED' THEN 'ABANDONED'
             WHEN NEW.status::text = 'DECLINED' THEN 'DECLINED'
             ELSE 'FAILED'
           END
     WHERE "paymentAttemptId" = NEW.id
       AND "tenantId" = NEW."tenantId"
       AND status = 'ACTIVE';
    RETURN NULL;
  END
  $release$;

  CREATE TRIGGER "PaymentAttempt_release_financial_holds" AFTER UPDATE OF status ON "PaymentAttempt"
    FOR EACH ROW WHEN (NEW.status::text IN ('DECLINED', 'FAILED') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION "release_financial_holds_on_outcome"();
END
$financial_holds$;
