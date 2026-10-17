-- SC4a — business owner self-service registration (owner decisions D1, D4,
-- D6, D8, D9): one registration per email, recording the staff-pool login it
-- created, its verification progress and limits, and — once the owner proved
-- the mailbox — their Terms and Privacy Policy acceptance.
--
-- ADDITIVE: one enum, one table, CHECK constraints and a guard trigger. No
-- existing table changes. It creates no business, staff member or role.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261106090000_owner_registration.down.sql.

CREATE TYPE "OwnerRegistrationStatus" AS ENUM ('PENDING_VERIFICATION', 'PASSWORD_SETUP', 'VERIFIED');

CREATE TABLE "OwnerRegistration" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" "OwnerRegistrationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "identityProvider" TEXT NOT NULL,
    "identitySubject" TEXT,
    "initialPasswordNonce" TEXT NOT NULL,
    "codesSent" INTEGER NOT NULL DEFAULT 0,
    "codeWindowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "displayName" TEXT,
    "termsVersion" TEXT,
    "privacyVersion" TEXT,
    "legalAcceptedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerRegistration_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerRegistration_email_key" ON "OwnerRegistration"("email");
CREATE UNIQUE INDEX "OwnerRegistration_identityProvider_identitySubject_key" ON "OwnerRegistration"("identityProvider", "identitySubject");
CREATE INDEX "OwnerRegistration_createdAt_idx" ON "OwnerRegistration"("createdAt");

ALTER TABLE "OwnerRegistration" ADD CONSTRAINT "OwnerRegistration_shape_check"
  CHECK (
    "email" = lower(btrim("email"))
    AND length("email") BETWEEN 3 AND 254
    AND "identityProvider" IN ('cognito-internal', 'internal-dev')
    AND ("identitySubject" IS NULL OR length("identitySubject") BETWEEN 1 AND 255)
    AND length("initialPasswordNonce") BETWEEN 32 AND 128
    AND "codesSent" >= 0
    AND "verificationAttempts" >= 0
    AND ("status" = 'PENDING_VERIFICATION' OR "identitySubject" IS NOT NULL)
    AND ("status" = 'VERIFIED') = ("verifiedAt" IS NOT NULL)
    AND ("status" = 'VERIFIED') = ("legalAcceptedAt" IS NOT NULL)
    AND ("legalAcceptedAt" IS NULL) = ("termsVersion" IS NULL)
    AND ("legalAcceptedAt" IS NULL) = ("privacyVersion" IS NULL)
    AND ("status" <> 'VERIFIED' OR "displayName" IS NOT NULL)
    AND ("displayName" IS NULL OR length("displayName") BETWEEN 1 AND 120)
    AND ("termsVersion" IS NULL OR length("termsVersion") BETWEEN 1 AND 64)
    AND ("privacyVersion" IS NULL OR length("privacyVersion") BETWEEN 1 AND 64)
  );

-- The email and provider never change; a recorded login is never replaced or
-- removed (it is what marks the login as self-registered); a VERIFIED
-- registration is final; a registration with a login is never deleted.
CREATE FUNCTION "guard_owner_registration"() RETURNS trigger
LANGUAGE plpgsql AS $guard_owner_registration$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."identitySubject" IS NOT NULL THEN
      RAISE EXCEPTION 'An owner registration with a login is never removed.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."email" <> OLD."email"
     OR NEW."identityProvider" <> OLD."identityProvider"
     OR NEW."initialPasswordNonce" <> OLD."initialPasswordNonce"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."identitySubject" IS NOT NULL
         AND NEW."identitySubject" IS DISTINCT FROM OLD."identitySubject")
     OR (OLD."status" = 'PASSWORD_SETUP' AND NEW."status" = 'PENDING_VERIFICATION')
     OR (OLD."status" = 'VERIFIED' AND (
           NEW."status" <> 'VERIFIED'
           OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
           OR NEW."legalAcceptedAt" IS DISTINCT FROM OLD."legalAcceptedAt"
           OR NEW."termsVersion" IS DISTINCT FROM OLD."termsVersion"
           OR NEW."privacyVersion" IS DISTINCT FROM OLD."privacyVersion"))
  THEN
    RAISE EXCEPTION 'An owner registration cannot be changed this way.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_owner_registration$;

CREATE TRIGGER "OwnerRegistration_guard"
  BEFORE UPDATE OR DELETE ON "OwnerRegistration"
  FOR EACH ROW EXECUTE FUNCTION "guard_owner_registration"();
