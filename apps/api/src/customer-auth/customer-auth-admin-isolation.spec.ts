import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { DevInternalGuard } from '../orders/infrastructure/dev-internal.guard';
import { signDevJwt } from './infrastructure/dev-jwt';

// Guardrail check: customer authentication must never confer any
// internal/Admin access. DevInternalGuard (orders/infrastructure) is the
// only internal/Admin authorization boundary that exists in this codebase
// today — it is deliberately unaware of the customer-auth boundary
// entirely (it never reads Authorization headers), so presenting a
// perfectly valid, successfully-verifiable customer bearer token must have
// zero effect on it either way.
describe('Customer authentication cannot satisfy DevInternalGuard', () => {
  const guard = new DevInternalGuard();
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function contextWithCustomerBearerToken(): ExecutionContext {
    const token = signDevJwt(
      { sub: 'dev:test@example.com', email: 'test@example.com', name: null },
      'admin-isolation-spec-secret',
      3600,
    );
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${token}` } }),
      }),
    } as unknown as ExecutionContext;
  }

  it('still denies admin access with a valid customer bearer token when the dev-admin flag is unset', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN;

    expect(() => guard.canActivate(contextWithCustomerBearerToken())).toThrow(
      ForbiddenException,
    );
  });

  it('still denies admin access with a valid customer bearer token in production, even with the dev-admin flag set', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = 'true';

    expect(() => guard.canActivate(contextWithCustomerBearerToken())).toThrow(
      ForbiddenException,
    );
  });

  it('admin access, when the dev-admin flag legitimately allows it, is unaffected by a customer bearer token being present', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = 'true';

    // Access is granted here purely by DevInternalGuard's own env check —
    // the presence of a customer token in the request is incidental, not
    // the reason. This documents that DevInternalGuard never reads it.
    expect(guard.canActivate(contextWithCustomerBearerToken())).toBe(true);
  });
});
