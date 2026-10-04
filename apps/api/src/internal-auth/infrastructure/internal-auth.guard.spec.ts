import {
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
import type { InternalIdentity } from './internal-identity';

// Milestone S0D-2E — every request reaching this guard already has a
// trusted TenantContext (TenantContextMiddleware runs before any guard);
// `tenantContext` defaults to Tenant #1 here so the pre-existing tests
// below don't need to know about it. The one test that sets it to
// `undefined` proves the guard's own fail-closed check.
// `tenantContext: null` (never `undefined`, which would trigger the
// default below) deliberately omits it, for the one test proving the
// guard's own fail-closed check.
function contextWithHeader(
  authorization?: string,
  tenantContext: { tenantId: string } | null = {
    tenantId: TENANT_1_MOCHA_HOUSE_ID,
  },
): ExecutionContext {
  const request: {
    headers: Record<string, string | undefined>;
    internalIdentity?: unknown;
    internalUser?: unknown;
    customerIdentity?: unknown;
    tenantContext?: { tenantId: string };
  } = { headers: { authorization } };
  if (tenantContext) {
    request.tenantContext = tenantContext;
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
  let seenIdentity: InternalIdentity | null;
  let seenTenantId: string | null;

  const internalUsersStub = {
    resolveForAuthentication: (identity: InternalIdentity, tenantId: string) => {
      seenIdentity = identity;
      seenTenantId = tenantId;
      return Promise.resolve(resolution);
    },
  };

  const guard = new InternalAuthGuard(
    new InternalCognitoTokenVerifier(),
    new InternalLocalDevTokenVerifier(),
    internalUsersStub as never,
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
    seenIdentity = null;
    seenTenantId = null;
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

  // --- Milestone S0D-2E -----------------------------------------------

  it("passes the request's own TenantContext.tenantId to resolution — never a default", async () => {
    resolution = { outcome: 'active', user: activeUser };
    const otherTenantId = '01a0db02-f800-7000-8000-7e570000000b';
    await guard.canActivate(
      contextWithHeader(`Bearer ${internalToken()}`, {
        tenantId: otherTenantId,
      }),
    );
    expect(seenTenantId).toBe(otherTenantId);
  });

  it('fails closed with a 500 if TenantContextMiddleware never ran (no request.tenantContext)', async () => {
    resolution = { outcome: 'active', user: activeUser };
    await expect(
      guard.canActivate(contextWithHeader(`Bearer ${internalToken()}`, null)),
    ).rejects.toThrow(InternalServerErrorException);
    // Never even reaches token verification / identity resolution.
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
