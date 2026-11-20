-- V1 Sales Tax PR 3 — tax refunds.
--
-- The sales tax an order's money coming back returns, attributed from the
-- order's ORIGINAL tax snapshot (V1 Sales Tax PR 2), never recalculated.
--
--   * OrderLine.lineIndex — the line's position in its order, as in the
--     frozen checkout and the tax snapshot (checkout sets it for every new
--     order; null on older orders). Unique per order, >= 0, never changed
--     once set.
--   * OrderTaxRefund (+ lines, + components) — written once, never updated
--     or deleted:
--       ITEM     an item refund of a completed taxed order; its card refund
--                (PaymentRefund, CENTERIVO) is for exactly merchandise + tax.
--       CLOSURE  a rejected or cancelled taxed order: every line in full.
--     On insert it must name its own order's snapshot, location and
--     currency, and an ITEM record its own order's card refund. At commit
--     its lines and components must add up to it, every line must be a line
--     of the order within its quantity and its snapshot amounts, and it never
--     returns more tax than the snapshot charged.
--   Whether the tax counts as refunded is read from the money (the card
--   refund's status, or the closure's obligation), never stored here.
--
-- ADDITIVE ONLY: one nullable column (no rewrite) with its partial unique
-- index, three tables, constraints and trigger guards. One DO block
-- (atomic), read-only preflight first, lock_timeout 5s.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261204090000_order_tax_refunds.down.sql.

