import { ForbiddenException } from '@nestjs/common';
import { DevInternalGuard } from './dev-internal.guard';

describe('DevInternalGuard', () => {
  const guard = new DevInternalGuard();
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalFlag === undefined) {
      delete process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN;
    } else {
      process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = originalFlag;
    }
  });

  it('allows access when explicitly enabled in a non-production environment', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = 'true';

    expect(guard.canActivate({} as never)).toBe(true);
  });

  it('fails closed when the flag is unset, even outside production', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN;

    expect(() => guard.canActivate({} as never)).toThrow(ForbiddenException);
  });

  it('fails closed when the flag is any value other than the exact string "true"', () => {
    process.env.NODE_ENV = 'development';
    process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = 'TRUE';

    expect(() => guard.canActivate({} as never)).toThrow(ForbiddenException);
  });

  it('always fails closed in production, even if the flag is set to true', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN = 'true';

    expect(() => guard.canActivate({} as never)).toThrow(ForbiddenException);
  });

  it('fails closed when NODE_ENV is unset and the flag is unset', () => {
    delete process.env.NODE_ENV;
    delete process.env.ENABLE_DEV_INTERNAL_ORDER_ADMIN;

    expect(() => guard.canActivate({} as never)).toThrow(ForbiddenException);
  });
});
