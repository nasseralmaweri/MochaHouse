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
} from './http-tenant-context.resolver';
import {
  SINGLE_TENANT_RESOLUTION,
  singleTenantResolutionProvider,
} from './single-tenant-resolution.provider';
import { RequestIdMiddleware } from './request-id.middleware';
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

// Milestone S0C — the API's tenant foundation. Importing this module:
//   - validates SINGLE_TENANT_ID against the Tenant table at startup
//     (startup fails otherwise);
//   - assigns a server-side request id on every request
//     (RequestIdMiddleware);
//   - establishes the deployment's TenantContext on every NON-member
//     request via TenantContextMiddleware (S0F: member routes excluded —
//     see MEMBER_TENANT_ROUTES);
//   - mirrors a guard-established TenantContext into the async-scoped
//     diagnostics carrier (TenantContextInterceptor, S0F).
// Global so any module can inject TenantDatabase / the resolver without
// re-importing; PrismaService comes from the @Global PrismaModule.
@Global()
@Module({
  providers: [
    singleTenantResolutionProvider,
    {
      provide: HttpTenantContextResolver,
      useClass: SingleTenantHttpContextResolver,
    },
    RequestIdMiddleware,
    TenantContextMiddleware,
    TenantDatabase,
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [
    SINGLE_TENANT_RESOLUTION,
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
      .exclude(...MEMBER_TENANT_ROUTES)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
