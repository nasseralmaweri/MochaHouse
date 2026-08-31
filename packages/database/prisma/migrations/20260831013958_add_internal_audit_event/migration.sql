-- CreateTable
CREATE TABLE "InternalAuditEvent" (
    "id" TEXT NOT NULL,
    "actorInternalUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "beforeData" JSONB,
    "afterData" JSONB,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InternalAuditEvent_targetType_targetId_idx" ON "InternalAuditEvent"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "InternalAuditEvent_actorInternalUserId_idx" ON "InternalAuditEvent"("actorInternalUserId");

-- CreateIndex
CREATE INDEX "InternalAuditEvent_createdAt_idx" ON "InternalAuditEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "InternalAuditEvent" ADD CONSTRAINT "InternalAuditEvent_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