DO $order_tax_refunds$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Order tax refunds refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"OrderTaxSnapshot"') IS NULL OR to_regclass('"PaymentRefund"') IS NULL THEN
    RAISE EXCEPTION 'Order tax refunds refused: the order tax snapshot or payment refund tables are missing. Nothing was changed.';
  END IF;
  IF to_regclass('"OrderTaxRefund"') IS NOT NULL
     OR to_regclass('"OrderTaxRefundLine"') IS NOT NULL
     OR to_regclass('"OrderTaxRefundComponent"') IS NOT NULL
     OR to_regprocedure('order_tax_refund_guard()') IS NOT NULL
     OR to_regprocedure('order_tax_refund_immutable()') IS NOT NULL
     OR to_regprocedure('order_tax_refund_consistent()') IS NOT NULL
     OR to_regprocedure('order_line_index_frozen()') IS NOT NULL THEN
    RAISE EXCEPTION 'Order tax refunds refused: a table or function it creates already exists. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'OrderLine' AND column_name = 'lineIndex'
  ) THEN
    RAISE EXCEPTION 'Order tax refunds refused: OrderLine.lineIndex already exists. Nothing was changed.';
  END IF;

  -- --- the order line's position ---------------------------------------------

  ALTER TABLE "OrderLine" ADD COLUMN "lineIndex" INTEGER;
  ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_lineIndex_check"
    CHECK ("lineIndex" IS NULL OR "lineIndex" >= 0);
  CREATE UNIQUE INDEX "OrderLine_orderId_lineIndex_key"
    ON "OrderLine"("orderId", "lineIndex") WHERE "lineIndex" IS NOT NULL;

  CREATE FUNCTION "order_line_index_frozen"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'An order line''s position never changes once set (%).', OLD.id;
  END
  $guard$;
  CREATE TRIGGER "OrderLine_lineIndex_frozen" BEFORE UPDATE OF "lineIndex" ON "OrderLine"
    FOR EACH ROW WHEN (OLD."lineIndex" IS NOT NULL AND OLD."lineIndex" IS DISTINCT FROM NEW."lineIndex")
    EXECUTE FUNCTION "order_line_index_frozen"();

  -- --- tax refunds -------------------------------------------------------------

  CREATE TABLE "OrderTaxRefund" (
      "id" TEXT NOT NULL,
      "orderId" TEXT NOT NULL,
      "locationId" TEXT NOT NULL,
      "orderTaxSnapshotId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "paymentRefundId" TEXT,
      "orderClosureId" TEXT,
      "currency" TEXT NOT NULL,
      "merchandiseMinorUnits" INTEGER NOT NULL,
      "taxMinorUnits" INTEGER NOT NULL,
      "createdByInternalUserId" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "OrderTaxRefund_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "OrderTaxRefund_kind_check" CHECK ("kind" IN ('ITEM', 'CLOSURE')),
      CONSTRAINT "OrderTaxRefund_source_check" CHECK (
        ("kind" = 'ITEM' AND "paymentRefundId" IS NOT NULL AND "orderClosureId" IS NULL)
        OR ("kind" = 'CLOSURE' AND "orderClosureId" IS NOT NULL AND "paymentRefundId" IS NULL)
      ),
      CONSTRAINT "OrderTaxRefund_amounts_check"
        CHECK ("merchandiseMinorUnits" >= 0 AND "taxMinorUnits" >= 0),
      CONSTRAINT "OrderTaxRefund_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
  );

  CREATE UNIQUE INDEX "OrderTaxRefund_paymentRefundId_key" ON "OrderTaxRefund"("paymentRefundId");
  CREATE UNIQUE INDEX "OrderTaxRefund_orderClosureId_key" ON "OrderTaxRefund"("orderClosureId");
  CREATE INDEX "OrderTaxRefund_tenantId_orderId_idx" ON "OrderTaxRefund"("tenantId", "orderId");
  CREATE INDEX "OrderTaxRefund_tenantId_locationId_createdAt_idx" ON "OrderTaxRefund"("tenantId", "locationId", "createdAt");
  CREATE INDEX "OrderTaxRefund_tenantId_idx" ON "OrderTaxRefund"("tenantId");
  CREATE UNIQUE INDEX "OrderTaxRefund_tenantId_id_key" ON "OrderTaxRefund"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderTaxRefund_tenantId_paymentRefundId_key" ON "OrderTaxRefund"("tenantId", "paymentRefundId");
  CREATE UNIQUE INDEX "OrderTaxRefund_tenantId_orderClosureId_key" ON "OrderTaxRefund"("tenantId", "orderClosureId");

  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_orderTaxSnapshotId_fkey" FOREIGN KEY ("tenantId", "orderTaxSnapshotId") REFERENCES "OrderTaxSnapshot"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_paymentRefundId_fkey" FOREIGN KEY ("tenantId", "paymentRefundId") REFERENCES "PaymentRefund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_orderClosureId_fkey" FOREIGN KEY ("tenantId", "orderClosureId") REFERENCES "OrderClosure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_createdByInternalUserId_fkey" FOREIGN KEY ("tenantId", "createdByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefund" ADD CONSTRAINT "OrderTaxRefund_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TABLE "OrderTaxRefundLine" (
      "id" TEXT NOT NULL,
      "taxRefundId" TEXT NOT NULL,
      "lineIndex" INTEGER NOT NULL,
      "quantity" INTEGER NOT NULL,
      "merchandiseMinorUnits" INTEGER NOT NULL,
      "taxMinorUnits" INTEGER NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "OrderTaxRefundLine_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "OrderTaxRefundLine_values_check" CHECK (
        "lineIndex" >= 0 AND "quantity" >= 1
        AND "merchandiseMinorUnits" >= 0 AND "taxMinorUnits" >= 0
      )
  );
  CREATE INDEX "OrderTaxRefundLine_tenantId_idx" ON "OrderTaxRefundLine"("tenantId");
  CREATE UNIQUE INDEX "OrderTaxRefundLine_tenantId_id_key" ON "OrderTaxRefundLine"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderTaxRefundLine_taxRefundId_lineIndex_key" ON "OrderTaxRefundLine"("taxRefundId", "lineIndex");
  ALTER TABLE "OrderTaxRefundLine" ADD CONSTRAINT "OrderTaxRefundLine_tenantId_taxRefundId_fkey" FOREIGN KEY ("tenantId", "taxRefundId") REFERENCES "OrderTaxRefund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefundLine" ADD CONSTRAINT "OrderTaxRefundLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TABLE "OrderTaxRefundComponent" (
      "id" TEXT NOT NULL,
      "taxRefundId" TEXT NOT NULL,
      "lineIndex" INTEGER NOT NULL,
      "componentKey" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "jurisdiction" TEXT NOT NULL,
      "ratePpm" INTEGER NOT NULL,
      "taxMinorUnits" INTEGER NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "OrderTaxRefundComponent_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "OrderTaxRefundComponent_values_check" CHECK (
        "lineIndex" >= 0 AND "taxMinorUnits" >= 0 AND "ratePpm" BETWEEN 1 AND 250000
        AND "jurisdiction" IN ('STATE', 'COUNTY', 'CITY', 'SPECIAL')
      )
  );
  CREATE INDEX "OrderTaxRefundComponent_tenantId_idx" ON "OrderTaxRefundComponent"("tenantId");
  CREATE UNIQUE INDEX "OrderTaxRefundComponent_tenantId_id_key" ON "OrderTaxRefundComponent"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderTaxRefundComponent_taxRefundId_lineIndex_componentKey_key" ON "OrderTaxRefundComponent"("taxRefundId", "lineIndex", "componentKey");
  ALTER TABLE "OrderTaxRefundComponent" ADD CONSTRAINT "OrderTaxRefundComponent_tenantId_taxRefundId_fkey" FOREIGN KEY ("tenantId", "taxRefundId") REFERENCES "OrderTaxRefund"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderTaxRefundComponent" ADD CONSTRAINT "OrderTaxRefundComponent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "OrderTaxRefund_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderTaxRefund"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderTaxRefundLine_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderTaxRefundLine"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderTaxRefundComponent_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderTaxRefundComponent"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- Written once: never updated or deleted.
  CREATE FUNCTION "order_tax_refund_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    RAISE EXCEPTION 'A tax refund record is never changed or deleted (%).', TG_TABLE_NAME;
  END
  $guard$;
  CREATE TRIGGER "OrderTaxRefund_immutable" BEFORE UPDATE OR DELETE ON "OrderTaxRefund"
    FOR EACH ROW EXECUTE FUNCTION "order_tax_refund_immutable"();
  CREATE TRIGGER "OrderTaxRefundLine_immutable" BEFORE UPDATE OR DELETE ON "OrderTaxRefundLine"
    FOR EACH ROW EXECUTE FUNCTION "order_tax_refund_immutable"();
  CREATE TRIGGER "OrderTaxRefundComponent_immutable" BEFORE UPDATE OR DELETE ON "OrderTaxRefundComponent"
    FOR EACH ROW EXECUTE FUNCTION "order_tax_refund_immutable"();

  -- On insert: its own order's snapshot, location and currency; an ITEM
  -- record its own order's CENTERIVO card refund, for merchandise + tax, of a
  -- completed order; a CLOSURE record its own order's closure.
  CREATE FUNCTION "order_tax_refund_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  DECLARE
    o RECORD;
    s RECORD;
    r RECORD;
  BEGIN
    SELECT "locationId", "currency", "status"::text AS status INTO o
      FROM "Order" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderId";
    SELECT "orderId", "currency" INTO s
      FROM "OrderTaxSnapshot" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderTaxSnapshotId";
    IF o IS NULL OR s IS NULL THEN
      RETURN NEW; -- left to the foreign keys
    END IF;
    IF s."orderId" <> NEW."orderId" OR o."locationId" <> NEW."locationId"
       OR o."currency" <> NEW."currency" OR s."currency" <> NEW."currency" THEN
      RAISE EXCEPTION 'A tax refund must name its own order''s snapshot, location and currency (%).', NEW."orderId";
    END IF;
    IF NEW."kind" = 'ITEM' THEN
      SELECT "orderId", "origin", "amountMinorUnits", "currency" INTO r
        FROM "PaymentRefund" WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."paymentRefundId";
      IF r IS NOT NULL AND (
           r."orderId" <> NEW."orderId" OR r."origin" <> 'CENTERIVO'
           OR r."currency" <> NEW."currency"
           OR r."amountMinorUnits" <> NEW."merchandiseMinorUnits" + NEW."taxMinorUnits") THEN
        RAISE EXCEPTION 'An item tax refund must be its own order''s card refund, for exactly its merchandise and tax (%).', NEW."orderId";
      END IF;
      IF o.status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'Items are refunded only on a completed order (%).', NEW."orderId";
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM "OrderClosure"
         WHERE "tenantId" = NEW."tenantId" AND "id" = NEW."orderClosureId" AND "orderId" = NEW."orderId"
      ) THEN
        RAISE EXCEPTION 'A cancellation tax refund must be its own order''s closure (%).', NEW."orderId";
      END IF;
    END IF;
    RETURN NEW;
  END
  $guard$;
  CREATE TRIGGER "OrderTaxRefund_guard" BEFORE INSERT ON "OrderTaxRefund"
    FOR EACH ROW EXECUTE FUNCTION "order_tax_refund_guard"();

  -- At commit: the record adds up, its lines are the order's own lines
  -- within their quantity and snapshot amounts, and the order's tax refunds
  -- together never return more tax or merchandise than the snapshot.
  CREATE FUNCTION "order_tax_refund_consistent"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  DECLARE
    h RECORD;
    snap RECORD;
    bad INTEGER;
  BEGIN
    SELECT * INTO h FROM "OrderTaxRefund" WHERE "id" = NEW."id";
    IF h IS NULL THEN
      RETURN NULL;
    END IF;
    IF h."merchandiseMinorUnits" <> COALESCE((SELECT SUM("merchandiseMinorUnits") FROM "OrderTaxRefundLine" WHERE "taxRefundId" = h."id"), -1)
       OR h."taxMinorUnits" <> COALESCE((SELECT SUM("taxMinorUnits") FROM "OrderTaxRefundLine" WHERE "taxRefundId" = h."id"), -1)
       OR h."taxMinorUnits" <> COALESCE((SELECT SUM("taxMinorUnits") FROM "OrderTaxRefundComponent" WHERE "taxRefundId" = h."id"), 0) THEN
      RAISE EXCEPTION 'A tax refund''s lines and components must add up to it (%).', h."orderId";
    END IF;
    -- Each line's components add up to the line, and name a refunded line.
    SELECT COUNT(*) INTO bad
      FROM (
        SELECT l."lineIndex", l."taxMinorUnits",
               COALESCE((SELECT SUM(c."taxMinorUnits") FROM "OrderTaxRefundComponent" c
                          WHERE c."taxRefundId" = h."id" AND c."lineIndex" = l."lineIndex"), 0) AS comp
          FROM "OrderTaxRefundLine" l WHERE l."taxRefundId" = h."id"
      ) x
     WHERE x.comp <> x."taxMinorUnits";
    IF bad > 0 OR EXISTS (
      SELECT 1 FROM "OrderTaxRefundComponent" c
       WHERE c."taxRefundId" = h."id"
         AND NOT EXISTS (SELECT 1 FROM "OrderTaxRefundLine" l
                          WHERE l."taxRefundId" = h."id" AND l."lineIndex" = c."lineIndex")
    ) THEN
      RAISE EXCEPTION 'A tax refund''s component amounts must add up to each of its lines (%).', h."orderId";
    END IF;
    -- Each line: a line of this order, within its quantity, and within the
    -- snapshot's net amount and tax for that line.
    SELECT COUNT(*) INTO bad
      FROM "OrderTaxRefundLine" l
      LEFT JOIN "OrderLine" ol
        ON ol."tenantId" = l."tenantId" AND ol."orderId" = h."orderId" AND ol."lineIndex" = l."lineIndex"
      LEFT JOIN "OrderTaxSnapshot" s ON s."id" = h."orderTaxSnapshotId"
      LEFT JOIN LATERAL (
        SELECT (e->>'taxableMinorUnits')::int AS taxable, (e->>'taxMinorUnits')::int AS tax
          FROM jsonb_array_elements(s."detail"->'lines') e
         WHERE (e->>'lineIndex')::int = l."lineIndex"
      ) sl ON true
     WHERE l."taxRefundId" = h."id"
       AND (ol."id" IS NULL OR sl.taxable IS NULL
            OR l."quantity" > ol."quantity"
            OR l."merchandiseMinorUnits" > sl.taxable
            OR l."taxMinorUnits" > sl.tax);
    IF bad > 0 THEN
      RAISE EXCEPTION 'A tax refund line must be a line of its order within its quantity and its snapshot amounts (%).', h."orderId";
    END IF;
    SELECT "taxMinorUnits", "merchandiseSubtotal" - "discountMinorUnits" AS net INTO snap
      FROM "OrderTaxSnapshot" WHERE "id" = h."orderTaxSnapshotId";
    -- A cancellation returns the whole order once; item refunds of a
    -- completed order are limited by the service per line, under the
    -- payment's lock, counting only those whose card refund is not known to
    -- have failed. Here: no single record exceeds the snapshot.
    IF h."taxMinorUnits" > snap."taxMinorUnits" OR h."merchandiseMinorUnits" > snap.net THEN
      RAISE EXCEPTION 'A tax refund never returns more than the order was charged (%).', h."orderId";
    END IF;
    RETURN NULL;
  END
  $guard$;
  CREATE CONSTRAINT TRIGGER "OrderTaxRefund_consistent" AFTER INSERT ON "OrderTaxRefund"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION "order_tax_refund_consistent"();
END
$order_tax_refunds$;
