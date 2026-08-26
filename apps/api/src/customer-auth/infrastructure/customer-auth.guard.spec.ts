import { UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { CustomerAuthGuard } from './customer-auth.guard';
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

describe('CustomerAuthGuard', () => {
  const guard = new CustomerAuthGuard(
    new CognitoTokenVerifier(),
    new LocalDevTokenVerifier(),
  );

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects a request with no Authorization header', async () => {
    const context = contextWithHeader(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request with a malformed Authorization header', async () => {
    const context = contextWithHeader('NotBearer abc');
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a Bearer header with no token', async () => {
    const context = contextWithHeader('Bearer ');
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  describe('when AUTH_PROVIDER=dev in a non-production environment', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      process.env.AUTH_PROVIDER = 'dev';
      process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    });

    it('accepts a valid dev token and attaches the resolved identity', async () => {
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

    it('rejects an invalid dev token', async () => {
      const context = contextWithHeader('Bearer not-a-real-token');
      await expect(guard.canActivate(context)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a dev token signed with the wrong secret', async () => {
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
  });

  it('never falls back to the dev boundary in production, even if AUTH_PROVIDER=dev', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'test-secret';
    // COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID deliberately left unset —
    // the Cognito verifier must be the one selected here, and it must fail
    // closed (not silently accept) when unconfigured.
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

  it('fails closed (never accepts a dev token) when AUTH_PROVIDER is unset', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.AUTH_PROVIDER;
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
