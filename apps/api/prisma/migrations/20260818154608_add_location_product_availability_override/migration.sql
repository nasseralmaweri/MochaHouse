-- CreateTable
CREATE TABLE "LocationProductAvailabilityOverride" (
    "locationId" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "isAvailable" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationProductAvailabilityOverride_pkey" PRIMARY KEY ("locationId","menuId","productId")
);

-- CreateIndex
CREATE INDEX "LocationProductAvailabilityOverride_menuId_idx" ON "LocationProductAvailabilityOverride"("menuId");

-- CreateIndex
CREATE INDEX "LocationProductAvailabilityOverride_productId_idx" ON "LocationProductAvailabilityOverride"("productId");

-- AddForeignKey
ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationProductAvailabilityOverride" ADD CONSTRAINT "LocationProductAvailabilityOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
