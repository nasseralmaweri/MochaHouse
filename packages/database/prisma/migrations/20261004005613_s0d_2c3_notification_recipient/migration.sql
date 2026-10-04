-- Milestone S0D-2C-3 — tenant-owned notification recipient routing. A
-- brand-new table, so tenantId is required FROM INCEPTION: no nullable
-- window, no backfill, no guard blocks — unlike every prior S0D-2 slice.
-- No recipient values are set here; rows are created only through the new
-- admin API (notifications.routing.manage) or the seed's one-time
-- Mocha-House bootstrap step (see seed.ts) — never hardcoded in SQL.

-- CreateTable
CREATE TABLE "NotificationRecipient" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationRecipient_tenantId_idx" ON "NotificationRecipient"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRecipient_tenantId_purpose_key" ON "NotificationRecipient"("tenantId", "purpose");

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
