-- Security 4C-6 — tenant-enforced catalog, menus, modifiers, offer
-- definitions and campaigns; product snapshot isolation.
--
-- Replaces the 32 single-column foreign keys between catalog and offer
-- records with composite ones on ("tenantId", <column>) -> parent
-- ("tenantId", "id"), and gives Campaign.mediaAssetId its first foreign
-- key. PostgreSQL itself therefore rejects a menu, product, modifier,
-- price/availability override, offer rule or campaign that references
-- another business's record:
--
--   Product.categoryId                             -> Category              ON DELETE RESTRICT
--   ModifierOption.modifierGroupId                 -> ModifierGroup         ON DELETE RESTRICT
--   ProductModifierGroup.productId                 -> Product               ON DELETE RESTRICT
--   ProductModifierGroup.modifierGroupId           -> ModifierGroup         ON DELETE RESTRICT
--   MenuProduct.menuId                             -> Menu                  ON DELETE RESTRICT
--   MenuProduct.productId                          -> Product               ON DELETE RESTRICT
--   LocationMenu.locationId                        -> Location              ON DELETE RESTRICT
--   LocationMenu.menuId                            -> Menu                  ON DELETE RESTRICT
--   LocationProductPriceOverride.locationId        -> Location              ON DELETE RESTRICT
--   LocationProductPriceOverride.menuId            -> Menu                  ON DELETE RESTRICT
--   LocationProductPriceOverride.productId         -> Product               ON DELETE RESTRICT
--   LocationProductAvailabilityOverride.locationId -> Location              ON DELETE RESTRICT
--   LocationProductAvailabilityOverride.menuId     -> Menu                  ON DELETE RESTRICT
--   LocationProductAvailabilityOverride.productId  -> Product               ON DELETE RESTRICT
--   LoyaltyRewardProduct.rewardId                  -> LoyaltyReward         ON DELETE CASCADE
--   LoyaltyRewardProduct.productId                 -> Product               ON DELETE RESTRICT
--   LoyaltyRewardCategory.rewardId                 -> LoyaltyReward         ON DELETE CASCADE
--   LoyaltyRewardCategory.categoryId               -> Category              ON DELETE RESTRICT
--   LoyaltyBonusPromotionProduct.promotionId       -> LoyaltyBonusPromotion ON DELETE CASCADE
--   LoyaltyBonusPromotionProduct.productId         -> Product               ON DELETE RESTRICT
--   LoyaltyBonusPromotionLocation.promotionId      -> LoyaltyBonusPromotion ON DELETE CASCADE
--   LoyaltyBonusPromotionLocation.locationId       -> Location              ON DELETE RESTRICT
--   PromotionProduct.promotionId                   -> Promotion             ON DELETE CASCADE
--   PromotionProduct.productId                     -> Product               ON DELETE RESTRICT
--   PromotionCategory.promotionId                  -> Promotion             ON DELETE CASCADE
--   PromotionCategory.categoryId                   -> Category              ON DELETE RESTRICT
--   PromotionLocation.promotionId                  -> Promotion             ON DELETE CASCADE
--   PromotionLocation.locationId                   -> Location              ON DELETE RESTRICT
--   Campaign.promotionId                           -> Promotion             ON DELETE RESTRICT
--   Campaign.loyaltyBonusPromotionId               -> LoyaltyBonusPromotion ON DELETE RESTRICT
--   CampaignProduct.campaignId                     -> Campaign              ON DELETE CASCADE
--   CampaignProduct.productId                      -> Product               ON DELETE RESTRICT
--   Campaign.mediaAssetId                          -> MediaAsset            ON DELETE RESTRICT   (NEW: had no foreign key)
--
-- Delete behaviour is unchanged (media assets are deactivated, never
-- deleted, so the new key's RESTRICT changes no application path). ON
-- UPDATE is RESTRICT (was CASCADE): ids never change.
--
-- Ownership: these tables reject any change of "tenantId" on an existing
-- row (trigger "<Table>_tenantId_immutable", SQLSTATE 23001), reusing
-- Security 4C-3's reject_tenant_reassignment():
--   Campaign, CampaignProduct, Category, LocationMenu, LocationProductAvailabilityOverride, LocationProductPriceOverride, LoyaltyBonusPromotionLocation, LoyaltyBonusPromotionProduct, LoyaltyRewardCategory, LoyaltyRewardProduct, Menu, MenuProduct, ModifierGroup, ModifierOption, Product, ProductModifierGroup, PromotionCategory, PromotionLocation, PromotionProduct.
--
-- Product snapshots (closes the OPEN SECURITY FINDING recorded in 4C-4):
--   OrderLine.productId
--   OrderLoyaltyBonusItem.productId
--   OrderLoyaltyRewardRedemption.freeItemProductId
--   OrderPromotionRedemption.freeItemProductId
--   - Each is indexed, and "Product_id_not_reused" (BEFORE INSERT OR UPDATE OF
--     "id" ON "Product") refuses a product id that a snapshot of ANOTHER
--     business still names (SQLSTATE 23505) — so a deleted product's id can
--     never be taken by another business while history names it.
--   - OrderLine.productId had no same-business check at all (it was not in
--     the 4C-4 finding): "OrderLine_productId_same_tenant" now requires a NEW
--     or CHANGED value to name an existing product of the SAME business; an
--     unchanged value may outlive its product (history is kept).
--   - reject_cross_tenant_snapshot() (4C-4, used by every snapshot trigger)
--     now locks the source row it validates (FOR KEY SHARE) until the
--     writing transaction ends, so the source cannot be deleted — and its id
--     re-created by another business — between validation and commit.
--   - reject_reused_snapshot_source() (4C-4) now accepts several
--     (table, column) pairs per trigger; the four existing triggers are
--     unaffected.
--
-- Safety:
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement,
--     so the migration applies completely or not at all.
--   - Preflight (read-only) first: the PostgreSQL version, the 4C-3 and 4C-4
--     functions, every row of the 33 relationships must reference a row of
--     the SAME business, and no product snapshot may name a product that
--     belongs to another business. Any problem aborts with counts and
--     nothing changed. Nothing is repaired or reassigned automatically.
--   - lock_timeout 5s (local to this transaction): it fails, atomically,
--     rather than queue application traffic behind a lock it cannot get.
--
-- If it fails: nothing changed. Fix the reported rows deliberately (or wait
-- for a quieter moment), run `prisma migrate resolve --rolled-back
-- 20261015090000_tenant_fk_catalog_offers_snapshots`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261015090000_tenant_fk_catalog_offers_snapshots.down.sql.

DO $tenant_fk_catalog_offers_snapshots$
DECLARE
  r record;
  n bigint;
  problems text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Security 4C-6 requires PostgreSQL 15 or later; this server is %. Nothing was changed.',
      current_setting('server_version');
  END IF;
  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Security 4C-6 requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;
  IF to_regprocedure('public.reject_cross_tenant_snapshot()') IS NULL
     OR to_regprocedure('public.reject_reused_snapshot_source()') IS NULL THEN
    RAISE EXCEPTION 'Security 4C-6 requires Security 4C-4 (snapshot functions). Nothing was changed.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('Product', 'categoryId', 'Category'),
      ('ModifierOption', 'modifierGroupId', 'ModifierGroup'),
      ('ProductModifierGroup', 'productId', 'Product'),
      ('ProductModifierGroup', 'modifierGroupId', 'ModifierGroup'),
      ('MenuProduct', 'menuId', 'Menu'),
      ('MenuProduct', 'productId', 'Product'),
      ('LocationMenu', 'locationId', 'Location'),
      ('LocationMenu', 'menuId', 'Menu'),
      ('LocationProductPriceOverride', 'locationId', 'Location'),
      ('LocationProductPriceOverride', 'menuId', 'Menu'),
      ('LocationProductPriceOverride', 'productId', 'Product'),
      ('LocationProductAvailabilityOverride', 'locationId', 'Location'),
      ('LocationProductAvailabilityOverride', 'menuId', 'Menu'),
      ('LocationProductAvailabilityOverride', 'productId', 'Product'),
      ('LoyaltyRewardProduct', 'rewardId', 'LoyaltyReward'),
      ('LoyaltyRewardProduct', 'productId', 'Product'),
      ('LoyaltyRewardCategory', 'rewardId', 'LoyaltyReward'),
      ('LoyaltyRewardCategory', 'categoryId', 'Category'),
      ('LoyaltyBonusPromotionProduct', 'promotionId', 'LoyaltyBonusPromotion'),
      ('LoyaltyBonusPromotionProduct', 'productId', 'Product'),
      ('LoyaltyBonusPromotionLocation', 'promotionId', 'LoyaltyBonusPromotion'),
      ('LoyaltyBonusPromotionLocation', 'locationId', 'Location'),
      ('PromotionProduct', 'promotionId', 'Promotion'),
      ('PromotionProduct', 'productId', 'Product'),
      ('PromotionCategory', 'promotionId', 'Promotion'),
      ('PromotionCategory', 'categoryId', 'Category'),
      ('PromotionLocation', 'promotionId', 'Promotion'),
      ('PromotionLocation', 'locationId', 'Location'),
      ('Campaign', 'promotionId', 'Promotion'),
      ('Campaign', 'loyaltyBonusPromotionId', 'LoyaltyBonusPromotion'),
      ('CampaignProduct', 'campaignId', 'Campaign'),
      ('CampaignProduct', 'productId', 'Product'),
      ('Campaign', 'mediaAssetId', 'MediaAsset')
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
  FOR r IN
    SELECT * FROM (VALUES
      ('OrderLine', 'productId'),
      ('OrderLoyaltyBonusItem', 'productId'),
      ('OrderLoyaltyRewardRedemption', 'freeItemProductId'),
      ('OrderPromotionRedemption', 'freeItemProductId')
    ) AS t(child, col)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c JOIN "Product" p ON p."id" = c.%I WHERE p."tenantId" <> c."tenantId"',
      r.child, r.col)
      INTO n;
    IF n > 0 THEN
      problems := problems || format(E'\n  %s.%s -> Product (snapshot of another business): %s row(s)', r.child, r.col, n);
    END IF;
  END LOOP;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Security 4C-6 aborted: rows reference another business''s record or a missing one. Nothing was changed; resolve them explicitly, then retry:%',
      problems;
  END IF;

  ALTER TABLE "Product" DROP CONSTRAINT "Product_categoryId_fkey";
  ALTER TABLE "ModifierOption" DROP CONSTRAINT "ModifierOption_modifierGroupId_fkey";
  ALTER TABLE "ProductModifierGroup" DROP CONSTRAINT "ProductModifierGroup_productId_fkey";
  ALTER TABLE "ProductModifierGroup" DROP CONSTRAINT "ProductModifierGroup_modifierGroupId_fkey";
  ALTER TABLE "MenuProduct" DROP CONSTRAINT "MenuProduct_menuId_fkey";
  ALTER TABLE "MenuProduct" DROP CONSTRAINT "MenuProduct_productId_fkey";
  ALTER TABLE "LocationMenu" DROP CONSTRAINT "LocationMenu_locationId_fkey";
  ALTER TABLE "LocationMenu" DROP CONSTRAINT "LocationMenu_menuId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_locationId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_menuId_fkey";
  ALTER TABLE "LocationProductPriceOverride" DROP CONSTRAINT "LocationProductPriceOverride_productId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_locationId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_menuId_fkey";
  ALTER TABLE "LocationProductAvailabilityOverride" DROP CONSTRAINT "LocationProductAvailabilityOverride_productId_fkey";
  ALTER TABLE "LoyaltyRewardProduct" DROP CONSTRAINT "LoyaltyRewardProduct_rewardId_fkey";
  ALTER TABLE "LoyaltyRewardProduct" DROP CONSTRAINT "LoyaltyRewardProduct_productId_fkey";
  ALTER TABLE "LoyaltyRewardCategory" DROP CONSTRAINT "LoyaltyRewardCategory_rewardId_fkey";
  ALTER TABLE "LoyaltyRewardCategory" DROP CONSTRAINT "LoyaltyRewardCategory_categoryId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionProduct" DROP CONSTRAINT "LoyaltyBonusPromotionProduct_promotionId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionProduct" DROP CONSTRAINT "LoyaltyBonusPromotionProduct_productId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionLocation" DROP CONSTRAINT "LoyaltyBonusPromotionLocation_promotionId_fkey";
  ALTER TABLE "LoyaltyBonusPromotionLocation" DROP CONSTRAINT "LoyaltyBonusPromotionLocation_locationId_fkey";
  ALTER TABLE "PromotionProduct" DROP CONSTRAINT "PromotionProduct_promotionId_fkey";
  ALTER TABLE "PromotionProduct" DROP CONSTRAINT "PromotionProduct_productId_fkey";
  ALTER TABLE "PromotionCategory" DROP CONSTRAINT "PromotionCategory_promotionId_fkey";
  ALTER TABLE "PromotionCategory" DROP CONSTRAINT "PromotionCategory_categoryId_fkey";
  ALTER TABLE "PromotionLocation" DROP CONSTRAINT "PromotionLocation_promotionId_fkey";
  ALTER TABLE "PromotionLocation" DROP CONSTRAINT "PromotionLocation_locationId_fkey";
  ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_promotionId_fkey";
  ALTER TABLE "Campaign" DROP CONSTRAINT "Campaign_loyaltyBonusPromotionId_fkey";
  ALTER TABLE "CampaignProduct" DROP CONSTRAINT "CampaignProduct_campaignId_fkey";
  ALTER TABLE "CampaignProduct" DROP CONSTRAINT "CampaignProduct_productId_fkey";

  ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "Category"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_tenantId_modifierGroupId_fkey" FOREIGN KEY ("tenantId", "modifierGroupId") REFERENCES "ModifierGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ProductModifierGroup" ADD CONSTRAINT "ProductModifierGroup_tenantId_modifierGroupId_fkey" FOREIGN KEY ("tenantId", "modifierGroupId") REFERENCES "ModifierGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_tenantId_menuId_fkey" FOREIGN KEY ("tenantId", "menuId") REFERENCES "Menu"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "MenuProduct" ADD CONSTRAINT "MenuProduct_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationMenu" ADD CONSTRAINT "LocationMenu_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationMenu" ADD CONSTRAINT "LocationMenu_tenantId_menuId_fkey" FOREIGN KEY ("tenantId", "menuId") REFERENCES "Menu"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_tenantId_menuId_fkey" FOREIGN KEY ("tenantId", "menuId") REFERENCES "Menu"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_tenantId_menuId_fkey" FOREIGN KEY ("tenantId", "menuId") REFERENCES "Menu"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_tenantId_rewardId_fkey" FOREIGN KEY ("tenantId", "rewardId") REFERENCES "LoyaltyReward"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyRewardProduct" ADD CONSTRAINT "LoyaltyRewardProduct_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_tenantId_rewardId_fkey" FOREIGN KEY ("tenantId", "rewardId") REFERENCES "LoyaltyReward"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyRewardCategory" ADD CONSTRAINT "LoyaltyRewardCategory_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "Category"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "LoyaltyBonusPromotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyBonusPromotionProduct" ADD CONSTRAINT "LoyaltyBonusPromotionProduct_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "LoyaltyBonusPromotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "LoyaltyBonusPromotionLocation" ADD CONSTRAINT "LoyaltyBonusPromotionLocation_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PromotionProduct" ADD CONSTRAINT "PromotionProduct_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PromotionCategory" ADD CONSTRAINT "PromotionCategory_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "Category"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PromotionLocation" ADD CONSTRAINT "PromotionLocation_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_loyaltyBonusPromotionId_fkey" FOREIGN KEY ("tenantId", "loyaltyBonusPromotionId") REFERENCES "LoyaltyBonusPromotion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_tenantId_campaignId_fkey" FOREIGN KEY ("tenantId", "campaignId") REFERENCES "Campaign"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "CampaignProduct" ADD CONSTRAINT "CampaignProduct_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_mediaAssetId_fkey" FOREIGN KEY ("tenantId", "mediaAssetId") REFERENCES "MediaAsset"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE INDEX "Campaign_mediaAssetId_idx" ON "Campaign"("mediaAssetId");
  CREATE INDEX "OrderLine_productId_idx" ON "OrderLine"("productId");
  CREATE INDEX "OrderLoyaltyBonusItem_productId_idx" ON "OrderLoyaltyBonusItem"("productId");
  CREATE INDEX "OrderLoyaltyRewardRedemption_freeItemProductId_idx" ON "OrderLoyaltyRewardRedemption"("freeItemProductId");
  CREATE INDEX "OrderPromotionRedemption_freeItemProductId_idx" ON "OrderPromotionRedemption"("freeItemProductId");

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
    -- Security 4C-6 — FOR KEY SHARE: the source row cannot be deleted (or
    -- its id changed) until this transaction ends, so it cannot vanish and
    -- reappear under another business between this check and the commit.
    EXECUTE format('SELECT "tenantId" FROM %I.%I WHERE "id" = $1 FOR KEY SHARE', TG_TABLE_SCHEMA, TG_ARGV[1])
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
    i int := 0;
  BEGIN
    IF TG_OP = 'UPDATE' AND NEW."id" = OLD."id" THEN
      RETURN NEW;
    END IF;
    -- Security 4C-6 — any number of (table, column) pairs: every snapshot
    -- column that may name this source.
    WHILE i < TG_NARGS LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1 AND "tenantId" <> $2)',
          TG_TABLE_SCHEMA, TG_ARGV[i], TG_ARGV[i + 1])
        INTO taken USING NEW."id", NEW."tenantId";
      IF taken THEN
        RAISE EXCEPTION '"%" id is still named by another business''s "%"."%".', TG_TABLE_NAME, TG_ARGV[i], TG_ARGV[i + 1]
          USING ERRCODE = 'unique_violation';
      END IF;
      i := i + 2;
    END LOOP;
    RETURN NEW;
  END
  $reject_reused_snapshot_source$;

  CREATE TRIGGER "OrderLine_productId_same_tenant" BEFORE INSERT OR UPDATE OF "productId" ON "OrderLine"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('productId', 'Product');
  CREATE TRIGGER "Product_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "Product"
    FOR EACH ROW EXECUTE FUNCTION "reject_reused_snapshot_source"('OrderLine', 'productId', 'OrderLoyaltyBonusItem', 'productId', 'OrderLoyaltyRewardRedemption', 'freeItemProductId', 'OrderPromotionRedemption', 'freeItemProductId');

  CREATE TRIGGER "Campaign_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Campaign"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "CampaignProduct_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CampaignProduct"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Category_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Category"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LocationMenu_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationMenu"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LocationProductAvailabilityOverride_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationProductAvailabilityOverride"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LocationProductPriceOverride_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LocationProductPriceOverride"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyBonusPromotionLocation_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyBonusPromotionLocation"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyBonusPromotionProduct_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyBonusPromotionProduct"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyRewardCategory_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyRewardCategory"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyRewardProduct_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyRewardProduct"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Menu_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Menu"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "MenuProduct_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "MenuProduct"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ModifierGroup_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ModifierGroup"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ModifierOption_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ModifierOption"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Product_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Product"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ProductModifierGroup_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ProductModifierGroup"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PromotionCategory_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PromotionCategory"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PromotionLocation_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PromotionLocation"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PromotionProduct_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PromotionProduct"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
END
$tenant_fk_catalog_offers_snapshots$;
