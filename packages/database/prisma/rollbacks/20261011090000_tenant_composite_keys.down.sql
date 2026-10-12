-- Security 4C-2 rollback for migration 20261011090000_tenant_composite_keys.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the @@unique([tenantId, id])
-- lines in schema.prisma and ship this SQL as a NEW forward migration (so
-- every environment's migration history stays linear). Only while no
-- composite foreign key (Security 4C-3+) depends on these indexes — a
-- dependent constraint makes DROP INDEX fail, and then nothing is dropped.
--
-- One DO block, like the migration, so Prisma applies it atomically: all 25
-- indexes are dropped or none. Data is untouched.

DO $tenant_composite_keys_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

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
END
$tenant_composite_keys_rollback$;
