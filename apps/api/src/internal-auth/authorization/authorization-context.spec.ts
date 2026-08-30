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
      });
    });

    it('mixed corporate + location grants', () => {
      const ctx = AuthorizationContext.of({
        'orders.view': [
          { scopeType: 'LOCATION', scopeId: 'loc-2' },
          { scopeType: 'LOCATION', scopeId: 'loc-1' },
        ],
        'catalog.products.edit': [{ scopeType: 'CORPORATE', scopeId: null }],
      });
      expect(ctx.summarize()).toEqual({
        permissions: ['catalog.products.edit', 'orders.view'],
        isCorporate: true,
        locationIds: ['loc-1', 'loc-2'],
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
      });
    });
  });
});
