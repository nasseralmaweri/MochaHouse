-- Security 4C-5 — tenant-enforced staff authorization.
--
-- Replaces the sixteen single-column foreign keys that reference a staff
-- user or role with composite ones on ("tenantId", <column>) -> parent
-- ("tenantId", "id"), and gives the role assignment's scopeId its first
-- foreign key: a LOCATION grant can only name a Location of the SAME
-- business. PostgreSQL itself therefore rejects a role, permission, grant
-- or staff-actor reference that crosses businesses:
--
--   InternalRolePermission.roleId                   -> InternalRole ON DELETE CASCADE
--   InternalUserRoleAssignment.internalUserId       -> InternalUser ON DELETE CASCADE
--   InternalUserRoleAssignment.roleId               -> InternalRole ON DELETE RESTRICT
--   InternalUserRoleAssignment.scopeId              -> Location     ON DELETE RESTRICT   (NEW)
--   InternalAuditEvent.actorInternalUserId          -> InternalUser ON DELETE RESTRICT
--   ApprovalRequest.requestedByInternalUserId       -> InternalUser ON DELETE RESTRICT
--   ApprovalRequest.decidedByInternalUserId         -> InternalUser ON DELETE RESTRICT
--   ChecklistInstanceItem.completedByInternalUserId -> InternalUser ON DELETE RESTRICT
--   ChecklistInstanceItem.exceptionByInternalUserId -> InternalUser ON DELETE RESTRICT
--   OperationsTask.createdByInternalUserId          -> InternalUser ON DELETE RESTRICT
--   OperationsTask.completedByInternalUserId        -> InternalUser ON DELETE RESTRICT
--   CustomerNote.authorInternalUserId               -> InternalUser ON DELETE RESTRICT
--   JobApplicationNote.authorInternalUserId         -> InternalUser ON DELETE RESTRICT
--   FranchiseInquiryNote.authorInternalUserId       -> InternalUser ON DELETE RESTRICT
--   MediaAsset.uploadedByInternalUserId             -> InternalUser ON DELETE RESTRICT
--   MochaBeanLedgerEntry.actorInternalUserId        -> InternalUser ON DELETE RESTRICT
--   GiftCardTransaction.actorInternalUserId         -> InternalUser ON DELETE RESTRICT
--
-- Delete behaviour is unchanged (no SET NULL is involved). ON UPDATE is
-- RESTRICT (was CASCADE): ids never change.
--
-- Role-assignment scope (the polymorphic scopeId kept its name; its only
-- target type is Location, so no column split is needed):
--   - CHECK "InternalUserRoleAssignment_scope_shape_check": CORPORATE <=> scopeId IS NULL,
--     LOCATION <=> scopeId IS NOT NULL (the shape AuthorizationService
--     already requires; a malformed row could only ever be ignored).
--   - UNIQUE "InternalUserRoleAssignment_corporate_grant_key" (internalUserId, roleId) WHERE
--     scopeType = 'CORPORATE': the existing unique key treats NULL scopeIds
--     as distinct, so two identical CORPORATE grants were possible and
--     removing one would silently leave the other in force.
--
-- Ownership: these tables reject any change of "tenantId" on an existing
-- row (trigger "<Table>_tenantId_immutable", SQLSTATE 23001), reusing
-- Security 4C-3's reject_tenant_reassignment():
--   ApprovalRequest, ChecklistInstanceItem, FranchiseInquiryNote, InternalAuditEvent, InternalRole, InternalRolePermission, InternalUser, InternalUserRoleAssignment, JobApplicationNote, MediaAsset, OperationsTask.
-- (CustomerNote, MochaBeanLedgerEntry and GiftCardTransaction already are,
-- since 4C-3 / 4C-4.) This migration requires that function and never drops
-- it; 4C-3 cannot be rolled back while these triggers exist.
--
-- Safety:
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement,
--     so the migration applies completely or not at all.
--   - Preflight (read-only) first: the PostgreSQL version, 4C-3's function,
--     every row of the seventeen relationships must reference a row of the
--     SAME business, every assignment must have a valid scope shape, and no
--     user may hold the same CORPORATE grant twice. Any problem aborts with
--     counts and nothing changed. Nothing is repaired, merged, revoked or
--     reassigned automatically.
--   - lock_timeout 5s (local to this transaction): it fails, atomically,
--     rather than queue application traffic behind a lock it cannot get.
--
-- If it fails: nothing changed. Fix the reported rows deliberately (or wait
-- for a quieter moment), run `prisma migrate resolve --rolled-back
-- 20261014090000_tenant_fk_staff_authorization`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261014090000_tenant_fk_staff_authorization.down.sql.

