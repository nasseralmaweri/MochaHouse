-- SC4f-1 — the approved storefront hostname registry (owner decisions F1, F2,
-- F4, F8). Each row is an exact, normalized hostname a storefront may be
-- served at and the ONE business it belongs to:
--   * unique hostname (one owner per address), checked to be a normalized DNS
--     name (lower case, no port, labels of 1–63 characters) or "localhost"
--     for local development; never an IP address;
--   * published / unpublished: only a published hostname resolves;
--   * the owning business and the hostname itself never change, and a row is
--     never deleted (unpublish instead) — database guard;
--   * platform data (no tenantId; it references the business like
--     TenantSubscription does). Managed only by platform operators — the
--     audited publishing controls arrive with SC4f-3.
--
-- ADDITIVE ONLY: one table, its checks and guard. No existing row changes;
-- with the routing switch (STOREFRONT_HOST_ROUTING_ENABLED) off — the
-- default — nothing reads it.
--
-- Rollback (never automatic):
-- prisma/rollbacks/20261110090000_storefront_hosts.down.sql.

CREATE TABLE "StorefrontHost" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "storefrontTenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontHost_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorefrontHost_shape_check" CHECK (
      "kind" IN ('PLATFORM_SUBDOMAIN', 'LEGACY', 'CUSTOM')
      AND "published" = ("publishedAt" IS NOT NULL)
      AND (
        "hostname" = 'localhost'
        OR (
          length("hostname") <= 253
          AND "hostname" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
          AND "hostname" !~ '^[0-9.]+$'
        )
      )
    )
);

CREATE UNIQUE INDEX "StorefrontHost_hostname_key" ON "StorefrontHost"("hostname");
CREATE INDEX "StorefrontHost_storefrontTenantId_idx" ON "StorefrontHost"("storefrontTenantId");

ALTER TABLE "StorefrontHost" ADD CONSTRAINT "StorefrontHost_storefrontTenantId_fkey" FOREIGN KEY ("storefrontTenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An approved address keeps its hostname, owner and kind forever; it is
-- never removed (an address that once served a business must never silently
-- start serving another). Only publishing state may change.
CREATE FUNCTION "guard_storefront_host"() RETURNS trigger
LANGUAGE plpgsql AS $guard_storefront_host$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'An approved storefront hostname is never removed; unpublish it instead.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id"
     OR NEW."hostname" <> OLD."hostname"
     OR NEW."storefrontTenantId" <> OLD."storefrontTenantId"
     OR NEW."kind" <> OLD."kind"
     OR NEW."createdAt" <> OLD."createdAt"
  THEN
    RAISE EXCEPTION 'An approved storefront hostname never changes its address, business or kind.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$guard_storefront_host$;

CREATE TRIGGER "StorefrontHost_guard"
  BEFORE UPDATE OR DELETE ON "StorefrontHost"
  FOR EACH ROW EXECUTE FUNCTION "guard_storefront_host"();
CREATE TRIGGER "StorefrontHost_no_truncate"
  BEFORE TRUNCATE ON "StorefrontHost"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_storefront_host"();
