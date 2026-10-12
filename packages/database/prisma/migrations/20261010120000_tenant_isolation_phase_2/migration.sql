-- Tenant isolation phase 2 — guarded, relationship-derived ownership
-- backfill + NOT NULL + tenant-scoped uniqueness for every remaining
-- tenant-owned model:
--   InternalAuditEvent, ApprovalRequest, MediaAsset, CmsPage,
--   CustomerLoyaltyAccount, MochaBeanLedgerEntry, LoyaltyConfiguration,
--   LoyaltyReward (+Product/Category), OrderLoyaltyRewardRedemption,
--   LoyaltyBonusPromotion (+Product/Location), OrderLoyaltyBonus (+Item),
--   Promotion (+Product/Category/Location/CustomerUsage),
--   OrderPromotionRedemption, GiftCard, GiftCardTransaction,
--   OrderGiftCardRedemption, GiftCardConfiguration, Campaign (+Product).
--
-- Applied as ONE atomic unit: any failed check rolls everything back.
--
-- OWNERSHIP IS NEVER ASSUMED. Unlike S0D-1 / S0D-2D, nothing here assigns a
-- row to Tenant #1 (or any tenant) for lack of evidence, and nothing depends
-- on how many tenants exist. Every NULL tenantId is filled ONLY from a
-- relationship whose own tenantId is already authoritative (NOT NULL):
--
--   direct parent (single, required FK)
--     InternalAuditEvent        <- actor InternalUser
--     ApprovalRequest           <- requesting InternalUser
--     MediaAsset                <- uploading InternalUser
--     CustomerLoyaltyAccount    <- Customer
--     MochaBeanLedgerEntry      <- its CustomerLoyaltyAccount
--     Order* snapshots          <- Order
--     OrderLoyaltyBonusItem     <- OrderLoyaltyBonus
--     PromotionCustomerUsage    <- Customer
--     *Product / *Category / *Location link rows <- Product / Category /
--                                  Location
--     GiftCardTransaction       <- its GiftCard (after the GiftCard below)
--   evidence-derived roots (every piece of evidence must agree)
--     GiftCard        <- GiftCardPurchase, transactions' actor / Order /
--                        purchase, redeeming Orders, its audit events
--     Promotion       <- eligibility links, customer usage, redemptions,
--                        linked Campaigns, its audit events
--     LoyaltyReward   <- eligibility links, redemptions, its audit events
--     LoyaltyBonusPromotion <- eligibility links, bonus items, linked
--                        Campaigns, its audit events
--     Campaign        <- featured products, image, linked promotions,
--                        approval requests, its audit events
--     CmsPage         <- its audit events
--     LoyaltyConfiguration / GiftCardConfiguration <- their audit events
--
-- A row whose evidence names MORE THAN ONE tenant is a conflict; a row
-- with NO evidence is unresolved. Either aborts the migration with a
-- per-table report (RAISE NOTICE) and the offending row ids, and nothing is
-- changed. Such rows need an explicit, approved ownership decision before
-- this migration can run. Finally every parent/child pair is checked for
-- agreement; a mismatch also aborts.
--
-- DRY RUN: `SET centerivo.tenant_backfill_dry_run = 'on'` before running
-- this file (see packages/database/prisma/scripts/tenant-isolation-phase-2-
-- dry-run.sql). The same derivation runs, the report is printed, and the
-- migration then aborts deliberately so nothing is committed.
DO $p2$
DECLARE
  dry_run BOOLEAN := coalesce(current_setting('centerivo.tenant_backfill_dry_run', true), '') = 'on';
  tname TEXT;
  null_before BIGINT;
  null_after BIGINT;
  pass INTEGER;
  changed BIGINT;
  total_changed BIGINT;
  problems BIGINT;
  rec RECORD;
  tables CONSTANT TEXT[] := ARRAY[
    'InternalAuditEvent', 'ApprovalRequest', 'MediaAsset', 'CmsPage',
    'CustomerLoyaltyAccount', 'MochaBeanLedgerEntry', 'LoyaltyConfiguration',
    'LoyaltyReward', 'LoyaltyRewardProduct', 'LoyaltyRewardCategory',
    'OrderLoyaltyRewardRedemption', 'LoyaltyBonusPromotion',
    'LoyaltyBonusPromotionProduct', 'LoyaltyBonusPromotionLocation',
    'OrderLoyaltyBonus', 'OrderLoyaltyBonusItem', 'Promotion',
    'PromotionProduct', 'PromotionCategory', 'PromotionLocation',
    'PromotionCustomerUsage', 'OrderPromotionRedemption', 'GiftCard',
    'GiftCardTransaction', 'OrderGiftCardRedemption', 'GiftCardConfiguration',
    'Campaign', 'CampaignProduct'
  ];
