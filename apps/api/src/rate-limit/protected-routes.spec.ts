import 'reflect-metadata';
import { AuthController } from '../customer-auth/api/auth.controller';
import { OptionalCustomerAuthGuard } from '../customer-auth/infrastructure/optional-customer-auth.guard';
import { InternalAuthController } from '../internal-auth/api/internal-auth.controller';
import { CheckoutRewardsController } from '../orders/api/checkout-rewards.controller';
import { OrdersController } from '../orders/api/orders.controller';
import { PlatformAuthController } from '../platform-auth/api/platform-auth.controller';
import { RATE_LIMIT_POLICY_KEY } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { PlatformTenantsController } from '../platform-tenants/api/platform-tenants.controller';
import { PlatformTenantLifecycleController } from '../platform-tenants/api/platform-tenant-lifecycle.controller';
import { PlatformPlansController } from '../platform-subscriptions/api/platform-plans.controller';
import { PlatformTenantSubscriptionController } from '../platform-subscriptions/api/platform-tenant-subscription.controller';
import type { PolicyName } from './rate-limit.config';
import { PlatformBillingController } from '../saas-billing/api/platform-billing.controller';
import { PlatformAdjustmentsController } from '../saas-billing/api/platform-adjustments.controller';
import { PlatformRevenueController } from '../saas-billing/api/platform-revenue.controller';
import { PlatformPermissionsController } from '../platform-auth/api/platform-permissions.controller';
import { AdminBillingController } from '../saas-billing/api/admin-billing.controller';
import { BillingWebhookController } from '../saas-billing/api/billing-webhook.controller';
import { OwnerRegistrationController } from '../owner-registration/api/owner-registration.controller';
import { OwnerOnboardingController } from '../owner-registration/api/owner-onboarding.controller';

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
  // SC1b — CENTERIVO platform-operator sign-in and its MFA steps.
  {
    controller: PlatformAuthController,
    method: 'start',
    policy: 'platform-sign-in',
  },
  { controller: PlatformAuthController, method: 'mfa', policy: 'platform-mfa' },
  {
    controller: PlatformAuthController,
    method: 'mfaSetup',
    policy: 'platform-mfa',
  },
  {
    controller: PlatformAuthController,
    method: 'mfaSetupDisplay',
    policy: 'platform-mfa',
  },
  {
    controller: PlatformAuthController,
    method: 'mfaSetupVerify',
    policy: 'platform-mfa',
  },
  // SC1d — business provisioning.
  {
    controller: PlatformTenantsController,
    method: 'provision',
    policy: 'platform-provisioning',
  },
  // SC1e — business lifecycle changes.
  {
    controller: PlatformTenantLifecycleController,
    method: 'suspend',
    policy: 'platform-lifecycle',
  },
  {
    controller: PlatformTenantLifecycleController,
    method: 'reactivate',
    policy: 'platform-lifecycle',
  },
  {
    controller: PlatformTenantLifecycleController,
    method: 'correctOwnerEmail',
    policy: 'platform-lifecycle',
  },
  // SC2a — plan and subscription changes.
  ...(
    [
      'create',
      'createVersion',
      'updateDraft',
      'publish',
      'retire',
      // SC4b
      'setSelfService',
    ] as const
  ).map((method) => ({
    controller: PlatformPlansController,
    method,
    policy: 'platform-lifecycle' as const,
  })),
  ...(['changePlan', 'grantAddOn', 'revokeAddOn'] as const).map((method) => ({
    controller: PlatformTenantSubscriptionController,
    method,
    policy: 'platform-lifecycle' as const,
  })),
  // SC3a/SC3b — SaaS billing changes (operators), Checkout (owners) and
  // provider webhooks.
  ...(
    [
      'createPrice',
      'archivePrice',
      'updatePolicy',
      'startBilling',
      'reconcile',
      'sweepEnforcement',
      'assignBillingContact',
      'extendGrace',
      'previewPlanChange',
      'resolveCase',
      // SC3e-2
      // SC3e-4
      'extendPaymentSetup',
      'grantComplimentary',
      'withdrawComplimentary',
      'revokeComplimentary',
      'recheckCase',
      'releaseCaseSchedule',
    ] as const
  ).map((method) => ({
    controller: PlatformBillingController,
    method,
    policy: 'platform-lifecycle' as const,
  })),
  // SC3e-3 — refunds and credits, and operator permissions.
  ...(
    [
      'adjustable',
      'preview',
      'request',
      'approve',
      'reject',
      'cancel',
      'resolveNotIssued',
    ] as const
  ).map((method) => ({
    controller: PlatformAdjustmentsController,
    method,
    policy: 'platform-lifecycle' as const,
  })),
  // SC3f — revenue reports (computed on request).
  {
    controller: PlatformRevenueController,
    method: 'revenue',
    policy: 'platform-lifecycle',
  },
  ...(['grantPermission', 'revokePermission'] as const).map((method) => ({
    controller: PlatformPermissionsController,
    method,
    policy: 'platform-lifecycle' as const,
  })),
  ...(
    [
      'checkout',
      'payInvoice',
      'openPortal',
      'previewPlanChange',
      'confirmPlanChange',
      'payPlanChange',
      'cancelPlanChange',
      'invoiceDocument',
      // SC4c
      'changeInitialPlan',
    ] as const
  ).map((method) => ({
    controller: AdminBillingController,
    method,
    policy: 'billing-checkout' as const,
  })),
  {
    controller: BillingWebhookController,
    method: 'receive',
    policy: 'billing-webhook',
  },
  // SC4a — business owner self-service registration.
  {
    controller: OwnerRegistrationController,
    method: 'start',
    policy: 'owner-registration',
  },
  {
    controller: OwnerRegistrationController,
    method: 'complete',
    policy: 'owner-registration-verification',
  },
  // SC4b — a verified owner creating their business.
  {
    controller: OwnerOnboardingController,
    method: 'createBusiness',
    policy: 'owner-onboarding',
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
