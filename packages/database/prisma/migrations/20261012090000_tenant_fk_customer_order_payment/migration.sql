-- Security 4C-3 — tenant-enforced foreign keys: customers, orders, payments.
--
-- Replaces eight single-column foreign keys with composite ones on
-- ("tenantId", <column>) -> parent ("tenantId", "id") and adds the planned
-- one for PaymentAttempt.locationId, so PostgreSQL itself rejects a row that
-- references another business's customer, location, payment attempt or
-- order — whatever the application code does:
--
--   CustomerPreferredLocation.customerId -> Customer   ON DELETE CASCADE
--   CustomerPreferredLocation.locationId -> Location   ON DELETE CASCADE
--   CustomerNote.customerId              -> Customer   ON DELETE CASCADE
--   Order.locationId                     -> Location   ON DELETE RESTRICT
--   Order.customerId (optional)          -> Customer   ON DELETE SET NULL ("customerId")
--   Order.paymentAttemptId               -> PaymentAttempt ON DELETE RESTRICT
--   OrderLine.orderId                    -> Order      ON DELETE RESTRICT
--   OrderStatusHistory.orderId           -> Order      ON DELETE RESTRICT
--   PaymentAttempt.locationId (optional, new) -> Location ON DELETE RESTRICT
--
-- A composite key alone cannot stop a row from MOVING to another business:
-- changing "tenantId" together with the reference (which is exactly what a
-- Prisma nested `connect` to another business's record does) keeps the pair
-- consistent. So the six referencing tables, and the Customer and Location
-- parents (which could otherwise move whenever nothing in scope references
-- them, e.g. a customer with only a loyalty account), reject any change of
-- "tenantId" on an existing row (trigger "<Table>_tenantId_immutable",
-- SQLSTATE 23001 restrict_violation). Rows are created with their business
-- and never change it; no application path updates "tenantId".
--
-- Delete behaviour is unchanged. Order.customerId keeps SET NULL but only for
-- "customerId" (PostgreSQL 15+): nulling the whole composite key would null
-- the required "tenantId". ON UPDATE is RESTRICT (was CASCADE): ids never
-- change, and a business id must never cascade into another row.
-- Order also gains UNIQUE ("tenantId", "paymentAttemptId"), which the
-- one-to-one composite relation requires ("paymentAttemptId" is already
-- unique, so the pair is too).
--
-- Safety:
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement,
--     so the migration applies completely or not at all.
--   - Preflight (read-only) first: the PostgreSQL version, then every row of
--     the nine relationships must reference a row of the SAME business. Any
--     problem aborts with counts and nothing changed. Ownership is never
--     reassigned automatically.
--   - lock_timeout 5s (local to this transaction): it fails, atomically,
--     rather than queue application traffic behind a lock it cannot get.
--     Dropping/adding foreign keys locks the child and parent tables until
--     commit.
--
-- If it fails: nothing changed. Fix the reported rows deliberately (or wait
-- for a quieter moment), run `prisma migrate resolve --rolled-back
-- 20261012090000_tenant_fk_customer_order_payment`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261012090000_tenant_fk_customer_order_payment.down.sql.

DO $tenant_fk_customer_order_payment$
DECLARE
  r record;
  n bigint;
  problems text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Security 4C-3 requires PostgreSQL 15 or later (ON DELETE SET NULL (column)); this server is %. Nothing was changed.',
      current_setting('server_version');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('CustomerPreferredLocation', 'customerId', 'Customer'),
      ('CustomerPreferredLocation', 'locationId', 'Location'),
      ('CustomerNote', 'customerId', 'Customer'),
      ('Order', 'locationId', 'Location'),
      ('Order', 'customerId', 'Customer'),
      ('Order', 'paymentAttemptId', 'PaymentAttempt'),
      ('OrderLine', 'orderId', 'Order'),
      ('OrderStatusHistory', 'orderId', 'Order'),
      ('PaymentAttempt', 'locationId', 'Location')
    ) AS t(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c LEFT JOIN %I p ON p."id" = c.%I
        WHERE c.%I IS NOT NULL AND (p."id" IS NULL OR p."tenantId" <> c."tenantId")',
      r.child, r.parent, r.col, r.col)
      INTO n;
    IF n > 0 THEN
      problems := problems || format(E'\n  %s.%s -> %s: %s row(s)', r.child, r.col, r.parent, n);
    END IF;
  END LOOP;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Security 4C-3 aborted: rows reference another business''s record or a missing one. Nothing was changed; resolve them explicitly, then retry:%',
      problems;
  END IF;

  ALTER TABLE "CustomerNote" DROP CONSTRAINT "CustomerNote_customerId_fkey";
  ALTER TABLE "CustomerPreferredLocation" DROP CONSTRAINT "CustomerPreferredLocation_customerId_fkey";
  ALTER TABLE "CustomerPreferredLocation" DROP CONSTRAINT "CustomerPreferredLocation_locationId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_customerId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_locationId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_paymentAttemptId_fkey";
  ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_orderId_fkey";
  ALTER TABLE "OrderStatusHistory" DROP CONSTRAINT "OrderStatusHistory_orderId_fkey";

  CREATE UNIQUE INDEX "Order_tenantId_paymentAttemptId_key" ON "Order"("tenantId", "paymentAttemptId");

  ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE SET NULL ("customerId") ON UPDATE RESTRICT;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

  CREATE FUNCTION "reject_tenant_reassignment"() RETURNS trigger
    LANGUAGE plpgsql AS $reject_tenant_reassignment$
  BEGIN
    RAISE EXCEPTION 'A "%" row cannot move to another business.', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END
  $reject_tenant_reassignment$;
  CREATE TRIGGER "Customer_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Customer"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "CustomerNote_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CustomerNote"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "CustomerPreferredLocation_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CustomerPreferredLocation"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Location_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Location"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Order_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Order"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderLine_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderLine"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderStatusHistory_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderStatusHistory"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PaymentAttempt_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PaymentAttempt"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
END
$tenant_fk_customer_order_payment$;