DO $tenant_fk_staff_authorization$
DECLARE
  r record;
  n bigint;
  problems text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Security 4C-5 requires PostgreSQL 15 or later; this server is %. Nothing was changed.',
      current_setting('server_version');
  END IF;
  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Security 4C-5 requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('InternalRolePermission', 'roleId', 'InternalRole'),
      ('InternalUserRoleAssignment', 'internalUserId', 'InternalUser'),
      ('InternalUserRoleAssignment', 'roleId', 'InternalRole'),
      ('InternalUserRoleAssignment', 'scopeId', 'Location'),
      ('InternalAuditEvent', 'actorInternalUserId', 'InternalUser'),
      ('ApprovalRequest', 'requestedByInternalUserId', 'InternalUser'),
      ('ApprovalRequest', 'decidedByInternalUserId', 'InternalUser'),
      ('ChecklistInstanceItem', 'completedByInternalUserId', 'InternalUser'),
      ('ChecklistInstanceItem', 'exceptionByInternalUserId', 'InternalUser'),
      ('OperationsTask', 'createdByInternalUserId', 'InternalUser'),
      ('OperationsTask', 'completedByInternalUserId', 'InternalUser'),
      ('CustomerNote', 'authorInternalUserId', 'InternalUser'),
      ('JobApplicationNote', 'authorInternalUserId', 'InternalUser'),
      ('FranchiseInquiryNote', 'authorInternalUserId', 'InternalUser'),
      ('MediaAsset', 'uploadedByInternalUserId', 'InternalUser'),
      ('MochaBeanLedgerEntry', 'actorInternalUserId', 'InternalUser'),
      ('GiftCardTransaction', 'actorInternalUserId', 'InternalUser')
    ) AS t(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I c LEFT JOIN %I p ON p."id" = c.%I
        WHERE c.%I IS NOT NULL AND (p."id" IS NULL OR p."tenantId" <> c."tenantId")',
      r.child, r.parent, r.col, r.col)
      INTO n;
    IF n > 0 THEN
      problems := problems || format(E'\n  %s.%s -> %s: %s row(s)', r.child, r.col, r.parent, n);
    END IF;
  END LOOP;
  SELECT count(*) INTO n FROM "InternalUserRoleAssignment"
   WHERE NOT (("scopeType" = 'CORPORATE' AND "scopeId" IS NULL)
           OR ("scopeType" = 'LOCATION' AND "scopeId" IS NOT NULL));
  IF n > 0 THEN
    problems := problems || format(E'\n  InternalUserRoleAssignment scope shape: %s row(s)', n);
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "InternalUserRoleAssignment" WHERE "scopeType" = 'CORPORATE'
     GROUP BY "internalUserId", "roleId" HAVING count(*) > 1) d;
  IF n > 0 THEN
    problems := problems || format(E'\n  InternalUserRoleAssignment duplicate CORPORATE grants: %s user/role pair(s)', n);
  END IF;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Security 4C-5 aborted: rows reference another business''s record or a missing one, or grants are malformed or duplicated. Nothing was changed; resolve them explicitly, then retry:%',
      problems;
  END IF;

  ALTER TABLE "InternalRolePermission" DROP CONSTRAINT "InternalRolePermission_roleId_fkey";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_internalUserId_fkey";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_roleId_fkey";
  ALTER TABLE "InternalAuditEvent" DROP CONSTRAINT "InternalAuditEvent_actorInternalUserId_fkey";
  ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_requestedByInternalUserId_fkey";
  ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_decidedByInternalUserId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_completedByInternalUserId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_exceptionByInternalUserId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_createdByInternalUserId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_completedByInternalUserId_fkey";
  ALTER TABLE "CustomerNote" DROP CONSTRAINT "CustomerNote_authorInternalUserId_fkey";
  ALTER TABLE "JobApplicationNote" DROP CONSTRAINT "JobApplicationNote_authorInternalUserId_fkey";
  ALTER TABLE "FranchiseInquiryNote" DROP CONSTRAINT "FranchiseInquiryNote_authorInternalUserId_fkey";
  ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_uploadedByInternalUserId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_actorInternalUserId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_actorInternalUserId_fkey";

  ALTER TABLE "InternalRolePermission" ADD CONSTRAINT "InternalRolePermission_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "InternalRole"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_tenantId_internalUserId_fkey" FOREIGN KEY ("tenantId", "internalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "InternalRole"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_tenantId_scopeId_fkey" FOREIGN KEY ("tenantId", "scopeId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "InternalAuditEvent" ADD CONSTRAINT "InternalAuditEvent_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_requestedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "requestedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_decidedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "decidedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_tenantId_completedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "completedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_tenantId_exceptionByInternalUserId_fkey" FOREIGN KEY ("tenantId", "exceptionByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_tenantId_createdByInternalUserId_fkey" FOREIGN KEY ("tenantId", "createdByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_tenantId_completedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "completedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_tenantId_authorInternalUserId_fkey" FOREIGN KEY ("tenantId", "authorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_tenantId_authorInternalUserId_fkey" FOREIGN KEY ("tenantId", "authorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_tenantId_authorInternalUserId_fkey" FOREIGN KEY ("tenantId", "authorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_tenantId_uploadedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "uploadedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_scope_shape_check"
    CHECK (("scopeType" = 'CORPORATE' AND "scopeId" IS NULL) OR ("scopeType" = 'LOCATION' AND "scopeId" IS NOT NULL));
  CREATE UNIQUE INDEX "InternalUserRoleAssignment_corporate_grant_key" ON "InternalUserRoleAssignment"("internalUserId", "roleId")
    WHERE "scopeType" = 'CORPORATE';

  CREATE TRIGGER "ApprovalRequest_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ApprovalRequest"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ChecklistInstanceItem_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ChecklistInstanceItem"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "FranchiseInquiryNote_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "FranchiseInquiryNote"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "InternalAuditEvent_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "InternalAuditEvent"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "InternalRole_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "InternalRole"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "InternalRolePermission_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "InternalRolePermission"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "InternalUser_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "InternalUser"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "InternalUserRoleAssignment_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "InternalUserRoleAssignment"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "JobApplicationNote_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "JobApplicationNote"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "MediaAsset_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "MediaAsset"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OperationsTask_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OperationsTask"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
END
$tenant_fk_staff_authorization$;
