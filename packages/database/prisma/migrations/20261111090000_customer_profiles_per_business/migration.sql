-- SC4f-2 — one CENTERIVO customer login, one profile per business (owner
-- decisions G1, G6, G7).
--
-- Replaces the platform-wide uniqueness of a customer login
-- ("externalProvider", "externalSubject") with uniqueness WITHIN a business
-- ("tenantId", "externalProvider", "externalSubject"). Each business keeps
-- its own Customer profile — and through it its own orders, loyalty, gift
-- cards, preferences, consent and account status, all already tied to the
-- profile's business by composite foreign keys (Security 4C-3).
--
-- No row is read into, changed or deleted: every existing (provider,
-- subject) pair is unique platform-wide, so it is unique per business too,
-- and every existing Customer keeps its id, business and login. No foreign
-- key references either index.
--
-- Atomic: ONE DO block (Prisma sends a dollar-quoted file as one
-- statement) — the new index is created BEFORE the old one is dropped, and
-- on any error neither change remains. lock_timeout (5s, this transaction
-- only) fails it fast instead of queueing customer writes; the SHARE /
-- ACCESS EXCLUSIVE locks are held only for the duration of the block.
--
-- If it fails: nothing changed. Remove the cause, run `prisma migrate
-- resolve --rolled-back 20261111090000_customer_profiles_per_business`,
-- then deploy again.
-- Rollback (never automatic):
-- prisma/rollbacks/20261111090000_customer_profiles_per_business.down.sql.

DO $customer_profiles_per_business$
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE UNIQUE INDEX "Customer_tenantId_externalProvider_externalSubject_key"
    ON "Customer"("tenantId", "externalProvider", "externalSubject");
  DROP INDEX "Customer_externalProvider_externalSubject_key";
END
$customer_profiles_per_business$;
