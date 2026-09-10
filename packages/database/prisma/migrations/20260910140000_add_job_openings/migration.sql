-- Milestone 8B — Careers / Job Openings. Fully additive: two enums, one
-- table, one FK to Location (ON DELETE RESTRICT). No changes to existing
-- tables or data. Applicant submission / management is Milestone 8C.

-- CreateEnum
CREATE TYPE "JobOpeningStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobEmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'TEMPORARY', 'SEASONAL');

-- CreateTable
CREATE TABLE "JobOpening" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "employmentType" "JobEmploymentType" NOT NULL,
    "locationId" TEXT,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "responsibilities" TEXT NOT NULL,
    "qualifications" TEXT NOT NULL,
    "status" "JobOpeningStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobOpening_status_idx" ON "JobOpening"("status");

-- CreateIndex
CREATE INDEX "JobOpening_locationId_idx" ON "JobOpening"("locationId");

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
