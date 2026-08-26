-- CreateEnum
CREATE TYPE "CustomerAccountStatus" AS ENUM ('ACTIVE', 'RESTRICTED', 'DEACTIVATED');

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "externalProvider" TEXT NOT NULL,
    "externalSubject" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "status" "CustomerAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_externalProvider_externalSubject_key" ON "Customer"("externalProvider", "externalSubject");
