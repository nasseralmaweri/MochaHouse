-- ESP-04 M1 rollback for migration 20261120090000_restaurant_payment_accounts.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API and web build without ESP-04 M1.
--
-- It REFUSES to run while any restaurant payment account or Connect event is
-- recorded: a connected account names a restaurant's real Stripe account and
-- must never be forgotten silently (an explicit, separately approved
-- archival step must come first). Nothing is changed when it refuses. One DO
-- block, so it applies atomically. The payments.connect grants are removed
-- from the built-in administrator roles.

DO $restaurant_payment_accounts_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  IF to_regclass('"TenantPaymentAccount"') IS NULL THEN
    RAISE EXCEPTION 'Restaurant payment accounts rollback refused: table "TenantPaymentAccount" does not exist. Nothing was changed.';
  END IF;
  LOCK TABLE "TenantPaymentAccount", "RestaurantPaymentProviderEvent" IN ACCESS EXCLUSIVE MODE;
  SELECT (SELECT count(*) FROM "TenantPaymentAccount")
       + (SELECT count(*) FROM "RestaurantPaymentProviderEvent")
    INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Restaurant payment accounts rollback refused: % payment account or Connect event record(s) exist. Nothing was changed.', remaining;
  END IF;

  DELETE FROM "InternalRolePermission" WHERE "permissionKey" = 'payments.connect';
  DROP TABLE "RestaurantPaymentProviderEvent";
  DROP TABLE "TenantPaymentAccount";
  DROP FUNCTION "payment_account_guard"();
END
$restaurant_payment_accounts_rollback$;
