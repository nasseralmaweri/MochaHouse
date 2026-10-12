-- Security 4C-4 — tenant-enforced foreign keys: loyalty, gift cards and
-- promotions.
--
-- Replaces sixteen single-column foreign keys with composite ones on
-- ("tenantId", <column>) -> parent ("tenantId", "id") and adds the missing
-- one for OrderPromotionRedemption.customerId, so PostgreSQL itself rejects
-- a loyalty, gift-card or promotion row that references another business's
-- customer, order, payment, card, purchase, account or promotion:
--
--   CustomerLoyaltyAccount.customerId         -> Customer               ON DELETE CASCADE
--   MochaBeanLedgerEntry.loyaltyAccountId     -> CustomerLoyaltyAccount ON DELETE CASCADE
--   MochaBeanLedgerEntry.orderId              -> Order                  ON DELETE SET NULL ("orderId")
--   OrderLoyaltyRewardRedemption.orderId      -> Order                  ON DELETE RESTRICT
--   OrderLoyaltyBonus.orderId                 -> Order                  ON DELETE RESTRICT
--   OrderLoyaltyBonusItem.orderLoyaltyBonusId -> OrderLoyaltyBonus      ON DELETE CASCADE
--   PromotionCustomerUsage.promotionId        -> Promotion              ON DELETE CASCADE
--   PromotionCustomerUsage.customerId         -> Customer               ON DELETE CASCADE
--   OrderPromotionRedemption.orderId          -> Order                  ON DELETE RESTRICT
--   OrderPromotionRedemption.customerId       -> Customer               ON DELETE SET NULL ("customerId")   (NEW)
--   GiftCardTransaction.giftCardId            -> GiftCard               ON DELETE RESTRICT
--   GiftCardTransaction.orderId               -> Order                  ON DELETE SET NULL ("orderId")
--   GiftCardTransaction.giftCardPurchaseId    -> GiftCardPurchase       ON DELETE SET NULL ("giftCardPurchaseId")
--   OrderGiftCardRedemption.orderId           -> Order                  ON DELETE RESTRICT
--   GiftCardPurchase.paymentAttemptId         -> PaymentAttempt         ON DELETE RESTRICT
--   GiftCardPurchase.giftCardId               -> GiftCard               ON DELETE RESTRICT
--   GiftCardPurchase.customerId               -> Customer               ON DELETE SET NULL ("customerId")
--
-- Delete behaviour is unchanged. Every SET NULL clears only the referencing
-- column (PostgreSQL 15+): nulling the whole composite key would null the
-- required "tenantId". The new OrderPromotionRedemption.customerId follows
-- Order.customerId: deleting the customer keeps the redemption snapshot and
-- clears only who it counted against. ON UPDATE is RESTRICT (was CASCADE).
-- Seven one-to-one relations gain UNIQUE ("tenantId", <column>), which the
-- composite relation requires (the column alone is already unique, so the
-- pair is too); OrderPromotionRedemption.customerId gains an index for its
-- SET NULL.
--
-- Historical snapshots (no foreign key: the source may later be deleted).
-- A NEW or CHANGED value must name an existing source of the SAME business
-- (trigger "<Table>_<column>_same_tenant", SQLSTATE 23503). A value stored
-- while its source existed may stay unchanged after that source is deleted
-- (the history is kept, never rewritten):
--
--   OrderLoyaltyRewardRedemption.sourceRewardId -> LoyaltyReward
--   OrderLoyaltyRewardRedemption.freeItemProductId -> Product
--   OrderLoyaltyBonusItem.sourcePromotionId   -> LoyaltyBonusPromotion
--   OrderLoyaltyBonusItem.productId           -> Product
--   OrderPromotionRedemption.sourcePromotionId -> Promotion
--   OrderPromotionRedemption.freeItemProductId -> Product
--   OrderGiftCardRedemption.sourceGiftCardId  -> GiftCard
--
-- A deleted source's id can never be taken by ANOTHER business while a
-- snapshot of the original business still names it (trigger
-- "<Table>_id_not_reused", SQLSTATE 23505) on
--   GiftCard, LoyaltyBonusPromotion, LoyaltyReward, Promotion,
-- so a kept snapshot can never silently start naming another business's
-- record. (Product snapshots get the same guard with the catalog, 4C-6.)
--
-- Ownership: these tables reject any change of "tenantId" on an existing
-- row (trigger "<Table>_tenantId_immutable", SQLSTATE 23001), reusing
-- Security 4C-3's reject_tenant_reassignment() function:
--   CustomerLoyaltyAccount, GiftCard, GiftCardPurchase, GiftCardTransaction, LoyaltyBonusPromotion, LoyaltyReward, MochaBeanLedgerEntry, OrderGiftCardRedemption, OrderLoyaltyBonus, OrderLoyaltyBonusItem, OrderLoyaltyRewardRedemption, OrderPromotionRedemption, Promotion, PromotionCustomerUsage.
-- That function belongs to 4C-3: this migration requires it and never
-- drops it, and 4C-3 cannot be rolled back while these triggers exist.
--
-- Safety:
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement,
--     so the migration applies completely or not at all.
--   - Preflight (read-only) first: the PostgreSQL version, 4C-3's function,
--     every row of the seventeen relationships must reference a row of the
--     SAME business, and no snapshot may name another business's record.
--     Any problem aborts with counts and nothing changed. Ownership is
--     never reassigned and nothing is repaired automatically.
--   - lock_timeout 5s (local to this transaction): it fails, atomically,
--     rather than queue application traffic behind a lock it cannot get.
--
-- If it fails: nothing changed. Fix the reported rows deliberately (or wait
-- for a quieter moment), run `prisma migrate resolve --rolled-back
-- 20261013090000_tenant_fk_loyalty_giftcard_promotion`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261013090000_tenant_fk_loyalty_giftcard_promotion.down.sql.

