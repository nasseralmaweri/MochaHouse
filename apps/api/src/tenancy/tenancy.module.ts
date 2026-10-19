import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  HttpTenantContextResolver,
  SingleTenantHttpContextResolver,
  StorefrontHostHttpContextResolver,
} from './http-tenant-context.resolver';
import {
  SINGLE_TENANT_RESOLUTION,
  singleTenantResolutionProvider,
} from './single-tenant-resolution.provider';
import { RequestIdMiddleware } from './request-id.middleware';
import { LEGACY_BRAND, legacyBrandProvider } from './legacy-brand';
import {
  STOREFRONT_ROUTING_CONFIG,
  type StorefrontRoutingConfig,
  storefrontRoutingConfig,
} from './storefront-context';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantDatabase } from './tenant-database';

// Milestone S0F — the authenticated internal ("member") routes. Their
// TenantContext is the administrator's validated active business,
// established by InternalAuthGuard; TenantContextMiddleware's
// deployment-wide resolution never runs on them. Matched by Nest's own
// router syntax, so the exclusion agrees with how these routes are routed.
export const MEMBER_TENANT_ROUTES = [
  { path: 'api/v1/admin', method: RequestMethod.ALL },
  { path: 'api/v1/admin/{*path}', method: RequestMethod.ALL },
  { path: 'api/v1/internal', method: RequestMethod.ALL },
  { path: 'api/v1/internal/{*path}', method: RequestMethod.ALL },
];

// SC1a — the CENTERIVO platform-operator routes. They belong to NO tenant:
// PlatformAuthGuard authenticates the operator and never establishes a
// TenantContext, so neither the deployment's storefront tenant nor its
// suspension gate (SC0.5a) may apply to them.
export const PLATFORM_ROUTES = [
  { path: 'api/v1/platform', method: RequestMethod.ALL },
  { path: 'api/v1/platform/{*path}', method: RequestMethod.ALL },
];

// SC3b — billing-provider webhooks belong to NO tenant either: the provider's
// signature is their only credential, the business is found from OUR stored
// provider ids, and a SUSPENDED business's payment events must still arrive
// (the suspension gate would otherwise answer 503 and lose them).
export const BILLING_WEBHOOK_ROUTES = [
  { path: 'api/v1/billing/webhooks/{*path}', method: RequestMethod.POST },
];

// ESP-04 M1 — restaurant-payments (Stripe Connect) webhooks: likewise no
// tenant (the business is found from OUR stored connected-account id), and a
// suspended business's account events must still arrive.
export const RESTAURANT_PAYMENTS_WEBHOOK_ROUTES = [
  {
    path: 'api/v1/restaurant-payments/webhooks/{*path}',
    method: RequestMethod.POST,
  },
];

// Milestone S0C — the API's tenant foundation. Importing this module:
//   - validates SINGLE_TENANT_ID against the Tenant table at startup
//     (startup fails otherwise);
//   - assigns a server-side request id on every request
//     (RequestIdMiddleware);
//   - establishes the deployment's TenantContext on every NON-member
//     request via TenantContextMiddleware (S0F: member routes excluded —
//     see MEMBER_TENANT_ROUTES);
//   - mirrors a guard-established TenantContext into the async-scoped
//     diagnostics carrier (TenantContextInterceptor, S0F);
//   - SC4f-1 — reads STOREFRONT_HOST_ROUTING_ENABLED once at startup (a
//     malformed value, or routing on without STOREFRONT_CONTEXT_SECRET,
//     fails startup) and picks the resolver: the single business (off, the
//     default) or the approved hostname registry (on).
// Global so any module can inject TenantDatabase / the resolver without
// re-importing; PrismaService comes from the @Global PrismaModule.
@Global()
@Module({
  providers: [
    singleTenantResolutionProvider,
    {
      provide: STOREFRONT_ROUTING_CONFIG,
      useFactory: () => storefrontRoutingConfig(),
    },
    SingleTenantHttpContextResolver,
    StorefrontHostHttpContextResolver,
    {
      provide: HttpTenantContextResolver,
      inject: [
        STOREFRONT_ROUTING_CONFIG,
        SingleTenantHttpContextResolver,
        StorefrontHostHttpContextResolver,
      ],
      useFactory: (
        routing: StorefrontRoutingConfig,
        single: SingleTenantHttpContextResolver,
        hosts: StorefrontHostHttpContextResolver,
      ) => (routing.hostRouting ? hosts : single),
    },
    // SC4f-3b — which business keeps the original storefront presentation.
    legacyBrandProvider,
    RequestIdMiddleware,
    TenantContextMiddleware,
    TenantDatabase,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [
    SINGLE_TENANT_RESOLUTION,
    STOREFRONT_ROUTING_CONFIG,
    LEGACY_BRAND,
    HttpTenantContextResolver,
    TenantDatabase,
  ],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
    consumer
      .apply(TenantContextMiddleware)
      .exclude(
        ...MEMBER_TENANT_ROUTES,
        ...PLATFORM_ROUTES,
        ...BILLING_WEBHOOK_ROUTES,
        ...RESTAURANT_PAYMENTS_WEBHOOK_ROUTES,
      )
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
