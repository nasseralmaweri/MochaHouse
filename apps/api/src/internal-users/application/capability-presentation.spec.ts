import { INTERNAL_PERMISSION_KEYS } from '@mocha-house/contracts';
import {
  PERMISSIONS_WITH_WORDING,
  describeAccessLevelCapabilities,
  describeEffectiveCapabilities,
} from './capability-presentation';

describe('capability presentation (Milestone 5E)', () => {
  it('every permission in the closed vocabulary has explicit wording', () => {
    // The Record<InternalPermissionKey, …> is exhaustive, so a missing key
    // is a compile error. This runtime check guards the same invariant: add
    // a key to INTERNAL_PERMISSION_KEYS without wording and this fails.
    expect([...PERMISSIONS_WITH_WORDING].sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
    for (const key of INTERNAL_PERMISSION_KEYS) {
      const groups = describeAccessLevelCapabilities(new Set([key]));
      const lines = groups.flatMap((g) => g.items);
      expect(lines).toHaveLength(1);
      expect(lines[0].length).toBeGreaterThan(0);
    }
  });

  describe('describeEffectiveCapabilities — a person', () => {
    it('uses "all locations" wording for a corporate grant', () => {
      expect(
        describeEffectiveCapabilities({ 'orders.view': { corporate: true } }),
      ).toEqual([{ group: 'Orders', items: ['View orders at all locations'] }]);
    });

    it('uses "their locations" wording for a location-scoped grant', () => {
      expect(
        describeEffectiveCapabilities({
          'orders.view': { corporate: false },
          'catalog.overrides.manage': { corporate: false },
        }),
      ).toEqual([
        { group: 'Orders', items: ['View orders at their locations'] },
        {
          group: 'Menu & Products',
          items: ['Set prices and availability for their locations'],
        },
      ]);
    });

    it('returns no groups for an empty capability map', () => {
      expect(describeEffectiveCapabilities({})).toEqual([]);
    });
  });

  describe('describeAccessLevelCapabilities — an access level template', () => {
    it('uses scope-agnostic definition wording', () => {
      expect(
        describeAccessLevelCapabilities(
          new Set(['orders.view', 'catalog.overrides.manage']),
        ),
      ).toEqual([
        { group: 'Orders', items: ['View orders'] },
        {
          group: 'Menu & Products',
          items: ['Set location prices and availability'],
        },
      ]);
    });

    it('orders groups Orders → Menu & Products → Locations → Administration, "view" first within a group', () => {
      const groups = describeAccessLevelCapabilities(
        new Set([...INTERNAL_PERMISSION_KEYS]),
      );
      expect(groups.map((g) => g.group)).toEqual([
        'Orders',
        'Menu & Products',
        'Locations',
        'Administration',
      ]);
      expect(groups.find((g) => g.group === 'Menu & Products')?.items).toEqual([
        'View products and menus',
        'Edit standard product information',
        'Manage which products are shown on menus',
        'Set location prices and availability',
      ]);
      expect(groups.find((g) => g.group === 'Locations')?.items).toEqual([
        'View locations',
        'Edit location information',
        'Turn online ordering on or off',
      ]);
      expect(groups.find((g) => g.group === 'Administration')?.items).toEqual([
        'View Admin users',
        'View access levels',
      ]);
    });

    it('an empty permission set yields no groups', () => {
      expect(describeAccessLevelCapabilities(new Set())).toEqual([]);
    });
  });
});