BEGIN
  CREATE TEMP TABLE _p2_nulls (tbl TEXT PRIMARY KEY, null_before BIGINT) ON COMMIT DROP;
  CREATE TEMP TABLE _p2_candidate (tbl TEXT, row_key TEXT, tenant_id TEXT, source TEXT) ON COMMIT DROP;
  CREATE TEMP TABLE _p2_problem (tbl TEXT, row_key TEXT, kind TEXT, detail TEXT) ON COMMIT DROP;

  FOREACH tname IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', tname) INTO null_before;
    INSERT INTO _p2_nulls VALUES (tname, null_before);
  END LOOP;

  -- --- 1. direct, single-parent derivations ---------------------------
  UPDATE "InternalAuditEvent" e SET "tenantId" = u."tenantId"
    FROM "InternalUser" u WHERE e."actorInternalUserId" = u."id" AND e."tenantId" IS NULL;
  UPDATE "ApprovalRequest" a SET "tenantId" = u."tenantId"
    FROM "InternalUser" u WHERE a."requestedByInternalUserId" = u."id" AND a."tenantId" IS NULL;
  UPDATE "MediaAsset" m SET "tenantId" = u."tenantId"
    FROM "InternalUser" u WHERE m."uploadedByInternalUserId" = u."id" AND m."tenantId" IS NULL;
  UPDATE "CustomerLoyaltyAccount" a SET "tenantId" = c."tenantId"
    FROM "Customer" c WHERE a."customerId" = c."id" AND a."tenantId" IS NULL;
  UPDATE "MochaBeanLedgerEntry" l SET "tenantId" = a."tenantId"
    FROM "CustomerLoyaltyAccount" a
   WHERE l."loyaltyAccountId" = a."id" AND l."tenantId" IS NULL AND a."tenantId" IS NOT NULL;
  UPDATE "OrderGiftCardRedemption" r SET "tenantId" = o."tenantId"
    FROM "Order" o WHERE r."orderId" = o."id" AND r."tenantId" IS NULL;
  UPDATE "OrderLoyaltyRewardRedemption" r SET "tenantId" = o."tenantId"
    FROM "Order" o WHERE r."orderId" = o."id" AND r."tenantId" IS NULL;
  UPDATE "OrderLoyaltyBonus" b SET "tenantId" = o."tenantId"
    FROM "Order" o WHERE b."orderId" = o."id" AND b."tenantId" IS NULL;
  UPDATE "OrderLoyaltyBonusItem" i SET "tenantId" = b."tenantId"
    FROM "OrderLoyaltyBonus" b
   WHERE i."orderLoyaltyBonusId" = b."id" AND i."tenantId" IS NULL AND b."tenantId" IS NOT NULL;
  UPDATE "OrderPromotionRedemption" r SET "tenantId" = o."tenantId"
    FROM "Order" o WHERE r."orderId" = o."id" AND r."tenantId" IS NULL;
  UPDATE "PromotionCustomerUsage" x SET "tenantId" = c."tenantId"
    FROM "Customer" c WHERE x."customerId" = c."id" AND x."tenantId" IS NULL;
  UPDATE "PromotionProduct" x SET "tenantId" = p."tenantId"
    FROM "Product" p WHERE x."productId" = p."id" AND x."tenantId" IS NULL;
  UPDATE "PromotionCategory" x SET "tenantId" = c."tenantId"
    FROM "Category" c WHERE x."categoryId" = c."id" AND x."tenantId" IS NULL;
  UPDATE "PromotionLocation" x SET "tenantId" = l."tenantId"
    FROM "Location" l WHERE x."locationId" = l."id" AND x."tenantId" IS NULL;
  UPDATE "LoyaltyRewardProduct" x SET "tenantId" = p."tenantId"
    FROM "Product" p WHERE x."productId" = p."id" AND x."tenantId" IS NULL;
  UPDATE "LoyaltyRewardCategory" x SET "tenantId" = c."tenantId"
    FROM "Category" c WHERE x."categoryId" = c."id" AND x."tenantId" IS NULL;
  UPDATE "LoyaltyBonusPromotionProduct" x SET "tenantId" = p."tenantId"
    FROM "Product" p WHERE x."productId" = p."id" AND x."tenantId" IS NULL;
  UPDATE "LoyaltyBonusPromotionLocation" x SET "tenantId" = l."tenantId"
    FROM "Location" l WHERE x."locationId" = l."id" AND x."tenantId" IS NULL;
  UPDATE "CampaignProduct" x SET "tenantId" = p."tenantId"
    FROM "Product" p WHERE x."productId" = p."id" AND x."tenantId" IS NULL;

  -- --- 2. evidence-derived roots (iterated: Campaign <-> promotions) ----
  FOR pass IN 1..3 LOOP
    TRUNCATE _p2_candidate;

    -- every root's own, already-set tenant is evidence too
    INSERT INTO _p2_candidate SELECT 'GiftCard', "id", "tenantId", 'self' FROM "GiftCard" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', "id", "tenantId", 'self' FROM "Promotion" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyReward', "id", "tenantId", 'self' FROM "LoyaltyReward" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', "id", "tenantId", 'self' FROM "LoyaltyBonusPromotion" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', "id", "tenantId", 'self' FROM "Campaign" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'CmsPage', "id", "tenantId", 'self' FROM "CmsPage" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyConfiguration', "id", "tenantId", 'self' FROM "LoyaltyConfiguration" WHERE "tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'GiftCardConfiguration', "id", "tenantId", 'self' FROM "GiftCardConfiguration" WHERE "tenantId" IS NOT NULL;

    -- GiftCard
    INSERT INTO _p2_candidate SELECT 'GiftCard', p."giftCardId", p."tenantId", 'purchase'
      FROM "GiftCardPurchase" p WHERE p."giftCardId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'GiftCard', t."giftCardId", u."tenantId", 'transaction actor'
      FROM "GiftCardTransaction" t JOIN "InternalUser" u ON u."id" = t."actorInternalUserId";
    INSERT INTO _p2_candidate SELECT 'GiftCard', t."giftCardId", o."tenantId", 'transaction order'
      FROM "GiftCardTransaction" t JOIN "Order" o ON o."id" = t."orderId";
    INSERT INTO _p2_candidate SELECT 'GiftCard', t."giftCardId", p."tenantId", 'transaction purchase'
      FROM "GiftCardTransaction" t JOIN "GiftCardPurchase" p ON p."id" = t."giftCardPurchaseId";
    INSERT INTO _p2_candidate SELECT 'GiftCard', t."giftCardId", t."tenantId", 'transaction'
      FROM "GiftCardTransaction" t WHERE t."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'GiftCard', r."sourceGiftCardId", r."tenantId", 'redemption order'
      FROM "OrderGiftCardRedemption" r WHERE r."sourceGiftCardId" IS NOT NULL AND r."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'GiftCard', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'gift_card' AND e."tenantId" IS NOT NULL;

    -- Promotion
    INSERT INTO _p2_candidate SELECT 'Promotion', x."promotionId", x."tenantId", 'eligible product' FROM "PromotionProduct" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', x."promotionId", x."tenantId", 'eligible category' FROM "PromotionCategory" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', x."promotionId", x."tenantId", 'eligible location' FROM "PromotionLocation" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', x."promotionId", x."tenantId", 'customer usage' FROM "PromotionCustomerUsage" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', r."sourcePromotionId", r."tenantId", 'redemption order'
      FROM "OrderPromotionRedemption" r WHERE r."sourcePromotionId" IS NOT NULL AND r."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', c."promotionId", c."tenantId", 'linked campaign'
      FROM "Campaign" c WHERE c."promotionId" IS NOT NULL AND c."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Promotion', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'promotion' AND e."tenantId" IS NOT NULL;

    -- LoyaltyReward
    INSERT INTO _p2_candidate SELECT 'LoyaltyReward', x."rewardId", x."tenantId", 'eligible product' FROM "LoyaltyRewardProduct" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyReward', x."rewardId", x."tenantId", 'eligible category' FROM "LoyaltyRewardCategory" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyReward', r."sourceRewardId", r."tenantId", 'redemption order'
      FROM "OrderLoyaltyRewardRedemption" r WHERE r."sourceRewardId" IS NOT NULL AND r."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyReward', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'loyalty_reward' AND e."tenantId" IS NOT NULL;

    -- LoyaltyBonusPromotion
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', x."promotionId", x."tenantId", 'eligible product' FROM "LoyaltyBonusPromotionProduct" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', x."promotionId", x."tenantId", 'eligible location' FROM "LoyaltyBonusPromotionLocation" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', i."sourcePromotionId", i."tenantId", 'bonus item order'
      FROM "OrderLoyaltyBonusItem" i WHERE i."sourcePromotionId" IS NOT NULL AND i."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', c."loyaltyBonusPromotionId", c."tenantId", 'linked campaign'
      FROM "Campaign" c WHERE c."loyaltyBonusPromotionId" IS NOT NULL AND c."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyBonusPromotion', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'loyalty_bonus_promotion' AND e."tenantId" IS NOT NULL;

    -- Campaign
    INSERT INTO _p2_candidate SELECT 'Campaign', x."campaignId", x."tenantId", 'featured product' FROM "CampaignProduct" x WHERE x."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', c."id", m."tenantId", 'image'
      FROM "Campaign" c JOIN "MediaAsset" m ON m."id" = c."mediaAssetId" WHERE m."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', c."id", p."tenantId", 'linked promotion'
      FROM "Campaign" c JOIN "Promotion" p ON p."id" = c."promotionId" WHERE p."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', c."id", b."tenantId", 'linked bonus promotion'
      FROM "Campaign" c JOIN "LoyaltyBonusPromotion" b ON b."id" = c."loyaltyBonusPromotionId" WHERE b."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', a."targetId", a."tenantId", 'approval request'
      FROM "ApprovalRequest" a WHERE a."targetType" = 'campaign' AND a."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'Campaign', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'campaign' AND e."tenantId" IS NOT NULL;

    -- CmsPage / configurations (configuration audit events name the key)
    INSERT INTO _p2_candidate SELECT 'CmsPage', e."targetId", e."tenantId", 'audit'
      FROM "InternalAuditEvent" e WHERE e."targetType" = 'cms_page' AND e."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'LoyaltyConfiguration', c."id", e."tenantId", 'audit'
      FROM "LoyaltyConfiguration" c JOIN "InternalAuditEvent" e
        ON e."targetType" = 'loyalty_configuration' AND e."targetId" = c."key" AND e."tenantId" IS NOT NULL;
    INSERT INTO _p2_candidate SELECT 'GiftCardConfiguration', c."id", e."tenantId", 'audit'
      FROM "GiftCardConfiguration" c JOIN "InternalAuditEvent" e
        ON e."targetType" = 'giftcard_configuration' AND e."targetId" = c."key" AND e."tenantId" IS NOT NULL;

    -- apply only where every piece of evidence names exactly one tenant
    total_changed := 0;
    FOREACH tname IN ARRAY ARRAY['GiftCard', 'Promotion', 'LoyaltyReward', 'LoyaltyBonusPromotion',
                               'Campaign', 'CmsPage', 'LoyaltyConfiguration', 'GiftCardConfiguration'] LOOP
      EXECUTE format(
        'UPDATE %I t SET "tenantId" = d.tenant_id
           FROM (SELECT row_key, min(tenant_id) AS tenant_id
                   FROM _p2_candidate WHERE tbl = %L
                  GROUP BY row_key HAVING count(DISTINCT tenant_id) = 1) d
          WHERE t."id" = d.row_key AND t."tenantId" IS NULL', tname, tname);
      GET DIAGNOSTICS changed = ROW_COUNT;
      total_changed := total_changed + changed;
    END LOOP;
    EXIT WHEN total_changed = 0;
  END LOOP;

  -- children that inherit from a now-resolved root
  UPDATE "GiftCardTransaction" t SET "tenantId" = g."tenantId"
    FROM "GiftCard" g WHERE t."giftCardId" = g."id" AND t."tenantId" IS NULL AND g."tenantId" IS NOT NULL;

  -- --- 3. conflicts, unresolved rows, parent/child mismatches -----------
  INSERT INTO _p2_problem
  SELECT c.tbl, c.row_key, 'conflict', string_agg(DISTINCT c.tenant_id || ' (' || c.source || ')', ', ')
    FROM _p2_candidate c GROUP BY c.tbl, c.row_key HAVING count(DISTINCT c.tenant_id) > 1;

  FOREACH tname IN ARRAY tables LOOP
    EXECUTE format(
      'INSERT INTO _p2_problem
       SELECT %L, to_jsonb(t)->>%L, %L, %L FROM %I t WHERE t."tenantId" IS NULL',
      tname,
      CASE tname
        WHEN 'LoyaltyRewardProduct' THEN 'rewardId' WHEN 'LoyaltyRewardCategory' THEN 'rewardId'
        WHEN 'LoyaltyBonusPromotionProduct' THEN 'promotionId' WHEN 'LoyaltyBonusPromotionLocation' THEN 'promotionId'
        WHEN 'PromotionProduct' THEN 'promotionId' WHEN 'PromotionCategory' THEN 'promotionId'
        WHEN 'PromotionLocation' THEN 'promotionId' WHEN 'PromotionCustomerUsage' THEN 'promotionId'
        WHEN 'CampaignProduct' THEN 'campaignId' ELSE 'id' END,
      'unresolved', 'no reliable relationship establishes its business', tname);
  END LOOP;

  -- parent/child agreement (only rows that carry a tenant; NULLs are
  -- already reported above)
  FOR rec IN
    SELECT * FROM (VALUES
      ('CustomerLoyaltyAccount', 'SELECT a."id" FROM "CustomerLoyaltyAccount" a JOIN "Customer" c ON c."id" = a."customerId" WHERE a."tenantId" <> c."tenantId"'),
      ('MochaBeanLedgerEntry', 'SELECT l."id" FROM "MochaBeanLedgerEntry" l JOIN "CustomerLoyaltyAccount" a ON a."id" = l."loyaltyAccountId" WHERE l."tenantId" <> a."tenantId"'),
      ('MochaBeanLedgerEntry', 'SELECT l."id" FROM "MochaBeanLedgerEntry" l JOIN "Order" o ON o."id" = l."orderId" WHERE l."tenantId" <> o."tenantId"'),
      ('MochaBeanLedgerEntry', 'SELECT l."id" FROM "MochaBeanLedgerEntry" l JOIN "InternalUser" u ON u."id" = l."actorInternalUserId" WHERE l."tenantId" <> u."tenantId"'),
      ('GiftCardTransaction', 'SELECT t."id" FROM "GiftCardTransaction" t JOIN "GiftCard" g ON g."id" = t."giftCardId" WHERE t."tenantId" <> g."tenantId"'),
      ('GiftCardTransaction', 'SELECT t."id" FROM "GiftCardTransaction" t JOIN "Order" o ON o."id" = t."orderId" WHERE t."tenantId" <> o."tenantId"'),
      ('GiftCardTransaction', 'SELECT t."id" FROM "GiftCardTransaction" t JOIN "GiftCardPurchase" p ON p."id" = t."giftCardPurchaseId" WHERE t."tenantId" <> p."tenantId"'),
      ('GiftCardTransaction', 'SELECT t."id" FROM "GiftCardTransaction" t JOIN "InternalUser" u ON u."id" = t."actorInternalUserId" WHERE t."tenantId" <> u."tenantId"'),
      ('GiftCard', 'SELECT g."id" FROM "GiftCard" g JOIN "GiftCardPurchase" p ON p."giftCardId" = g."id" WHERE g."tenantId" <> p."tenantId"'),
      ('OrderGiftCardRedemption', 'SELECT r."id" FROM "OrderGiftCardRedemption" r JOIN "Order" o ON o."id" = r."orderId" WHERE r."tenantId" <> o."tenantId"'),
      ('OrderGiftCardRedemption', 'SELECT r."id" FROM "OrderGiftCardRedemption" r JOIN "GiftCard" g ON g."id" = r."sourceGiftCardId" WHERE r."tenantId" <> g."tenantId"'),
      ('OrderLoyaltyRewardRedemption', 'SELECT r."id" FROM "OrderLoyaltyRewardRedemption" r JOIN "Order" o ON o."id" = r."orderId" WHERE r."tenantId" <> o."tenantId"'),
      ('OrderLoyaltyBonus', 'SELECT b."id" FROM "OrderLoyaltyBonus" b JOIN "Order" o ON o."id" = b."orderId" WHERE b."tenantId" <> o."tenantId"'),
      ('OrderLoyaltyBonusItem', 'SELECT i."id" FROM "OrderLoyaltyBonusItem" i JOIN "OrderLoyaltyBonus" b ON b."id" = i."orderLoyaltyBonusId" WHERE i."tenantId" <> b."tenantId"'),
      ('OrderPromotionRedemption', 'SELECT r."id" FROM "OrderPromotionRedemption" r JOIN "Order" o ON o."id" = r."orderId" WHERE r."tenantId" <> o."tenantId"'),
      ('PromotionProduct', 'SELECT x."promotionId" FROM "PromotionProduct" x JOIN "Promotion" p ON p."id" = x."promotionId" JOIN "Product" c ON c."id" = x."productId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('PromotionCategory', 'SELECT x."promotionId" FROM "PromotionCategory" x JOIN "Promotion" p ON p."id" = x."promotionId" JOIN "Category" c ON c."id" = x."categoryId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('PromotionLocation', 'SELECT x."promotionId" FROM "PromotionLocation" x JOIN "Promotion" p ON p."id" = x."promotionId" JOIN "Location" c ON c."id" = x."locationId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('PromotionCustomerUsage', 'SELECT x."promotionId" FROM "PromotionCustomerUsage" x JOIN "Promotion" p ON p."id" = x."promotionId" JOIN "Customer" c ON c."id" = x."customerId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('LoyaltyRewardProduct', 'SELECT x."rewardId" FROM "LoyaltyRewardProduct" x JOIN "LoyaltyReward" p ON p."id" = x."rewardId" JOIN "Product" c ON c."id" = x."productId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('LoyaltyRewardCategory', 'SELECT x."rewardId" FROM "LoyaltyRewardCategory" x JOIN "LoyaltyReward" p ON p."id" = x."rewardId" JOIN "Category" c ON c."id" = x."categoryId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('LoyaltyBonusPromotionProduct', 'SELECT x."promotionId" FROM "LoyaltyBonusPromotionProduct" x JOIN "LoyaltyBonusPromotion" p ON p."id" = x."promotionId" JOIN "Product" c ON c."id" = x."productId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('LoyaltyBonusPromotionLocation', 'SELECT x."promotionId" FROM "LoyaltyBonusPromotionLocation" x JOIN "LoyaltyBonusPromotion" p ON p."id" = x."promotionId" JOIN "Location" c ON c."id" = x."locationId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('CampaignProduct', 'SELECT x."campaignId" FROM "CampaignProduct" x JOIN "Campaign" p ON p."id" = x."campaignId" JOIN "Product" c ON c."id" = x."productId" WHERE x."tenantId" <> p."tenantId" OR x."tenantId" <> c."tenantId"'),
      ('Campaign', 'SELECT c."id" FROM "Campaign" c JOIN "MediaAsset" m ON m."id" = c."mediaAssetId" WHERE c."tenantId" <> m."tenantId"'),
      ('Campaign', 'SELECT c."id" FROM "Campaign" c JOIN "Promotion" p ON p."id" = c."promotionId" WHERE c."tenantId" <> p."tenantId"'),
      ('Campaign', 'SELECT c."id" FROM "Campaign" c JOIN "LoyaltyBonusPromotion" b ON b."id" = c."loyaltyBonusPromotionId" WHERE c."tenantId" <> b."tenantId"'),
      ('ApprovalRequest', 'SELECT a."id" FROM "ApprovalRequest" a JOIN "InternalUser" u ON u."id" = a."requestedByInternalUserId" WHERE a."tenantId" <> u."tenantId"'),
      ('ApprovalRequest', 'SELECT a."id" FROM "ApprovalRequest" a JOIN "InternalUser" u ON u."id" = a."decidedByInternalUserId" WHERE a."tenantId" <> u."tenantId"'),
      ('MediaAsset', 'SELECT m."id" FROM "MediaAsset" m JOIN "InternalUser" u ON u."id" = m."uploadedByInternalUserId" WHERE m."tenantId" <> u."tenantId"'),
      ('InternalAuditEvent', 'SELECT e."id" FROM "InternalAuditEvent" e JOIN "InternalUser" u ON u."id" = e."actorInternalUserId" WHERE e."tenantId" <> u."tenantId"')
    ) AS checks(tbl, query)
  LOOP
    EXECUTE format('INSERT INTO _p2_problem SELECT %L, q.k, %L, %L FROM (%s) AS q(k)',
      rec.tbl, 'mismatch', 'its tenant disagrees with a related record', rec.query);
  END LOOP;

  -- --- 4. report --------------------------------------------------------
  RAISE NOTICE 'Tenant isolation phase 2 backfill report (%):',
    CASE WHEN dry_run THEN 'DRY RUN' ELSE 'migration' END;
  FOR rec IN SELECT n.tbl, n.null_before FROM _p2_nulls n ORDER BY n.tbl LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE "tenantId" IS NULL', rec.tbl) INTO null_after;
    RAISE NOTICE '  %: % NULL before, % derived, % unresolved, % conflicting, % mismatched',
      rpad(rec.tbl, 30), rec.null_before, rec.null_before - null_after, null_after,
      (SELECT count(*) FROM _p2_problem p WHERE p.tbl = rec.tbl AND p.kind = 'conflict'),
      (SELECT count(*) FROM _p2_problem p WHERE p.tbl = rec.tbl AND p.kind = 'mismatch');
  END LOOP;

  SELECT count(*) INTO problems FROM _p2_problem;
  IF problems > 0 THEN
    RAISE NOTICE 'Rows that need an explicit, approved ownership decision (first 50 per table and kind):';
    FOR rec IN
      SELECT tbl, kind, row_key, detail FROM (
        SELECT p.*, row_number() OVER (PARTITION BY p.tbl, p.kind ORDER BY p.row_key) AS rn FROM _p2_problem p
      ) ranked WHERE rn <= 50 ORDER BY tbl, kind, row_key
    LOOP
      RAISE NOTICE '  % % % — %', rpad(rec.tbl, 30), rpad(rec.kind, 10), rec.row_key, rec.detail;
    END LOOP;
  END IF;

  IF dry_run THEN
    RAISE EXCEPTION 'Tenant isolation phase 2 DRY RUN complete: % problem row(s). Nothing was committed.', problems;
  END IF;
  IF problems > 0 THEN
    RAISE EXCEPTION 'Tenant isolation phase 2 aborted: % row(s) have conflicting, missing or inconsistent business ownership (see the NOTICE report). Nothing was changed. These rows need an explicit, approved ownership decision before this migration can run.', problems;
  END IF;
END
$p2$;

-- --- Generated by `prisma migrate diff` ---------------------------------
-- DropIndex
DROP INDEX "Category_slug_key";

-- DropIndex
DROP INDEX "ChecklistTemplate_key_key";

-- DropIndex
DROP INDEX "CmsPage_key_key";

-- DropIndex
DROP INDEX "GiftCardConfiguration_key_key";

-- DropIndex
DROP INDEX "Location_slug_key";

-- DropIndex
DROP INDEX "LoyaltyConfiguration_key_key";

-- DropIndex
DROP INDEX "Menu_slug_key";

-- DropIndex
DROP INDEX "MochaBeanLedgerEntry_type_operationKey_key";

-- DropIndex
DROP INDEX "Product_slug_key";

-- DropIndex
DROP INDEX "Promotion_code_key";

-- AlterTable
ALTER TABLE "ApprovalRequest" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Campaign" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CampaignProduct" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CmsPage" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "CustomerLoyaltyAccount" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GiftCard" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GiftCardConfiguration" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "GiftCardTransaction" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InternalAuditEvent" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotion" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotionLocation" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyBonusPromotionProduct" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyConfiguration" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyReward" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyRewardCategory" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "LoyaltyRewardProduct" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MediaAsset" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "MochaBeanLedgerEntry" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderGiftCardRedemption" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderLoyaltyBonus" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderLoyaltyBonusItem" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderLoyaltyRewardRedemption" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderPromotionRedemption" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Promotion" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromotionCategory" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromotionCustomerUsage" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromotionLocation" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "PromotionProduct" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_slug_key" ON "Category"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_tenantId_key_key" ON "ChecklistTemplate"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CmsPage_tenantId_key_key" ON "CmsPage"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardConfiguration_tenantId_key_key" ON "GiftCardConfiguration"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_slug_key" ON "Location"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyConfiguration_tenantId_key_key" ON "LoyaltyConfiguration"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_tenantId_slug_key" ON "Menu"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "MochaBeanLedgerEntry_tenantId_type_operationKey_key" ON "MochaBeanLedgerEntry"("tenantId", "type", "operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_slug_key" ON "Product"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_tenantId_code_key" ON "Promotion"("tenantId", "code");

