-- Security 4C-2 rollback for migration 20261011090000_tenant_composite_keys.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration, revert the @@unique([tenantId, id])
-- lines in schema.prisma and ship this SQL as a NEW forward migration (so
-- every environment's migration history stays linear). It must be applied
-- only while no composite foreign key (Security 4C-3+) depends on these
-- indexes — DROP INDEX fails, harmlessly, if one does.
--
-- Drops only the 25 indexes the migration created; data is untouched.

DROP INDEX IF EXISTS "Campaign_tenantId_id_key";
DROP INDEX IF EXISTS "Category_tenantId_id_key";
DROP INDEX IF EXISTS "ChecklistInstance_tenantId_id_key";
DROP INDEX IF EXISTS "ChecklistTemplate_tenantId_id_key";
DROP INDEX IF EXISTS "Customer_tenantId_id_key";
DROP INDEX IF EXISTS "CustomerLoyaltyAccount_tenantId_id_key";
DROP INDEX IF EXISTS "FranchiseInquiry_tenantId_id_key";
DROP INDEX IF EXISTS "GiftCard_tenantId_id_key";
DROP INDEX IF EXISTS "GiftCardPurchase_tenantId_id_key";
DROP INDEX IF EXISTS "InternalRole_tenantId_id_key";
DROP INDEX IF EXISTS "InternalUser_tenantId_id_key";
DROP INDEX IF EXISTS "JobApplication_tenantId_id_key";
DROP INDEX IF EXISTS "JobOpening_tenantId_id_key";
DROP INDEX IF EXISTS "Location_tenantId_id_key";
DROP INDEX IF EXISTS "LoyaltyBonusPromotion_tenantId_id_key";
DROP INDEX IF EXISTS "LoyaltyReward_tenantId_id_key";
DROP INDEX IF EXISTS "MediaAsset_tenantId_id_key";
DROP INDEX IF EXISTS "Menu_tenantId_id_key";
DROP INDEX IF EXISTS "ModifierGroup_tenantId_id_key";
DROP INDEX IF EXISTS "Order_tenantId_id_key";
DROP INDEX IF EXISTS "OrderLoyaltyBonus_tenantId_id_key";
DROP INDEX IF EXISTS "OutboxEvent_tenantId_id_key";
DROP INDEX IF EXISTS "PaymentAttempt_tenantId_id_key";
DROP INDEX IF EXISTS "Product_tenantId_id_key";
DROP INDEX IF EXISTS "Promotion_tenantId_id_key";
