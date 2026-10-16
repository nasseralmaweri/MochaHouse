import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { PlatformTenantsController } from './api/platform-tenants.controller';
import { PlatformTenantsService } from './application/platform-tenants.service';
import { TenantProvisioningService } from './application/tenant-provisioning.service';
import { TenantLifecycleService } from './application/tenant-lifecycle.service';
import { PlatformTenantLifecycleController } from './api/platform-tenant-lifecycle.controller';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

// SC1c — the CENTERIVO tenant registry (/api/v1/platform/tenants*), read-only.
// SC1d — plus business provisioning (TenantProvisioningService: the only
// platform code that writes a business's own rows).
// SC1e — plus lifecycle: suspend, reactivate, correct the first owner's
// email (TenantLifecycleService).
// Imports only the platform boundary (PlatformAuthGuard); nothing from the
// customer or tenant-staff auth modules. PrismaService is @Global.
@Module({
  imports: [PlatformAuthModule, RateLimitModule],
  controllers: [PlatformTenantsController, PlatformTenantLifecycleController],
  providers: [
    PlatformTenantsService,
    TenantProvisioningService,
    TenantLifecycleService,
  ],
})
export class PlatformTenantsModule {}