DO $tenant_fk_loyalty_giftcard_promotion$
DECLARE
  r record;
  n bigint;
  problems text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Security 4C-4 requires PostgreSQL 15 or later (ON DELETE SET NULL (column)); this server is %. Nothing was changed.',
      current_setting('server_version');
  END IF;
  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Security 4C-4 requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('CustomerLoyaltyAccount', 'customerId', 'Customer'),
      ('MochaBeanLedgerEntry', 'loyaltyAccountId', 'CustomerLoyaltyAccount'),
      ('MochaBeanLedgerEntry', 'orderId', 'Order'),
      ('OrderLoyaltyRewardRedemption', 'orderId', 'Order'),
      ('OrderLoyaltyBonus', 'orderId', 'Order'),
      ('OrderLoyaltyBonusItem', 'orderLoyaltyBonusId', 'OrderLoyaltyBonus'),
      ('PromotionCustomerUsage', 'promotionId', 'Promotion'),
      ('PromotionCustomerUsage', 'customerId', 'Customer'),
      ('OrderPromotionRedemption', 'orderId', 'Order'),
      ('OrderPromotionRedemption', 'customerId', 'Customer'),
      ('GiftCardTransaction', 'giftCardId', 'GiftCard'),
      ('GiftCardTransaction', 'orderId', 'Order'),
      ('GiftCardTransaction', 'giftCardPurchaseId', 'GiftCardPurchase'),
      ('OrderGiftCardRedemption', 'orderId', 'Order'),
      ('GiftCardPurchase', 'paymentAttemptId', 'PaymentAttempt'),
      ('GiftCardPurchase', 'giftCardId', 'GiftCard'),
      ('GiftCardPurchase', 'customerId', 'Customer')
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
      ('OrderLoyaltyRewardRedemption', 'sourceRewardId', 'LoyaltyReward'),
      ('OrderLoyaltyRewardRedemption', 'freeItemProductId', 'Product'),
      ('OrderLoyaltyBonusItem', 'sourcePromotionId', 'LoyaltyBonusPromotion'),
      ('OrderLoyaltyBonusItem', 'productId', 'Product'),
      ('OrderPromotionRedemption', 'sourcePromotionId', 'Promotion'),
      ('OrderPromotionRedemption', 'freeItemProductId', 'Product'),
      ('OrderGiftCardRedemption', 'sourceGiftCardId', 'GiftCard')
    ) AS t(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c JOIN %I p ON p."id" = c.%I
        WHERE p."tenantId" <> c."tenantId"',
      r.child, r.parent, r.col)
      INTO n;
    IF n > 0 THEN
      problems := problems || format(E'\n  %s.%s -> %s (snapshot): %s row(s)', r.child, r.col, r.parent, n);
    END IF;
  END LOOP;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Security 4C-4 aborted: rows reference another business''s record or a missing one. Nothing was changed; resolve them explicitly, then retry:%',
      problems;
  END IF;

  ALTER TABLE "CustomerLoyaltyAccount" DROP CONSTRAINT "CustomerLoyaltyAccount_customerId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_loyaltyAccountId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_orderId_fkey";
  ALTER TABLE "OrderLoyaltyRewardRedemption" DROP CONSTRAINT "OrderLoyaltyRewardRedemption_orderId_fkey";
  ALTER TABLE "OrderLoyaltyBonus" DROP CONSTRAINT "OrderLoyaltyBonus_orderId_fkey";
  ALTER TABLE "OrderLoyaltyBonusItem" DROP CONSTRAINT "OrderLoyaltyBonusItem_orderLoyaltyBonusId_fkey";
  ALTER TABLE "PromotionCustomerUsage" DROP CONSTRAINT "PromotionCustomerUsage_promotionId_fkey";
  ALTER TABLE "PromotionCustomerUsage" DROP CONSTRAINT "PromotionCustomerUsage_customerId_fkey";
  ALTER TABLE "OrderPromotionRedemption" DROP CONSTRAINT "OrderPromotionRedemption_orderId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_giftCardId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_orderId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_giftCardPurchaseId_fkey";
  ALTER TABLE "OrderGiftCardRedemption" DROP CONSTRAINT "OrderGiftCardRedemption_orderId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_paymentAttemptId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_giftCardId_fkey";
  ALTER TABLE "GiftCardPurchase" DROP CONSTRAINT "GiftCardPurchase_customerId_fkey";

  CREATE UNIQUE INDEX "CustomerLoyaltyAccount_tenantId_customerId_key" ON "CustomerLoyaltyAccount"("tenantId", "customerId");
  CREATE UNIQUE INDEX "GiftCardPurchase_tenantId_paymentAttemptId_key" ON "GiftCardPurchase"("tenantId", "paymentAttemptId");
  CREATE UNIQUE INDEX "GiftCardPurchase_tenantId_giftCardId_key" ON "GiftCardPurchase"("tenantId", "giftCardId");
  CREATE UNIQUE INDEX "OrderGiftCardRedemption_tenantId_orderId_key" ON "OrderGiftCardRedemption"("tenantId", "orderId");
  CREATE UNIQUE INDEX "OrderLoyaltyBonus_tenantId_orderId_key" ON "OrderLoyaltyBonus"("tenantId", "orderId");
  CREATE UNIQUE INDEX "OrderLoyaltyRewardRedemption_tenantId_orderId_key" ON "OrderLoyaltyRewardRedemption"("tenantId", "orderId");
  CREATE UNIQUE INDEX "OrderPromotionRedemption_tenantId_orderId_key" ON "OrderPromotionRedemption"("tenantId", "orderId");
  CREATE INDEX "OrderPromotionRedemption_customerId_idx" ON "OrderPromotionRedemption"("customerId");

  ALTER TABLE "CustomerLoyaltyAccount" ADD CONSTRAINT "CustomerLoyaltyAccount_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_tenantId_loyaltyAccountId_fkey" FOREIGN KEY ("tenantId", "loyaltyAccountId") REFERENCES "CustomerLoyaltyAccount"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE SET NULL ("orderId") ON UPDATE RESTRICT;
  ALTER TABLE "OrderLoyaltyRewardRedemption" ADD CONSTRAINT "OrderLoyaltyRewardRedemption_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderLoyaltyBonus" ADD CONSTRAINT "OrderLoyaltyBonus_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderLoyaltyBonusItem" ADD CONSTRAINT "OrderLoyaltyBonusItem_tenantId_orderLoyaltyBonusId_fkey" FOREIGN KEY ("tenantId", "orderLoyaltyBonusId") REFERENCES "OrderLoyaltyBonus"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_tenantId_promotionId_fkey" FOREIGN KEY ("tenantId", "promotionId") REFERENCES "Promotion"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "PromotionCustomerUsage" ADD CONSTRAINT "PromotionCustomerUsage_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "OrderPromotionRedemption" ADD CONSTRAINT "OrderPromotionRedemption_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OrderPromotionRedemption" ADD CONSTRAINT "OrderPromotionRedemption_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE SET NULL ("customerId") ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_tenantId_giftCardId_fkey" FOREIGN KEY ("tenantId", "giftCardId") REFERENCES "GiftCard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE SET NULL ("orderId") ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_tenantId_giftCardPurchaseId_fkey" FOREIGN KEY ("tenantId", "giftCardPurchaseId") REFERENCES "GiftCardPurchase"("tenantId", "id") ON DELETE SET NULL ("giftCardPurchaseId") ON UPDATE RESTRICT;
  ALTER TABLE "OrderGiftCardRedemption" ADD CONSTRAINT "OrderGiftCardRedemption_tenantId_orderId_fkey" FOREIGN KEY ("tenantId", "orderId") REFERENCES "Order"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_tenantId_giftCardId_fkey" FOREIGN KEY ("tenantId", "giftCardId") REFERENCES "GiftCard"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardPurchase" ADD CONSTRAINT "GiftCardPurchase_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE SET NULL ("customerId") ON UPDATE RESTRICT;

  CREATE FUNCTION "reject_cross_tenant_snapshot"() RETURNS trigger
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
  CREATE TRIGGER "OrderLoyaltyRewardRedemption_sourceRewardId_same_tenant" BEFORE INSERT OR UPDATE OF "sourceRewardId" ON "OrderLoyaltyRewardRedemption"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('sourceRewardId', 'LoyaltyReward');
  CREATE TRIGGER "OrderLoyaltyRewardRedemption_freeItemProductId_same_tenant" BEFORE INSERT OR UPDATE OF "freeItemProductId" ON "OrderLoyaltyRewardRedemption"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('freeItemProductId', 'Product');
  CREATE TRIGGER "OrderLoyaltyBonusItem_sourcePromotionId_same_tenant" BEFORE INSERT OR UPDATE OF "sourcePromotionId" ON "OrderLoyaltyBonusItem"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('sourcePromotionId', 'LoyaltyBonusPromotion');
  CREATE TRIGGER "OrderLoyaltyBonusItem_productId_same_tenant" BEFORE INSERT OR UPDATE OF "productId" ON "OrderLoyaltyBonusItem"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('productId', 'Product');
  CREATE TRIGGER "OrderPromotionRedemption_sourcePromotionId_same_tenant" BEFORE INSERT OR UPDATE OF "sourcePromotionId" ON "OrderPromotionRedemption"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('sourcePromotionId', 'Promotion');
  CREATE TRIGGER "OrderPromotionRedemption_freeItemProductId_same_tenant" BEFORE INSERT OR UPDATE OF "freeItemProductId" ON "OrderPromotionRedemption"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('freeItemProductId', 'Product');
  CREATE TRIGGER "OrderGiftCardRedemption_sourceGiftCardId_same_tenant" BEFORE INSERT OR UPDATE OF "sourceGiftCardId" ON "OrderGiftCardRedemption"
    FOR EACH ROW EXECUTE FUNCTION "reject_cross_tenant_snapshot"('sourceGiftCardId', 'GiftCard');

  CREATE FUNCTION "reject_reused_snapshot_source"() RETURNS trigger
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
  CREATE TRIGGER "GiftCard_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "GiftCard"
    FOR EACH ROW EXECUTE FUNCTION "reject_reused_snapshot_source"('OrderGiftCardRedemption', 'sourceGiftCardId');
  CREATE TRIGGER "LoyaltyBonusPromotion_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "LoyaltyBonusPromotion"
    FOR EACH ROW EXECUTE FUNCTION "reject_reused_snapshot_source"('OrderLoyaltyBonusItem', 'sourcePromotionId');
  CREATE TRIGGER "LoyaltyReward_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "LoyaltyReward"
    FOR EACH ROW EXECUTE FUNCTION "reject_reused_snapshot_source"('OrderLoyaltyRewardRedemption', 'sourceRewardId');
  CREATE TRIGGER "Promotion_id_not_reused" BEFORE INSERT OR UPDATE OF "id" ON "Promotion"
    FOR EACH ROW EXECUTE FUNCTION "reject_reused_snapshot_source"('OrderPromotionRedemption', 'sourcePromotionId');

  CREATE TRIGGER "CustomerLoyaltyAccount_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CustomerLoyaltyAccount"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "GiftCard_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "GiftCard"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "GiftCardPurchase_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "GiftCardPurchase"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "GiftCardTransaction_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "GiftCardTransaction"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyBonusPromotion_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyBonusPromotion"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyReward_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyReward"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "MochaBeanLedgerEntry_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "MochaBeanLedgerEntry"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderGiftCardRedemption_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderGiftCardRedemption"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderLoyaltyBonus_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderLoyaltyBonus"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderLoyaltyBonusItem_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderLoyaltyBonusItem"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderLoyaltyRewardRedemption_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderLoyaltyRewardRedemption"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OrderPromotionRedemption_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OrderPromotionRedemption"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "Promotion_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "Promotion"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PromotionCustomerUsage_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PromotionCustomerUsage"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
END
$tenant_fk_loyalty_giftcard_promotion$;
