-- Milestone 4F. Two additive changes, no data migration:
--   1. Customer.marketingEmailOptIn — every existing customer safely
--      defaults to false (not opted in). This is deliberate: absence of a
--      recorded opt-in is treated as "no consent", never backfilled to
--      true. The column records current preference state only and is not
--      an audit record of when/how consent was given.
--   2. CustomerPreferredLocation — a plain join table (customer <-> the
--      authoritative Location records). ON DELETE CASCADE on both foreign
--      keys: a join row cannot outlive either referent, and dropping one
--      cannot corrupt a Customer or a Location row.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "marketingEmailOptIn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomerPreferredLocation" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPreferredLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerPreferredLocation_customerId_idx" ON "CustomerPreferredLocation"("customerId");

-- CreateIndex
CREATE INDEX "CustomerPreferredLocation_locationId_idx" ON "CustomerPreferredLocation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPreferredLocation_customerId_locationId_key" ON "CustomerPreferredLocation"("customerId", "locationId");

-- AddForeignKey
ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPreferredLocation" ADD CONSTRAINT "CustomerPreferredLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
