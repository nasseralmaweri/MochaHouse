-- A promotion whose evidence names two businesses: eligible for business
-- A's product AND business B's location. Fictional data only.
INSERT INTO "Promotion"(id, name, kind, "discountType", "updatedAt") VALUES ('x-promo-split', 'Split', 'AUTOMATIC', 'PERCENTAGE_OFF', now());
INSERT INTO "PromotionProduct"("promotionId", "productId") VALUES ('x-promo-split', 'a-prod');
INSERT INTO "PromotionLocation"("promotionId", "locationId") VALUES ('x-promo-split', 'b-loc');
