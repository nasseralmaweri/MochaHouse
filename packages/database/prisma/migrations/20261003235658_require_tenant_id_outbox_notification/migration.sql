-- Milestone S0D-2C-2 — Outbox & Notification tenant ownership: guarded,
-- deterministic backfill + NOT NULL for OutboxEvent and NotificationDelivery
-- ONLY. Closes the async pipeline's ownership chain: trusted business
-- aggregate -> OutboxEvent -> per-event worker TenantContext ->
-- tenant-scoped aggregate resolution -> NotificationDelivery.
--
-- OutboxEvent is deliberately NOT scoped to a single parent table (it is a
-- genuine, aggregate-agnostic outbox — see the model comment), so unlike
-- every prior S0D-2 slice there is no single JOIN target. Ownership is
-- resolved per aggregateType against that type's own table. The three
-- aggregateTypes that exist in this codebase today are Order,
-- JobApplication and FranchiseInquiry (every current OutboxEvent producer
-- already writes tenantId from already-validated ownership — this
-- migration only needs to cover rows written in the nullable window
-- before each producer was converted). No Tenant #1 fallback, no
-- SINGLE_TENANT_ID fallback, and no payload-derived ownership anywhere —
-- an unrecognized aggregateType, a referenced aggregate that no longer
-- exists, or any other unresolved row aborts the whole migration rather
-- than guessing.
--
-- NotificationDelivery's own parent (outboxEventId) IS a required, direct
-- FK, so its conversion is the familiar single-tier, fully parent-derived
-- pattern (like GiftCardPurchase <- PaymentAttempt in S0D-2C-1B) — it just
-- cannot run until OutboxEvent's own tenantId is fully populated, which is
-- why both conversions are ordered within this one atomic migration.
--
-- Applied as ONE atomic unit, so a failed guard or check rolls back
-- everything. Adds NO default, no unique constraint, no composite FK,
-- index or trigger (S0D-4). Preserves every existing index, the
-- aggregate-agnostic architecture, the @@unique([outboxEventId, channel])
-- idempotency guard, and all existing status/claim behavior untouched.

/*
  Warnings:

  - Made the column `tenantId` on table `NotificationDelivery` required. This step will fail if there are existing NULL values in that column.
  - Made the column `tenantId` on table `OutboxEvent` required. This step will fail if there are existing NULL values in that column.

*/
-- --- Hand-written (S0D-2C-2): guards, per-aggregate-type backfill, checks -----
DO $s0d2c2_outbox$
DECLARE
  bad_rows BIGINT;
  updated_rows BIGINT;
