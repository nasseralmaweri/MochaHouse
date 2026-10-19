-- ESP-04 M1 — restaurant payment accounts (Stripe Connect foundation).
--
-- Restaurant CUSTOMER payments only. CENTERIVO's own SaaS billing
-- (BillingProviderEvent, TenantSubscription, ...) is untouched and shares no
-- table, configuration or credential with this.
--
--   * TenantPaymentAccount — at most ONE connected payment account per
--     business: the restaurant's own Stripe account (Accounts v2), its
--     configuration and status exactly as last read back from Stripe, and
--     who connected it. A business cannot have two (unique tenantId), an
--     account can never belong to two businesses (unique externalAccountId),
--     and once recorded the account id never changes. Test mode only for now
--     (CHECK): a live account cannot be stored.
--   * RestaurantPaymentProviderEvent — every verified Connect webhook event,
--     once (unique per provider event id): its type, mode, the connected
--     account it names and what we did with it. No payload is stored, only
--     its SHA-256 digest. Platform-level: an event can name an account that
--     belongs to no business here.
--   * The new permission payments.connect is granted to every business's
--     built-in administrator role (the role is defined as holding every
--     permission; new businesses get it at provisioning). No other role is
--     touched.
--
-- Nothing here enables payments: no charge is possible.
--
-- ADDITIVE ONLY: two tables, their indexes, constraints and two trigger
-- guards, plus the role-permission backfill. One DO block (atomic),
-- read-only preflight first, lock_timeout 5s (local to this transaction).
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261120090000_restaurant_payment_accounts.down.sql.

