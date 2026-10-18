import { legacyBrand } from './legacy-brand';
import {
  LEGACY_POINTS_LABEL,
  normalizePointsLabel,
  resolvePointsLabel,
} from '../loyalty/application/loyalty-points-label';

// SC4f-3b — which business keeps the original presentation, and the
// loyalty points name rules, in isolation.
describe('legacyBrand', () => {
  const MOCHA = '01a0db02-f800-7000-8000-000000000001';
  const OTHER = '01a0db02-f800-7000-8000-7e5700000b0b';

  it('is the configured business, whatever the routing mode', () => {
    for (const hostRouting of [true, false]) {
      const brand = legacyBrand({
        configuredTenantId: OTHER,
        hostRouting,
        singleTenantId: MOCHA,
      });
      expect(brand.isLegacy(OTHER)).toBe(true);
      expect(brand.isLegacy(MOCHA)).toBe(false);
    }
  });

  it('without configuration, is the single business only while host routing is off', () => {
    expect(
      legacyBrand({
        configuredTenantId: undefined,
        hostRouting: false,
        singleTenantId: MOCHA,
      }).isLegacy(MOCHA),
    ).toBe(true);
    const routed = legacyBrand({
      configuredTenantId: undefined,
      hostRouting: true,
      singleTenantId: MOCHA,
    });
    expect(routed.isLegacy(MOCHA)).toBe(false);
    expect(routed.isLegacy(OTHER)).toBe(false);
  });

  it('refuses a malformed setting rather than guessing', () => {
    for (const configuredTenantId of [
      'mocha-house',
      MOCHA.toUpperCase(),
      ` ${OTHER}x`,
    ]) {
      expect(() =>
        legacyBrand({
          configuredTenantId,
          hostRouting: true,
          singleTenantId: MOCHA,
        }),
      ).toThrow('LEGACY_STOREFRONT_TENANT_ID');
    }
    // Surrounding whitespace is trimmed, as storefrontPublishingConfig does.
    expect(
      legacyBrand({
        configuredTenantId: ` ${OTHER} `,
        hostRouting: true,
        singleTenantId: MOCHA,
      }).isLegacy(OTHER),
    ).toBe(true);
  });
});

describe('loyalty points name', () => {
  it('uses the business’s own name, else the legacy name, else "Points"', () => {
    expect(resolvePointsLabel('Stars', true)).toBe('Stars');
    expect(resolvePointsLabel(null, true)).toBe(LEGACY_POINTS_LABEL);
    expect(resolvePointsLabel(null, false)).toBe('Points');
  });

  it('normalizes and bounds a submitted name; blank restores the default', () => {
    expect(normalizePointsLabel('  Gold   Stars ')).toBe('Gold Stars');
    expect(normalizePointsLabel("Chef's Coins")).toBe("Chef's Coins");
    expect(normalizePointsLabel('Café Points')).toBe('Café Points');
    expect(normalizePointsLabel('   ')).toBeNull();
    expect(normalizePointsLabel(null)).toBeNull();
    for (const bad of ['x'.repeat(33), '<script>', 'a;b', '-dash', 7, {}]) {
      expect(() => normalizePointsLabel(bad)).toThrow();
    }
  });
});
