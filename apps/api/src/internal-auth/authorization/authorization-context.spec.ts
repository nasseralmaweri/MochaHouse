import { ForbiddenException } from '@nestjs/common';
import { AuthorizationContext } from './authorization-context';

describe('AuthorizationContext', () => {
  it('empty context grants nothing', () => {
    const ctx = AuthorizationContext.empty();
    expect(ctx.has('orders.view')).toBe(false);
    expect(ctx.authorizedLocations('orders.view')).toEqual({ kind: 'none' });
    expect(ctx.canActOnLocation('orders.view', 'loc-1')).toBe(false);
  });

  it('CORPORATE grant authorizes any location', () => {
    const ctx = AuthorizationContext.of({
      'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
    });
    expect(ctx.has('orders.view')).toBe(true);
    expect(ctx.authorizedLocations('orders.view')).toEqual({ kind: 'all' });
    expect(ctx.canActOnLocation('orders.view', 'anything')).toBe(true);
  });

  it('LOCATION grants authorize only the named locations', () => {
    const ctx = AuthorizationContext.of({
      'orders.view': [
        { scopeType: 'LOCATION', scopeId: 'loc-1' },
        { scopeType: 'LOCATION', scopeId: 'loc-2' },
      ],
    });
    const authorized = ctx.authorizedLocations('orders.view');
    expect(authorized.kind).toBe('locations');
    if (authorized.kind === 'locations') {
      expect([...authorized.locationIds].sort()).toEqual(['loc-1', 'loc-2']);
    }
    expect(ctx.canActOnLocation('orders.view', 'loc-1')).toBe(true);
    expect(ctx.canActOnLocation('orders.view', 'loc-3')).toBe(false);
  });

  it('CORPORATE + LOCATION grants for the same key resolve to all', () => {
    const ctx = AuthorizationContext.of({
      'orders.view': [
        { scopeType: 'LOCATION', scopeId: 'loc-1' },
        { scopeType: 'CORPORATE', scopeId: null },
      ],
    });
    expect(ctx.authorizedLocations('orders.view')).toEqual({ kind: 'all' });
  });

  it('a CORPORATE-only permission held only via LOCATION scope is NOT granted', () => {
    const ctx = AuthorizationContext.of({
      'catalog.products.edit': [{ scopeType: 'LOCATION', scopeId: 'loc-1' }],
    });
    expect(ctx.has('catalog.products.edit')).toBe(false);
    expect(ctx.authorizedLocations('catalog.products.edit')).toEqual({
      kind: 'none',
    });
    expect(() => ctx.assertCorporate('catalog.products.edit')).toThrow(
      ForbiddenException,
    );
  });

  it('a CORPORATE-only permission held via CORPORATE scope is granted', () => {
    const ctx = AuthorizationContext.of({
      'catalog.products.edit': [{ scopeType: 'CORPORATE', scopeId: null }],
    });
    expect(ctx.has('catalog.products.edit')).toBe(true);
    expect(() => ctx.assertCorporate('catalog.products.edit')).not.toThrow();
  });

  it('assertCanActOnLocation throws for an unauthorized location, passes for an authorized one', () => {
    const ctx = AuthorizationContext.of({
      'catalog.overrides.manage': [{ scopeType: 'LOCATION', scopeId: 'loc-1' }],
    });
    expect(() =>
      ctx.assertCanActOnLocation('catalog.overrides.manage', 'loc-1'),
    ).not.toThrow();
    expect(() =>
      ctx.assertCanActOnLocation('catalog.overrides.manage', 'loc-2'),
    ).toThrow(ForbiddenException);
  });

  it('a LOCATION grant with a null scopeId contributes nothing', () => {
    const ctx = AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: null }],
    });
    expect(ctx.has('orders.view')).toBe(false);
    expect(ctx.authorizedLocations('orders.view')).toEqual({ kind: 'none' });
  });

  describe('summarize() (Milestone 5C shell projection)', () => {
    it('empty context', () => {
      expect(AuthorizationContext.empty().summarize()).toEqual({
        permissions: [],
        isCorporate: false,
        locationIds: [],
        capabilities: {},
      });
    });

    it('keeps each permission scope distinct — no cross-inference', () => {
      const ctx = AuthorizationContext.of({
        'orders.view': [
          { scopeType: 'LOCATION', scopeId: 'loc-b' },
          { scopeType: 'LOCATION', scopeId: 'loc-a' },
        ],
        'locations.manage_digital_ordering': [
          { scopeType: 'LOCATION', scopeId: 'loc-a' },
        ],
      });
      const summary = ctx.summarize();

      expect(summary.permissions).toEqual([
        'locations.manage_digital_ordering',
        'orders.view',
      ]);
      // union across all grants, for the general selector
      expect(summary.locationIds).toEqual(['loc-a', 'loc-b']);
      // per-permission scope stays separate
      expect(summary.capabilities).toEqual({
        'orders.view': { corporate: false, locationIds: ['loc-a', 'loc-b'] },
        'locations.manage_digital_ordering': {
          corporate: false,
          locationIds: ['loc-a'],
        },
      });
      expect(summary.isCorporate).toBe(false);
    });

    it('CORPORATE grant => corporate:true for that permission (and isCorporate:true overall)', () => {
      const ctx = AuthorizationContext.of({
        'orders.view': [{ scopeType: 'LOCATION', scopeId: 'loc-a' }],
        'catalog.products.edit': [{ scopeType: 'CORPORATE', scopeId: null }],
      });
      const summary = ctx.summarize();
      expect(summary.isCorporate).toBe(true);
      expect(summary.capabilities['orders.view']).toEqual({
        corporate: false,
        locationIds: ['loc-a'],
      });
      expect(summary.capabilities['catalog.products.edit']).toEqual({
        corporate: true,
        locationIds: [],
      });
    });

    it('a CORPORATE-only permission held only via LOCATION scope is not summarised as held', () => {
      const ctx = AuthorizationContext.of({
        'catalog.products.edit': [{ scopeType: 'LOCATION', scopeId: 'loc-1' }],
      });
      expect(ctx.summarize()).toEqual({
        permissions: [],
        isCorporate: false,
        locationIds: [],
        capabilities: {},
      });
    });

    it('a LOCATION grant with a null scopeId contributes nothing to a capability', () => {
      const ctx = AuthorizationContext.of({
        'orders.view': [
          { scopeType: 'LOCATION', scopeId: null },
          { scopeType: 'LOCATION', scopeId: 'loc-a' },
        ],
      });
      expect(ctx.summarize().capabilities['orders.view']).toEqual({
        corporate: false,
        locationIds: ['loc-a'],
      });
    });
  });
});
