-- V1 Sales Tax PR 2 — sales tax on restaurant orders.
--
-- Checkout calculates sales tax from the location's CONFIRMED tax settings
-- (V1 Sales Tax PR 1) when SALES_TAX_ENABLED is on, freezes the calculation
-- with the rest of the checkout before the customer is charged, and the
-- order keeps it as an immutable snapshot.
--
--   * Order.taxMinorUnits — the tax charged on the order (>= 0). Existing
--     orders get 0: nothing is retroactive. It never changes after the order
--     is created (trigger), and an order with tax always has its snapshot
--     (deferred trigger, checked at commit).
--   * OrderTaxSnapshot — one per taxed order, written once, never updated or
--     deleted (trigger). Its totals reconcile by CHECK
--     (total = subtotal - discounts + tax; charged = total - gift card) and,
--     on insert, against the order's own amounts (trigger). `detail` holds
--     the full calculation (components, rates, classes, taxable amounts,
--     per-line allocations).
--   * CheckoutSnapshot.version may be 3: the frozen checkout with its tax.
--
-- ADDITIVE ONLY: one column, one table, constraints and trigger guards. The
-- column has a constant default (no table rewrite). One DO block (atomic),
-- read-only preflight first, lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261203090000_order_sales_tax.down.sql.

DO $order_sales_tax$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Order sales tax refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"LocationTaxVersion"') IS NULL THEN
    RAISE EXCEPTION 'Order sales tax refused: the V1 Sales Tax PR 1 tables are missing. Nothing was changed.';
  END IF;
  IF to_regclass('"OrderTaxSnapshot"') IS NOT NULL
     OR to_regprocedure('order_tax_snapshot_guard()') IS NOT NULL
     OR to_regprocedure('order_tax_amount_frozen()') IS NOT NULL
     OR to_regprocedure('order_tax_snapshot_required()') IS NOT NULL THEN
    RAISE EXCEPTION 'Order sales tax refused: a table or function it creates already exists. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'Order' AND column_name = 'taxMinorUnits'
  ) THEN
    RAISE EXCEPTION 'Order sales tax refused: Order.taxMinorUnits already exists. Nothing was changed.';
  END IF;

  -- --- the order's tax -----------------------------------------------------

  ALTER TABLE "Order" ADD COLUMN "taxMinorUnits" INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_taxMinorUnits_check" CHECK ("taxMinorUnits" >= 0);

  -- The tax charged never changes after the order is created.
  CREATE FUNCTION "order_tax_amount_frozen"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'An order''s sales tax never changes after it is created (%).', OLD.id;
  END
  $guard$;
  CREATE TRIGGER "Order_taxMinorUnits_frozen" BEFORE UPDATE OF "taxMinorUnits" ON "Order"
    FOR EACH ROW WHEN (OLD."taxMinorUnits" IS DISTINCT FROM NEW."taxMinorUnits")
    EXECUTE FUNCTION "order_tax_amount_frozen"();

  -- --- the immutable snapshot ----------------------------------------------

  CREATE TABLE "OrderTaxSnapshot" (
      "id" TEXT NOT NULL,
      "orderId" TEXT NOT NULL,
      "locationTaxVersionId" TEXT NOT NULL,
      "taxVersion" INTEGER NOT NULL,
      "source" TEXT NOT NULL,
      "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
      "calculationVersion" INTEGER NOT NULL DEFAULT 1,
      "currency" TEXT NOT NULL,
      "merchandiseSubtotal" INTEGER NOT NULL,
      "discountMinorUnits" INTEGER NOT NULL,
      "taxableMinorUnits" INTEGER NOT NULL,
      "taxMinorUnits" INTEGER NOT NULL,
      "totalMinorUnits" INTEGER NOT NULL,
      "giftCardTenderMinorUnits" INTEGER NOT NULL,
      "chargedMinorUnits" INTEGER NOT NULL,
      "detail" JSONB NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "OrderTaxSnapshot_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "OrderTaxSnapshot_source_check" CHECK ("source" IN ('BUILT_IN')),
      CONSTRAINT "OrderTaxSnapshot_tax_exclusive_check" CHECK (NOT "pricesIncludeTax"),
      CONSTRAINT "OrderTaxSnapshot_calculationVersion_check" CHECK ("calculationVersion" = 1),
      CONSTRAINT "OrderTaxSnapshot_taxVersion_check" CHECK ("taxVersion" >= 1),
      CONSTRAINT "OrderTaxSnapshot_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
      CONSTRAINT "OrderTaxSnapshot_amounts_check" CHECK (
        "merchandiseSubtotal" >= 0 AND "discountMinorUnits" >= 0
        AND "taxableMinorUnits" >= 0 AND "taxMinorUnits" >= 0
        AND "totalMinorUnits" >= 0 AND "giftCardTenderMinorUnits" >= 0
        AND "chargedMinorUnits" >= 0
      ),
      -- The totals reconcile exactly.
      CONSTRAINT "OrderTaxSnapshot_taxable_check"
        CHECK ("taxableMinorUnits" <= "merchandiseSubtotal" - "discountMinorUnits"),
      CONSTRAINT "OrderTaxSnapshot_total_check"
        CHECK ("totalMinorUnits" = "merchandiseSubtotal" - "discountMinorUnits" + "taxMinorUnits"),
      CONSTRAINT "OrderTaxSnapshot_charged_check"
        CHECK ("chargedMinorUnits" = "totalMinorUnits" - "giftCardTenderMinorUnits"),
      CONSTRAINT "OrderTaxSnapshot_detail_check"
        CHECK (jsonb_typeof("detail") = 'object' AND pg_column_size("detail") <= 262144)
  );

  CREATE UNIQUE INDEX "OrderTaxSnapshot_orderId_key" ON "OrderTaxSnapshot"("orderId");
  CREATE UNIQUE INDEX "OrderTaxSnapshot_tenantId_id_key" ON "OrderTaxSnapshot"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderTaxSnapshot_tenantId_orderId_key" ON "OrderTaxSnapshot"("tenantId", "orderId");
  CREATE INDEX "OrderTaxSnapshot_tenantId_locationTaxVersionId_idx" ON "OrderTaxSnapshot"("tenantId", "locationTaxVersionId");
  CREATE INDEX "OrderTaxSnapshot_tenantId_idx" ON "OrderTaxSnapshot"("tenantId");

  ALTER TABLE "OrderTaxSnapshot" ADD CONSTRAINT "OrderTaxSnapshot_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxSnapshot" ADD CONSTRAINT "OrderTaxSnapshot_tenantId_locationTaxVersionId_fkey" FOREIGN KEY ("tenantId", "locationTaxVersionId") REFERENCES "LocationTaxVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxSnapshot" ADD CONSTRAINT "OrderTaxSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  CREATE TRIGGER "OrderTaxSnapshot_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderTaxSnapshot"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- Written once: never updated or deleted. On insert it must agree with its
  -- order (the same amounts, currency and location) and with the confirmed
  -- (or since superseded) version it names — never a draft.
  CREATE FUNCTION "order_tax_snapshot_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  DECLARE
    o RECORD;
    v RECORD;
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      RAISE EXCEPTION 'An order''s tax snapshot is never changed or deleted (%).', OLD.id;
    END IF;
    SELECT "subtotal", "promotionDiscountMinorUnits", "rewardDiscountMinorUnits",
           "giftCardTenderMinorUnits", "taxMinorUnits", "currency", "locationId"
      INTO o
      FROM "Order" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderId";
    IF NOT FOUND THEN
      RETURN NEW; -- left to the foreign key
    END IF;
    IF o."subtotal" <> NEW."merchandiseSubtotal"
       OR o."promotionDiscountMinorUnits" + o."rewardDiscountMinorUnits" <> NEW."discountMinorUnits"
       OR o."giftCardTenderMinorUnits" <> NEW."giftCardTenderMinorUnits"
       OR o."taxMinorUnits" <> NEW."taxMinorUnits"
       OR o."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'An order''s tax snapshot must match the order''s own amounts (%).', NEW."orderId";
    END IF;
    SELECT "locationId", "version", "status" INTO v
      FROM "LocationTaxVersion"
     WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."locationTaxVersionId";
    IF FOUND AND (v."locationId" <> o."locationId" OR v."version" <> NEW."taxVersion" OR v."status" = 'DRAFT') THEN
      RAISE EXCEPTION 'An order''s tax snapshot must name a confirmed tax version of its own location (%).', NEW."orderId";
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "OrderTaxSnapshot_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrderTaxSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "order_tax_snapshot_guard"();

  -- An order with tax always has its snapshot (checked at commit, after the
  -- order transaction has written both).
  CREATE FUNCTION "order_tax_snapshot_required"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    IF NEW."taxMinorUnits" > 0 AND NOT EXISTS (
      SELECT 1 FROM "OrderTaxSnapshot"
       WHERE "tenantId" = NEW."tenantId" AND "orderId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'An order with sales tax must have its tax snapshot (%).', NEW.id;
    END IF;
    RETURN NULL;
  END
  $guard$;

  CREATE CONSTRAINT TRIGGER "Order_tax_snapshot_required" AFTER INSERT ON "Order"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "order_tax_snapshot_required"();

  -- --- the frozen checkout with its tax ------------------------------------

  ALTER TABLE "CheckoutSnapshot" DROP CONSTRAINT "CheckoutSnapshot_version_check";
  ALTER TABLE "CheckoutSnapshot" ADD CONSTRAINT "CheckoutSnapshot_version_check" CHECK ("version" IN (1, 2, 3));
END
$order_sales_tax$;