BEGIN
  -- Check 1a: a non-null OutboxEvent.tenantId for an Order-typed row must
  -- already agree with that Order's own tenant.
  SELECT COUNT(*) INTO bad_rows
    FROM "OutboxEvent" AS e
    JOIN "Order" AS o ON o."id" = e."aggregateId"
   WHERE e."aggregateType" = 'Order'
     AND e."tenantId" IS NOT NULL
     AND e."tenantId" <> o."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % OutboxEvent row(s) (aggregateType Order) have a non-null tenantId that disagrees with their Order''s tenant.', bad_rows;
  END IF;

  -- Check 1b: same, for JobApplication.
  SELECT COUNT(*) INTO bad_rows
    FROM "OutboxEvent" AS e
    JOIN "JobApplication" AS j ON j."id" = e."aggregateId"
   WHERE e."aggregateType" = 'JobApplication'
     AND e."tenantId" IS NOT NULL
     AND e."tenantId" <> j."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % OutboxEvent row(s) (aggregateType JobApplication) have a non-null tenantId that disagrees with their JobApplication''s tenant.', bad_rows;
  END IF;

  -- Check 1c: same, for FranchiseInquiry.
  SELECT COUNT(*) INTO bad_rows
    FROM "OutboxEvent" AS e
    JOIN "FranchiseInquiry" AS f ON f."id" = e."aggregateId"
   WHERE e."aggregateType" = 'FranchiseInquiry'
     AND e."tenantId" IS NOT NULL
     AND e."tenantId" <> f."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % OutboxEvent row(s) (aggregateType FranchiseInquiry) have a non-null tenantId that disagrees with their FranchiseInquiry''s tenant.', bad_rows;
  END IF;

  -- Backfill, per aggregateType, against that type's own table.
  UPDATE "OutboxEvent" AS e
     SET "tenantId" = o."tenantId"
    FROM "Order" AS o
   WHERE e."aggregateType" = 'Order' AND e."aggregateId" = o."id" AND e."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-2 backfill: OutboxEvent -> % row(s) from Order', updated_rows;

  UPDATE "OutboxEvent" AS e
     SET "tenantId" = j."tenantId"
    FROM "JobApplication" AS j
   WHERE e."aggregateType" = 'JobApplication' AND e."aggregateId" = j."id" AND e."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-2 backfill: OutboxEvent -> % row(s) from JobApplication', updated_rows;

  UPDATE "OutboxEvent" AS e
     SET "tenantId" = f."tenantId"
    FROM "FranchiseInquiry" AS f
   WHERE e."aggregateType" = 'FranchiseInquiry' AND e."aggregateId" = f."id" AND e."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-2 backfill: OutboxEvent -> % row(s) from FranchiseInquiry', updated_rows;

  -- Check 2: any row STILL null and whose aggregateType is not one of the
  -- three known types is an unrecognized aggregateType — never guessed.
  SELECT COUNT(*) INTO bad_rows
    FROM "OutboxEvent"
   WHERE "tenantId" IS NULL
     AND "aggregateType" NOT IN ('Order', 'JobApplication', 'FranchiseInquiry');
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % OutboxEvent row(s) have an unrecognized aggregateType with no tenant resolution path.', bad_rows;
  END IF;

  -- Check 3: any row still null with a KNOWN aggregateType means the
  -- referenced aggregate (Order / JobApplication / FranchiseInquiry) no
  -- longer exists — unresolved ownership, never guessed.
  SELECT COUNT(*) INTO bad_rows
    FROM "OutboxEvent"
   WHERE "tenantId" IS NULL
     AND "aggregateType" IN ('Order', 'JobApplication', 'FranchiseInquiry');
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % OutboxEvent row(s) reference a missing aggregate and could not resolve a tenant.', bad_rows;
  END IF;

  -- Check 4: no NULL tenantId remains (safety net; should already be
  -- guaranteed by checks 2 and 3 above).
  SELECT COUNT(*) INTO bad_rows FROM "OutboxEvent" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: OutboxEvent still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
END
$s0d2c2_outbox$;

-- AlterTable
ALTER TABLE "OutboxEvent" ALTER COLUMN "tenantId" SET NOT NULL;

-- --- Hand-written (S0D-2C-2): NotificationDelivery, single-tier from its
-- required OutboxEvent parent (now fully populated above) -------------
DO $s0d2c2_notification$
DECLARE
  bad_rows BIGINT;
  updated_rows BIGINT;
BEGIN
  -- Check: any existing non-null NotificationDelivery.tenantId must
  -- already agree with its triggering OutboxEvent's tenant.
  SELECT COUNT(*) INTO bad_rows
    FROM "NotificationDelivery" AS n
    JOIN "OutboxEvent" AS e ON e."id" = n."outboxEventId"
   WHERE n."tenantId" IS NOT NULL AND n."tenantId" <> e."tenantId";
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: % NotificationDelivery row(s) have a non-null tenantId that disagrees with their OutboxEvent''s tenant.', bad_rows;
  END IF;

  -- Backfill: NotificationDelivery <- its OutboxEvent (the only parent;
  -- outboxEventId is a required FK, and OutboxEvent.tenantId is fully
  -- populated by the block above).
  UPDATE "NotificationDelivery" AS n
     SET "tenantId" = e."tenantId"
    FROM "OutboxEvent" AS e
   WHERE e."id" = n."outboxEventId" AND n."tenantId" IS NULL;
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  RAISE NOTICE 'S0D-2C-2 backfill: NotificationDelivery -> % row(s) from OutboxEvent', updated_rows;

  -- Check: no NULL tenantId remains.
  SELECT COUNT(*) INTO bad_rows FROM "NotificationDelivery" WHERE "tenantId" IS NULL;
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'S0D-2C-2 aborted: NotificationDelivery still has % row(s) with NULL tenantId after backfill.', bad_rows;
  END IF;
END
$s0d2c2_notification$;

-- AlterTable
ALTER TABLE "NotificationDelivery" ALTER COLUMN "tenantId" SET NOT NULL;
