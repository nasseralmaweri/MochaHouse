import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import {
  HttpTenantContextResolver,
  SingleTenantHttpContextResolver,
} from './http-tenant-context.resolver';
import {
  SINGLE_TENANT_RESOLUTION,
  singleTenantResolutionProvider,
} from './single-tenant-resolution.provider';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantDatabase } from './tenant-database';

// Milestone S0C — the API's tenant foundation. Importing this module:
//   - validates SINGLE_TENANT_ID against the Tenant table at startup
//     (startup fails otherwise);
//   - establishes a TenantContext on every request via
//     TenantContextMiddleware (applied to all routes).
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
    TenantContextMiddleware,
    TenantDatabase,
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
      .apply(TenantContextMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
