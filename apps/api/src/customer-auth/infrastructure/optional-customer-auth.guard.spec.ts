import { ExecutionContext } from '@nestjs/common';
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

  it('never rejects an invalid/expired token — proceeds as anonymous instead', async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';

    const context = contextWithHeader('Bearer not-a-real-token');

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const request = context
      .switchToHttp()
      .getRequest<{ customerIdentity?: unknown }>();
    expect(request.customerIdentity).toBeUndefined();
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
    });
  });

  it('never falls back to the dev boundary in production — an invalid token there also proceeds as anonymous, not authenticated', async () => {
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

    await expect(guard.canActivate(context)).resolves.toBe(true);
    const request = context
      .switchToHttp()
      .getRequest<{ customerIdentity?: unknown }>();
    expect(request.customerIdentity).toBeUndefined();
  });
});
