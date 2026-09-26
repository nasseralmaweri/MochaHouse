import { Global, Module } from '@nestjs/common';
import {
  SINGLE_TENANT_RESOLUTION,
  singleTenantResolutionProvider,
} from './single-tenant-resolution.provider';
import { WorkerTenantContextFactory } from './worker-tenant-context.factory';

// Milestone S0C — the worker's tenant foundation: SINGLE_TENANT_ID is
// validated at startup, and background work obtains its TenantContext from
// WorkerTenantContextFactory. PrismaService comes from the @Global
// PrismaModule.
@Global()
@Module({
  providers: [singleTenantResolutionProvider, WorkerTenantContextFactory],
  exports: [SINGLE_TENANT_RESOLUTION, WorkerTenantContextFactory],
})
export class WorkerTenancyModule {}
