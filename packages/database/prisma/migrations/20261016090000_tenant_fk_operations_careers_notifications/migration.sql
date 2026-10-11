-- Security 4C-7 — tenant-enforced operations, careers, franchising and
-- notifications; ownership immutability for every remaining business table.
--
-- Replaces the last 10 single-column foreign keys between business-owned
-- records with composite ones on ("tenantId", <column>) -> parent
-- ("tenantId", "id"). PostgreSQL itself therefore rejects a checklist,
-- checklist item, task, job opening, job application, application note,
-- franchise-inquiry note or notification delivery that references another
-- business's record:
--
--   ChecklistTemplateItem.templateId          -> ChecklistTemplate ON DELETE CASCADE
--   ChecklistInstance.templateId              -> ChecklistTemplate ON DELETE RESTRICT
--   ChecklistInstance.locationId              -> Location          ON DELETE RESTRICT
--   ChecklistInstanceItem.checklistInstanceId -> ChecklistInstance ON DELETE CASCADE
--   OperationsTask.locationId                 -> Location          ON DELETE RESTRICT
--   JobOpening.locationId                     -> Location          ON DELETE RESTRICT   (optional)
--   JobApplication.jobOpeningId               -> JobOpening        ON DELETE RESTRICT
--   JobApplicationNote.jobApplicationId       -> JobApplication    ON DELETE CASCADE
--   FranchiseInquiryNote.franchiseInquiryId   -> FranchiseInquiry  ON DELETE CASCADE
--   NotificationDelivery.outboxEventId        -> OutboxEvent       ON DELETE RESTRICT
--
-- Delete behaviour is unchanged. ON UPDATE is RESTRICT (was CASCADE): ids
-- never change. Every child column is already indexed (leading column), so
-- no index is added.
--
-- Ownership: these twelve tables — the last business-owned tables without
-- it — now reject any change of "tenantId" on an existing row (trigger
-- "<Table>_tenantId_immutable", SQLSTATE 23001), reusing Security 4C-3's
-- reject_tenant_reassignment(). After this migration every table with a
-- "tenantId" column has the trigger.
--   ChecklistInstance
--   ChecklistTemplate
--   ChecklistTemplateItem
--   CmsPage
--   FranchiseInquiry
--   GiftCardConfiguration
--   JobApplication
--   JobOpening
--   LoyaltyConfiguration
--   NotificationDelivery
--   NotificationRecipient
--   OutboxEvent
--
-- Not changed on purpose (see docs/security/ci-and-required-checks.md):
-- polymorphic references (OutboxEvent / NotificationDelivery aggregateId,
-- InternalAuditEvent and ApprovalRequest targetId), historical snapshots and
-- external identifiers stay without foreign keys; the integrity checker
-- verifies them.
--
-- Safety:
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement,
--     so the migration applies completely or not at all.
--   - Preflight (read-only) first: the PostgreSQL version, the 4C-3
--     function, and every row of the 10 relationships must reference a row
--     of the SAME business. Any problem aborts with counts and nothing
--     changed. Nothing is repaired or reassigned automatically.
--   - lock_timeout 5s (local to this transaction): it fails, atomically,
--     rather than queue application traffic behind a lock it cannot get.
--     It limits only the wait to ACQUIRE a lock: once acquired, locks
--     (ACCESS EXCLUSIVE on both tables of each replaced key) are held until
--     the migration commits.
--
-- If it fails: nothing changed. Fix the reported rows deliberately (or wait
-- for a quieter moment), run `prisma migrate resolve --rolled-back
-- 20261016090000_tenant_fk_operations_careers_notifications`, then deploy again.
-- Rollback (never automatic): prisma/rollbacks/20261016090000_tenant_fk_operations_careers_notifications.down.sql.

