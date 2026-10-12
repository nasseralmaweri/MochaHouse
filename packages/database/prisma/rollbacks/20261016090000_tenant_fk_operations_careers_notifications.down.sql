-- Security 4C-7 rollback for migration 20261016090000_tenant_fk_operations_careers_notifications.
--
-- NOT a Prisma migration and never run automatically. To roll back an
-- environment that applied the migration: revert the 4C-7 composite
-- relations in schema.prisma (back to single-column fields/references) and
-- ship this SQL as a NEW forward migration, so every environment's history
-- stays linear.
--
-- It removes only what 4C-7 added — the twelve ownership triggers and the
-- ten composite foreign keys — and restores the ten single-column foreign
-- keys exactly as they were (including ON UPDATE CASCADE). Data is
-- untouched. It keeps reject_tenant_reassignment() (4C-3). One DO block, so
-- Prisma applies it atomically. Roll back 4C-7 before 4C-6, 4C-5, 4C-4,
-- 4C-3 or 4C-2.

DO $tenant_fk_operations_careers_notifications_rollback$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  DROP TRIGGER "ChecklistInstance_tenantId_immutable" ON "ChecklistInstance";
  DROP TRIGGER "ChecklistTemplate_tenantId_immutable" ON "ChecklistTemplate";
  DROP TRIGGER "ChecklistTemplateItem_tenantId_immutable" ON "ChecklistTemplateItem";
  DROP TRIGGER "CmsPage_tenantId_immutable" ON "CmsPage";
  DROP TRIGGER "FranchiseInquiry_tenantId_immutable" ON "FranchiseInquiry";
  DROP TRIGGER "GiftCardConfiguration_tenantId_immutable" ON "GiftCardConfiguration";
  DROP TRIGGER "JobApplication_tenantId_immutable" ON "JobApplication";
  DROP TRIGGER "JobOpening_tenantId_immutable" ON "JobOpening";
  DROP TRIGGER "LoyaltyConfiguration_tenantId_immutable" ON "LoyaltyConfiguration";
  DROP TRIGGER "NotificationDelivery_tenantId_immutable" ON "NotificationDelivery";
  DROP TRIGGER "NotificationRecipient_tenantId_immutable" ON "NotificationRecipient";
  DROP TRIGGER "OutboxEvent_tenantId_immutable" ON "OutboxEvent";

  ALTER TABLE "ChecklistTemplateItem" DROP CONSTRAINT "ChecklistTemplateItem_tenantId_templateId_fkey";
  ALTER TABLE "ChecklistInstance" DROP CONSTRAINT "ChecklistInstance_tenantId_templateId_fkey";
  ALTER TABLE "ChecklistInstance" DROP CONSTRAINT "ChecklistInstance_tenantId_locationId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_tenantId_checklistInstanceId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_tenantId_locationId_fkey";
  ALTER TABLE "JobOpening" DROP CONSTRAINT "JobOpening_tenantId_locationId_fkey";
  ALTER TABLE "JobApplication" DROP CONSTRAINT "JobApplication_tenantId_jobOpeningId_fkey";
  ALTER TABLE "JobApplicationNote" DROP CONSTRAINT "JobApplicationNote_tenantId_jobApplicationId_fkey";
  ALTER TABLE "FranchiseInquiryNote" DROP CONSTRAINT "FranchiseInquiryNote_tenantId_franchiseInquiryId_fkey";
  ALTER TABLE "NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_tenantId_outboxEventId_fkey";

  ALTER TABLE "ChecklistTemplateItem" ADD CONSTRAINT "ChecklistTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "ChecklistInstance" ADD CONSTRAINT "ChecklistInstance_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ChecklistInstance" ADD CONSTRAINT "ChecklistInstance_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_checklistInstanceId_fkey" FOREIGN KEY ("checklistInstanceId") REFERENCES "ChecklistInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_jobOpeningId_fkey" FOREIGN KEY ("jobOpeningId") REFERENCES "JobOpening"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_franchiseInquiryId_fkey" FOREIGN KEY ("franchiseInquiryId") REFERENCES "FranchiseInquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_outboxEventId_fkey" FOREIGN KEY ("outboxEventId") REFERENCES "OutboxEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
END
$tenant_fk_operations_careers_notifications_rollback$;
