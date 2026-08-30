-- CreateEnum
CREATE TYPE "InternalScopeType" AS ENUM ('CORPORATE', 'LOCATION');

-- CreateTable
CREATE TABLE "InternalRole" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalRolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalRolePermission_pkey" PRIMARY KEY ("roleId","permissionKey")
);

-- CreateTable
CREATE TABLE "InternalUserRoleAssignment" (
    "id" TEXT NOT NULL,
    "internalUserId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scopeType" "InternalScopeType" NOT NULL,
    "scopeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalUserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalRole_key_key" ON "InternalRole"("key");

-- CreateIndex
CREATE INDEX "InternalRolePermission_permissionKey_idx" ON "InternalRolePermission"("permissionKey");

-- CreateIndex
CREATE INDEX "InternalUserRoleAssignment_internalUserId_idx" ON "InternalUserRoleAssignment"("internalUserId");

-- CreateIndex
CREATE INDEX "InternalUserRoleAssignment_roleId_idx" ON "InternalUserRoleAssignment"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalUserRoleAssignment_internalUserId_roleId_scopeType__key" ON "InternalUserRoleAssignment"("internalUserId", "roleId", "scopeType", "scopeId");

-- AddForeignKey
ALTER TABLE "InternalRolePermission" ADD CONSTRAINT "InternalRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "InternalRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "InternalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "InternalRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
