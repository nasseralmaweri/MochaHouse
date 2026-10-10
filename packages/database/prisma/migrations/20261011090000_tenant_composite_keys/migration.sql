-- Security 4C-2 — composite tenant keys.
--
-- Adds a UNIQUE ("tenantId", "id") index to each of the 25 business-owned
-- tables that other business-owned tables reference (the targets of the
-- composite foreign-key candidates in
-- packages/database/src/integrity/relationship-inventory.ts), so Security
-- 4C-3 can replace single-column foreign keys with
-- FOREIGN KEY ("tenantId", col) REFERENCES parent ("tenantId", "id").
--
-- Purely additive: no data is read into, changed or deleted; no existing
-- key, index, constraint or foreign key is touched. "id" is already each
-- table's primary key, so every ("tenantId", "id") pair is already unique —
-- the index cannot fail on existing data.
--
-- Locking: CREATE UNIQUE INDEX (not CONCURRENTLY — Prisma applies a
-- migration as one transaction) holds a SHARE lock on each table until the
-- migration commits: reads continue, writes to these tables wait. Build
-- time is proportional to table size.
--
-- Rollback (never automatic): prisma/rollbacks/20261011090000_tenant_composite_keys.down.sql.

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_tenantId_id_key" ON "Campaign"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Category_tenantId_id_key" ON "Category"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistInstance_tenantId_id_key" ON "ChecklistInstance"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChecklistTemplate_tenantId_id_key" ON "ChecklistTemplate"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_id_key" ON "Customer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLoyaltyAccount_tenantId_id_key" ON "CustomerLoyaltyAccount"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FranchiseInquiry_tenantId_id_key" ON "FranchiseInquiry"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCard_tenantId_id_key" ON "GiftCard"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardPurchase_tenantId_id_key" ON "GiftCardPurchase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InternalRole_tenantId_id_key" ON "InternalRole"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_tenantId_id_key" ON "InternalUser"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "JobApplication_tenantId_id_key" ON "JobApplication"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "JobOpening_tenantId_id_key" ON "JobOpening"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_id_key" ON "Location"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyBonusPromotion_tenantId_id_key" ON "LoyaltyBonusPromotion"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyReward_tenantId_id_key" ON "LoyaltyReward"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_tenantId_id_key" ON "MediaAsset"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_tenantId_id_key" ON "Menu"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_tenantId_id_key" ON "ModifierGroup"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_tenantId_id_key" ON "Order"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLoyaltyBonus_tenantId_id_key" ON "OrderLoyaltyBonus"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_tenantId_id_key" ON "OutboxEvent"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_tenantId_id_key" ON "PaymentAttempt"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_id_key" ON "Product"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_tenantId_id_key" ON "Promotion"("tenantId", "id");

