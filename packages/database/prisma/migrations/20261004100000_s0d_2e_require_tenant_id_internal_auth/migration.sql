-- Milestone S0D-2E — Tenant-Scoped Internal Identity & Authorization:
-- guarded backfill + NOT NULL for the internal admin identity/authorization
-- chain — InternalUser, InternalRole, InternalRolePermission,
-- InternalUserRoleAssignment — ONLY. Every other tenant-owned table stays
-- as it is.
--
-- InternalUser and InternalRole have no tenant-owning parent (the same
-- shape as Customer in S0D-2B-1): backfilled straight to Tenant #1, guarded
-- by the same "Tenant #1 exists, is ACTIVE, and is the ONLY tenant" checks
-- used by every prior single-tenant-era conversion. InternalRolePermission
-- and InternalUserRoleAssignment are children (the S0D-2B-2 shape):
-- InternalRolePermission inherits its owning InternalRole's tenant;
-- InternalUserRoleAssignment inherits its InternalUser's tenant, with an
-- additional check that the assigned InternalRole agrees — the two parents
-- of an assignment must never disagree.
--
-- Also changes two uniqueness constraints that would otherwise make the
-- newly tenant-owned model inconsistent with itself (see schema.prisma for
-- the full reasoning): InternalUser.email and InternalRole.key move from
-- globally UNIQUE to UNIQUE per (tenantId, email) / (tenantId, key).
-- externalProvider+externalSubject uniqueness on InternalUser is
-- deliberately left GLOBAL — S0F's concern, not this migration's.
--
-- Applied as ONE atomic unit, so a failed guard or check rolls back
-- everything. Adds NO composite FK, trigger, or same-tenant DB constraint
-- (S0D-4).

/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,key]` on the table `InternalRole` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenantId,email]` on the table `InternalUser` will be added. If there are existing duplicate values, this will fail.
  - Made the column `tenantId` on table `InternalRole` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `InternalRolePermission` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `InternalUser` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `InternalUserRoleAssignment` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2E): guards, backfill, checks ---------------------
DO $s0d2e$
DECLARE
  tenant_one CONSTANT TEXT := '01a0db02-f800-7000-8000-000000000001';
  tenant_one_status TEXT;
  other_tenants INTEGER;
  updated_rows BIGINT;
  bad_rows BIGINT;
BEGIN
  SELECT "status"::TEXT INTO tenant_one_status FROM "Tenant" WHERE "id" = tenant_one;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S0D-2E aborted: Tenant #1 (%) does not exist.', tenant_one;
  END IF;
  IF tenant_one_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'S0D-2E aborted: Tenant #1 is %, not ACTIVE.', tenant_one_status;
  END IF;

  SELECT COUNT(*) INTO other_tenants FROM "Tenant" WHERE "id" <> tenant_one;
  IF other_tenants > 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: % tenant(s) other than Tenant #1 exist; NULL rows in the internal-auth chain cannot be safely attributed to Tenant #1.', other_tenants;
  END IF;

  -- Backfill: InternalUser and InternalRole have no owning parent — same
  -- shape as Customer in S0D-2B-1.
  UPDATE "InternalUser" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2E backfill: InternalUser -> % row(s) assigned to Tenant #1', updated_rows;

  UPDATE "InternalRole" SET "tenantId" = tenant_one WHERE "tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2E backfill: InternalRole -> % row(s) assigned to Tenant #1', updated_rows;

  -- Backfill: InternalRolePermission inherits its owning InternalRole's
  -- tenant (now fully populated above).
  UPDATE "InternalRolePermission" AS rp
     SET "tenantId" = r."tenantId"
    FROM "InternalRole" AS r
   WHERE rp."roleId" = r."id" AND rp."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2E backfill: InternalRolePermission -> % row(s) from parent InternalRole', updated_rows;

  -- Backfill: InternalUserRoleAssignment inherits its InternalUser's tenant
  -- (now fully populated above) — the same authoritative-parent choice the
  -- application layer uses (assignment.tenantId is copied from the
  -- assignee, never the role).
  UPDATE "InternalUserRoleAssignment" AS a
     SET "tenantId" = u."tenantId"
    FROM "InternalUser" AS u
   WHERE a."internalUserId" = u."id" AND a."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2E backfill: InternalUserRoleAssignment -> % row(s) from parent InternalUser', updated_rows;

  -- Check 1: no NULL tenantId remains anywhere in the chain.
  SELECT COUNT(*) INTO bad_rows FROM "InternalUser" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: InternalUser still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "InternalRole" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: InternalRole still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "InternalRolePermission" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: InternalRolePermission still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
  SELECT COUNT(*) INTO bad_rows FROM "InternalUserRoleAssignment" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: InternalUserRoleAssignment still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;

  -- Check 2: every InternalRolePermission's tenant matches its
  -- InternalRole's tenant (including rows that already carried a tenantId
  -- before this slice).
  SELECT COUNT(*) INTO bad_rows
    FROM "InternalRolePermission" AS rp
    JOIN "InternalRole" AS r ON r."id" = rp."roleId"
   WHERE rp."tenantId" <> r."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: % InternalRolePermission row(s) do not match their InternalRole''s tenant.', bad_rows;
  END IF;

  -- Check 3: every InternalUserRoleAssignment's tenant matches its
  -- InternalUser's tenant.
  SELECT COUNT(*) INTO bad_rows
    FROM "InternalUserRoleAssignment" AS a
    JOIN "InternalUser" AS u ON u."id" = a."internalUserId"
   WHERE a."tenantId" <> u."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: % InternalUserRoleAssignment row(s) do not match their InternalUser''s tenant.', bad_rows;
  END IF;

  -- Check 4: no assignment ever joins an InternalUser and an InternalRole
  -- of different tenants — the two parents must agree.
  SELECT COUNT(*) INTO bad_rows
    FROM "InternalUserRoleAssignment" AS a
    JOIN "InternalUser" AS u ON u."id" = a."internalUserId"
    JOIN "InternalRole" AS r ON r."id" = a."roleId"
   WHERE u."tenantId" <> r."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2E aborted: % InternalUserRoleAssignment row(s) join an InternalUser and an InternalRole of different tenants.', bad_rows;
  END IF;
END
$s0d2e$;

-- DropIndex
DROP INDEX "InternalRole_key_key";

-- DropIndex
DROP INDEX "InternalUser_email_key";

-- AlterTable
ALTER TABLE "InternalRole" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InternalRolePermission" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InternalUser" ALTER COLUMN "tenantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InternalUserRoleAssignment" ALTER COLUMN "tenantId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "InternalRole_tenantId_key_key" ON "InternalRole"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "InternalUser_tenantId_email_key" ON "InternalUser"("tenantId", "email");