DO $restaurant_payment_accounts$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Restaurant payment accounts refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"TenantPaymentAccount"') IS NOT NULL
     OR to_regclass('"RestaurantPaymentProviderEvent"') IS NOT NULL
     OR to_regprocedure('payment_account_guard()') IS NOT NULL THEN
    RAISE EXCEPTION 'Restaurant payment accounts refused: a table or function it creates already exists. Nothing was changed.';
  END IF;

  CREATE TABLE "TenantPaymentAccount" (
      "id" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "livemode" BOOLEAN NOT NULL DEFAULT false,
      "externalAccountId" TEXT,
      "dashboard" TEXT,
      "feesCollector" TEXT,
      "lossesCollector" TEXT,
      "cardPaymentsStatus" TEXT,
      "requirementsStatus" TEXT,
      "requirementsDue" INTEGER NOT NULL DEFAULT 0,
      "closed" BOOLEAN NOT NULL DEFAULT false,
      "lastSyncedAt" TIMESTAMP(3),
      "connectedByInternalUserId" TEXT NOT NULL,
      -- When the provider account was first requested (before its id is
      -- known): a retry reuses the same idempotency key only while the
      -- provider still honours it; afterwards creation is refused for support.
      "creationRequestedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      "tenantId" TEXT NOT NULL,

      CONSTRAINT "TenantPaymentAccount_pkey" PRIMARY KEY ("id"),
      -- "fake" exists only in development and test databases (the fake
      -- provider is refused anywhere else).
      CONSTRAINT "TenantPaymentAccount_provider_check" CHECK ("provider" IN ('stripe', 'fake')),
      -- Test mode only until a separately approved live launch.
      CONSTRAINT "TenantPaymentAccount_test_mode_check" CHECK (NOT "livemode"),
      CONSTRAINT "TenantPaymentAccount_externalAccountId_check"
        CHECK ("externalAccountId" IS NULL OR "externalAccountId" ~ '^acct_[A-Za-z0-9]{1,100}$'),
      CONSTRAINT "TenantPaymentAccount_cardPaymentsStatus_check"
        CHECK ("cardPaymentsStatus" IS NULL OR "cardPaymentsStatus" IN ('active', 'pending', 'restricted', 'unsupported')),
      CONSTRAINT "TenantPaymentAccount_requirementsDue_check" CHECK ("requirementsDue" >= 0),
      -- Status read back from Stripe exists only for a recorded account.
      CONSTRAINT "TenantPaymentAccount_synced_check"
        CHECK ("lastSyncedAt" IS NULL OR "externalAccountId" IS NOT NULL)
  );

  -- One per business; one business per account.
  CREATE UNIQUE INDEX "TenantPaymentAccount_tenantId_key" ON "TenantPaymentAccount"("tenantId");
  CREATE UNIQUE INDEX "TenantPaymentAccount_tenantId_id_key" ON "TenantPaymentAccount"("tenantId", "id");
  CREATE UNIQUE INDEX "TenantPaymentAccount_externalAccountId_key" ON "TenantPaymentAccount"("externalAccountId");

  ALTER TABLE "TenantPaymentAccount" ADD CONSTRAINT "TenantPaymentAccount_tenantId_connectedByInternalUserId_fkey" FOREIGN KEY ("tenantId", "connectedByInternalUserId") REFERENCES "InternalUser"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
  ALTER TABLE "TenantPaymentAccount" ADD CONSTRAINT "TenantPaymentAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

  CREATE TRIGGER "TenantPaymentAccount_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "TenantPaymentAccount"
    FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
    EXECUTE FUNCTION "reject_tenant_reassignment"();

  -- Once recorded, the connected account id, provider and mode never change,
  -- and the record is never deleted (no account can be swapped or lost).
  CREATE FUNCTION "payment_account_guard"() RETURNS trigger
  LANGUAGE plpgsql AS $guard$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'A restaurant payment account record is never deleted (%).', OLD.id;
    END IF;
    IF OLD."externalAccountId" IS NOT NULL
       AND NEW."externalAccountId" IS DISTINCT FROM OLD."externalAccountId" THEN
      RAISE EXCEPTION 'A restaurant payment account''s connected account never changes (%).', OLD.id;
    END IF;
    IF NEW.provider IS DISTINCT FROM OLD.provider OR NEW.livemode IS DISTINCT FROM OLD.livemode THEN
      RAISE EXCEPTION 'A restaurant payment account''s provider and mode never change (%).', OLD.id;
    END IF;
    RETURN NEW;
  END
  $guard$;

  CREATE TRIGGER "TenantPaymentAccount_guard" BEFORE UPDATE OR DELETE ON "TenantPaymentAccount"
    FOR EACH ROW EXECUTE FUNCTION "payment_account_guard"();

  CREATE TABLE "RestaurantPaymentProviderEvent" (
      "id" TEXT NOT NULL,
      "provider" TEXT NOT NULL,
      "externalEventId" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "livemode" BOOLEAN NOT NULL,
      "externalAccountId" TEXT,
      "payloadDigest" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'RECEIVED',
      "outcome" TEXT,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "processedAt" TIMESTAMP(3),

      CONSTRAINT "RestaurantPaymentProviderEvent_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "RestaurantPaymentProviderEvent_provider_check" CHECK ("provider" IN ('stripe', 'fake')),
      CONSTRAINT "RestaurantPaymentProviderEvent_status_check"
        CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')),
      CONSTRAINT "RestaurantPaymentProviderEvent_digest_check" CHECK ("payloadDigest" ~ '^[0-9a-f]{64}$'),
      CONSTRAINT "RestaurantPaymentProviderEvent_attempts_check" CHECK ("attempts" >= 0)
  );

  -- Each provider event is handled once.
  CREATE UNIQUE INDEX "RestaurantPaymentProviderEvent_provider_externalEventId_key"
    ON "RestaurantPaymentProviderEvent"("provider", "externalEventId");
  CREATE INDEX "RestaurantPaymentProviderEvent_externalAccountId_idx"
    ON "RestaurantPaymentProviderEvent"("externalAccountId");

  -- payments.connect for every business's built-in administrator role
  -- (idempotent: an existing grant is left as it is).
  INSERT INTO "InternalRolePermission" ("roleId", "permissionKey", "tenantId", "createdAt")
  SELECT r."id", 'payments.connect', r."tenantId", CURRENT_TIMESTAMP
    FROM "InternalRole" r
   WHERE r."key" = 'platform-administrator'
     AND r."isSystem" = true
  ON CONFLICT ("roleId", "permissionKey") DO NOTHING;
END
$restaurant_payment_accounts$;
