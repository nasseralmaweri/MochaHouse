-- ESP-03 PR 1 — payment recovery database foundation. ADDITIVE ONLY: nothing
-- reads or writes any of this yet, so application behaviour is unchanged.
--
-- What it adds
--   PaymentAttempt."paymentState"      TEXT NULL  (provider side of the new state machine)
--   PaymentAttempt."fulfilmentStatus"  TEXT NULL  (order / gift-card side)
--   PaymentReconciliationCase          one operational case per attempt needing attention
--   PaymentReconciliationEvent         append-only history of a case (rejects UPDATE / DELETE)
--
-- NULL on PaymentAttempt means "legacy semantics": the existing "status" and
-- "reconciliationRequired" columns stay authoritative. Plain text + CHECK, not
-- enums: PostgreSQL cannot add an enum value and use it in the same
-- transaction, and enum values cannot be dropped.
--   paymentState      NOT_SENT | CHARGING | AWAITING_CONFIRMATION | UNKNOWN |
--                     SUCCEEDED | DECLINED | FAILED
--   fulfilmentStatus  NOT_REQUIRED | PENDING | DONE | NEEDS_REVIEW
--
-- Conservative backfill (existing rows). Only rows that CLEARLY need attention
-- are classified and given a reconciliation case; every other row stays NULL:
--   1. status PENDING for more than one hour -> paymentState UNKNOWN, case
--      LEGACY_PENDING_UNRESOLVED. An unresolved payment is NEVER classified as
--      FAILED: whether money moved is not known. Exception: a gift-card
--      purchase attempt whose charge was never claimed (chargeClaimedAt NULL)
--      provably never reached the provider — an abandoned intent — and is left
--      untouched.
--   2. status SUCCEEDED with no Order and no ISSUED gift-card purchase, and
--      either flagged reconciliationRequired or older than one hour ->
--      paymentState SUCCEEDED, fulfilmentStatus NEEDS_REVIEW, case
--      LEGACY_SUCCEEDED_UNFULFILLED. (The one-hour margin keeps a payment whose
--      order transaction is still running at deploy time out of the queue.)
-- No status, flag or amount is changed, nothing is marked failed, and nothing
-- is refunded, retried or fulfilled. Each case gets an OPENED SYSTEM event.
--
-- Tenancy (the Security 4C conventions): both tables carry a required
-- "tenantId"; every relationship is a composite foreign key on ("tenantId", col)
-- -> parent ("tenantId", "id"), so PostgreSQL itself refuses a case that names
-- another business's attempt, assignee or event; the
-- "<Table>_tenantId_immutable" trigger (reject_tenant_reassignment(), 4C-3)
-- refuses a change of "tenantId".
--
-- Safety
--   - ONE DO block: Prisma sends a dollar-quoted file as a single statement, so
--     the migration applies completely or not at all.
--   - Read-only preflight first (required objects exist, the new objects do
--     not); any problem aborts with nothing changed.
--   - lock_timeout 5s (local to this transaction): it fails, atomically, rather
--     than queue application traffic behind a lock it cannot get. Adding two
--     nullable columns to PaymentAttempt is metadata-only; the two CHECK
--     constraints scan the table once, under the lock the ADD COLUMN takes
--     (held until commit). Nothing is rewritten.
--   - The backfill touches only the problem rows (typically none) and is safe
--     to re-run only by rolling back first.
--
-- If it fails: nothing changed. Fix the reported problem, run `prisma migrate
-- resolve --rolled-back 20261017090000_payment_recovery_foundation`, then
-- deploy again.
-- Rollback (never automatic):
-- prisma/rollbacks/20261017090000_payment_recovery_foundation.down.sql.

