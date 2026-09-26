import {
  TENANT_1_MOCHA_HOUSE_ID,
  TenantContextError,
  createTenantContext,
  getCurrentTenantContext,
  isValidTenantId,
  runWithTenantContext,
} from '@mocha-house/database';
import { TEST_TENANT_B_ID } from '@mocha-house/testing';

// Milestone S0C — the TenantContext value object and its async-scoped
// carrier (pure; no database).
describe('TenantContext', () => {
  const valid = {
    tenantId: TENANT_1_MOCHA_HOUSE_ID,
    principalType: 'system' as const,
    requestId: 'req-1',
  };

  describe('isValidTenantId', () => {
    it('accepts canonical lowercase UUIDs', () => {
      expect(isValidTenantId(TENANT_1_MOCHA_HOUSE_ID)).toBe(true);
      expect(isValidTenantId(TEST_TENANT_B_ID)).toBe(true);
    });

    it.each([
      ['uppercase', TENANT_1_MOCHA_HOUSE_ID.toUpperCase()],
      ['padded', ` ${TENANT_1_MOCHA_HOUSE_ID}`],
      ['not a uuid', 'mocha-house'],
      ['empty', ''],
      ['bad version nibble', '01a0db02-f800-0000-8000-000000000001'],
      ['bad variant nibble', '01a0db02-f800-7000-0000-000000000001'],
    ])('rejects %s', (_label, value) => {
      expect(isValidTenantId(value)).toBe(false);
    });

    it('rejects non-strings', () => {
      expect(isValidTenantId(undefined)).toBe(false);
      expect(isValidTenantId(null)).toBe(false);
      expect(isValidTenantId(42)).toBe(false);
    });
  });

  describe('createTenantContext', () => {
    it('returns a frozen context carrying exactly tenantId, principalType and requestId', () => {
      const context = createTenantContext(valid);
      expect(context).toEqual(valid);
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as { tenantId: string }).tenantId = TEST_TENANT_B_ID;
      }).toThrow(TypeError);
    });

    it('supports every approved principal type', () => {
      for (const principalType of [
        'member',
        'support',
        'customer',
        'anonymous',
        'worker',
        'system',
      ] as const) {
        expect(
          createTenantContext({ ...valid, principalType }).principalType,
        ).toBe(principalType);
      }
    });

    it('fails closed on a malformed tenant id', () => {
      expect(() =>
        createTenantContext({ ...valid, tenantId: 'not-a-tenant' }),
      ).toThrow(TenantContextError);
    });

    it('fails closed on an unknown principal type', () => {
      expect(() =>
        createTenantContext({ ...valid, principalType: 'admin' as never }),
      ).toThrow(TenantContextError);
    });

    it('fails closed on a missing request id', () => {
      expect(() => createTenantContext({ ...valid, requestId: '  ' })).toThrow(
        TenantContextError,
      );
    });
  });

  describe('runWithTenantContext / getCurrentTenantContext', () => {
    it('has no context outside a run — there is no implicit default tenant', () => {
      expect(getCurrentTenantContext()).toBeUndefined();
    });

    it('exposes the context across async boundaries inside a run, and not after', async () => {
      const context = createTenantContext(valid);
      const seen = await runWithTenantContext(context, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getCurrentTenantContext();
      });
      expect(seen).toBe(context);
      expect(getCurrentTenantContext()).toBeUndefined();
    });

    it('allows re-entering the SAME tenant', () => {
      const outer = createTenantContext(valid);
      const inner = createTenantContext({ ...valid, requestId: 'req-2' });
      const seen = runWithTenantContext(outer, () =>
        runWithTenantContext(inner, () => getCurrentTenantContext()),
      );
      expect(seen).toBe(inner);
    });

    it('refuses to enter a DIFFERENT tenant from inside a tenant context', () => {
      const tenantA = createTenantContext(valid);
      const tenantB = createTenantContext({
        ...valid,
        tenantId: TEST_TENANT_B_ID,
      });
      expect(() =>
        runWithTenantContext(tenantA, () =>
          runWithTenantContext(tenantB, () => undefined),
        ),
      ).toThrow(TenantContextError);
    });
  });
});
