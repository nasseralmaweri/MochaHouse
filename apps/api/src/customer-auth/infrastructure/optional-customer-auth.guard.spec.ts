import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { OptionalCustomerAuthGuard } from './optional-customer-auth.guard';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { LocalDevTokenVerifier } from './local-dev-token-verifier';
import { signDevJwt } from './dev-jwt';

function contextWithHeader(authorization?: string): ExecutionContext {
  const request: {
    headers: Record<string, string | undefined>;
    customerIdentity?: unknown;
  } = {
    headers: { authorization },
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('OptionalCustomerAuthGuard', () => {
  const guard = new OptionalCustomerAuthGuard(
    new CognitoTokenVerifier(),
    new LocalDevTokenVerifier(),
  );
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows a request through with no Authorization header at all, as anonymous', async () => {
    const context = contextWithHeader(undefined);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const request = context
      .switchToHttp()
      .getRequest<{ customerIdentity?: unknown }>();
    expect(request.customerIdentity).toBeUndefined();
  });

  it('rejects an invalid/expired token with 401 rather than silently downgrading to anonymous', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';

    const context = contextWithHeader('Bearer not-a-real-token');

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired (but otherwise validly signed) token with 401', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    const expiredToken = signDevJwt(
      { sub: 'dev:test@example.com', email: 'test@example.com', name: null },
      'test-secret',
      -1,
    );

    const context = contextWithHeader(`Bearer ${expiredToken}`);

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      'other-secret',
      3600,
    );

    const context = contextWithHeader(`Bearer ${token}`);

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('attaches the resolved identity for a valid token', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    const token = signDevJwt(
      { sub: 'dev:test@example.com', email: 'test@example.com', name: null },
      'test-secret',
      3600,
    );

    const context = contextWithHeader(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);

    const request = context
      .switchToHttp()
      .getRequest<{ customerIdentity?: unknown }>();
    expect(request.customerIdentity).toEqual({
      provider: 'dev',
      subject: 'dev:test@example.com',
      email: 'test@example.com',
      name: null,
      emailVerified: null,
    });
  });

  it('rejects a present token with 401 in production even when AUTH_PROVIDER=dev (never falls back to the dev boundary)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    delete process.env.COGNITO_USER_POOL_ID;
    delete process.env.COGNITO_CLIENT_ID;

    const token = signDevJwt(
      { sub: 'dev:x', email: null, name: null },
      'test-secret',
      3600,
    );
    const context = contextWithHeader(`Bearer ${token}`);

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
