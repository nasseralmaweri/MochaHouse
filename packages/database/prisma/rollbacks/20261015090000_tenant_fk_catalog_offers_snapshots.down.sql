-- Security 4C-6 rollback for migration 20261015090000_tenant_fk_catalog_offers_snapshots.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the 4C-6 composite
-- relations in schema.prisma (back to single-column fields/references,
-- removing Campaign.mediaAsset / MediaAsset.campaigns and the four snapshot
-- indexes) and ship this SQL as a NEW forward migration, so every
-- environment's history stays linear.
--
-- It removes only what 4C-6 added — the 19 ownership triggers, the product
-- reuse guard, the OrderLine snapshot trigger, the five indexes and the 33
-- composite foreign keys — restores the 32 single-column foreign keys
-- exactly as they were (including ON UPDATE CASCADE; Campaign.mediaAssetId
-- goes back to having none), and restores the two 4C-4 snapshot functions
-- to their 4C-4 definitions (no source-row lock; one (table, column) pair
-- per trigger). Data is untouched. It keeps reject_tenant_reassignment()
-- (4C-3). One DO block, so Prisma applies it atomically. Roll back 4C-6
-- before 4C-5, 4C-4, 4C-3 or 4C-2.

DO $tenant_fk_catalog_offers_snapshots_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  DROP TRIGGER "Campaign_tenantId_immutable" ON "Campaign";
  DROP TRIGGER "CampaignProduct_tenantId_immutable" ON "CampaignProduct";
  DROP TRIGGER "Category_tenantId_immutable" ON "Category";
  DROP TRIGGER "LocationMenu_tenantId_immutable" ON "LocationMenu";
  DROP TRIGGER "LocationProductAvailabilityOverride_tenantId_immutable" ON "LocationProductAvailabilityOverride";
  DROP TRIGGER "LocationProductPriceOverride_tenantId_immutable" ON "LocationProductPriceOverride";
  DROP TRIGGER "LoyaltyBonusPromotionLocation_tenantId_immutable" ON "LoyaltyBonusPromotionLocation";
  DROP TRIGGER "LoyaltyBonusPromotionProduct_tenantId_immutable" ON "LoyaltyBonusPromotionProduct";
  DROP TRIGGER "LoyaltyRewardCategory_tenantId_immutable" ON "LoyaltyRewardCategory";
  DROP TRIGGER "LoyaltyRewardProduct_tenantId_immutable" ON "LoyaltyRewardProduct";
  DROP TRIGGER "Menu_tenantId_immutable" ON "Menu";
  DROP TRIGGER "MenuProduct_tenantId_immutable" ON "MenuProduct";
  DROP TRIGGER "ModifierGroup_tenantId_immutable" ON "ModifierGroup";
  DROP TRIGGER "ModifierOption_tenantId_immutable" ON "ModifierOption";
  DROP TRIGGER "Product_tenantId_immutable" ON "Product";
  DROP TRIGGER "ProductModifierGroup_tenantId_immutable" ON "ProductModifierGroup";
  DROP TRIGGER "PromotionCategory_tenantId_immutable" ON "PromotionCategory";
  DROP TRIGGER "PromotionLocation_tenantId_immutable" ON "PromotionLocation";
  DROP TRIGGER "PromotionProduct_tenantId_immutable" ON "PromotionProduct";
  DROP TRIGGER "Product_id_not_reused" ON "Product";
  DROP TRIGGER "OrderLine_productId_same_tenant" ON "OrderLine";

  DROP INDEX "Campaign_mediaAssetId_idx";
  DROP INDEX "OrderLine_productId_idx";
  DROP INDEX "OrderLoyaltyBonusItem_productId_idx";
  DROP INDEX "OrderLoyaltyRewardRedemption_freeItemProductId_idx";
  DROP INDEX "OrderPromotionRedemption_freeItemProductId_idx";

  ALTER TABLE "Product" DROP CONSTRAINT "Product_tenantId_categoryId_fkey";
  ALTER TABLE "ModifierOption" DROP CONSTRAINT "ModifierOption_tenantId_modifierGroupId_fkey";
  ALTER TABLE "ProductModifierGroup" DROP CONSTRAINT "ProductModifierGroup_tenantId_productId_fkey";
  ALTER TABLE "ProductModifierGroup" DROP CONSTRAINT "ProductModifierGroup_tenantId_modifierGroupId_fkey";
  ALTER TABLE "MenuProduct" DROP CONSTRAINT "MenuProduct_tenantId_menuId_fkey";
  ALTER TABLE "MenuProduct" DROP CONSTRAINT "MenuProduct_tenantId_productId_fkey";
  ALTER TABLE "LocationMenu" DROP CONSTRAINT "LocationMenu_tenantId_locationId_fkey";
  ALTER TABLE "LocationMenu" DROP CONSTRAINT "LocationMenu_tenantId_menuId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_tenantId_locationId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_tenantId_menuId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_tenantId_productId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_tenantId_locationId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_tenantId_menuId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_tenantId_productId_fkey";
  ALTER TABLE "LoyaltyRewardProduct" DROP CONSTRAINT "LoyaltyRewardProduct_tenantId_rewardId_fkey";
  ALTER TABLE "LoyaltyRewardProduct" DROP CONSTRAINT "LoyaltyRewardProduct_tenantId_productId_fkey";
  ALTER TABLE "LoyaltyRewardCategory" DROP CONSTRAINT "LoyaltyRewardCategory_tenantId_rewardId_fkey";
  ALTER TABLE "LoyaltyRewardCategory" DROP CONSTRAINT "LoyaltyRewardCategory_tenantId_categoryId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionProduct" DROP CONSTRAINT "LoyaltyBonusPromotionProduct_tenantId_promotionId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionProduct" DROP CONSTRAINT "LoyaltyBonusPromotionProduct_tenantId_productId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionLocation" DROP CONSTRAINT "LoyaltyBonusPromotionLocation_tenantId_promotionId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionLocation" DROP CONSTRAINT "LoyaltyBonusPromotionLocation_tenantId_locationId_fkey";
  ALTER TABLE "PromotionProduct" DROP CONSTRAINT "PromotionProduct_tenantId_promotionId_fkey";
  ALTER TABLE "PromotionProduct" DROP CONSTRAINT "PromotionProduct_tenantId_productId_fkey";
  ALTER TABLE "PromotionCategory" DROP CONSTRAINT "PromotionCategory_tenantId_promotionId_fkey";
  ALTER TABLE "PromotionCategory" DROP CONSTRAINT "PromotionCategory_tenantId_categoryId_fkey";
  ALTER TABLE "PromotionLocation" DROP CONSTRAINT "PromotionLocation_tenantId_promotionId_fkey";
  ALTER TABLE "PromotionLocation" DROP CONSTRAINT "PromotionLocation_tenantId_locationId_fkey";
  ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_tenantId_promotionId_fkey";
  ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_tenantId_loyaltyBonusPromotionId_fkey";
  ALTER TABLE "CampaignProduct" DROP CONSTRAINT "CampaignProduct_tenantId_campaignId_fkey";
  ALTER TABLE "CampaignProduct" DROP CONSTRAINT "CampaignProduct_tenantId_productId_fkey";
  ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_tenantId_mediaAssetId_fkey";

  ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "ModifierGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_modifierGroupId_fkey" FOREIGN KEY ("modifierGroupId") REFERENCES "ModifierGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationMenu" ADD CONSTRAINT "LocationMenu_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationMenu" ADD CONSTRAINT "LocationMenu_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "LoyaltyReward"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "LoyaltyReward"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyBonusPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "LoyaltyBonusPromotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_loyaltyBonusPromotionId_fkey" FOREIGN KEY ("loyaltyBonusPromotionId") REFERENCES "LoyaltyBonusPromotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

  -- The 4C-4 definitions, verbatim.
  CREATE OR REPLACE FUNCTION "reject_cross_tenant_snapshot"() RETURNS trigger
    LANGUAGE plpgsql AS $reject_cross_tenant_snapshot$
  DECLARE
    ref text := to_jsonb(NEW) ->> TG_ARGV[0];
    owner text;
  BEGIN
    -- No reference, or a value kept unchanged (its source may since have
    -- been deleted): nothing new is being asserted.
    IF ref IS NULL OR (TG_OP = 'UPDATE' AND ref IS NOT DISTINCT FROM to_jsonb(OLD) ->> TG_ARGV[0]) THEN
      RETURN NEW;
    END IF;
    EXECUTE format('SELECT "tenantId" FROM %I.%I WHERE "id" = $1', TG_TABLE_SCHEMA, TG_ARGV[1])
      INTO owner USING ref;
    IF owner IS NULL THEN
      RAISE EXCEPTION '"%"."%" must name an existing "%".', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF owner <> NEW."tenantId" THEN
      RAISE EXCEPTION '"%"."%" cannot name another business''s "%".', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END
  $reject_cross_tenant_snapshot$;
  CREATE OR REPLACE FUNCTION "reject_reused_snapshot_source"() RETURNS trigger
    LANGUAGE plpgsql AS $reject_reused_snapshot_source$
  DECLARE
    taken boolean;
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW."id" = OLD."id" THEN
      RETURN NEW;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1 AND "tenantId" <> $2)',
        TG_TABLE_SCHEMA, TG_ARGV[0], TG_ARGV[1])
      INTO taken USING NEW."id", NEW."tenantId";
    IF taken THEN
      RAISE EXCEPTION '"%" id is still named by another business''s "%"."%".', TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[1]
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END
  $reject_reused_snapshot_source$;
END
$tenant_fk_catalog_offers_snapshots_rollback$;
