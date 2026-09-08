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
        // Milestone 5E-3
        'users.manage_status',
        // Milestone 5E-4
        'users.manage_roles',
        // Milestone 5F
        'audit.view',
        // Milestone 5G
        'platform.view',
        // Milestone 6A
        'operations.view',
        // Milestone 6B
        'operations.tasks.complete',
        // Milestone 6B-2
        'operations.checklists.configure',
        // Milestone 6C
        'operations.exceptions.manage',
        // Milestone 7A
        'loyalty.view',
        'loyalty.adjust',
        // Milestone 7B
        'loyalty.configure',
        // Milestone 7E
        'promotions.configure',
        // Milestone 7F
        'giftcards.view',
        'giftcards.manage',
        'giftcards.configure',
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
    // users.manage_status — a highly privileged corporate write (5E-3).
    expect(allowedScopeTypesFor('users.manage_status')).toEqual(['CORPORATE']);
    // users.manage_roles — access assignment is a corporate write (5E-4).
    expect(allowedScopeTypesFor('users.manage_roles')).toEqual(['CORPORATE']);
    // audit.view — the activity log is a corporate read (5F).
    expect(allowedScopeTypesFor('audit.view')).toEqual(['CORPORATE']);
    // platform.view — platform status is a corporate read (5G).
    expect(allowedScopeTypesFor('platform.view')).toEqual(['CORPORATE']);
    // operations.checklists.configure — one corporate checklist standard,
    // no per-location override (Milestone 6B-2).
    expect(allowedScopeTypesFor('operations.checklists.configure')).toEqual([
      'CORPORATE',
    ]);
    // loyalty.* — a Mocha Bean balance is a single company-wide figure per
    // customer, and manual adjustment is a highly sensitive HQ action
    // (Milestone 7A).
    expect(allowedScopeTypesFor('loyalty.view')).toEqual(['CORPORATE']);
    expect(allowedScopeTypesFor('loyalty.adjust')).toEqual(['CORPORATE']);
    // loyalty.configure — the earning rate and Rewards Catalog are
    // company-wide HQ configuration (Milestone 7B).
    expect(allowedScopeTypesFor('loyalty.configure')).toEqual(['CORPORATE']);
    // promotions.configure — Promotions & Coupons are company-wide pricing
    // configuration (Milestone 7E).
    expect(allowedScopeTypesFor('promotions.configure')).toEqual(['CORPORATE']);
    // giftcards.* — a gift card is company-wide stored value; issuance,
    // correction and purchasing configuration are all HQ (Milestone 7F).
    expect(allowedScopeTypesFor('giftcards.view')).toEqual(['CORPORATE']);
    expect(allowedScopeTypesFor('giftcards.manage')).toEqual(['CORPORATE']);
    expect(allowedScopeTypesFor('giftcards.configure')).toEqual(['CORPORATE']);
  });

  it('location-capable permissions accept CORPORATE and LOCATION scope', () => {
    for (const key of [
      'orders.view',
      'orders.manage_status',
      'catalog.overrides.manage',
      'locations.view',
      'locations.manage_digital_ordering',
      // Milestone 6A — a store manager holds operations.view per location.
      'operations.view',
      // Milestone 6B — completing checklist items is held per location too.
      'operations.tasks.complete',
      // Milestone 6C — logging a checklist management exception, per location.
      'operations.exceptions.manage',
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
