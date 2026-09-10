-- Milestone 8C — Applicants. Fully additive: one enum, two tables (a
-- public visitor's job application, and an append-only internal note on
-- it), FKs to JobOpening (RESTRICT) / JobApplication (CASCADE) /
-- InternalUser (RESTRICT). No changes to existing tables or data. No file
-- storage — resumeUrl is an external link only.

-- CreateEnum
CREATE TYPE "JobApplicationStatus" AS ENUM ('NEW', 'REVIEWING', 'CONTACTED', 'HIRED', 'REJECTED');

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "jobOpeningId" TEXT NOT NULL,
    "jobTitleSnapshot" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "workAuthorized" BOOLEAN NOT NULL,
    "availability" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resumeUrl" TEXT,
    "status" "JobApplicationStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobApplicationNote" (
    "id" TEXT NOT NULL,
    "jobApplicationId" TEXT NOT NULL,
    "authorInternalUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobApplicationNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobApplication_jobOpeningId_idx" ON "JobApplication"("jobOpeningId");

-- CreateIndex
CREATE INDEX "JobApplication_status_idx" ON "JobApplication"("status");

-- CreateIndex
CREATE INDEX "JobApplication_createdAt_idx" ON "JobApplication"("createdAt");

-- CreateIndex
CREATE INDEX "JobApplicationNote_jobApplicationId_createdAt_idx" ON "JobApplicationNote"("jobApplicationId", "createdAt");

-- CreateIndex
CREATE INDEX "JobApplicationNote_authorInternalUserId_idx" ON "JobApplicationNote"("authorInternalUserId");

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jobOpeningId_fkey" FOREIGN KEY ("jobOpeningId") REFERENCES "JobOpening"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_authorInternalUserId_fkey" FOREIGN KEY ("authorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
