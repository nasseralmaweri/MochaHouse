-- ESP-03 PR 6 — server-owned checkout sessions and server-generated payment
-- keys for food-order checkout.
--
--   * CheckoutSession: one per checkout, owned by one business, for one
--     location and (when signed in) one customer. The caller holds a random
--     256-bit token; only its SHA-256 hash is stored here. New payment
--     attempts are accepted until expiresAt; the token is recognised for
--     replays until tokenExpiresAt. Expiry deletes nothing.
--   * PaymentAttempt.checkoutSessionId / requestFingerprint: the session a
--     food-order attempt belongs to and the HMAC fingerprint of the
--     server-validated checkout it was created for (keyed with the session's
--     own token, so it cannot be reversed from the database).
--   * At most ONE attempt per session that is not definitively unsuccessful:
--     a partial unique index over every attempt whose status is not DECLINED
--     or FAILED — so one that is waiting to be sent, charging, awaiting the
--     provider, unknown or succeeded blocks any other charge for the session.
--   * paymentState gains ABANDONED: an attempt saved but never sent to the
--     provider, closed (with status FAILED) only by a conditional update from
--     NOT_SENT, which the charge claim also requires — so it can never race a
--     real charge.
--
-- ADDITIVE ONLY: one table, two nullable columns, one index, and the
-- paymentState CHECK replaced with a superset. No existing row changes. A
-- read-only preflight refuses (changing nothing) if the ownership guard
-- function is missing or the table already exists.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261117090000_checkout_sessions.down.sql.

DO $checkout_sessions_preflight$
BEGIN
  IF to_regprocedure('reject_tenant_reassignment()') IS NULL THEN
    RAISE EXCEPTION 'Checkout sessions refused: the Security 4C ownership guard function reject_tenant_reassignment() is missing. Nothing was changed.';
  END IF;
  IF to_regclass('"CheckoutSession"') IS NOT NULL THEN
    RAISE EXCEPTION 'Checkout sessions refused: table "CheckoutSession" already exists. Nothing was changed.';
  END IF;
END
$checkout_sessions_preflight$;

-- Checkout sessions -------------------------------------------------------------
CREATE TABLE "CheckoutSession" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerBound" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT NOT NULL,

    CONSTRAINT "CheckoutSession_pkey" PRIMARY KEY ("id"),
    -- A customer's session stays a customer's session: if its customer is
    -- ever removed (customerId set NULL) it is refused, never treated as a
    -- guest session.
    CONSTRAINT "CheckoutSession_customer_check" CHECK ("customerId" IS NULL OR "customerBound"),
    CONSTRAINT "CheckoutSession_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "CheckoutSession_lifetime_check" CHECK (
      "expiresAt" > "createdAt" AND "tokenExpiresAt" >= "expiresAt"
    )
);

CREATE UNIQUE INDEX "CheckoutSession_tokenHash_key" ON "CheckoutSession"("tokenHash");

CREATE INDEX "CheckoutSession_tenantId_locationId_idx" ON "CheckoutSession"("tenantId", "locationId");

CREATE UNIQUE INDEX "CheckoutSession_tenantId_id_key" ON "CheckoutSession"("tenantId", "id");

-- A session's location and customer belong to the same business.
ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_tenantId_locationId_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "Location"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "Customer"("tenantId", "id") ON DELETE SET NULL ("customerId") ON UPDATE RESTRICT;

ALTER TABLE "CheckoutSession" ADD CONSTRAINT "CheckoutSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "CheckoutSession_tenantId_immutable" BEFORE UPDATE OF "tenantId" ON "CheckoutSession"
  FOR EACH ROW WHEN (OLD."tenantId" IS DISTINCT FROM NEW."tenantId")
  EXECUTE FUNCTION "reject_tenant_reassignment"();

-- Payment attempts --------------------------------------------------------------
ALTER TABLE "PaymentAttempt" ADD COLUMN "checkoutSessionId" TEXT,
ADD COLUMN "requestFingerprint" TEXT;

ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_requestFingerprint_check"
  CHECK ("requestFingerprint" IS NULL OR "requestFingerprint" ~ '^[0-9a-f]{64}$');
-- A session attempt always carries its fingerprint, and only a session
-- attempt does.
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_checkout_session_check"
  CHECK (("checkoutSessionId" IS NULL) = ("requestFingerprint" IS NULL));

-- The attempt's session belongs to the same business.
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_tenantId_checkoutSessionId_fkey" FOREIGN KEY ("tenantId", "checkoutSessionId") REFERENCES "CheckoutSession"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- One live charge per checkout session: every attempt that is not
-- definitively unsuccessful (it may be waiting, charging, held, unknown or
-- succeeded).
CREATE UNIQUE INDEX "PaymentAttempt_live_per_checkout_session"
  ON "PaymentAttempt"("tenantId", "checkoutSessionId")
  WHERE "checkoutSessionId" IS NOT NULL AND "status" NOT IN ('DECLINED', 'FAILED');

-- ABANDONED joins the payment states (never sent to the provider; closed).
ALTER TABLE "PaymentAttempt" DROP CONSTRAINT "PaymentAttempt_paymentState_check";
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentState_check"
  CHECK ("paymentState" IS NULL OR "paymentState" IN
    ('NOT_SENT', 'CHARGING', 'AWAITING_CONFIRMATION', 'UNKNOWN', 'SUCCEEDED', 'DECLINED', 'FAILED', 'ABANDONED'));
-- An abandoned attempt is definitively closed: status FAILED.
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_abandoned_check"
  CHECK ("paymentState" IS DISTINCT FROM 'ABANDONED' OR "status" = 'FAILED');
