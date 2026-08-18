-- CreateTable
CREATE TABLE "LocationProductPriceOverride" (
    "locationId" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationProductPriceOverride_pkey" PRIMARY KEY ("locationId","menuId","productId")
);

-- CreateIndex
CREATE INDEX "LocationProductPriceOverride_menuId_idx" ON "LocationProductPriceOverride"("menuId");

-- CreateIndex
CREATE INDEX "LocationProductPriceOverride_productId_idx" ON "LocationProductPriceOverride"("productId");

-- AddForeignKey
ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationProductPriceOverride" ADD CONSTRAINT "LocationProductPriceOverride_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
