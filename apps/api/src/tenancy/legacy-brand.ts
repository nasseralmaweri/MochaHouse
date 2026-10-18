import type { Provider } from '@nestjs/common';
import type { SingleTenantResolution } from '@mocha-house/database';
import { SINGLE_TENANT_RESOLUTION } from './single-tenant-resolution.provider';
import {
  STOREFRONT_ROUTING_CONFIG,
  type StorefrontRoutingConfig,
} from './storefront-context';

// SC4f-3b — which business keeps the ORIGINAL storefront presentation (Mocha
// House: its own homepage and franchising copy, its "Mocha Beans" points
// name when it has not chosen one). Never a tenant id written in application
// code — the boundary rule is that there is no default business:
//   * LEGACY_STOREFRONT_TENANT_ID (trusted deployment configuration, the same
//     setting SC4f-3a registers Mocha House's existing addresses against)
//     names it explicitly;
//   * without it, ONLY while host routing is off, the deployment's single
//     business keeps the presentation it has today — exactly the legacy
//     behaviour. With host routing on and no setting, no business does.

export const LEGACY_STOREFRONT_TENANT_ID_ENV = 'LEGACY_STOREFRONT_TENANT_ID';
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LegacyBrand {
  isLegacy(tenantId: string): boolean;
}

export const LEGACY_BRAND = Symbol('LEGACY_BRAND');

export function legacyBrand(input: {
  configuredTenantId: string | undefined;
  hostRouting: boolean;
  singleTenantId: string;
}): LegacyBrand {
  const configured = (input.configuredTenantId ?? '').trim();
  // A malformed setting stops startup rather than silently dropping the
  // legacy presentation (the same rule storefrontPublishingConfig applies).
  if (configured !== '' && !CANONICAL_UUID.test(configured)) {
    throw new Error(
      `${LEGACY_STOREFRONT_TENANT_ID_ENV} must be a canonical business id.`,
    );
  }
  const explicit = configured === '' ? null : configured;
  return {
    isLegacy: (tenantId) =>
      explicit !== null
        ? tenantId === explicit
        : !input.hostRouting && tenantId === input.singleTenantId,
  };
}

export const legacyBrandProvider: Provider = {
  provide: LEGACY_BRAND,
  inject: [STOREFRONT_ROUTING_CONFIG, SINGLE_TENANT_RESOLUTION],
  useFactory: (
    routing: StorefrontRoutingConfig,
    single: SingleTenantResolution,
  ): LegacyBrand =>
    legacyBrand({
      configuredTenantId: process.env[LEGACY_STOREFRONT_TENANT_ID_ENV],
      hostRouting: routing.hostRouting,
      singleTenantId: single.tenantId,
    }),
};
