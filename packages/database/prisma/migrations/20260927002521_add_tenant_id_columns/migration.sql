-- Milestone S0D-1 — EXPAND + BACKFILL tenant columns.
--
-- Adds a NULLABLE "tenantId" (no default) to all 63 tenant-owned tables
-- (MODEL_TENANCY 'tenant' in src/tenancy/model-tenancy.ts; the platform-plane
-- "Tenant" table is untouched), backfills every EXISTING row to Mocha House
-- Tenant #1, then adds the per-table index and FK -> "Tenant"("id")
-- (ON DELETE RESTRICT ON UPDATE RESTRICT).
--
-- The whole script runs as ONE implicit transaction (a multi-statement
-- script sent as a single simple query): if any guard below raises, every
-- statement in this file — including the ADD COLUMNs — is rolled back.
--
-- This is the ONLY intentional write to append-only/history tables
-- (MochaBeanLedgerEntry, GiftCardTransaction, OrderStatusHistory,
-- InternalAuditEvent, …): a one-time, migration-time ownership backfill.
-- Application code still never updates those rows.
--
-- tenantId stays NULLABLE after this migration by design. Each domain's
-- S0D-2 slice converts its writes to supply tenantId explicitly, re-runs this
-- guarded backfill for rows created in between, and only then sets NOT NULL.

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "CampaignProduct" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistInstance" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistInstanceItem" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistTemplate" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ChecklistTemplateItem" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "CmsPage" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "CustomerLoyaltyAccount" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "CustomerNote" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "CustomerPreferredLocation" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "FranchiseInquiry" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "FranchiseInquiryNote" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "GiftCard" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "GiftCardConfiguration" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "GiftCardPurchase" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "GiftCardTransaction" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "InternalAuditEvent" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "InternalRole" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "InternalRolePermission" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "InternalUser" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "InternalUserRoleAssignment" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "JobApplicationNote" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "JobOpening" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LocationMenu" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LocationProductAvailabilityOverride" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LocationProductPriceOverride" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotion" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotionLocation" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotionProduct" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyConfiguration" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyReward" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyRewardCategory" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "LoyaltyRewardProduct" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Menu" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "MenuProduct" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "MochaBeanLedgerEntry" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ModifierGroup" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ModifierOption" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OperationsTask" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderGiftCardRedemption" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderLoyaltyBonus" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderLoyaltyBonusItem" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderLoyaltyRewardRedemption" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderPromotionRedemption" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OrderStatusHistory" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "ProductModifierGroup" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "PromotionCategory" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "PromotionCustomerUsage" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "PromotionLocation" ADD COLUMN     "tenantId" TEXT;

-- AlterTable
ALTER TABLE "PromotionProduct" ADD COLUMN     "tenantId" TEXT;


