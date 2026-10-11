-- Security 4C-5 rollback for migration 20261014090000_tenant_fk_staff_authorization.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the 4C-5 composite
-- relations in schema.prisma (back to single-column fields/references,
-- removing InternalUserRoleAssignment.location and
-- Location.staffRoleAssignments) and ship this SQL as a NEW forward
-- migration, so every environment's history stays linear.
--
-- It removes only what 4C-5 added — the 11 ownership triggers, the
-- CORPORATE-grant unique index, the scope-shape CHECK and the 17
-- composite foreign keys — and restores exactly the 16 single-column
-- foreign keys as they were before 4C-5 (including ON UPDATE CASCADE).
-- scopeId goes back to a plain column. Data is untouched. It keeps
-- reject_tenant_reassignment(), which belongs to 4C-3. One DO block, so
-- Prisma applies it atomically. Roll back 4C-5 before 4C-4, 4C-3 or 4C-2.

DO $tenant_fk_staff_authorization_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  DROP TRIGGER "ApprovalRequest_tenantId_immutable" ON "ApprovalRequest";
  DROP TRIGGER "ChecklistInstanceItem_tenantId_immutable" ON "ChecklistInstanceItem";
  DROP TRIGGER "FranchiseInquiryNote_tenantId_immutable" ON "FranchiseInquiryNote";
  DROP TRIGGER "InternalAuditEvent_tenantId_immutable" ON "InternalAuditEvent";
  DROP TRIGGER "InternalRole_tenantId_immutable" ON "InternalRole";
  DROP TRIGGER "InternalRolePermission_tenantId_immutable" ON "InternalRolePermission";
  DROP TRIGGER "InternalUser_tenantId_immutable" ON "InternalUser";
  DROP TRIGGER "InternalUserRoleAssignment_tenantId_immutable" ON "InternalUserRoleAssignment";
  DROP TRIGGER "JobApplicationNote_tenantId_immutable" ON "JobApplicationNote";
  DROP TRIGGER "MediaAsset_tenantId_immutable" ON "MediaAsset";
  DROP TRIGGER "OperationsTask_tenantId_immutable" ON "OperationsTask";

  DROP INDEX "InternalUserRoleAssignment_corporate_grant_key";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_scope_shape_check";

  ALTER TABLE "InternalRolePermission" DROP CONSTRAINT "InternalRolePermission_tenantId_roleId_fkey";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_tenantId_internalUserId_fkey";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_tenantId_roleId_fkey";
  ALTER TABLE "InternalUserRoleAssignment" DROP CONSTRAINT "InternalUserRoleAssignment_tenantId_scopeId_fkey";
  ALTER TABLE "InternalAuditEvent" DROP CONSTRAINT "InternalAuditEvent_tenantId_actorInternalUserId_fkey";
  ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_tenantId_requestedByInternalUserId_fkey";
  ALTER TABLE "ApprovalRequest" DROP CONSTRAINT "ApprovalRequest_tenantId_decidedByInternalUserId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_tenantId_completedByInternalUserId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_tenantId_exceptionByInternalUserId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_tenantId_createdByInternalUserId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_tenantId_completedByInternalUserId_fkey";
  ALTER TABLE "CustomerNote" DROP CONSTRAINT "CustomerNote_tenantId_authorInternalUserId_fkey";
  ALTER TABLE "JobApplicationNote" DROP CONSTRAINT "JobApplicationNote_tenantId_authorInternalUserId_fkey";
  ALTER TABLE "FranchiseInquiryNote" DROP CONSTRAINT "FranchiseInquiryNote_tenantId_authorInternalUserId_fkey";
  ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_tenantId_uploadedByInternalUserId_fkey";
  ALTER TABLE "MochaBeanLedgerEntry" DROP CONSTRAINT "MochaBeanLedgerEntry_tenantId_actorInternalUserId_fkey";
  ALTER TABLE "GiftCardTransaction" DROP CONSTRAINT "GiftCardTransaction_tenantId_actorInternalUserId_fkey";

  ALTER TABLE "InternalRolePermission" ADD CONSTRAINT "InternalRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "InternalRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_internalUserId_fkey" FOREIGN KEY ("internalUserId") REFERENCES "InternalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "InternalUserRoleAssignment" ADD CONSTRAINT "InternalUserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "InternalRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "InternalAuditEvent" ADD CONSTRAINT "InternalAuditEvent_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_requestedByInternalUserId_fkey" FOREIGN KEY ("requestedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_decidedByInternalUserId_fkey" FOREIGN KEY ("decidedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_completedByInternalUserId_fkey" FOREIGN KEY ("completedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_exceptionByInternalUserId_fkey" FOREIGN KEY ("exceptionByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_createdByInternalUserId_fkey" FOREIGN KEY ("createdByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_completedByInternalUserId_fkey" FOREIGN KEY ("completedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorInternalUserId_fkey" FOREIGN KEY ("authorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_authorInternalUserId_fkey" FOREIGN KEY ("authorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_authorInternalUserId_fkey" FOREIGN KEY ("authorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploadedByInternalUserId_fkey" FOREIGN KEY ("uploadedByInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "MochaBeanLedgerEntry" ADD CONSTRAINT "MochaBeanLedgerEntry_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_actorInternalUserId_fkey" FOREIGN KEY ("actorInternalUserId") REFERENCES "InternalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END
$tenant_fk_staff_authorization_rollback$;
