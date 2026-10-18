-- SC4f-2 rollback for migration 20261111090000_customer_profiles_per_business.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW
-- forward migration so every environment's history stays linear, and only
-- together with an API build without SC4f-2.
--
-- It REFUSES to run while any customer login holds a profile in more than
-- one business: restoring platform-wide uniqueness would require deleting
-- or merging profiles, and discarding a business's customer records is not
-- a rollback's decision. Nothing is changed when it refuses. One DO block,
-- so it applies atomically; the table is locked against writes while it
-- checks, so no second profile can appear in between.

DO $customer_profiles_per_business_rollback$
DECLARE
  shared bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "Customer" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FROM (
    SELECT 1 FROM "Customer"
    GROUP BY "externalProvider", "externalSubject"
    HAVING count(*) > 1
  ) logins INTO shared;
  IF shared > 0 THEN
    RAISE EXCEPTION 'SC4f-2 rollback refused: % customer login(s) hold profiles in more than one business. Nothing was changed.', shared;
  END IF;

  CREATE UNIQUE INDEX "Customer_externalProvider_externalSubject_key"
    ON "Customer"("externalProvider", "externalSubject");
  DROP INDEX "Customer_tenantId_externalProvider_externalSubject_key";
END
$customer_profiles_per_business_rollback$;
