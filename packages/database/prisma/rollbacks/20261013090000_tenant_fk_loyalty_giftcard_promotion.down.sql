-- Security 4C-4 rollback for migration 20261013090000_tenant_fk_loyalty_giftcard_promotion.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the 4C-4 composite
-- relations in schema.prisma (back to single-column fields/references,
-- removing OrderPromotionRedemption.customer, Customer.promoRedemptions and
-- the 4C-4 @@unique/@@index lines) and ship this SQL as a NEW forward
-- migration, so every environment's history stays linear.
--
-- It removes only what 4C-4 added — the 14 ownership triggers, the
-- 7 snapshot triggers and their function, the 17 composite foreign
-- keys and 8 indexes — and restores exactly the 16 single-column foreign
-- keys as they were before 4C-4 (including ON UPDATE CASCADE).
-- OrderPromotionRedemption.customerId goes back to a plain column. Data is
-- untouched. It keeps reject_tenant_reassignment(), which belongs to 4C-3.
-- One DO block, so Prisma applies it atomically. Roll back 4C-4 before
-- 4C-3 or 4C-2.

DO $tenant_fk_loyalty_giftcard_promotion_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  DROP TRIGGER "CustomerLoyaltyAccount_tenantId_immutable" ON "CustomerLoyaltyAccount";
  DROP TRIGGER "GiftCard_tenantId_immutable" ON "GiftCard";
  DROP TRIGGER "GiftCardPurchase_tenantId_immutable" ON "GiftCardPurchase";
  DROP TRIGGER "GiftCardTransaction_tenantId_immutable" ON "GiftCardTransaction";
  DROP TRIGGER "LoyaltyBonusPromotion_tenantId_immutable" ON "LoyaltyBonusPromotion";
  DROP TRIGGER "LoyaltyReward_tenantId_immutable" ON "LoyaltyReward";
  DROP TRIGGER "MochaBeanLedgerEntry_tenantId_immutable" ON "MochaBeanLedgerEntry";
  DROP TRIGGER "OrderGiftCardRedemption_tenantId_immutable" ON "OrderGiftCardRedemption";
  DROP TRIGGER "OrderLoyaltyBonus_tenantId_immutable" ON "OrderLoyaltyBonus";
  DROP TRIGGER "OrderLoyaltyBonusItem_tenantId_immutable" ON "OrderLoyaltyBonusItem";
  DROP TRIGGER "OrderLoyaltyRewardRedemption_tenantId_immutable" ON "OrderLoyaltyRewardRedemption";
  DROP TRIGGER "OrderPromotionRedemption_tenantId_immutable" ON "OrderPromotionRedemption";
  DROP TRIGGER "Promotion_tenantId_immutable" ON "Promotion";
  DROP TRIGGER "PromotionCustomerUsage_tenantId_immutable" ON "PromotionCustomerUsage";
  DROP TRIGGER "OrderLoyaltyRewardRedemption_sourceRewardId_same_tenant" ON "OrderLoyaltyRewardRedemption";
  DROP TRIGGER "OrderLoyaltyRewardRedemption_freeItemProductId_same_tenant" ON "OrderLoyaltyRewardRedemption";
  DROP TRIGGER "OrderLoyaltyBonusItem_sourcePromotionId_same_tenant" ON "OrderLoyaltyBonusItem";
  DROP TRIGGER "OrderLoyaltyBonusItem_productId_same_tenant" ON "OrderLoyaltyBonusItem";
  DROP TRIGGER "OrderPromotionRedemption_sourcePromotionId_same_tenant" ON "OrderPromotionRedemption";
  DROP TRIGGER "OrderPromotionRedemption_freeItemProductId_same_tenant" ON "OrderPromotionRedemption";
  DROP TRIGGER "OrderGiftCardRedemption_sourceGiftCardId_same_tenant" ON "OrderGiftCardRedemption";
  DROP FUNCTION "reject_cross_tenant_snapshot"();

  ALTER TABLE "CustomerLoyaltyAccount" DROP CONSTRAINT "CustomerLoyaltyAccount_tenantId_customerId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_tenantId_loyaltyAccountId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_tenantId_orderId_fkey";
  ALTER TABLE "OrderLoyaltyRewardRedemption" DROP CONSTRAINT "OrderLoyaltyRewardRedemption_tenantId_orderId_fkey";
  ALTER TABLE "OrderLoyaltyBonus" DROP CONSTRAINT "OrderLoyaltyBonus_tenantId_orderId_fkey";
  ALTER TABLE "OrderLoyaltyBonusItem" DROP CONSTRAINT "OrderLoyaltyBonusItem_tenantId_orderLoyaltyBonusId_fkey";
  ALTER TABLE "PromotionCustomerUsage" DROP CONSTRAINT "PromotionCustomerUsage_tenantId_promotionId_fkey";
  ALTER TABLE "PromotionCustomerUsage" DROP CONSTRAINT "PromotionCustomerUsage_tenantId_customerId_fkey";
  ALTER TABLE "OrderPromotionRedemption" DROP CONSTRAINT "OrderPromotionRedemption_tenantId_orderId_fkey";
  ALTER TABLE "OrderPromotionRedemption" DROP CONSTRAINT "OrderPromotionRedemption_tenantId_customerId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_tenantId_giftCardId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_tenantId_orderId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_tenantId_giftCardPurchaseId_fkey";
  ALTER TABLE "OrderGiftCardRedemption" DROP CONSTRAINT "OrderGiftCardRedemption_tenantId_orderId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_tenantId_paymentAttemptId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_tenantId_giftCardId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_tenantId_customerId_fkey";

  DROP INDEX "CustomerLoyaltyAccount_tenantId_customerId_key";
  DROP INDEX "GiftCardPurchase_tenantId_paymentAttemptId_key";
  DROP INDEX "GiftCardPurchase_tenantId_giftCardId_key";
  DROP INDEX "OrderGiftCardRedemption_tenantId_orderId_key";
  DROP INDEX "OrderLoyaltyBonus_tenantId_orderId_key";
  DROP INDEX "OrderLoyaltyRewardRedemption_tenantId_orderId_key";
  DROP INDEX "OrderPromotionRedemption_tenantId_orderId_key";
  DROP INDEX "OrderPromotionRedemption_customerId_idx";

  ALTER TABLE "CustomerLoyaltyAccount" ADD CONSTRAINT "CustomerLoyaltyAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_loyaltyAccountId_fkey" FOREIGN KEY ("loyaltyAccountId") REFERENCES "CustomerLoyaltyAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "OrderLoyaltyRewardRedemption" ADD CONSTRAINT "OrderLoyaltyRewardRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OrderLoyaltyBonus" ADD CONSTRAINT "OrderLoyaltyBonus_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OrderLoyaltyBonusItem" ADD CONSTRAINT "OrderLoyaltyBonusItem_orderLoyaltyBonusId_fkey" FOREIGN KEY ("orderLoyaltyBonusId") REFERENCES "OrderLoyaltyBonus"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "OrderPromotionRedemption" ADD CONSTRAINT "OrderPromotionRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardPurchaseId_fkey" FOREIGN KEY ("giftCardPurchaseId") REFERENCES "GiftCardPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  ALTER TABLE "OrderGiftCardRedemption" ADD CONSTRAINT "OrderGiftCardRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_paymentAttemptId_fkey" FOREIGN KEY ("paymentAttemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
END
$tenant_fk_loyalty_giftcard_promotion_rollback$;
