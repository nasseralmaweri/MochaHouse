-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "MediaAsset" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByInternalUserId" TEXT NOT NULL,
    "decidedByInternalUserId" TEXT,
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalRequest_targetType_targetId_action_idx" ON "ApprovalRequest"("targetType", "targetId", "action");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_idx" ON "ApprovalRequest"("status");

-- Structural "at most one PENDING request per target+action" guarantee.
-- A partial unique index (not expressible via Prisma's @@unique) so a
-- genuinely concurrent double-request can never create two PENDING rows —
-- application-level check-then-create is the fast path, this is the
-- backstop. Does not restrict re-requesting after a PENDING request is
-- decided (APPROVED/REJECTED rows are outside this index's WHERE clause).
CREATE UNIQUE INDEX "ApprovalRequest_one_pending_per_target" ON "ApprovalRequest"("targetType", "targetId", "action") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedByInternalUserId_fkey" FOREIGN KEY ("requestedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedByInternalUserId_fkey" FOREIGN KEY ("decidedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
