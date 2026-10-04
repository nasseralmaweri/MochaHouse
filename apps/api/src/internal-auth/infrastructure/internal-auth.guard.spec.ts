import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { InternalAuthGuard } from './internal-auth.guard';
import { InternalCognitoTokenVerifier } from './internal-cognito-token-verifier';
import { InternalLocalDevTokenVerifier } from './internal-local-dev-token-verifier';
import { signInternalDevJwt } from './internal-dev-jwt';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import type { InternalUserResolution } from '../application/internal-users.service';
import type { ActiveTenantSelection } from '../application/internal-tenant-membership.service';
import type { InternalIdentity } from './internal-identity';

// Milestone S0F — the guard itself establishes the TenantContext (from the
// validated active business), so a request reaching it carries only the
// server-side request id (RequestIdMiddleware) and, optionally, the
// client's X-Tenant-Id intent. `requestId: null` omits the id, for the one
// test proving the guard's own fail-closed check.
function contextWithHeader(
  authorization?: string,
  opts: { tenantHeader?: string | string[]; requestId?: string | null } = {},
): ExecutionContext {
  const request: {
    headers: Record<string, string | string[] | undefined>;
    requestId?: string;
    internalIdentity?: unknown;
    internalUser?: unknown;
    customerIdentity?: unknown;
    tenantContext?: unknown;
  } = { headers: { authorization, 'x-tenant-id': opts.tenantHeader } };
  if (opts.requestId !== null) {
    request.requestId = opts.requestId ?? 'req-guard-spec';
  }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('InternalAuthGuard', () => {
  const originalEnv = { ...process.env };
  const internalSecret = 'guard-spec-internal-secret';
  const customerSecret = 'guard-spec-customer-secret';

  // Records what resolveForAuthentication is asked, and returns whatever the
  // test set up — the guard's lifecycle behaviour is exercised through this.
  let resolution: InternalUserResolution;
  let selection: ActiveTenantSelection;
  let seenIdentity: InternalIdentity | null;
  let seenTenantId: string | null;
  let seenRequestedTenantId: string | null | undefined;

  const internalUsersStub = {
    resolveForAuthentication: (
      identity: InternalIdentity,
      tenantId: string,
    ) => {
      seenIdentity = identity;
      seenTenantId = tenantId;
      return Promise.resolve(resolution);
    },
  };

  // Milestone S0F — what selectActiveTenant is asked, and what it returns.
  const membershipsStub = {
    selectActiveTenant: (
      _identity: InternalIdentity,
      requestedTenantId: string | null,
    ) => {
      seenRequestedTenantId = requestedTenantId;
      return Promise.resolve(selection);
    },
  };

  const guard = new InternalAuthGuard(
    new InternalCognitoTokenVerifier(),
    new InternalLocalDevTokenVerifier(),
    internalUsersStub as never,
    membershipsStub as never,
  );

  const activeUser = {
    id: 'iu_1',
    email: 'admin@example.com',
    displayName: 'Admin',
    status: 'ACTIVE' as const,
    externalProvider: 'internal-dev',
    externalSubject: 'internal-dev:admin@example.com',
    invitedAt: new Date(),
    activatedAt: new Date(),
    lastAuthenticatedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    // Milestone S0D-1 — an existing internal user row, backfilled to Tenant #1.
    tenantId: TENANT_1_MOCHA_HOUSE_ID,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    resolution = { outcome: 'not-found' };
    selection = { outcome: 'selected', tenantId: TENANT_1_MOCHA_HOUSE_ID };
    seenIdentity = null;
    seenTenantId = null;
    seenRequestedTenantId = undefined;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function internalToken(identifier = 'admin@example.com'): string {
    return signInternalDevJwt(
      { sub: `internal-dev:${identifier}`, email: identifier, name: null },
      internalSecret,
      3600,
    );
  }

  it('rejects a request with no Authorization header (401)', async () => {
    await expect(guard.canActivate(contextWithHeader())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a malformed Authorization header (401)', async () => {
    await expect(
      guard.canActivate(contextWithHeader('NotBearer abc')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid/garbage bearer token (401)', async () => {
    await expect(
      guard.canActivate(contextWithHeader('Bearer not-a-real-token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an internal dev token signed with the wrong secret (401)', async () => {
    const token = signInternalDevJwt(
      { sub: 'internal-dev:x', email: null, name: null },
      'the-wrong-secret',
      3600,
    );
    await expect(
      guard.canActivate(contextWithHeader(`Bearer ${token}`)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a valid CUSTOMER dev token — it never reaches identity resolution (401)', async () => {
    const customerToken = signDevJwt(
      {
        sub: 'dev:customer@example.com',
        email: 'customer@example.com',
        name: null,
      },
      customerSecret,
      3600,
    );
    resolution = { outcome: 'active', user: activeUser };

    await expect(
      guard.canActivate(contextWithHeader(`Bearer ${customerToken}`)),
    ).rejects.toThrow(UnauthorizedException);
    expect(seenIdentity).toBeNull();
  });

  it('rejects a valid internal token for an UNKNOWN internal identity (403)', async () => {
    resolution = { outcome: 'not-found' };
    await expect(
      guard.canActivate(contextWithHeader(`Bearer ${internalToken()}`)),
    ).rejects.toThrow(ForbiddenException);
  });

  it.each(['INVITED', 'SUSPENDED', 'DISABLED'] as const)(
    'rejects a valid internal token when the InternalUser is %s (403)',
    async (status) => {
      resolution = { outcome: 'inactive', status };
      await expect(
        guard.canActivate(contextWithHeader(`Bearer ${internalToken()}`)),
      ).rejects.toThrow(ForbiddenException);
    },
  );

  it('allows a valid internal token mapped to an ACTIVE InternalUser', async () => {
    resolution = { outcome: 'active', user: activeUser };
    const context = contextWithHeader(`Bearer ${internalToken()}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const request = context.switchToHttp().getRequest<{
      internalIdentity?: InternalIdentity;
      internalUser?: unknown;
      customerIdentity?: unknown;
    }>();
    expect(request.internalIdentity).toEqual({
      provider: 'internal-dev',
      subject: 'internal-dev:admin@example.com',
      email: 'admin@example.com',
      name: null,
    });
    expect(request.internalUser).toBe(activeUser);
    // Never writes the customer request contract.
    expect(request.customerIdentity).toBeUndefined();
  });

  it('passes the verified identity (not raw token) to resolution', async () => {
    resolution = { outcome: 'active', user: activeUser };
    await guard.canActivate(
      contextWithHeader(`Bearer ${internalToken('other@example.com')}`),
    );
    expect(seenIdentity).toEqual({
      provider: 'internal-dev',
      subject: 'internal-dev:other@example.com',
      email: 'other@example.com',
      name: null,
    });
  });

  // --- Milestone S0F: active business resolution ----------------------

  const TENANT_B = '01a0db02-f800-7000-8000-7e570000000b';

  it('builds a member TenantContext for the SELECTED tenant (never a default) and resolves the user inside it', async () => {
    selection = { outcome: 'selected', tenantId: TENANT_B };
    resolution = {
      outcome: 'active',
      user: { ...activeUser, tenantId: TENANT_B },
    };
    const context = contextWithHeader(`Bearer ${internalToken()}`, {
      tenantHeader: TENANT_B,
      requestId: 'req-123',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(seenRequestedTenantId).toBe(TENANT_B);
    expect(seenTenantId).toBe(TENANT_B);
    const request = context
      .switchToHttp()
      .getRequest<{ tenantContext?: unknown }>();
    expect(request.tenantContext).toEqual({
      tenantId: TENANT_B,
      principalType: 'member',
      requestId: 'req-123',
    });
    expect(Object.isFrozen(request.tenantContext)).toBe(true);
  });

  it('passes no requested tenant when X-Tenant-Id is absent', async () => {
    resolution = { outcome: 'active', user: activeUser };
    await guard.canActivate(contextWithHeader(`Bearer ${internalToken()}`));
    expect(seenRequestedTenantId).toBeNull();
  });

  it('rejects a business the identity may not enter with the generic 403 — before resolving any InternalUser', async () => {
    selection = { outcome: 'denied' };
    resolution = { outcome: 'active', user: activeUser };
    const context = contextWithHeader(`Bearer ${internalToken()}`, {
      tenantHeader: TENANT_B,
    });
    await expect(guard.canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
    expect(seenTenantId).toBeNull();
    expect(
      context.switchToHttp().getRequest<{ tenantContext?: unknown }>()
        .tenantContext,
    ).toBeUndefined();
  });

  it('asks a multi-business identity to choose (409 BUSINESS_SELECTION_REQUIRED)', async () => {
    selection = { outcome: 'selection-required' };
    const error = await guard
      .canActivate(contextWithHeader(`Bearer ${internalToken()}`))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'BUSINESS_SELECTION_REQUIRED',
    });
  });

  it.each([
    ['not a uuid', 'tenant-b'],
    ['upper-case uuid', TENANT_B.toUpperCase()],
    ['repeated header', [TENANT_B, TENANT_B]],
  ])(
    'rejects a malformed X-Tenant-Id (%s) with 400',
    async (_label, header) => {
      await expect(
        guard.canActivate(
          contextWithHeader(`Bearer ${internalToken()}`, {
            tenantHeader: header,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(seenRequestedTenantId).toBeUndefined();
    },
  );

  it('authenticates BEFORE reading the business: no token is 401 even with a tenant header', async () => {
    await expect(
      guard.canActivate(
        contextWithHeader(undefined, { tenantHeader: TENANT_B }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(seenRequestedTenantId).toBeUndefined();
  });

  it('fails closed with a 500 if RequestIdMiddleware never ran', async () => {
    resolution = { outcome: 'active', user: activeUser };
    await expect(
      guard.canActivate(
        contextWithHeader(`Bearer ${internalToken()}`, { requestId: null }),
      ),
    ).rejects.toThrow(InternalServerErrorException);
    expect(seenIdentity).toBeNull();
  });

  it('never selects the dev verifier in production, even with INTERNAL_AUTH_PROVIDER=dev', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.INTERNAL_COGNITO_USER_POOL_ID;
    delete process.env.INTERNAL_COGNITO_CLIENT_ID;
    resolution = { outcome: 'active', user: activeUser };

    await expect(
      guard.canActivate(contextWithHeader(`Bearer ${internalToken()}`)),
    ).rejects.toThrow(UnauthorizedException);
  });
});
