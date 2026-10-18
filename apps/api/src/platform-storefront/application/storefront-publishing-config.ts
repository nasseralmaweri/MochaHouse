import { normalizeStorefrontHost } from '@mocha-house/contracts';

// SC4f-3a — the TRUSTED configuration storefront publishing relies on. Read
// once at startup; a malformed value refuses to start (fail closed) rather
// than letting an operator assign an address nobody approved.
//
//   STOREFRONT_DOMAIN            the platform storefront domain: a business's
//                                platform address is "{slug}.{domain}".
//                                Unset: platform addresses cannot be assigned.
//   LEGACY_STOREFRONT_HOSTNAMES  comma-separated existing Mocha House
//                                addresses approved for registration against
//                                Mocha House (and only Mocha House). Never
//                                taken from a request's Host header.
//   LEGACY_STOREFRONT_TENANT_ID  the business those addresses belong to
//                                (Mocha House's tenant id). Required when
//                                any legacy address is listed; there is no
//                                default business in application code.
//
// Neither setting changes DNS, TLS or routing; they only bound what the
// Platform Console may record.

export const STOREFRONT_DOMAIN_ENV = 'STOREFRONT_DOMAIN';
export const LEGACY_STOREFRONT_HOSTNAMES_ENV = 'LEGACY_STOREFRONT_HOSTNAMES';
export const LEGACY_STOREFRONT_TENANT_ID_ENV = 'LEGACY_STOREFRONT_TENANT_ID';
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface StorefrontPublishingConfig {
  storefrontDomain: string | null;
  legacyHostnames: readonly string[];
  // The one business legacy addresses may be registered for; null exactly
  // when no legacy address is listed.
  legacyTenantId: string | null;
}

export const STOREFRONT_PUBLISHING_CONFIG = Symbol(
  'STOREFRONT_PUBLISHING_CONFIG',
);

export class StorefrontPublishingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorefrontPublishingConfigError';
  }
}

export function storefrontPublishingConfig(
  env: Record<string, string | undefined> = process.env,
): StorefrontPublishingConfig {
  const rawDomain = (env[STOREFRONT_DOMAIN_ENV] ?? '').trim();
  let storefrontDomain: string | null = null;
  if (rawDomain !== '') {
    const domain = normalizeStorefrontHost(rawDomain);
    if (!domain || domain === 'localhost' || domain !== rawDomain) {
      throw new StorefrontPublishingConfigError(
        `${STOREFRONT_DOMAIN_ENV} must be a lower-case DNS name without a port (for example shops.example.com).`,
      );
    }
    storefrontDomain = domain;
  }

  const legacy = new Set<string>();
  for (const entry of (env[LEGACY_STOREFRONT_HOSTNAMES_ENV] ?? '').split(',')) {
    const raw = entry.trim();
    if (raw === '') continue;
    const hostname = normalizeStorefrontHost(raw);
    if (!hostname || hostname !== raw) {
      throw new StorefrontPublishingConfigError(
        `${LEGACY_STOREFRONT_HOSTNAMES_ENV} must list lower-case DNS names without ports, separated by commas.`,
      );
    }
    legacy.add(hostname);
  }
  // A Mocha House address may never fall inside the platform storefront
  // domain: otherwise another business's platform address could sit next
  // to (or be) one of Mocha House's addresses.
  if (storefrontDomain) {
    for (const hostname of legacy) {
      if (
        hostname === storefrontDomain ||
        hostname.endsWith(`.${storefrontDomain}`) ||
        storefrontDomain.endsWith(`.${hostname}`)
      ) {
        throw new StorefrontPublishingConfigError(
          `${LEGACY_STOREFRONT_HOSTNAMES_ENV} must not overlap ${STOREFRONT_DOMAIN_ENV}: use a dedicated platform storefront domain.`,
        );
      }
    }
  }
  const rawTenant = (env[LEGACY_STOREFRONT_TENANT_ID_ENV] ?? '').trim();
  let legacyTenantId: string | null = null;
  if (legacy.size > 0) {
    if (!CANONICAL_UUID.test(rawTenant)) {
      throw new StorefrontPublishingConfigError(
        `${LEGACY_STOREFRONT_HOSTNAMES_ENV} needs ${LEGACY_STOREFRONT_TENANT_ID_ENV}: the canonical id of the business those addresses belong to.`,
      );
    }
    legacyTenantId = rawTenant;
  } else if (rawTenant !== '') {
    throw new StorefrontPublishingConfigError(
      `${LEGACY_STOREFRONT_TENANT_ID_ENV} is set but no ${LEGACY_STOREFRONT_HOSTNAMES_ENV} are listed.`,
    );
  }
  return {
    storefrontDomain,
    legacyHostnames: [...legacy].sort(),
    legacyTenantId,
  };
}
