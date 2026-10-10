-- Disposable-DB fixture: two businesses with LEGACY rows (tenantId NULL)
-- in every phase-2 table, each reachable through a reliable relationship.
-- Fictional data only.
INSERT INTO "Tenant"(id, slug, name, status, "updatedAt") VALUES ('01a0db02-f800-7000-8000-7e570000000b', 'p2-tenant-b', 'P2 Business B', 'ACTIVE', now());

CREATE FUNCTION p2_fixture(t TEXT, k TEXT) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  -- authoritative (already tenant-owned) base records
  INSERT INTO "InternalUser"(id, "externalProvider", email, status, "updatedAt", "tenantId") VALUES (k||'-staff', 'internal-dev', k||'-staff@example.test', 'ACTIVE', now(), t);
  INSERT INTO "Customer"(id, "externalProvider", "externalSubject", email, "updatedAt", "tenantId") VALUES (k||'-cust', 'dev', 'dev:'||k, k||'-cust@example.test', now(), t);
  INSERT INTO "Location"(id, name, slug, "updatedAt", "tenantId") VALUES (k||'-loc', k||' Store', 'main-street-'||k, now(), t);
  INSERT INTO "Category"(id, name, slug, "updatedAt", "tenantId") VALUES (k||'-cat', 'Coffee', 'coffee-'||k, now(), t);
  INSERT INTO "Product"(id, name, slug, "categoryId", "updatedAt", "tenantId") VALUES (k||'-prod', 'Drip', 'drip-'||k, k||'-cat', now(), t);
  INSERT INTO "PaymentAttempt"(id, "idempotencyKey", provider, amount, currency, status, "updatedAt", "tenantId") VALUES (k||'-pa1', k||'-idem1', 'fake', 1000, 'USD', 'SUCCEEDED', now(), t), (k||'-pa2', k||'-idem2', 'fake', 2500, 'USD', 'SUCCEEDED', now(), t);
  INSERT INTO "Order"(id, "orderNumber", "accessToken", "locationId", "paymentAttemptId", "guestName", "guestPhone", currency, subtotal, "updatedAt", "tenantId", "customerId")
    VALUES (k||'-order', k||'-1001', k||'-tok', k||'-loc', k||'-pa1', 'Guest', '5550000', 'USD', 1000, now(), t, k||'-cust');
  INSERT INTO "GiftCardPurchase"(id, "amountMinorUnits", "paymentAttemptId", "purchaserEmail", "updatedAt", "tenantId") VALUES (k||'-gcp', 2500, k||'-pa2', k||'-buyer@example.test', now(), t);

  -- legacy rows: tenantId deliberately NULL everywhere below
  INSERT INTO "InternalAuditEvent"(id, "actorInternalUserId", action, "targetType", "targetId", reason) VALUES (k||'-ev-user', k||'-staff', 'user.status_changed', 'internal_user', k||'-staff', 'x');
  INSERT INTO "MediaAsset"(id, "objectKey", "fileName", "contentType", "fileSizeBytes", "uploadedByInternalUserId", "updatedAt") VALUES (k||'-media', k||'/a.png', 'a.png', 'image/png', 10, k||'-staff', now());
  INSERT INTO "CustomerLoyaltyAccount"(id, "customerId", balance, "updatedAt") VALUES (k||'-acct', k||'-cust', 150, now());
  INSERT INTO "MochaBeanLedgerEntry"(id, "loyaltyAccountId", type, amount, "orderId") VALUES (k||'-earn', k||'-acct', 'EARN', 10, k||'-order');
  INSERT INTO "MochaBeanLedgerEntry"(id, "loyaltyAccountId", type, amount, reason, "operationKey", "actorInternalUserId") VALUES (k||'-adj', k||'-acct', 'MANUAL_ADJUSTMENT', 140, 'goodwill', 'op-key-'||k, k||'-staff');
  -- gift cards: one bought, one HQ-issued (evidence = ISSUANCE actor), one known only via an audit event
  INSERT INTO "GiftCard"(id, "codeHash", last4, "originalValueMinorUnits", "balanceMinorUnits", "updatedAt") VALUES (k||'-gc-bought', k||'-h1', '1111', 2500, 1500, now()), (k||'-gc-hq', k||'-h2', '2222', 5000, 5000, now()), (k||'-gc-audit', k||'-h3', '3333', 100, 100, now());
  UPDATE "GiftCardPurchase" SET "giftCardId" = k||'-gc-bought', status = 'ISSUED' WHERE id = k||'-gcp';
  INSERT INTO "GiftCardTransaction"(id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "giftCardPurchaseId") VALUES (k||'-gct1', k||'-gc-bought', 'ISSUANCE', 2500, 2500, k||'-gcp');
  INSERT INTO "GiftCardTransaction"(id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "orderId") VALUES (k||'-gct2', k||'-gc-bought', 'REDEMPTION', -1000, 1500, k||'-order');
  INSERT INTO "GiftCardTransaction"(id, "giftCardId", type, "amountMinorUnits", "balanceAfterMinorUnits", "actorInternalUserId") VALUES (k||'-gct3', k||'-gc-hq', 'ISSUANCE', 5000, 5000, k||'-staff');
  INSERT INTO "InternalAuditEvent"(id, "actorInternalUserId", action, "targetType", "targetId", reason) VALUES (k||'-ev-gc', k||'-staff', 'giftcards.card_deactivated', 'gift_card', k||'-gc-audit', 'x');
  INSERT INTO "OrderGiftCardRedemption"(id, "orderId", "sourceGiftCardId", last4, "amountMinorUnits", currency) VALUES (k||'-ogr', k||'-order', k||'-gc-bought', '1111', 1000, 'USD');
  -- promotions: coupon with SAME code in both businesses, evidence = eligibility / usage / redemption
  INSERT INTO "Promotion"(id, name, kind, code, "discountType", "updatedAt") VALUES (k||'-promo', 'Welcome', 'COUPON', 'WELCOME10-'||upper(k), 'PERCENTAGE_OFF', now()), (k||'-promo-audit', 'Spring', 'AUTOMATIC', NULL, 'PERCENTAGE_OFF', now());
  INSERT INTO "PromotionProduct"("promotionId", "productId") VALUES (k||'-promo', k||'-prod');
  INSERT INTO "PromotionLocation"("promotionId", "locationId") VALUES (k||'-promo', k||'-loc');
  INSERT INTO "PromotionCustomerUsage"("promotionId", "customerId", "usedCount", "updatedAt") VALUES (k||'-promo', k||'-cust', 1, now());
  INSERT INTO "OrderPromotionRedemption"(id, "orderId", "sourcePromotionId", "promotionName", "promotionKind", "discountType", "discountValue", "discountMinorUnits") VALUES (k||'-opr', k||'-order', k||'-promo', 'Welcome', 'COUPON', 'PERCENTAGE_OFF', 10, 100);
  INSERT INTO "InternalAuditEvent"(id, "actorInternalUserId", action, "targetType", "targetId", reason) VALUES (k||'-ev-promo', k||'-staff', 'promotions.promotion_created', 'promotion', k||'-promo-audit', 'x');
  -- rewards: FREE_ITEM via eligibility, FIXED_AMOUNT via redemption
  INSERT INTO "LoyaltyReward"(id, name, type, "beanCost", "fixedAmountMinorUnits", "updatedAt") VALUES (k||'-rw-free', 'Free drip', 'FREE_ITEM', 100, NULL, now()), (k||'-rw-fixed', '$2 off', 'FIXED_AMOUNT', 50, 200, now());
  INSERT INTO "LoyaltyRewardProduct"("rewardId", "productId") VALUES (k||'-rw-free', k||'-prod');
  INSERT INTO "LoyaltyRewardCategory"("rewardId", "categoryId") VALUES (k||'-rw-free', k||'-cat');
  INSERT INTO "OrderLoyaltyRewardRedemption"(id, "orderId", "sourceRewardId", "rewardName", "rewardType", "beanCost", "discountMinorUnits") VALUES (k||'-olr', k||'-order', k||'-rw-fixed', '$2 off', 'FIXED_AMOUNT', 50, 200);
  -- bonus promotion via eligibility; bonus snapshot
  INSERT INTO "LoyaltyBonusPromotion"(id, name, type, "bonusValue", "updatedAt") VALUES (k||'-bonus', 'Double beans', 'MULTIPLIER', 2, now());
  INSERT INTO "LoyaltyBonusPromotionProduct"("promotionId", "productId") VALUES (k||'-bonus', k||'-prod');
  INSERT INTO "LoyaltyBonusPromotionLocation"("promotionId", "locationId") VALUES (k||'-bonus', k||'-loc');
  INSERT INTO "OrderLoyaltyBonus"(id, "orderId", "totalBonusBeans") VALUES (k||'-olb', k||'-order', 5);
  INSERT INTO "OrderLoyaltyBonusItem"(id, "orderLoyaltyBonusId", "sourcePromotionId", "promotionName", "promotionType", "bonusValue", "productId", "productName", "qualifyingUnits", "qualifyingSpendMinorUnits", "standardBeansForItem", "bonusBeans")
    VALUES (k||'-olbi', k||'-olb', k||'-bonus', 'Double beans', 'MULTIPLIER', 2, k||'-prod', 'Drip', 1, 1000, 5, 5);
  -- campaign evidence = image only; its approval request via the requester
  INSERT INTO "Campaign"(id, name, "mediaAssetId", "updatedAt") VALUES (k||'-camp', 'Launch', k||'-media', now());
  INSERT INTO "CampaignProduct"("campaignId", "productId", "displayOrder") VALUES (k||'-camp', k||'-prod', 0);
  INSERT INTO "ApprovalRequest"(id, "targetType", "targetId", action, "requestedByInternalUserId") VALUES (k||'-appr', 'campaign', k||'-camp', 'activate', k||'-staff');
  -- CMS page (keys collide across businesses) via its audit event
  INSERT INTO "CmsPage"(id, key, title, "draftContent", "updatedAt") VALUES (k||'-cms', CASE WHEN k='a' THEN 'home' ELSE 'franchising' END, 'Page', '{}', now());
  INSERT INTO "InternalAuditEvent"(id, "actorInternalUserId", action, "targetType", "targetId", reason) VALUES (k||'-ev-cms', k||'-staff', 'cms.content_updated', 'cms_page', k||'-cms', 'x');
END
$f$;

SELECT p2_fixture('01a0db02-f800-7000-8000-000000000001', 'a');
SELECT p2_fixture('01a0db02-f800-7000-8000-7e570000000b', 'b');
-- configurations: Tenant #1's legacy singleton, evidenced by its own audit
INSERT INTO "LoyaltyConfiguration"(id, key, "earningRatePerDollar", "updatedAt") VALUES ('cfg-loyalty', 'company', 3, now());
INSERT INTO "GiftCardConfiguration"(id, key, "presetAmountsMinorUnits", "updatedAt") VALUES ('cfg-gc', 'company', '{1000,2500}', now());
INSERT INTO "InternalAuditEvent"(id, "actorInternalUserId", action, "targetType", "targetId", reason) VALUES
  ('a-ev-cfg1', 'a-staff', 'loyalty.earning_rate_changed', 'loyalty_configuration', 'company', 'x'),
  ('a-ev-cfg2', 'a-staff', 'giftcards.configuration_updated', 'giftcard_configuration', 'company', 'x');
DROP FUNCTION p2_fixture(TEXT, TEXT);
