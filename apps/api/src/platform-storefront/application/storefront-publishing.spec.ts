import {
  StorefrontPublishingConfigError,
  storefrontPublishingConfig,
} from './storefront-publishing-config';
import {
  parseStorefrontAssign,
  parseStorefrontChange,
} from './storefront-publishing-query';

// SC4f-3a — the trusted configuration and the exact request shapes, in
// isolation (the integration spec drives them through real requests).
describe('storefrontPublishingConfig', () => {
  it('is empty by default', () => {
    expect(storefrontPublishingConfig({})).toEqual({
      storefrontDomain: null,
      legacyHostnames: [],
      legacyTenantId: null,
    });
  });

  it('reads a normalized domain and a de-duplicated, sorted legacy list', () => {
    expect(
      storefrontPublishingConfig({
        STOREFRONT_DOMAIN: 'shops.centerivo.test',
        LEGACY_STOREFRONT_HOSTNAMES:
          ' www.mochahouse.test , order.mochahouse.test,www.mochahouse.test,',
        LEGACY_STOREFRONT_TENANT_ID: '01a0db02-f800-7000-8000-000000000001',
      }),
    ).toEqual({
      storefrontDomain: 'shops.centerivo.test',
      legacyHostnames: ['order.mochahouse.test', 'www.mochahouse.test'],
      legacyTenantId: '01a0db02-f800-7000-8000-000000000001',
    });
  });

  it('accepts the legacy business id on its own (it also names the legacy presentation)', () => {
    expect(
      storefrontPublishingConfig({
        LEGACY_STOREFRONT_TENANT_ID: '01a0db02-f800-7000-8000-000000000001',
      }),
    ).toEqual({
      storefrontDomain: null,
      legacyHostnames: [],
      legacyTenantId: '01a0db02-f800-7000-8000-000000000001',
    });
  });

  it('refuses to start with a malformed value rather than accept an unapproved address', () => {
    for (const env of [
      { STOREFRONT_DOMAIN: 'Shops.Centerivo.Test' },
      { STOREFRONT_DOMAIN: 'shops.centerivo.test:443' },
      { STOREFRONT_DOMAIN: 'localhost' },
      { STOREFRONT_DOMAIN: '10.0.0.1' },
      { LEGACY_STOREFRONT_HOSTNAMES: 'order.mochahouse.test,https://x.test' },
      { LEGACY_STOREFRONT_HOSTNAMES: 'Order.MochaHouse.test' },
      // Legacy addresses need the business they belong to, by canonical id;
      // and that id alone means nothing.
      { LEGACY_STOREFRONT_HOSTNAMES: 'order.mochahouse.test' },
      {
        LEGACY_STOREFRONT_HOSTNAMES: 'order.mochahouse.test',
        LEGACY_STOREFRONT_TENANT_ID: 'mocha-house',
      },
      {
        LEGACY_STOREFRONT_HOSTNAMES: 'order.mochahouse.test',
        LEGACY_STOREFRONT_TENANT_ID: '01A0DB02-F800-7000-8000-000000000001',
      },
      // On its own the setting must still be a canonical id.
      { LEGACY_STOREFRONT_TENANT_ID: 'mocha-house' },
      // A Mocha House address inside (or above) the platform domain.
      {
        STOREFRONT_DOMAIN: 'mochahouse.test',
        LEGACY_STOREFRONT_HOSTNAMES: 'order.mochahouse.test',
      },
      {
        STOREFRONT_DOMAIN: 'shops.centerivo.test',
        LEGACY_STOREFRONT_HOSTNAMES: 'cafe.shops.centerivo.test',
      },
      {
        STOREFRONT_DOMAIN: 'shops.mochahouse.test',
        LEGACY_STOREFRONT_HOSTNAMES: 'mochahouse.test',
      },
    ]) {
      expect(() => storefrontPublishingConfig(env)).toThrow(
        StorefrontPublishingConfigError,
      );
    }
  });
});

describe('storefront publishing request shapes', () => {
  const reason = 'Approved storefront launch';

  it('accepts exactly { reason, confirmSlug } for publish / unpublish', () => {
    expect(
      parseStorefrontChange({ reason: `  ${reason}  `, confirmSlug: 'cafe' }),
    ).toEqual({
      reason,
      confirmSlug: 'cafe',
    });
    for (const body of [
      null,
      [],
      { reason },
      { confirmSlug: 'cafe' },
      { reason: 'short', confirmSlug: 'cafe' },
      { reason: `bad\u0007reason text`, confirmSlug: 'cafe' },
      { reason, confirmSlug: '' },
      { reason, confirmSlug: 'cafe', tenantId: 'x' },
    ]) {
      expect(() => parseStorefrontChange(body)).toThrow();
    }
  });

  it('derives platform addresses and takes a hostname only for an existing address', () => {
    expect(
      parseStorefrontAssign({
        kind: 'PLATFORM_SUBDOMAIN',
        reason,
        confirmSlug: 'cafe',
      }),
    ).toEqual({
      kind: 'PLATFORM_SUBDOMAIN',
      hostname: null,
      reason,
      confirmSlug: 'cafe',
    });
    expect(
      parseStorefrontAssign({
        kind: 'LEGACY',
        hostname: ' order.mochahouse.test ',
        reason,
        confirmSlug: 'mocha-house',
      }),
    ).toMatchObject({ kind: 'LEGACY', hostname: 'order.mochahouse.test' });
    for (const body of [
      {
        kind: 'PLATFORM_SUBDOMAIN',
        hostname: 'evil.test',
        reason,
        confirmSlug: 'cafe',
      },
      { kind: 'LEGACY', reason, confirmSlug: 'cafe' },
      { kind: 'CUSTOM', hostname: 'shop.test', reason, confirmSlug: 'cafe' },
      {
        kind: 'PLATFORM_SUBDOMAIN',
        reason,
        confirmSlug: 'cafe',
        storefrontTenantId: 'x',
      },
    ]) {
      expect(() => parseStorefrontAssign(body)).toThrow();
    }
  });
});
