import {
  INTERNAL_PERMISSION_KEYS,
  INTERNAL_PERMISSION_METADATA,
  allowedScopeTypesFor,
  isKnownPermissionKey,
} from './permission-catalog';

describe('internal permission catalog', () => {
  it('is exactly the approved vocabulary — nothing more', () => {
    expect([...INTERNAL_PERMISSION_KEYS].sort()).toEqual(
      [
        'catalog.menu.manage',
        'catalog.overrides.manage',
        'catalog.products.edit',
        // Milestone 5D-3
        'catalog.view',
        // Milestone 5D-1
        'locations.view',
        'locations.edit',
        'locations.manage_digital_ordering',
        'orders.manage_status',
        'orders.view',
        // Milestone 5E-1
        'users.view',
        // Milestone 5E-2
        'roles.view',
      ].sort(),
    );
  });

  it('every key has metadata and every metadata entry is a key', () => {
    for (const key of INTERNAL_PERMISSION_KEYS) {
      expect(INTERNAL_PERMISSION_METADATA[key]?.key).toBe(key);
      expect(
        INTERNAL_PERMISSION_METADATA[key].description.length,
      ).toBeGreaterThan(0);
    }
    expect(Object.keys(INTERNAL_PERMISSION_METADATA).sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
  });

  it('master / global catalog permissions are CORPORATE-only', () => {
    expect(allowedScopeTypesFor('catalog.products.edit')).toEqual([
      'CORPORATE',
    ]);
    expect(allowedScopeTypesFor('catalog.menu.manage')).toEqual(['CORPORATE']);
    // catalog.view — the master catalog is shared, so viewing it in Admin
    // is a corporate capability (Milestone 5D-3).
    expect(allowedScopeTypesFor('catalog.view')).toEqual(['CORPORATE']);
    // locations.edit is a corporate-scoped operation (Milestone 5D-2).
    expect(allowedScopeTypesFor('locations.edit')).toEqual(['CORPORATE']);
    // users.view — user administration is corporate (Milestone 5E-1).
    expect(allowedScopeTypesFor('users.view')).toEqual(['CORPORATE']);
    // roles.view — access-level administration is corporate (Milestone 5E-2).
    expect(allowedScopeTypesFor('roles.view')).toEqual(['CORPORATE']);
  });

  it('location-capable permissions accept CORPORATE and LOCATION scope', () => {
    for (const key of [
      'orders.view',
      'orders.manage_status',
      'catalog.overrides.manage',
      'locations.view',
      'locations.manage_digital_ordering',
    ] as const) {
      expect([...allowedScopeTypesFor(key)].sort()).toEqual([
        'CORPORATE',
        'LOCATION',
      ]);
    }
  });

  it('isKnownPermissionKey only accepts vocabulary keys', () => {
    expect(isKnownPermissionKey('orders.view')).toBe(true);
    expect(isKnownPermissionKey('orders.delete')).toBe(false);
    expect(isKnownPermissionKey('*')).toBe(false);
    expect(isKnownPermissionKey('')).toBe(false);
  });
});
