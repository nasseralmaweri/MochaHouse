import 'reflect-metadata';
import { AuthController } from '../customer-auth/api/auth.controller';
import { OptionalCustomerAuthGuard } from '../customer-auth/infrastructure/optional-customer-auth.guard';
import { InternalAuthController } from '../internal-auth/api/internal-auth.controller';
import { CheckoutRewardsController } from '../orders/api/checkout-rewards.controller';
import { OrdersController } from '../orders/api/orders.controller';
import { RATE_LIMIT_POLICY_KEY } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import type { PolicyName } from './rate-limit.config';

// The list of public routes protected by S3a. If a route here loses its
// decorator or its guard — or someone adds a new unauthenticated ordering or
// sign-in route — this fails, so a protection cannot be dropped silently.

type Constructor = { prototype: object };

const handlerOf = (controller: Constructor, method: string): unknown =>
  (controller.prototype as Record<string, unknown>)[method];

const PROTECTED: ReadonlyArray<{
  controller: Constructor;
  method: string;
  policy: PolicyName;
  // guards that must run BEFORE the rate limiter, so a verified customer
  // identity is available to it
  authenticatedFirst?: unknown;
}> = [
  {
    controller: OrdersController,
    method: 'checkout',
    policy: 'checkout',
    authenticatedFirst: OptionalCustomerAuthGuard,
  },
  {
    controller: OrdersController,
    method: 'quote',
    policy: 'checkout-quote',
    authenticatedFirst: OptionalCustomerAuthGuard,
  },
  { controller: OrdersController, method: 'getStatus', policy: 'order-status' },
  {
    controller: CheckoutRewardsController,
    method: 'quote',
    policy: 'reward-eligibility',
  },
  { controller: AuthController, method: 'signIn', policy: 'customer-sign-in' },
  {
    controller: AuthController,
    method: 'register',
    policy: 'account-recovery',
  },
  {
    controller: AuthController,
    method: 'resendVerification',
    policy: 'account-recovery',
  },
  {
    controller: AuthController,
    method: 'forgotPassword',
    policy: 'account-recovery',
  },
  {
    controller: AuthController,
    method: 'verify',
    policy: 'account-verification',
  },
  {
    controller: AuthController,
    method: 'resetPassword',
    policy: 'account-verification',
  },
  {
    controller: InternalAuthController,
    method: 'signIn',
    policy: 'internal-sign-in',
  },
];

function guardsFor(controller: Constructor, method: string): unknown[] {
  const handler = handlerOf(controller, method);
  const onMethod = (Reflect.getMetadata('__guards__', handler as object) ??
    []) as unknown[];
  const onClass = (Reflect.getMetadata('__guards__', controller) ??
    []) as unknown[];
  return [...onClass, ...onMethod];
}

describe('routes protected by the public-API rate limiter', () => {
  it.each(PROTECTED)(
    '$controller.name.$method uses the $policy policy and the rate-limit guard',
    ({ controller, method, policy, authenticatedFirst }) => {
      const handler = handlerOf(controller, method);
      expect(typeof handler).toBe('function');
      expect(
        Reflect.getMetadata(RATE_LIMIT_POLICY_KEY, handler as object),
      ).toBe(policy);

      const guards = guardsFor(controller, method);
      const limiterAt = guards.indexOf(RateLimitGuard);
      expect(limiterAt).toBeGreaterThanOrEqual(0);
      if (authenticatedFirst !== undefined) {
        const authAt = guards.indexOf(authenticatedFirst);
        expect(authAt).toBeGreaterThanOrEqual(0);
        expect(authAt).toBeLessThan(limiterAt);
      }
    },
  );

  it('covers every unauthenticated sign-in / recovery route of the customer auth controller', () => {
    const routes = Object.getOwnPropertyNames(AuthController.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        typeof AuthController.prototype[name as keyof AuthController] ===
          'function',
    );
    const covered = new Set(
      PROTECTED.filter((p) => p.controller === AuthController).map(
        (p) => p.method,
      ),
    );
    for (const route of routes) {
      // Every handler that is an HTTP route (has Nest path metadata) must be listed.
      const isRoute =
        Reflect.getMetadata(
          'path',
          handlerOf(AuthController, route) as object,
        ) !== undefined;
      if (isRoute) expect(covered.has(route)).toBe(true);
    }
  });
});
