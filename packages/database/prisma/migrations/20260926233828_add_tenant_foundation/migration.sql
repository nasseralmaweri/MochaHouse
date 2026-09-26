-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TenantSuspensionReason" AS ENUM ('SECURITY', 'BILLING', 'REQUESTED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL,
    "suspensionReason" "TenantSuspensionReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- --- Hand-written (S0C): invariants Prisma cannot express --------------

-- A suspension reason is present exactly when the tenant is SUSPENDED —
-- never a SUSPENDED tenant without a reason, never a stale reason on an
-- ACTIVE tenant.
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_suspension_reason_matches_status"
  CHECK (("status" = 'SUSPENDED') = ("suspensionReason" IS NOT NULL));

-- Tenant ids are canonical lowercase UUID strings (compared as plain text
-- everywhere; see isValidTenantId in src/tenancy/tenant-id.ts).
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_id_canonical_uuid"
  CHECK ("id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

-- Slugs are URL/host-safe: lowercase alphanumeric words joined by single
-- hyphens (reserved for future host/domain resolution).
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- --- Tenant #1: Mocha House --------------------------------------------
-- Inserted here (not only by the seed) so EVERY environment, including one
-- that never runs the seed, has the same fixed Tenant #1 id for the S0D
-- backfill and for recovery tooling. The id is TENANT_1_MOCHA_HOUSE_ID in
-- src/tenancy/well-known-tenants.ts. Idempotent. This row is NOT a default:
-- no column anywhere defaults to it.
INSERT INTO "Tenant" ("id", "slug", "name", "status", "suspensionReason", "createdAt", "updatedAt")
VALUES ('01a0db02-f800-7000-8000-000000000001', 'mocha-house', 'Mocha House', 'ACTIVE', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
