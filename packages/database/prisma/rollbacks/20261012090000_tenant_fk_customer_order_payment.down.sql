-- Security 4C-3 rollback for migration 20261012090000_tenant_fk_customer_order_payment.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the composite relations in
-- schema.prisma (back to single-column fields/references, removing
-- PaymentAttempt.location and Order @@unique([tenantId, paymentAttemptId]))
-- and ship this SQL as a NEW forward migration, so every environment's
-- history stays linear.
--
-- It restores exactly the eight single-column foreign keys as they were
-- before 4C-3 (including ON UPDATE CASCADE), drops the nine composite ones,
-- the composite payment key and the eight tenantId-immutability triggers
-- (and their function). PaymentAttempt.locationId goes back to a plain
-- column. Data is untouched. One DO block, so Prisma applies it atomically.
-- After a rollback, cross-business references are again possible at the
-- database level (the application checks and the integrity checker remain).

DO $tenant_fk_customer_order_payment_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  DROP TRIGGER "Customer_tenantId_immutable" ON "Customer";
  DROP TRIGGER "CustomerNote_tenantId_immutable" ON "CustomerNote";
  DROP TRIGGER "CustomerPreferredLocation_tenantId_immutable" ON "CustomerPreferredLocation";
  DROP TRIGGER "Location_tenantId_immutable" ON "Location";
  DROP TRIGGER "Order_tenantId_immutable" ON "Order";
  DROP TRIGGER "OrderLine_tenantId_immutable" ON "OrderLine";
  DROP TRIGGER "OrderStatusHistory_tenantId_immutable" ON "OrderStatusHistory";
  DROP TRIGGER "PaymentAttempt_tenantId_immutable" ON "PaymentAttempt";
  DROP FUNCTION "reject_tenant_reassignment"();

  ALTER TABLE "CustomerPreferredLocation" DROP CONSTRAINT "CustomerPreferredLocation_tenantId_customerId_fkey";
  ALTER TABLE "CustomerPreferredLocation" DROP CONSTRAINT "CustomerPreferredLocation_tenantId_locationId_fkey";
  ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_tenantId_locationId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_locationId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_customerId_fkey";
  ALTER TABLE "Order" DROP CONSTRAINT "Order_tenantId_paymentAttemptId_fkey";
  ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_tenantId_orderId_fkey";
  ALTER TABLE "OrderStatusHistory" DROP CONSTRAINT "OrderStatusHistory_tenantId_orderId_fkey";
  ALTER TABLE "CustomerNote" DROP CONSTRAINT "CustomerNote_tenantId_customerId_fkey";

  DROP INDEX "Order_tenantId_paymentAttemptId_key";

  ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END
$tenant_fk_customer_order_payment_rollback$;
