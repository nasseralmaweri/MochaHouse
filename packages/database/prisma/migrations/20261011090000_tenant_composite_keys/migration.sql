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
-- table's primary key, so every ("tenantId", "id") pair is already unique.
--
-- Atomic by construction. Prisma Migrate 7.x (verified from the PostgreSQL
-- statement log) sends a migration WITHOUT dollar-quoting as separate
-- statements, each committed on its own — a failure part-way would leave
-- some indexes behind. A file WITH dollar-quoting is sent as one statement.
-- Everything therefore lives in ONE DO block: it either creates all 25
-- indexes or, on any error, none (Prisma then records the migration as
-- failed — P3018 — and refuses further deploys until it is resolved).
--
-- Locking: each CREATE UNIQUE INDEX (not CONCURRENTLY, which cannot run
-- inside a transaction) takes a SHARE lock on its table, held until the
-- block commits: reads continue, writes to these tables wait. lock_timeout
-- (5s, local to this transaction) makes the migration fail — atomically —
-- instead of queueing application writes behind a lock it cannot get.
--
-- If it fails: nothing was created. Remove the cause (or wait for a quieter
-- moment), run `prisma migrate resolve --rolled-back
-- 20261011090000_tenant_composite_keys`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261011090000_tenant_composite_keys.down.sql.

DO $tenant_composite_keys$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE UNIQUE INDEX "Campaign_tenantId_id_key" ON "Campaign"("tenantId", "id");
  CREATE UNIQUE INDEX "Category_tenantId_id_key" ON "Category"("tenantId", "id");
  CREATE UNIQUE INDEX "ChecklistInstance_tenantId_id_key" ON "ChecklistInstance"("tenantId", "id");
  CREATE UNIQUE INDEX "ChecklistTemplate_tenantId_id_key" ON "ChecklistTemplate"("tenantId", "id");
  CREATE UNIQUE INDEX "Customer_tenantId_id_key" ON "Customer"("tenantId", "id");
  CREATE UNIQUE INDEX "CustomerLoyaltyAccount_tenantId_id_key" ON "CustomerLoyaltyAccount"("tenantId", "id");
  CREATE UNIQUE INDEX "FranchiseInquiry_tenantId_id_key" ON "FranchiseInquiry"("tenantId", "id");
  CREATE UNIQUE INDEX "GiftCard_tenantId_id_key" ON "GiftCard"("tenantId", "id");
  CREATE UNIQUE INDEX "GiftCardPurchase_tenantId_id_key" ON "GiftCardPurchase"("tenantId", "id");
  CREATE UNIQUE INDEX "InternalRole_tenantId_id_key" ON "InternalRole"("tenantId", "id");
  CREATE UNIQUE INDEX "InternalUser_tenantId_id_key" ON "InternalUser"("tenantId", "id");
  CREATE UNIQUE INDEX "JobApplication_tenantId_id_key" ON "JobApplication"("tenantId", "id");
  CREATE UNIQUE INDEX "JobOpening_tenantId_id_key" ON "JobOpening"("tenantId", "id");
  CREATE UNIQUE INDEX "Location_tenantId_id_key" ON "Location"("tenantId", "id");
  CREATE UNIQUE INDEX "LoyaltyBonusPromotion_tenantId_id_key" ON "LoyaltyBonusPromotion"("tenantId", "id");
  CREATE UNIQUE INDEX "LoyaltyReward_tenantId_id_key" ON "LoyaltyReward"("tenantId", "id");
  CREATE UNIQUE INDEX "MediaAsset_tenantId_id_key" ON "MediaAsset"("tenantId", "id");
  CREATE UNIQUE INDEX "Menu_tenantId_id_key" ON "Menu"("tenantId", "id");
  CREATE UNIQUE INDEX "ModifierGroup_tenantId_id_key" ON "ModifierGroup"("tenantId", "id");
  CREATE UNIQUE INDEX "Order_tenantId_id_key" ON "Order"("tenantId", "id");
  CREATE UNIQUE INDEX "OrderLoyaltyBonus_tenantId_id_key" ON "OrderLoyaltyBonus"("tenantId", "id");
  CREATE UNIQUE INDEX "OutboxEvent_tenantId_id_key" ON "OutboxEvent"("tenantId", "id");
  CREATE UNIQUE INDEX "PaymentAttempt_tenantId_id_key" ON "PaymentAttempt"("tenantId", "id");
  CREATE UNIQUE INDEX "Product_tenantId_id_key" ON "Product"("tenantId", "id");
  CREATE UNIQUE INDEX "Promotion_tenantId_id_key" ON "Promotion"("tenantId", "id");
END
$tenant_composite_keys$;