-- --- Hand-written (S0D-1): guarded Tenant #1 backfill --------------------
-- Guards run BEFORE any row is touched:
--   1. Tenant #1 (Mocha House) must exist ...
--   2. ... and be ACTIVE;
--   3. NO other tenant may exist. Existing rows can only be assigned to
--      Tenant #1 because, while it is the sole tenant, every row in this
--      database was necessarily created by Tenant #1 traffic (S0C single-
--      tenant mode). If any other tenant exists that reasoning no longer
--      holds, so the migration refuses rather than guess.
-- Then every NULL tenantId is set to Tenant #1 (idempotent: only NULLs), and
-- a post-check refuses to finish if any tenant-owned table still has a NULL.
DO $s0d1$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  tenant_tables CONSTANT TEXT[] := ARRAY[
    'ApprovalRequest',
    'Campaign',
    'CampaignProduct',
    'Category',
    'ChecklistInstance',
    'ChecklistInstanceItem',
    'ChecklistTemplate',
    'ChecklistTemplateItem',
    'CmsPage',
    'Customer',
    'CustomerLoyaltyAccount',
    'CustomerNote',
    'CustomerPreferredLocation',
    'FranchiseInquiry',
    'FranchiseInquiryNote',
    'GiftCard',
    'GiftCardConfiguration',
    'GiftCardPurchase',
    'GiftCardTransaction',
    'InternalAuditEvent',
    'InternalRole',
    'InternalRolePermission',
    'InternalUser',
    'InternalUserRoleAssignment',
    'JobApplication',
    'JobApplicationNote',
    'JobOpening',
    'Location',
    'LocationMenu',
    'LocationProductAvailabilityOverride',
    'LocationProductPriceOverride',
    'LoyaltyBonusPromotion',
    'LoyaltyBonusPromotionLocation',
    'LoyaltyBonusPromotionProduct',
    'LoyaltyConfiguration',
    'LoyaltyReward',
    'LoyaltyRewardCategory',
    'LoyaltyRewardProduct',
    'MediaAsset',
    'Menu',
    'MenuProduct',
    'MochaBeanLedgerEntry',
    'ModifierGroup',
    'ModifierOption',
    'NotificationDelivery',
    'OperationsTask',
    'Order',
    'OrderGiftCardRedemption',
    'OrderLine',
    'OrderLoyaltyBonus',
    'OrderLoyaltyBonusItem',
    'OrderLoyaltyRewardRedemption',
    'OrderPromotionRedemption',
    'OrderStatusHistory',
    'OutboxEvent',
    'PaymentAttempt',
    'Product',
    'ProductModifierGroup',
    'Promotion',
    'PromotionCategory',
    'PromotionCustomerUsage',
    'PromotionLocation',
    'PromotionProduct'
  ];
  table_name TEXT;
  updated_rows BIGINT;
  remaining_nulls BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-1 aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-1 aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-1 aborted: % tenant(s) other than Tenant #1 exist; existing rows cannot be safely attributed to Tenant #1.', other_tenants;
  END IF;

  IF array_length(tenant_tables, 1) <> 63 THEN
    RAISE EXCEPTION 'S0D-1 aborted: expected 63 tenant-owned tables, got %.', array_length(tenant_tables, 1);
  END IF;

  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('UPDATE %I SET "tenantId" = $1 WHERE "tenantId" IS NULL', table_name)
      USING tenant_one;
    GET DIAGNOSTICS updated_rows = ROW_COUNT;
    RAISE NOTICE 'S0D-1 backfill: % -> % row(s) assigned to Tenant #1', table_name, updated_rows;
  END LOOP;

  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I WHERE "tenantId" IS NULL', table_name)
      INTO remaining_nulls;
    IF remaining_nulls <> 0 THEN
      RAISE EXCEPTION 'S0D-1 aborted: % still has % row(s) with NULL tenantId after backfill.', table_name, remaining_nulls;
    END IF;
  END LOOP;
END
$s0d1$;

-- CreateIndex
CREATE INDEX "ApprovalRequest_tenantId_idx" ON "ApprovalRequest"("tenantId");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_idx" ON "Campaign"("tenantId");

-- CreateIndex
CREATE INDEX "CampaignProduct_tenantId_idx" ON "CampaignProduct"("tenantId");

-- CreateIndex
CREATE INDEX "Category_tenantId_idx" ON "Category"("tenantId");

-- CreateIndex
CREATE INDEX "ChecklistInstance_tenantId_idx" ON "ChecklistInstance"("tenantId");

-- CreateIndex
CREATE INDEX "ChecklistInstanceItem_tenantId_idx" ON "ChecklistInstanceItem"("tenantId");

-- CreateIndex
CREATE INDEX "ChecklistTemplate_tenantId_idx" ON "ChecklistTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "ChecklistTemplateItem_tenantId_idx" ON "ChecklistTemplateItem"("tenantId");

