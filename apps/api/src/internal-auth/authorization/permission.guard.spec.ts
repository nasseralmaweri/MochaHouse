import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { PermissionGuard } from './permission.guard';
import { AuthorizationContext } from './authorization-context';

// Milestone S0D-2E — every request reaching this guard already has a
// trusted TenantContext (TenantContextMiddleware runs before any guard);
// defaults to Tenant #1 here so every pre-existing test below keeps
// working without knowing about it. Pass `withTenantContext: false` for
// the one test proving the guard's own fail-closed check.
function executionContext(
  requiredPermission: string | undefined,
  request: Record<string, unknown>,
  opts: { withTenantContext?: boolean } = {},
): { context: ExecutionContext; request: Record<string, unknown> } {
  const reflectorValue = requiredPermission;
  if (opts.withTenantContext !== false) {
    request.tenantContext = { tenantId: TENANT_1_MOCHA_HOUSE_ID };
  }
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => reflectorValue,
    getClass: () => reflectorValue,
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('PermissionGuard', () => {
  const internalUser = { id: 'iu-1' } as never;

  function makeGuard(opts: {
    metadata?: string;
    context?: AuthorizationContext;
  }) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(opts.metadata),
    } as unknown as Reflector;
    const authorizationService = {
      loadContext: jest
        .fn()
        .mockResolvedValue(opts.context ?? AuthorizationContext.empty()),
    };
    const guard = new PermissionGuard(reflector, authorizationService as never);
    return { guard, loadContext: authorizationService.loadContext };
  }

  it('fails when request.internalUser is missing', async () => {
    const { guard } = makeGuard({ metadata: 'orders.view' });
    const { context } = executionContext('orders.view', {});
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('fails closed when the route declares NO required permission', async () => {
    const { guard, loadContext } = makeGuard({ metadata: undefined });
    const { context } = executionContext(undefined, { internalUser });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(loadContext).not.toHaveBeenCalled();
  });

  it('fails closed when the declared permission is not in the vocabulary', async () => {
    const { guard } = makeGuard({ metadata: 'orders.delete' });
    const { context } = executionContext('orders.delete', { internalUser });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('403 when the user has no role assignments (empty context)', async () => {
    const { guard } = makeGuard({
      metadata: 'orders.view',
      context: AuthorizationContext.empty(),
    });
    const { context } = executionContext('orders.view', { internalUser });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('403 when the user lacks the specific permission', async () => {
    const { guard } = makeGuard({
      metadata: 'orders.manage_status',
      context: AuthorizationContext.of({
        'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      }),
    });
    const { context } = executionContext('orders.manage_status', {
      internalUser,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('allows and attaches the context when the permission is held at a valid scope', async () => {
    const authContext = AuthorizationContext.of({
      'orders.view': [{ scopeType: 'LOCATION', scopeId: 'loc-1' }],
    });
    const { guard } = makeGuard({
      metadata: 'orders.view',
      context: authContext,
    });
    const { context, request } = executionContext('orders.view', {
      internalUser,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.authorization).toBe(authContext);
  });

  it('a LOCATION-only grant cannot satisfy a CORPORATE-only master permission', async () => {
    const { guard } = makeGuard({
      metadata: 'catalog.products.edit',
      context: AuthorizationContext.of({
        'catalog.products.edit': [{ scopeType: 'LOCATION', scopeId: 'loc-1' }],
      }),
    });
    const { context } = executionContext('catalog.products.edit', {
      internalUser,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('a CORPORATE grant satisfies a CORPORATE-only master permission', async () => {
    const { guard } = makeGuard({
      metadata: 'catalog.products.edit',
      context: AuthorizationContext.of({
        'catalog.products.edit': [{ scopeType: 'CORPORATE', scopeId: null }],
      }),
    });
    const { context } = executionContext('catalog.products.edit', {
      internalUser,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  // --- Milestone S0D-2E -----------------------------------------------

  it("fails closed with a 500 if TenantContextMiddleware never ran (no request.tenantContext)", async () => {
    const { guard, loadContext } = makeGuard({ metadata: 'orders.view' });
    const { context } = executionContext(
      'orders.view',
      { internalUser },
      { withTenantContext: false },
    );
    await expect(guard.canActivate(context)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(loadContext).not.toHaveBeenCalled();
  });

  it("passes the request's own TenantContext to loadContext — never a default", async () => {
    const { guard, loadContext } = makeGuard({
      metadata: 'orders.view',
      context: AuthorizationContext.of({
        'orders.view': [{ scopeType: 'CORPORATE', scopeId: null }],
      }),
    });
    const otherTenantId = '01a0db02-f800-7000-8000-7e570000000b';
    const { context, request } = executionContext('orders.view', {
      internalUser,
    });
    request.tenantContext = { tenantId: otherTenantId };

    await guard.canActivate(context);

    expect(loadContext).toHaveBeenCalledWith('iu-1', request.tenantContext);
  });
});
