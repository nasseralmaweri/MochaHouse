-- SC4f-1 rollback for migration 20261110090000_storefront_hosts.
--
-- NOT a Prisma migration and never run automatically. Ship it as a NEW forward
-- migration so every environment's history stays linear, and only together
-- with an API build without SC4f-1 (or with STOREFRONT_HOST_ROUTING_ENABLED
-- off and the registry unused). Since SC4f-3a, roll back
-- 20261112090000_storefront_publishing first: its address history references
-- this table, so this rollback fails (changing nothing) while it exists.
--
-- It REFUSES to run while any approved storefront hostname exists: the
-- registry is the record of which business an address belongs to, and
-- discarding it is not a rollback's decision. Nothing is changed when it
-- refuses. One DO block, so it applies atomically.

DO $storefront_hosts_rollback$
DECLARE
  remaining bigint;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE "StorefrontHost" IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) FROM "StorefrontHost" INTO remaining;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'SC4f-1 rollback refused: % approved storefront hostname(s) exist. Nothing was changed.', remaining;
  END IF;

  DROP TABLE "StorefrontHost";
  DROP FUNCTION "guard_storefront_host"();
END
$storefront_hosts_rollback$;