-- CreateIndex
CREATE INDEX "CmsPage_tenantId_idx" ON "CmsPage"("tenantId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_idx" ON "Customer"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerLoyaltyAccount_tenantId_idx" ON "CustomerLoyaltyAccount"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerNote_tenantId_idx" ON "CustomerNote"("tenantId");

-- CreateIndex
CREATE INDEX "CustomerPreferredLocation_tenantId_idx" ON "CustomerPreferredLocation"("tenantId");

-- CreateIndex
CREATE INDEX "FranchiseInquiry_tenantId_idx" ON "FranchiseInquiry"("tenantId");

-- CreateIndex
CREATE INDEX "FranchiseInquiryNote_tenantId_idx" ON "FranchiseInquiryNote"("tenantId");

-- CreateIndex
CREATE INDEX "GiftCard_tenantId_idx" ON "GiftCard"("tenantId");

-- CreateIndex
CREATE INDEX "GiftCardConfiguration_tenantId_idx" ON "GiftCardConfiguration"("tenantId");

-- CreateIndex
CREATE INDEX "GiftCardPurchase_tenantId_idx" ON "GiftCardPurchase"("tenantId");

-- CreateIndex
CREATE INDEX "GiftCardTransaction_tenantId_idx" ON "GiftCardTransaction"("tenantId");

-- CreateIndex
CREATE INDEX "InternalAuditEvent_tenantId_idx" ON "InternalAuditEvent"("tenantId");

-- CreateIndex
CREATE INDEX "InternalRole_tenantId_idx" ON "InternalRole"("tenantId");

-- CreateIndex
CREATE INDEX "InternalRolePermission_tenantId_idx" ON "InternalRolePermission"("tenantId");

-- CreateIndex
CREATE INDEX "InternalUser_tenantId_idx" ON "InternalUser"("tenantId");

-- CreateIndex
CREATE INDEX "InternalUserRoleAssignment_tenantId_idx" ON "InternalUserRoleAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "JobApplication_tenantId_idx" ON "JobApplication"("tenantId");

-- CreateIndex
CREATE INDEX "JobApplicationNote_tenantId_idx" ON "JobApplicationNote"("tenantId");

-- CreateIndex
CREATE INDEX "JobOpening_tenantId_idx" ON "JobOpening"("tenantId");

-- CreateIndex
CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");

-- CreateIndex
CREATE INDEX "LocationMenu_tenantId_idx" ON "LocationMenu"("tenantId");

-- CreateIndex
CREATE INDEX "LocationProductAvailabilityOverride_tenantId_idx" ON "LocationProductAvailabilityOverride"("tenantId");

-- CreateIndex
CREATE INDEX "LocationProductPriceOverride_tenantId_idx" ON "LocationProductPriceOverride"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotion_tenantId_idx" ON "LoyaltyBonusPromotion"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotionLocation_tenantId_idx" ON "LoyaltyBonusPromotionLocation"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyBonusPromotionProduct_tenantId_idx" ON "LoyaltyBonusPromotionProduct"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyConfiguration_tenantId_idx" ON "LoyaltyConfiguration"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyReward_tenantId_idx" ON "LoyaltyReward"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyRewardCategory_tenantId_idx" ON "LoyaltyRewardCategory"("tenantId");

-- CreateIndex
CREATE INDEX "LoyaltyRewardProduct_tenantId_idx" ON "LoyaltyRewardProduct"("tenantId");

-- CreateIndex
CREATE INDEX "MediaAsset_tenantId_idx" ON "MediaAsset"("tenantId");

-- CreateIndex
CREATE INDEX "Menu_tenantId_idx" ON "Menu"("tenantId");

-- CreateIndex
CREATE INDEX "MenuProduct_tenantId_idx" ON "MenuProduct"("tenantId");

-- CreateIndex
CREATE INDEX "MochaBeanLedgerEntry_tenantId_idx" ON "MochaBeanLedgerEntry"("tenantId");

-- CreateIndex
CREATE INDEX "ModifierGroup_tenantId_idx" ON "ModifierGroup"("tenantId");

-- CreateIndex
CREATE INDEX "ModifierOption_tenantId_idx" ON "ModifierOption"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_tenantId_idx" ON "NotificationDelivery"("tenantId");

-- CreateIndex
CREATE INDEX "OperationsTask_tenantId_idx" ON "OperationsTask"("tenantId");

-- CreateIndex
CREATE INDEX "Order_tenantId_idx" ON "Order"("tenantId");

-- CreateIndex
CREATE INDEX "OrderGiftCardRedemption_tenantId_idx" ON "OrderGiftCardRedemption"("tenantId");

-- CreateIndex
CREATE INDEX "OrderLine_tenantId_idx" ON "OrderLine"("tenantId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyBonus_tenantId_idx" ON "OrderLoyaltyBonus"("tenantId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyBonusItem_tenantId_idx" ON "OrderLoyaltyBonusItem"("tenantId");

-- CreateIndex
CREATE INDEX "OrderLoyaltyRewardRedemption_tenantId_idx" ON "OrderLoyaltyRewardRedemption"("tenantId");

-- CreateIndex
CREATE INDEX "OrderPromotionRedemption_tenantId_idx" ON "OrderPromotionRedemption"("tenantId");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_tenantId_idx" ON "OrderStatusHistory"("tenantId");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_idx" ON "OutboxEvent"("tenantId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_tenantId_idx" ON "PaymentAttempt"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE INDEX "ProductModifierGroup_tenantId_idx" ON "ProductModifierGroup"("tenantId");

-- CreateIndex
CREATE INDEX "Promotion_tenantId_idx" ON "Promotion"("tenantId");

-- CreateIndex
CREATE INDEX "PromotionCategory_tenantId_idx" ON "PromotionCategory"("tenantId");

-- CreateIndex
CREATE INDEX "PromotionCustomerUsage_tenantId_idx" ON "PromotionCustomerUsage"("tenantId");

-- CreateIndex
CREATE INDEX "PromotionLocation_tenantId_idx" ON "PromotionLocation"("tenantId");

-- CreateIndex
CREATE INDEX "PromotionProduct_tenantId_idx" ON "PromotionProduct"("tenantId");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Menu" ADD CONSTRAINT "Menu_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ModifierGroup" ADD CONSTRAINT "ModifierGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LocationMenu" ADD CONSTRAINT "LocationMenu_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InternalUser" ADD CONSTRAINT "InternalUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InternalAuditEvent" ADD CONSTRAINT "InternalAuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InternalRole" ADD CONSTRAINT "InternalRole_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InternalRolePermission" ADD CONSTRAINT "InternalRolePermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChecklistTemplate" ADD CONSTRAINT "ChecklistTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChecklistTemplateItem" ADD CONSTRAINT "ChecklistTemplateItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChecklistInstance" ADD CONSTRAINT "ChecklistInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerLoyaltyAccount" ADD CONSTRAINT "CustomerLoyaltyAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyConfiguration" ADD CONSTRAINT "LoyaltyConfiguration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyReward" ADD CONSTRAINT "LoyaltyReward_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLoyaltyRewardRedemption" ADD CONSTRAINT "OrderLoyaltyRewardRedemption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotion" ADD CONSTRAINT "LoyaltyBonusPromotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLoyaltyBonus" ADD CONSTRAINT "OrderLoyaltyBonus_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLoyaltyBonusItem" ADD CONSTRAINT "OrderLoyaltyBonusItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderPromotionRedemption" ADD CONSTRAINT "OrderPromotionRedemption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGiftCardRedemption" ADD CONSTRAINT "OrderGiftCardRedemption_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GiftCardConfiguration" ADD CONSTRAINT "GiftCardConfiguration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FranchiseInquiry" ADD CONSTRAINT "FranchiseInquiry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CmsPage" ADD CONSTRAINT "CmsPage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