DO $tenant_fk_operations_careers_notifications$
DECLARE
  r record;
  cross_rows bigint;
  missing_rows bigint;
  problems text := '';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION 'Security 4C-7 requires PostgreSQL 15 or later; this server is %. Nothing was changed.',
      current_setting('server_version');
  END IF;
  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Security 4C-7 requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('ChecklistTemplateItem', 'templateId', 'ChecklistTemplate'),
      ('ChecklistInstance', 'templateId', 'ChecklistTemplate'),
      ('ChecklistInstance', 'locationId', 'Location'),
      ('ChecklistInstanceItem', 'checklistInstanceId', 'ChecklistInstance'),
      ('OperationsTask', 'locationId', 'Location'),
      ('JobOpening', 'locationId', 'Location'),
      ('JobApplication', 'jobOpeningId', 'JobOpening'),
      ('JobApplicationNote', 'jobApplicationId', 'JobApplication'),
      ('FranchiseInquiryNote', 'franchiseInquiryId', 'FranchiseInquiry'),
      ('NotificationDelivery', 'outboxEventId', 'OutboxEvent')
    ) AS t(child, col, parent)
  LOOP
    EXECUTE format(
      'SELECT count(*) FILTER (WHERE p."id" IS NOT NULL), count(*) FILTER (WHERE p."id" IS NULL)
         FROM %I c LEFT JOIN %I p ON p."id" = c.%I
        WHERE c.%I IS NOT NULL AND (p."id" IS NULL OR p."tenantId" <> c."tenantId")',
      r.child, r.parent, r.col, r.col)
      INTO cross_rows, missing_rows;
    IF cross_rows > 0 OR missing_rows > 0 THEN
      problems := problems || format(E'\n  %s.%s: %s row(s) name another business''s record, %s row(s) name a missing one',
        r.child, r.col, cross_rows, missing_rows);
    END IF;
  END LOOP;
  IF problems <> '' THEN
    RAISE EXCEPTION 'Security 4C-7 aborted: rows reference another business''s record or a missing one. Nothing was changed; resolve them explicitly, then retry:%',
      problems;
  END IF;

  ALTER TABLE "ChecklistTemplateItem" DROP CONSTRAINT "ChecklistTemplateItem_templateId_fkey";
  ALTER TABLE "ChecklistInstance" DROP CONSTRAINT "ChecklistInstance_templateId_fkey";
  ALTER TABLE "ChecklistInstance" DROP CONSTRAINT "ChecklistInstance_locationId_fkey";
  ALTER TABLE "ChecklistInstanceItem" DROP CONSTRAINT "ChecklistInstanceItem_checklistInstanceId_fkey";
  ALTER TABLE "OperationsTask" DROP CONSTRAINT "OperationsTask_locationId_fkey";
  ALTER TABLE "JobOpening" DROP CONSTRAINT "JobOpening_locationId_fkey";
  ALTER TABLE "JobApplication" DROP CONSTRAINT "JobApplication_jobOpeningId_fkey";
  ALTER TABLE "JobApplicationNote" DROP CONSTRAINT "JobApplicationNote_jobApplicationId_fkey";
  ALTER TABLE "FranchiseInquiryNote" DROP CONSTRAINT "FranchiseInquiryNote_franchiseInquiryId_fkey";
  ALTER TABLE "NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_outboxEventId_fkey";

  ALTER TABLE "ChecklistTemplateItem" ADD CONSTRAINT "ChecklistTemplateItem_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "ChecklistTemplate"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "ChecklistInstance" ADD CONSTRAINT "ChecklistInstance_tenantId_templateId_fkey" FOREIGN KEY ("tenantId", "templateId") REFERENCES "ChecklistTemplate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ChecklistInstance" ADD CONSTRAINT "ChecklistInstance_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "ChecklistInstanceItem" ADD CONSTRAINT "ChecklistInstanceItem_tenantId_checklistInstanceId_fkey" FOREIGN KEY ("tenantId", "checklistInstanceId") REFERENCES "ChecklistInstance"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "OperationsTask" ADD CONSTRAINT "OperationsTask_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_tenantId_jobOpeningId_fkey" FOREIGN KEY ("tenantId", "jobOpeningId") REFERENCES "JobOpening"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "JobApplicationNote" ADD CONSTRAINT "JobApplicationNote_tenantId_jobApplicationId_fkey" FOREIGN KEY ("tenantId", "jobApplicationId") REFERENCES "JobApplication"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "FranchiseInquiryNote" ADD CONSTRAINT "FranchiseInquiryNote_tenantId_franchiseInquiryId_fkey" FOREIGN KEY ("tenantId", "franchiseInquiryId") REFERENCES "FranchiseInquiry"("tenantId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;
  ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_tenantId_outboxEventId_fkey" FOREIGN KEY ("tenantId", "outboxEventId") REFERENCES "OutboxEvent"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "ChecklistInstance_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ChecklistInstance"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ChecklistTemplate_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ChecklistTemplate"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "ChecklistTemplateItem_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "ChecklistTemplateItem"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "CmsPage_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CmsPage"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "FranchiseInquiry_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "FranchiseInquiry"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "GiftCardConfiguration_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "GiftCardConfiguration"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "JobApplication_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "JobApplication"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "JobOpening_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "JobOpening"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "LoyaltyConfiguration_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "LoyaltyConfiguration"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "NotificationDelivery_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "NotificationDelivery"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "NotificationRecipient_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "NotificationRecipient"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "OutboxEvent_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "OutboxEvent"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
END
$tenant_fk_operations_careers_notifications$;
