-- CreateEnum
CREATE TYPE "InternalUserStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateTable
CREATE TABLE "InternalUser" (
    "id" TEXT NOT NULL,
    "externalProvider" TEXT NOT NULL,
    "externalSubject" TEXT,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "InternalUserStatus" NOT NULL DEFAULT 'INVITED',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "lastAuthenticatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InternalUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_email_key" ON "InternalUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_externalProvider_externalSubject_key" ON "InternalUser"("externalProvider", "externalSubject");
