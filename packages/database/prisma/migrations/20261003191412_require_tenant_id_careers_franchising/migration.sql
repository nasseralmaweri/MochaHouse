-- Milestone S0D-2D — Careers & Franchising tenant ownership: guarded,
-- parent-derived backfill + NOT NULL for JobOpening, JobApplication,
-- JobApplicationNote, FranchiseInquiry and FranchiseInquiryNote ONLY.
-- OutboxEvent and NotificationDelivery (which these two domains also write
-- to) are untouched — they stay nullable; that conversion depends on every
-- producer domain being converted and is deliberately out of scope here.
--
-- Applied as ONE atomic unit, so a failed guard or check rolls back
-- everything. Adds NO default, no unique constraint, no composite FK,
-- index or trigger (S0D-4).

/*
  Warnings:

  - Made the column `tenantId` on table `FranchiseInquiry` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `FranchiseInquiryNote` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `JobApplication` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `JobApplicationNote` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `JobOpening` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2D): guards, parent-derived backfill, checks ----
-- Rows written between S0D-1 and this slice carry a NULL tenantId.
--   JobOpening           <- its Location when one is set; else Tenant #1
--                           (a corporate / HQ job has no parent to derive
--                           from), justified only by the single-tenant
--                           guard below.
--   JobApplication       <- its JobOpening.
--   JobApplicationNote   <- its JobApplication.
--   FranchiseInquiry     <- Tenant #1 (no parent at all), justified only by
--                           the single-tenant guard below.
--   FranchiseInquiryNote <- its FranchiseInquiry.
-- Post-checks refuse to reach SET NOT NULL unless no NULL remains and every
-- child agrees with its parent's tenant.
DO $s0d2d$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  updated_rows BIGINT;
  bad_rows BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2D aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2D aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: % tenant(s) other than Tenant #1 exist; the conversion window assumes a single tenant.', other_tenants;
  END IF;

  -- JobOpening, tier 1 <- its Location
  UPDATE "JobOpening" AS j
     SET "tenantId" = l."tenantId"
    FROM "Location" AS l
   WHERE j."locationId" = l."id" AND j."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: JobOpening -> % row(s) from Location', updated_rows;

  -- JobOpening, tier 2 <- Tenant #1 (corporate / HQ jobs with no location),
  -- justified only by the single-tenant guard above.
  UPDATE "JobOpening" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: JobOpening -> % corporate row(s) assigned to Tenant #1 (single-tenant guard)', updated_rows;

  -- JobApplication <- its JobOpening
  UPDATE "JobApplication" AS a
     SET "tenantId" = j."tenantId"
    FROM "JobOpening" AS j
   WHERE a."jobOpeningId" = j."id" AND a."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: JobApplication -> % row(s) from JobOpening', updated_rows;

  -- JobApplicationNote <- its JobApplication
  UPDATE "JobApplicationNote" AS n
     SET "tenantId" = a."tenantId"
    FROM "JobApplication" AS a
   WHERE n."jobApplicationId" = a."id" AND n."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: JobApplicationNote -> % row(s) from JobApplication', updated_rows;

  -- FranchiseInquiry <- Tenant #1 (no parent at all), justified only by the
  -- single-tenant guard above.
  UPDATE "FranchiseInquiry" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: FranchiseInquiry -> % row(s) assigned to Tenant #1 (single-tenant guard)', updated_rows;

  -- FranchiseInquiryNote <- its FranchiseInquiry
  UPDATE "FranchiseInquiryNote" AS n
     SET "tenantId" = f."tenantId"
    FROM "FranchiseInquiry" AS f
   WHERE n."franchiseInquiryId" = f."id" AND n."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2D backfill: FranchiseInquiryNote -> % row(s) from FranchiseInquiry', updated_rows;

  -- Check 1: no NULL tenantId remains.
  SELECT COUNT(*) INTO bad_rows FROM "JobOpening" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: JobOpening still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "JobApplication" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: JobApplication still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "JobApplicationNote" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: JobApplicationNote still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "FranchiseInquiry" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: FranchiseInquiry still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "FranchiseInquiryNote" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: FranchiseInquiryNote still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;

  -- Check 2: every located JobOpening agrees with its Location.
  SELECT COUNT(*) INTO bad_rows
    FROM "JobOpening" AS j JOIN "Location" AS l ON l."id" = j."locationId"
   WHERE j."tenantId" <> l."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: % JobOpening row(s) do not match their Location''s tenant.', bad_rows;
  END IF;

  -- Check 3: every JobApplication agrees with its JobOpening.
  SELECT COUNT(*) INTO bad_rows
    FROM "JobApplication" AS a JOIN "JobOpening" AS j ON j."id" = a."jobOpeningId"
   WHERE a."tenantId" <> j."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: % JobApplication row(s) do not match their JobOpening''s tenant.', bad_rows;
  END IF;

  -- Check 4: every JobApplicationNote agrees with its JobApplication.
  SELECT COUNT(*) INTO bad_rows
    FROM "JobApplicationNote" AS n JOIN "JobApplication" AS a ON a."id" = n."jobApplicationId"
   WHERE n."tenantId" <> a."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: % JobApplicationNote row(s) do not match their JobApplication''s tenant.', bad_rows;
  END IF;

  -- Check 5: every FranchiseInquiryNote agrees with its FranchiseInquiry.
  SELECT COUNT(*) INTO bad_rows
    FROM "FranchiseInquiryNote" AS n JOIN "FranchiseInquiry" AS f ON f."id" = n."franchiseInquiryId"
   WHERE n."tenantId" <> f."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2D aborted: % FranchiseInquiryNote row(s) do not match their FranchiseInquiry''s tenant.', bad_rows;
  END IF;
END
$s0d2d$;

-- AlterTable
ALTER TABLE "JobOpening" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "JobApplication" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "JobApplicationNote" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FranchiseInquiry" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "FranchiseInquiryNote" ALTER COLUMN "tenantId" SET NOT NULL;
