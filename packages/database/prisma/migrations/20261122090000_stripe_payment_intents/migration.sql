-- ESP-04 M3 — Stripe PaymentIntents (direct charges on the restaurant's
-- connected account), STRIPE TEST MODE ONLY.
--
--   * PaymentAttempt."providerAccountId" — the connected account (acct_…) a
--     Stripe intent was created on, recorded with the charge claim before
--     Stripe is called. Every later read of the intent (the customer's check,
--     a payment webhook) uses exactly this account:
--       - a Stripe attempt that names an intent always names its account
--         (CHECK);
--       - once recorded, neither the account nor the intent of a Stripe
--         attempt ever changes (trigger guard);
--       - at most ONE Stripe attempt names a given intent (partial unique
--         index), so a webhook can never link one intent to two payments.
--   * RestaurantPaymentProviderEvent — payment events (B1: their own
--     endpoint) are recorded in the same table as the M1 account events:
--       - "externalObjectId": the intent the event is about (pi_…), so an
--         event can be processed again from what is stored, without its body;
--       - "lastAttemptAt": when processing was last tried (re-drive backoff);
--       - status UNMATCHED: a verified payment event for one of our accounts
--         that names no payment of that business — kept for reconciliation,
--         never linked by its metadata;
--       - an index on (status, receivedAt) for finding unfinished events.
--
-- Nothing here enables payments. CENTERIVO's SaaS billing is untouched.
--
-- ADDITIVE ONLY: two columns and two on another table, CHECKs, one index on
-- each table, one guard. No existing row changes (every new column is null
-- and the status CHECK is a superset). One DO block (atomic), read-only
-- preflight first, lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261122090000_stripe_payment_intents.down.sql.

DO $stripe_payment_intents$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regclass('"PaymentAttempt"') IS NULL
     OR to_regclass('"RestaurantPaymentProviderEvent"') IS NULL THEN
    RAISE EXCEPTION 'Stripe payment intents refused: "PaymentAttempt" or "RestaurantPaymentProviderEvent" is missing. Nothing was changed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RestaurantPaymentProviderEvent_status_check'
  ) THEN
    RAISE EXCEPTION 'Stripe payment intents refused: constraint "RestaurantPaymentProviderEvent_status_check" is missing. Nothing was changed.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'PaymentAttempt' AND column_name = 'providerAccountId'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'RestaurantPaymentProviderEvent'
       AND column_name IN ('externalObjectId', 'lastAttemptAt')
  ) OR to_regprocedure('stripe_payment_attempt_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'Stripe payment intents refused: a column or function it creates already exists. Nothing was changed.';
  END IF;
  -- No Stripe payment can exist before this migration (no code could create
  -- one); refuse rather than guess about any that does.
  IF EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE provider = 'stripe') THEN
    RAISE EXCEPTION 'Stripe payment intents refused: Stripe payment attempts already exist. Nothing was changed.';
  END IF;

  ALTER TABLE "PaymentAttempt" ADD COLUMN "providerAccountId" TEXT;
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_providerAccountId_check"
    CHECK ("providerAccountId" IS NULL OR "providerAccountId" ~ '^acct_[A-Za-z0-9]{1,100}$');
  -- A Stripe attempt that names an intent always names the account it lives
  -- on.
  ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_stripe_account_check"
    CHECK ("provider" IS DISTINCT FROM 'stripe'
      OR "providerReference" IS NULL
      OR "providerAccountId" IS NOT NULL);
  CREATE UNIQUE INDEX "PaymentAttempt_stripe_providerReference_key"
    ON "PaymentAttempt"("provider", "providerReference")
    WHERE "provider" = 'stripe' AND "providerReference" IS NOT NULL;

  -- Once recorded, a Stripe attempt's account and intent never change.
  CREATE FUNCTION "stripe_payment_attempt_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    IF OLD."providerAccountId" IS NOT NULL
       AND NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId" THEN
      RAISE EXCEPTION 'A payment''s connected account never changes (%).', OLD.id;
    END IF;
    IF OLD.provider = 'stripe'
       AND OLD."providerReference" IS NOT NULL
       AND NEW."providerReference" IS DISTINCT FROM OLD."providerReference" THEN
      RAISE EXCEPTION 'A Stripe payment''s intent never changes (%).', OLD.id;
    END IF;
    IF OLD.provider = 'stripe' AND NEW.provider IS DISTINCT FROM OLD.provider THEN
      RAISE EXCEPTION 'A Stripe payment''s provider never changes (%).', OLD.id;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "PaymentAttempt_stripe_guard"
    BEFORE UPDATE OF "providerAccountId", "providerReference", "provider" ON "PaymentAttempt"
    FOR EACH ROW EXECUTE FUNCTION "stripe_payment_attempt_guard"();

  ALTER TABLE "RestaurantPaymentProviderEvent" ADD COLUMN "externalObjectId" TEXT;
  ALTER TABLE "RestaurantPaymentProviderEvent" ADD COLUMN "lastAttemptAt" TIMESTAMP(3);
  ALTER TABLE "RestaurantPaymentProviderEvent" ADD CONSTRAINT "RestaurantPaymentProviderEvent_externalObjectId_check"
    CHECK ("externalObjectId" IS NULL OR "externalObjectId" ~ '^pi_[A-Za-z0-9]{1,100}$');
  ALTER TABLE "RestaurantPaymentProviderEvent" DROP CONSTRAINT "RestaurantPaymentProviderEvent_status_check";
  ALTER TABLE "RestaurantPaymentProviderEvent" ADD CONSTRAINT "RestaurantPaymentProviderEvent_status_check"
    CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED', 'UNMATCHED'));
  CREATE INDEX "RestaurantPaymentProviderEvent_status_receivedAt_idx"
    ON "RestaurantPaymentProviderEvent"("status", "receivedAt");
END
$stripe_payment_intents$;
