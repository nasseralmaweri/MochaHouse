-- AlterTable
ALTER TABLE "ChecklistInstanceItem" ADD COLUMN     "exceptionAt" TIMESTAMP(3),
ADD COLUMN     "exceptionByInternalUserId" TEXT,
ADD COLUMN     "exceptionReason" TEXT;

-- CreateTable
CREATE TABLE "OperationsTask" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "createdByInternalUserId" TEXT NOT NULL,
    "completedByInternalUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationsTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationsTask_locationId_businessDate_idx" ON "OperationsTask"("locationId", "businessDate");

-- CreateIndex
CREATE INDEX "OperationsTask_createdByInternalUserId_idx" ON "OperationsTask"("createdByInternalUserId");

-- CreateIndex
CREATE INDEX "OperationsTask_completedByInternalUserId_idx" ON "OperationsTask"("completedByInternalUserId");

-- CreateIndex
CREATE INDEX "ChecklistInstanceItem_exceptionByInternalUserId_idx" ON "ChecklistInstanceItem"("exceptionByInternalUserId");

-- AddForeignKey
ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_exceptionByInternalUserId_fkey" FOREIGN KEY ("exceptionByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_createdByInternalUserId_fkey" FOREIGN KEY ("createdByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_completedByInternalUserId_fkey" FOREIGN KEY ("completedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