DO $payment_recovery_foundation$
DECLARE
  unknown_rows bigint;
  unfulfilled_rows bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('public.reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'ESP-03 requires Security 4C-3 (function reject_tenant_reassignment). Nothing was changed.';
  END IF;
  IF to_regclass('public."PaymentAttempt"') IS NULL OR to_regclass('public."InternalUser"') IS NULL THEN
    RAISE EXCEPTION 'ESP-03 requires PaymentAttempt and InternalUser. Nothing was changed.';
  END IF;
  IF to_regclass('public."PaymentReconciliationCase"') IS NOT NULL
     OR to_regclass('public."PaymentReconciliationEvent"') IS NOT NULL THEN
    RAISE EXCEPTION 'ESP-03 aborted: a PaymentReconciliation table already exists. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'PaymentAttempt'
       AND column_name IN ('paymentState', 'fulfilmentStatus')
  ) THEN
    RAISE EXCEPTION 'ESP-03 aborted: PaymentAttempt already has paymentState or fulfilmentStatus. Nothing was changed.';
  END IF;

  -- PaymentAttempt: the two nullable state columns and their value checks.
  ALTER TABLE "PaymentAttempt" ADD COLUMN "paymentState" TEXT;
  ALTER TABLE "PaymentAttempt" ADD COLUMN "fulfilmentStatus" TEXT;
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentState_check"
    CHECK ("paymentState" IS NULL OR "paymentState" IN
      ('NOT_SENT', 'CHARGING', 'AWAITING_CONFIRMATION', 'UNKNOWN', 'SUCCEEDED', 'DECLINED', 'FAILED'));
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_fulfilmentStatus_check"
    CHECK ("fulfilmentStatus" IS NULL OR "fulfilmentStatus" IN
      ('NOT_REQUIRED', 'PENDING', 'DONE', 'NEEDS_REVIEW'));

  -- PaymentReconciliationCase
  CREATE TABLE "PaymentReconciliationCase" (
    "id" TEXT NOT NULL,
    "paymentAttemptId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reasonCode" TEXT NOT NULL,
    "assigneeInternalUserId" TEXT,
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "PaymentReconciliationCase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentReconciliationCase_status_check"
      CHECK ("status" IN ('OPEN', 'IN_REVIEW', 'RESOLVED')),
    CONSTRAINT "PaymentReconciliationCase_resolution_check"
      CHECK ("resolution" IS NULL OR "resolution" IN ('FULFILLED', 'REFUNDED_EXTERNALLY', 'NOT_CHARGED')),
    CONSTRAINT "PaymentReconciliationCase_resolved_consistency_check"
      CHECK (("status" = 'RESOLVED' AND "resolution" IS NOT NULL AND "resolvedAt" IS NOT NULL)
          OR ("status" <> 'RESOLVED' AND "resolution" IS NULL AND "resolvedAt" IS NULL)),
    CONSTRAINT "PaymentReconciliationCase_reasonCode_check"
      CHECK ("reasonCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
  );

  -- PaymentReconciliationEvent (append-only)
  CREATE TABLE "PaymentReconciliationEvent" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorInternalUserId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "PaymentReconciliationEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PaymentReconciliationEvent_actorKind_check"
      CHECK ("actorKind" IN ('USER', 'SYSTEM')),
    CONSTRAINT "PaymentReconciliationEvent_actor_consistency_check"
      CHECK (("actorKind" = 'USER') = ("actorInternalUserId" IS NOT NULL)),
    CONSTRAINT "PaymentReconciliationEvent_action_check"
      CHECK ("action" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "PaymentReconciliationEvent_detail_check"
      CHECK ("detail" IS NULL OR jsonb_typeof("detail") = 'object')
  );

  CREATE UNIQUE INDEX "PaymentReconciliationCase_tenantId_id_key" ON "PaymentReconciliationCase"("tenantId", "id");
  CREATE UNIQUE INDEX "PaymentReconciliationCase_tenantId_paymentAttemptId_key" ON "PaymentReconciliationCase"("tenantId", "paymentAttemptId");
  CREATE INDEX "PaymentReconciliationCase_tenantId_status_idx" ON "PaymentReconciliationCase"("tenantId", "status");
  CREATE INDEX "PaymentReconciliationEvent_tenantId_idx" ON "PaymentReconciliationEvent"("tenantId");
  CREATE INDEX "PaymentReconciliationEvent_caseId_createdAt_idx" ON "PaymentReconciliationEvent"("caseId", "createdAt");

  ALTER TABLE "PaymentReconciliationCase" ADD CONSTRAINT "PaymentReconciliationCase_tenantId_paymentAttemptId_fkey" FOREIGN KEY ("tenantId", "paymentAttemptId") REFERENCES "PaymentAttempt"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentReconciliationCase" ADD CONSTRAINT "PaymentReconciliationCase_tenantId_assigneeInternalUserId_fkey" FOREIGN KEY ("tenantId", "assigneeInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentReconciliationCase" ADD CONSTRAINT "PaymentReconciliationCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentReconciliationEvent" ADD CONSTRAINT "PaymentReconciliationEvent_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "PaymentReconciliationCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentReconciliationEvent" ADD CONSTRAINT "PaymentReconciliationEvent_tenantId_actorInternalUserId_fkey" FOREIGN KEY ("tenantId", "actorInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "PaymentReconciliationEvent" ADD CONSTRAINT "PaymentReconciliationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "PaymentReconciliationCase_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PaymentReconciliationCase"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();
  CREATE TRIGGER "PaymentReconciliationEvent_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "PaymentReconciliationEvent"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- A reconciliation event is history: it can be added, never changed or removed.
  CREATE FUNCTION "reject_payment_reconciliation_event_change"() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'PaymentReconciliationEvent is append-only: % is not allowed.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END;
  $fn$;
  CREATE TRIGGER "PaymentReconciliationEvent_append_only" BEFORE UPDATE OR DELETE ON "PaymentReconciliationEvent"
    FOR EACH ROW EXECUTE FUNCTION "reject_payment_reconciliation_event_change"();

  -- Conservative backfill (see the header). Only classified rows get a case.
  UPDATE "PaymentAttempt" a
     SET "paymentState" = 'UNKNOWN'
   WHERE a."status" = 'PENDING'
     AND a."updatedAt" < now() - interval '1 hour'
     AND NOT EXISTS (
       SELECT 1 FROM "GiftCardPurchase" g
        WHERE g."paymentAttemptId" = a."id" AND g."chargeClaimedAt" IS NULL);
  GET DIAGNOSTICS unknown_rows = ROW_COUNT;

  UPDATE "PaymentAttempt" a
     SET "paymentState" = 'SUCCEEDED', "fulfilmentStatus" = 'NEEDS_REVIEW'
   WHERE a."status" = 'SUCCEEDED'
     AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."paymentAttemptId" = a."id")
     AND NOT EXISTS (
       SELECT 1 FROM "GiftCardPurchase" g
        WHERE g."paymentAttemptId" = a."id" AND g."status" = 'ISSUED' AND g."giftCardId" IS NOT NULL)
     AND (a."reconciliationRequired" OR a."updatedAt" < now() - interval '1 hour');
  GET DIAGNOSTICS unfulfilled_rows = ROW_COUNT;

  INSERT INTO "PaymentReconciliationCase" ("id", "paymentAttemptId", "status", "reasonCode", "tenantId", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, a."id", 'OPEN',
         CASE WHEN a."paymentState" = 'UNKNOWN' THEN 'LEGACY_PENDING_UNRESOLVED' ELSE 'LEGACY_SUCCEEDED_UNFULFILLED' END,
         a."tenantId", now(), now()
    FROM "PaymentAttempt" a
   WHERE a."paymentState" = 'UNKNOWN' OR a."fulfilmentStatus" = 'NEEDS_REVIEW';

  INSERT INTO "PaymentReconciliationEvent" ("id", "caseId", "actorKind", "action", "detail", "createdAt", "tenantId")
  SELECT gen_random_uuid()::text, c."id", 'SYSTEM', 'OPENED',
         jsonb_build_object('source', 'migration', 'migration', '20261017090000_payment_recovery_foundation', 'reasonCode', c."reasonCode"),
         now(), c."tenantId"
    FROM "PaymentReconciliationCase" c;

  RAISE NOTICE 'ESP-03 backfill: % pending attempt(s) classified UNKNOWN, % succeeded attempt(s) without an order or card queued for review.',
    unknown_rows, unfulfilled_rows;
END
$payment_recovery_foundation$;
